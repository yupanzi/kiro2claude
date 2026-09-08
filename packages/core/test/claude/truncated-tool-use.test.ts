/**
 * 截断 tool_use 的终态守卫。
 *
 * 上游偶发「宣告 tool_use、发了几段 input 分片、却从未发 isComplete」就断流。
 * Claude Code 2.1.263 实测:只改 stop_reason=max_tokens 仍会先解析已关闭工具块,
 * 报 InputValidationError。工具参数必须缓存到 isComplete 再发,截断调用不上 wire。
 *
 * 与 mid-stream Exception 同一条红线：绝不静默截断成看似完整的 message_stop。
 */

import { describe, expect, it, vi } from 'vitest';
import { reduceKiroResponse } from '../../src/claude/non-stream-reduce.js';
import { StreamContext } from '../../src/claude/stream.js';
import type { Event } from '../../src/kiro/model/events/base.js';
import { HookBus } from '../../src/plugin-host/index.js';
import { logger } from '../../src/shared/logger.js';
import {
  buildAssistantResponseFrame,
  buildMetadataFrame,
  buildToolUseFrame,
} from '../helpers/event-stream.js';

function makeContext(): StreamContext {
  return new StreamContext('test-model', 1, false, new Map(), new HookBus());
}

function makeToolUse(
  name: string,
  id: string,
  input: string,
  isComplete: boolean,
): Extract<Event, { kind: 'ToolUse' }> {
  return { kind: 'ToolUse', name, toolUseId: id, input, isComplete };
}

/** 把 SSE 事件流里某个 block 的 input_json_delta 拼回去（客户端所做的事）。 */
function accumulateToolInput(events: { event: string; data: Record<string, unknown> }[]): {
  json: string;
  stopped: boolean;
} {
  let index = -1;
  let json = '';
  let stopped = false;
  for (const e of events) {
    const cb = e.data.content_block as { type?: string } | undefined;
    if (e.event === 'content_block_start' && cb?.type === 'tool_use') {
      index = e.data.index as number;
    } else if (e.event === 'content_block_delta' && (e.data.index as number) === index) {
      const d = e.data.delta as { type?: string; partial_json?: string };
      if (d?.type === 'input_json_delta') json += d.partial_json ?? '';
    } else if (e.event === 'content_block_stop' && (e.data.index as number) === index) {
      stopped = true;
    }
  }
  return { json, stopped };
}

function finalStopReason(events: { event: string; data: Record<string, unknown> }[]): unknown {
  const md = events.find((e) => e.event === 'message_delta');
  return (md?.data.delta as { stop_reason?: unknown } | undefined)?.stop_reason;
}

describe('截断 tool_use（无 isComplete）的终态', () => {
  it('可见文本 + 截断 tool_use：客户端绝不能收到残缺的可执行工具块', async () => {
    const ctx = makeContext();
    const events = [
      ...ctx.processAssistantResponse('我先看一下你的项目结构，然后给你几个选项。'),
      // 上游把 input 分片发下来，但从未 isComplete —— 生成被截断
      ...ctx.processToolUse(
        makeToolUse('AskUserQuestion', 'toolu_x', '{"questions":[{"question":"选哪种缓存', false),
      ),
      ...(await ctx.generateFinalEvents()),
    ];

    const { json, stopped } = accumulateToolInput(events);

    // 真实 Claude Code 在读取 stop_reason 之前便会解析工具块。不能仅改终态。
    expect(json).toBe('');
    expect(stopped).toBe(false);
    expect(
      events.some(
        (event) => (event.data.content_block as { type?: string } | undefined)?.type === 'tool_use',
      ),
    ).toBe(false);
    expect(finalStopReason(events)).toBe('max_tokens');
  });

  it('工具分片缓存到 isComplete，完成后参数逐字节保留且只发一个完整调用', async () => {
    const ctx = makeContext();
    const partial = ctx.processToolUse(makeToolUse('Read', 'toolu_x', '{"file_path":"/a', false));
    expect(partial).toEqual([]);
    expect(ctx.hasIncompleteToolUse()).toBe(true);
    const events = [
      ...ctx.processToolUse(makeToolUse('Read', 'toolu_x', '.txt"}', true)),
      ...ctx.processKiroEvent({ kind: 'Metadata', stopReason: 'END_TURN' }),
      ...(await ctx.generateFinalEvents()),
    ];
    expect(accumulateToolInput(events)).toEqual({ json: '{"file_path":"/a.txt"}', stopped: true });
    expect(ctx.hasIncompleteToolUse()).toBe(false);
    expect(finalStopReason(events)).toBe('tool_use');
  });

  it('未完成工具不占用 block index，也不会与另一个调用的参数混合', async () => {
    const ctx = makeContext();
    ctx.processToolUse(makeToolUse('Read', 'toolu_truncated', '{"file_path":"/bad', false));
    const events = [
      ...ctx.processToolUse(makeToolUse('Read', 'toolu_complete', '{"file_path":"/good"}', true)),
      ...(await ctx.generateFinalEvents()),
    ];
    const starts = events.filter((event) => event.event === 'content_block_start');
    expect(starts).toHaveLength(1);
    expect(starts[0]?.data).toMatchObject({ index: 0, content_block: { id: 'toolu_complete' } });
    expect(accumulateToolInput(events).json).toBe('{"file_path":"/good"}');
    expect(finalStopReason(events)).toBe('max_tokens');
  });

  it('交错到达的两次调用按完成顺序发出，参数和连续索引各自独立', async () => {
    const ctx = makeContext();
    expect(ctx.processToolUse(makeToolUse('Read', 'toolu_a', '{"file_path":"/a', false))).toEqual(
      [],
    );
    expect(ctx.processToolUse(makeToolUse('Read', 'toolu_b', '{"file_path":"/b', false))).toEqual(
      [],
    );
    const events = [
      ...ctx.processToolUse(makeToolUse('Read', 'toolu_b', '.txt"}', true)),
      ...ctx.processToolUse(makeToolUse('Read', 'toolu_a', '.ts"}', true)),
      ...ctx.processKiroEvent({ kind: 'Metadata', stopReason: 'END_TURN' }),
      ...(await ctx.generateFinalEvents()),
    ];
    const starts = events.filter((event) => event.event === 'content_block_start');
    expect(starts.map((event) => event.data.index)).toEqual([0, 1]);
    expect(starts.map((event) => (event.data.content_block as { id: string }).id)).toEqual([
      'toolu_b',
      'toolu_a',
    ]);
    for (const [index, filePath] of ['/b.txt', '/a.ts'].entries()) {
      const input = events
        .filter((event) => event.event === 'content_block_delta' && event.data.index === index)
        .map((event) => (event.data.delta as { partial_json: string }).partial_json)
        .join('');
      expect(JSON.parse(input)).toEqual({ file_path: filePath });
      expect(
        events.filter(
          (event) => event.event === 'content_block_stop' && event.data.index === index,
        ),
      ).toHaveLength(1);
    }
    expect(finalStopReason(events)).toBe('tool_use');
  });

  it('截断的 tool_use 必须以 max_tokens 收尾，不能谎报 tool_use', async () => {
    const ctx = makeContext();
    const events = [
      ...ctx.processAssistantResponse('让我问你几个问题。'),
      ...ctx.processToolUse(makeToolUse('AskUserQuestion', 'toolu_x', '{"questions":[{"q', false)),
      ...(await ctx.generateFinalEvents()),
    ];

    // 截断 = 输出被砍断，语义上就是 max_tokens；报 tool_use 会让客户端
    // 把残缺调用当成一次完整的工具调用去解析
    expect(finalStopReason(events)).toBe('max_tokens');
  });

  it('反向守卫：正常完成的 tool_use 仍报 tool_use', async () => {
    const ctx = makeContext();
    const events = [
      ...ctx.processAssistantResponse('好的。'),
      ...ctx.processToolUse(makeToolUse('AskUserQuestion', 'toolu_x', '{"questions":[]}', true)),
      ...ctx.processKiroEvent({ kind: 'Metadata', stopReason: 'END_TURN' }),
      ...(await ctx.generateFinalEvents()),
    ];

    const { json } = accumulateToolInput(events);
    expect(() => JSON.parse(json)).not.toThrow();
    expect(finalStopReason(events)).toBe('tool_use');
  });

  it('反向守卫：多个 tool_use 中只要有一个未完成，就按截断收尾', async () => {
    const ctx = makeContext();
    const events = [
      ...ctx.processToolUse(makeToolUse('Read', 'toolu_a', '{"file_path":"/a"}', true)),
      ...ctx.processToolUse(makeToolUse('AskUserQuestion', 'toolu_b', '{"questi', false)),
      ...(await ctx.generateFinalEvents()),
    ];

    expect(finalStopReason(events)).toBe('max_tokens');
  });

  /**
   * ★ 最关键的反向守卫。「空壳帧(有名字、零 input)+ 立即断流」是**确定性空流**,
   * stream-handler 靠 `!hasContent() && hasIncompleteToolUse()` 认出它并单次
   * 定案、不耗重试预算(踩坑「空流有界重试」)。它与「有 input 分片」的 max_tokens
   * 属不同终态,且两者都不得向客户端发送未完成调用。
   */
  it('反向守卫：空壳帧（零 input）必须仍报 tool_use，否则砸掉确定性空流判定', async () => {
    const ctx = makeContext();
    const events = [
      ...ctx.processToolUse(makeToolUse('AskUserQuestion', 'toolu_x', '', false)),
      ...(await ctx.generateFinalEvents()),
    ];

    expect(ctx.hasContent()).toBe(false);
    expect(finalStopReason(events)).toBe('tool_use');
  });
});

describe('网关自伤的截断不算上游故障', () => {
  it('gatewayTruncatedUpstream=true → 终态仍是 max_tokens，但日志走 info 且不占用上游 msg', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    try {
      const ctx = makeContext();
      ctx.processAssistantResponse('我来读一下文件。');
      ctx.processToolUse(makeToolUse('Read', 'toolu_x', '{"file_pa', false));
      // 客户端断连 → 网关主动 abort/destroy 上游（见 stream-handler 两处置位点）
      ctx.gatewayTruncatedUpstream = true;
      const events = await ctx.generateFinalEvents();

      expect(finalStopReason(events)).toBe('max_tokens');
      const upstreamMsgs = warn.mock.calls
        .map((c) => (c[0] as { msg?: string }).msg)
        .filter((m) => m?.includes('upstream truncated tool_use'));
      expect(upstreamMsgs).toHaveLength(0);
      const selfMsgs = info.mock.calls
        .map((c) => c[0] as { msg?: string; self_inflicted?: boolean })
        .filter((f) => f.msg?.includes('truncated by gateway-initiated'));
      expect(selfMsgs).toHaveLength(1);
      expect(selfMsgs[0]?.self_inflicted).toBe(true);
    } finally {
      warn.mockRestore();
      info.mockRestore();
    }
  });

  it('反向守卫：未置位时仍以 warn 报「upstream truncated tool_use」（runbook 的 grep 目标）', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      const ctx = makeContext();
      ctx.processAssistantResponse('我来读一下文件。');
      ctx.processToolUse(makeToolUse('Read', 'toolu_x', '{"file_pa', false));
      await ctx.generateFinalEvents();

      const fields = warn.mock.calls
        .map((c) => c[0] as { msg?: string; self_inflicted?: boolean })
        .filter((f) => f.msg?.includes('upstream truncated tool_use'));
      expect(fields).toHaveLength(1);
      expect(fields[0]?.self_inflicted).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('非流式路径：截断终态必须与流式同源', () => {
  const MODEL = 'claude-opus-4-6';
  const reduce = (frames: Buffer[]) =>
    reduceKiroResponse(Buffer.concat(frames), MODEL, false, new Map(), undefined);

  /**
   * ★ 本组的两条是 2026-09 review 抓到的分叉:守卫曾写成 `toolUses.length > 0`,
   * 于是「一个都没完成」的截断全部落进 `else if (hasToolUse)`。它比 `hasContent()`
   * 严格,漏掉了「有文本」「有 input 分片」两种上游已开工的形态。
   */
  it('可见文本 + 截断（零完成调用）→ max_tokens，且绝不产出 0 个 block 的 tool_use 终态', () => {
    const r = reduce([
      buildAssistantResponseFrame('我先看一下你的项目结构，然后给你几个选项。'),
      buildToolUseFrame('AskUserQuestion', 'toolu_x', '{"questions":[{"quest', false),
    ]);

    // 终态若是 tool_use,客户端(以及 OpenAI 侧的 finish_reason:"tool_calls")
    // 会去找一个根本不存在的工具调用
    expect(r.toolUses).toHaveLength(0);
    expect(r.stopReason).toBe('max_tokens');
    expect(r.silentFailure).toBe(false);
    expect(r.textContent).toContain('项目结构');
  });

  it('只有 input 分片、无文本 → max_tokens + 占位文本（流式对同一份字节回 200）', () => {
    const r = reduce([
      buildToolUseFrame('AskUserQuestion', 'toolu_x', '{"questions":[{"quest', false),
    ]);

    expect(r.stopReason).toBe('max_tokens');
    expect(r.silentFailure).toBe(false);
    // 残缺调用被丢弃后一个 block 都不剩 → 必须补占位符,别产 `content: []`
    expect(r.textContent).toBe(' ');
  });

  it('流式对拍：同一形态（有 input 分片、无完成调用）两条路径都落 max_tokens', async () => {
    const ctx = makeContext();
    const events = [
      ...ctx.processToolUse(
        makeToolUse('AskUserQuestion', 'toolu_x', '{"questions":[{"quest', false),
      ),
      ...(await ctx.generateFinalEvents()),
    ];

    expect(ctx.hasContent()).toBe(true); // input 分片计入 outputTokens
    expect(finalStopReason(events)).toBe('max_tokens');
  });

  it('一个完成 + 一个截断 → max_tokens（不谎报 tool_use）', () => {
    const r = reduce([
      buildAssistantResponseFrame('先读文件，再问你几个问题。'),
      buildToolUseFrame('Read', 'toolu_a', '{"file_path":"/a"}', true),
      buildToolUseFrame('AskUserQuestion', 'toolu_b', '{"questions":[{"quest', false),
    ]);

    expect(r.toolUses).toHaveLength(1);
    expect(r.stopReason).toBe('max_tokens');
    expect(r.silentFailure).toBe(false);
  });

  it('反向守卫：纯截断（无任何完成调用）留在判空路径，不被 max_tokens 摘出去', () => {
    const r = reduce([buildToolUseFrame('AskUserQuestion', 'toolu_x', '', false)]);

    expect(r.toolUses).toHaveLength(0);
    expect(r.silentFailure).toBe(true);
  });

  it('反向守卫：全部完成 → 仍报 tool_use', () => {
    const r = reduce([
      buildToolUseFrame('Read', 'toolu_a', '{"file_path":"/a"}', true),
      buildMetadataFrame(),
    ]);

    expect(r.toolUses).toHaveLength(1);
    expect(r.stopReason).toBe('tool_use');
  });
});
