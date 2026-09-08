/**
 * 正文在帧边界干净 EOF → 不能当「说完了」。
 *
 * 真实上游的每个完整响应都以 `metadataEvent` 收尾(2026-09 帧审计 351/352,唯一缺它的
 * 那条正是 reasoning 中途 EOF)。EOF 落在帧边界时 `assertComplete()` 天然通过、没有半帧
 * 可判,而客户端把 `end_turn` 当任务完成——真实 Claude Code 对 12 步任务做了 4 步就
 * `exit 0`。故流式与非流式**同源**地把「有内容、无错误、无尾帧」收窄为 `max_tokens`
 * (Responses → `incomplete`,两种终态实测都会让客户端续接)。
 *
 * 边界(反向守卫):零内容仍归判空路径;显式错误帧走 in-band error 而非这里;网关自己
 * 掐断的上游降 info。三协议的 HTTP 结果在 `transport-integrity.test.ts` /
 * `conversation-content-integrity.test.ts`。
 */
import { describe, expect, it, vi } from 'vitest';
import { reduceKiroResponse } from '../../src/claude/non-stream-reduce.js';
import { type SseEvent, StreamContext } from '../../src/claude/stream.js';
import type { Event } from '../../src/kiro/model/events/base.js';
import { HookBus } from '../../src/plugin-host/index.js';
import { logger } from '../../src/shared/logger.js';
import {
  buildAssistantResponseFrame,
  buildErrorFrame,
  buildMetadataFrame,
  buildToolUseFrame,
} from '../helpers/event-stream.js';

const MODEL = 'claude-opus-4-6';
const METADATA: Event = { kind: 'Metadata', stopReason: 'END_TURN' };
const TOOL: Event = {
  kind: 'ToolUse',
  name: 'Read',
  toolUseId: 'toolu_a',
  input: '{"file_path":"/a"}',
  isComplete: true,
};

function makeContext(): StreamContext {
  return new StreamContext(MODEL, 1, false, new Map(), new HookBus());
}

function stopReasonOf(events: SseEvent[]): unknown {
  const delta = events.find((e) => e.event === 'message_delta');
  return (delta?.data.delta as { stop_reason?: unknown } | undefined)?.stop_reason;
}

async function finish(events: Event[], ctx = makeContext()): Promise<SseEvent[]> {
  const out: SseEvent[] = [...ctx.generateInitialEvents()];
  for (const event of events) out.push(...ctx.processKiroEvent(event));
  out.push(...(await ctx.generateFinalEvents()));
  return out;
}

function reduce(frames: Buffer[]) {
  return reduceKiroResponse(Buffer.concat(frames), MODEL, false, new Map(), undefined);
}

function withSpies<T>(
  run: (spies: {
    warn: ReturnType<typeof vi.spyOn>;
    info: ReturnType<typeof vi.spyOn>;
  }) => Promise<T>,
): Promise<T> {
  const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
  return run({ warn, info }).finally(() => {
    warn.mockRestore();
    info.mockRestore();
  });
}

const messagesOf = (spy: ReturnType<typeof vi.spyOn>) =>
  spy.mock.calls.map((c) => (c[0] as { msg?: string }).msg ?? '');

describe('流式:metadata 尾帧决定「说完了」还是「说到一半」', () => {
  it('文本 + 尾帧 → end_turn', async () => {
    const events = await finish([{ kind: 'AssistantResponse', content: 'done.' }, METADATA]);
    expect(stopReasonOf(events)).toBe('end_turn');
  });

  it('文本、无尾帧 → max_tokens,并以 warn 记「without metadata frame」', async () => {
    await withSpies(async ({ warn }) => {
      const events = await finish([{ kind: 'AssistantResponse', content: 'half of the ans' }]);
      expect(stopReasonOf(events)).toBe('max_tokens');
      expect(events.map((e) => e.event)).toContain('message_stop');
      expect(messagesOf(warn).filter((m) => m.includes('without metadata frame'))).toHaveLength(1);
    });
  });

  it('已完成的 tool_use、无尾帧 → max_tokens,不谎报 tool_use(后面可能还有没到的兄弟调用)', async () => {
    const events = await finish([TOOL]);
    expect(
      events.filter(
        (e) =>
          e.event === 'content_block_start' &&
          (e.data.content_block as { type?: string }).type === 'tool_use',
      ),
    ).toHaveLength(1);
    expect(stopReasonOf(events)).toBe('max_tokens');
    expect(stopReasonOf(await finish([TOOL, METADATA]))).toBe('tool_use');
  });

  it('尾帧在错误路径也被消费,但显式错误帧的终结不经这里', async () => {
    await withSpies(async ({ warn }) => {
      const ctx = makeContext();
      ctx.processKiroEvent({ kind: 'AssistantResponse', content: 'prefix' });
      ctx.processKiroEvent({ kind: 'Error', errorCode: 'InternalError', errorMessage: 'boom' });
      ctx.processKiroEvent(METADATA);
      expect(ctx.sawUpstreamMetadata()).toBe(true);
      await ctx.generateFinalEvents(false);
      expect(messagesOf(warn).some((m) => m.includes('without metadata frame'))).toBe(false);
      expect(ctx.getPendingUpstreamError()).toBeDefined();
    });
  });

  it('反向守卫:零内容、无尾帧不在这里定终态(仍归判空路径)', async () => {
    await withSpies(async ({ warn }) => {
      const ctx = makeContext();
      const events = await finish([], ctx);
      expect(ctx.hasContent()).toBe(false);
      expect(stopReasonOf(events)).toBe('end_turn');
      expect(messagesOf(warn).some((m) => m.includes('without metadata frame'))).toBe(false);
    });
  });

  it('网关自己掐断的上游 → 终态仍 max_tokens,但降 info 且 self_inflicted=true', async () => {
    await withSpies(async ({ warn, info }) => {
      const ctx = makeContext();
      ctx.gatewayTruncatedUpstream = true;
      const events = await finish([{ kind: 'AssistantResponse', content: 'partial' }], ctx);
      expect(stopReasonOf(events)).toBe('max_tokens');
      expect(messagesOf(warn).some((m) => m.includes('without metadata frame'))).toBe(false);
      const self = info.mock.calls
        .map((c) => c[0] as { msg?: string; self_inflicted?: boolean })
        .filter((f) => f.msg?.includes('without metadata frame'));
      expect(self).toHaveLength(1);
      expect(self[0]?.self_inflicted).toBe(true);
    });
  });
});

describe('非流式:终态判定与流式同源', () => {
  it('文本 + 尾帧 → end_turn;无尾帧 → max_tokens 且不判空', () => {
    expect(reduce([buildAssistantResponseFrame('done.'), buildMetadataFrame()]).stopReason).toBe(
      'end_turn',
    );
    const cut = reduce([buildAssistantResponseFrame('half of the ans')]);
    expect(cut.stopReason).toBe('max_tokens');
    expect(cut.textContent).toBe('half of the ans');
    expect(cut.silentFailure).toBe(false);
  });

  it('已完成的 tool_use、无尾帧 → max_tokens;带尾帧 → tool_use', () => {
    const tool = buildToolUseFrame('Read', 'toolu_a', '{"file_path":"/a"}', true);
    const cut = reduce([tool]);
    expect(cut.toolUses).toHaveLength(1);
    expect(cut.stopReason).toBe('max_tokens');
    expect(reduce([tool, buildMetadataFrame()]).stopReason).toBe('tool_use');
  });

  it('显式错误帧优先:不会被改写成 max_tokens', () => {
    const r = reduce([buildAssistantResponseFrame('prefix'), buildErrorFrame('error', 'boom')]);
    expect(r.upstreamError).toBeDefined();
    expect(r.stopReason).toBe('end_turn');
  });

  it('反向守卫:零内容、无尾帧仍是 silentFailure', () => {
    const r = reduce([]);
    expect(r.silentFailure).toBe(true);
    expect(r.stopReason).toBe('end_turn');
  });
});
