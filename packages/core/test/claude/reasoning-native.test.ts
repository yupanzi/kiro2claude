/**
 * 契约测试：kiro-cli 2.6.0+ 原生 reasoning 路径（`userInputMessage.reasoning.effort`
 * 请求字段 + `reasoningContentEvent` 响应事件 + `signature_delta` SSE delta）。
 *
 * 四层覆盖：
 *   - parser  (`src/kiro/model/events/base.ts`)
 *   - stream  (`src/claude/stream.ts` 的 `StreamContext.processReasoningContent`)
 *   - convert (`src/claude/converter.ts` 的 `mapThinkingToEffort` + body 注入)
 *   - 端到端：parser → stream 完整 SSE 序列断言
 *
 * 现有的 `<thinking>` 标签提取测试（`test/claude/stream.test.ts`）不受影响——
 * 旧路径对 4.6 / sonnet / haiku 等不支持原生 reasoning 的 model 仍生效。
 */

import { describe, expect, it } from 'vitest';
import {
  clientModelHasEncryptedReasoning,
  convertRequest,
  getContextWindowSize,
  MODELS_WITH_NATIVE_REASONING,
  mapModel,
  mapThinkingToEffort,
  usesNativeReasoning,
} from '../../src/claude/converter.js';
import { type SseEvent, StreamContext } from '../../src/claude/stream.js';
import type { MessagesRequest } from '../../src/claude/types.js';
import { eventFromFrame } from '../../src/kiro/model/events/base.js';
import { parseFrame } from '../../src/kiro/parser/frame.js';
import { HookBus } from '../../src/plugin-host/index.js';
import {
  buildAssistantResponseFrame,
  buildReasoningContentFrame,
  buildRedactedReasoningFrame,
} from '../helpers/event-stream.js';

// ============================================================================
// helpers
// ============================================================================

function makeContext(
  thinkingEnabled = true,
  toolNameMap = new Map<string, string>(),
): StreamContext {
  return new StreamContext('claude-opus-4-7', 100, thinkingEnabled, toolNameMap, new HookBus());
}

function decodeFrame(frame: Buffer) {
  const r = parseFrame(frame);
  if (!r) throw new Error('frame parse failed');
  return eventFromFrame(r.frame);
}

function thinkingDeltas(events: SseEvent[]): string[] {
  return events
    .filter(
      (e) => e.event === 'content_block_delta' && (e.data.delta as any)?.type === 'thinking_delta',
    )
    .map((e) => (e.data.delta as any).thinking as string);
}

function signatureDeltas(events: SseEvent[]): string[] {
  return events
    .filter(
      (e) => e.event === 'content_block_delta' && (e.data.delta as any)?.type === 'signature_delta',
    )
    .map((e) => (e.data.delta as any).signature as string);
}

function textDeltas(events: SseEvent[]): string {
  return events
    .filter(
      (e) => e.event === 'content_block_delta' && (e.data.delta as any)?.type === 'text_delta',
    )
    .map((e) => (e.data.delta as any).text as string)
    .join('');
}

function blockStarts(events: SseEvent[]): Array<{ index: number; type: string }> {
  return events
    .filter((e) => e.event === 'content_block_start')
    .map((e) => ({
      index: e.data.index as number,
      type: (e.data.content_block as any).type as string,
    }));
}

function blockStops(events: SseEvent[]): number[] {
  return events.filter((e) => e.event === 'content_block_stop').map((e) => e.data.index as number);
}

function baseMessagesRequest(overrides: Partial<MessagesRequest> = {}): MessagesRequest {
  return {
    model: 'claude-opus-4-7',
    max_tokens: 4096,
    messages: [{ role: 'user', content: 'hello' }],
    stream: false,
    ...overrides,
  };
}

// ============================================================================
// parser 层
// ============================================================================

describe('parser: reasoningContentEvent', () => {
  it('解析 text 字段', () => {
    const ev = decodeFrame(buildReasoningContentFrame(' Let me think about this'));
    expect(ev.kind).toBe('ReasoningContent');
    if (ev.kind !== 'ReasoningContent') throw new Error('unreachable');
    expect(ev.text).toBe(' Let me think about this');
    expect(ev.signature).toBeUndefined();
  });

  it('解析 text + signature (最后一个 chunk)', () => {
    const sig = 'EuYBCkQIBhgCKkA0...rzAB';
    const ev = decodeFrame(buildReasoningContentFrame(' final thought.', sig));
    expect(ev.kind).toBe('ReasoningContent');
    if (ev.kind !== 'ReasoningContent') throw new Error('unreachable');
    expect(ev.text).toBe(' final thought.');
    expect(ev.signature).toBe(sig);
  });

  it('text 缺失时回落空字符串', () => {
    // 反向边界：上游若曾出现仅 signature 的 chunk，text 给空串而不是 undefined
    const r = parseFrame(buildReasoningContentFrame(''));
    if (!r) throw new Error('frame parse failed');
    const ev = eventFromFrame(r.frame);
    expect(ev.kind).toBe('ReasoningContent');
    if (ev.kind === 'ReasoningContent') expect(ev.text).toBe('');
  });

  it('GPT redacted reasoning: 解析出 redactedContent + text 空串', () => {
    const ev = decodeFrame(buildRedactedReasoningFrame('.KTR~~eyJlbmM='));
    expect(ev.kind).toBe('ReasoningContent');
    if (ev.kind !== 'ReasoningContent') throw new Error('unreachable');
    expect(ev.text).toBe('');
    expect(ev.signature).toBeUndefined();
    expect(ev.redactedContent).toBe('.KTR~~eyJlbmM=');
  });
});

// ============================================================================
// stream: GPT redacted reasoning 整块丢弃(不开空 thinking 块)
// ============================================================================

describe('stream: GPT redacted reasoning', () => {
  it('redacted-only reasoning 帧不产任何 SSE 事件、不开 thinking 块', () => {
    const ctx = makeContext(true);
    const events = ctx.processKiroEvent(decodeFrame(buildRedactedReasoningFrame()));
    expect(events).toEqual([]);
    // 没有 thinking content_block_start
    expect(blockStarts(events).some((b) => b.type === 'thinking')).toBe(false);
  });

  it('redacted reasoning 后接正常文本 → 只有 text 块,无 thinking 块', () => {
    // thinkingEnabled=false 直接走 text_delta,避开 <thinking> 扫描的缓冲(那需
    // generateFinalEvents 才 flush,与本用例意图无关)。守卫对两种模式都生效。
    const ctx = makeContext(false);
    const all: SseEvent[] = [];
    all.push(...ctx.processKiroEvent(decodeFrame(buildRedactedReasoningFrame())));
    all.push(...ctx.processKiroEvent(decodeFrame(buildAssistantResponseFrame('pong'))));
    expect(textDeltas(all)).toBe('pong');
    expect(thinkingDeltas(all)).toEqual([]);
    expect(blockStarts(all).some((b) => b.type === 'thinking')).toBe(false);
  });

  it('Claude 明文 reasoning 不受守卫影响(回归)', () => {
    const ctx = makeContext(true);
    const all: SseEvent[] = [];
    all.push(...ctx.processKiroEvent(decodeFrame(buildReasoningContentFrame('thinking...'))));
    all.push(...ctx.processKiroEvent(decodeFrame(buildReasoningContentFrame(' more', 'sig123'))));
    expect(thinkingDeltas(all).join('')).toContain('thinking...');
    expect(signatureDeltas(all)).toContain('sig123');
    expect(blockStarts(all).some((b) => b.type === 'thinking')).toBe(true);
  });
});

// ============================================================================
// converter: thinking → reasoning.effort 双通道映射
// ============================================================================

describe('mapThinkingToEffort: 双通道映射', () => {
  it('adaptive + output_config.effort 直接同步', () => {
    expect(mapThinkingToEffort({ type: 'adaptive' }, { effort: 'low' })).toBe('low');
    expect(mapThinkingToEffort({ type: 'adaptive' }, { effort: 'medium' })).toBe('medium');
    expect(mapThinkingToEffort({ type: 'adaptive' }, { effort: 'high' })).toBe('high');
    expect(mapThinkingToEffort({ type: 'adaptive' }, { effort: 'xhigh' })).toBe('xhigh');
    expect(mapThinkingToEffort({ type: 'adaptive' }, { effort: 'max' })).toBe('max');
  });

  it('adaptive 无 effort 落到默认 high', () => {
    expect(mapThinkingToEffort({ type: 'adaptive' }, undefined)).toBe('high');
    expect(mapThinkingToEffort({ type: 'adaptive' }, {})).toBe('high');
  });

  it('adaptive + 未知 effort 取默认 high (forwards-compat)', () => {
    expect(mapThinkingToEffort({ type: 'adaptive' }, { effort: 'mega' })).toBe('high');
  });

  it('enabled + budget_tokens 按阈值映射', () => {
    expect(mapThinkingToEffort({ type: 'enabled', budget_tokens: 1024 }, undefined)).toBe('low');
    expect(mapThinkingToEffort({ type: 'enabled', budget_tokens: 2047 }, undefined)).toBe('low');
    expect(mapThinkingToEffort({ type: 'enabled', budget_tokens: 2048 }, undefined)).toBe('medium');
    expect(mapThinkingToEffort({ type: 'enabled', budget_tokens: 8191 }, undefined)).toBe('medium');
    expect(mapThinkingToEffort({ type: 'enabled', budget_tokens: 8192 }, undefined)).toBe('high');
    expect(mapThinkingToEffort({ type: 'enabled', budget_tokens: 16383 }, undefined)).toBe('high');
    expect(mapThinkingToEffort({ type: 'enabled', budget_tokens: 16384 }, undefined)).toBe('xhigh');
    expect(mapThinkingToEffort({ type: 'enabled', budget_tokens: 32767 }, undefined)).toBe('xhigh');
    expect(mapThinkingToEffort({ type: 'enabled', budget_tokens: 32768 }, undefined)).toBe('max');
    expect(mapThinkingToEffort({ type: 'enabled', budget_tokens: 65536 }, undefined)).toBe('max');
  });

  it('enabled 缺 budget_tokens 取默认 20000 → high', () => {
    expect(mapThinkingToEffort({ type: 'enabled' }, undefined)).toBe('xhigh');
  });

  it('disabled / 未识别 type 返回 undefined', () => {
    expect(mapThinkingToEffort({ type: 'disabled' }, undefined)).toBeUndefined();
    expect(mapThinkingToEffort({ type: 'unknown' }, undefined)).toBeUndefined();
    expect(mapThinkingToEffort(undefined, undefined)).toBeUndefined();
  });
});

describe('usesNativeReasoning: 模型能力探测', () => {
  it('4.7 / 4.8 走原生', () => {
    expect(usesNativeReasoning('claude-opus-4.7')).toBe(true);
    expect(usesNativeReasoning('claude-opus-4.8')).toBe(true);
  });

  it('4.6 / sonnet / haiku / 4.5 走 fallback prompt 路径', () => {
    expect(usesNativeReasoning('claude-opus-4.6')).toBe(false);
    expect(usesNativeReasoning('claude-opus-4.5')).toBe(false);
    expect(usesNativeReasoning('claude-sonnet-4.6')).toBe(false);
    expect(usesNativeReasoning('claude-sonnet-4.5')).toBe(false);
    expect(usesNativeReasoning('claude-haiku-4.5')).toBe(false);
  });

  it('MODELS_WITH_NATIVE_REASONING 是 exhaustive list', () => {
    expect([...MODELS_WITH_NATIVE_REASONING].sort()).toEqual(
      [
        'claude-opus-4.7',
        'claude-opus-4.8',
        // GPT-5.6 系列同走原生 reasoning.effort（reasoning 内容加密不可 surface）
        'gpt-5.6-sol',
        'gpt-5.6-terra',
        'gpt-5.6-luna',
      ].sort(),
    );
  });

  it('GPT-5.6 走原生 reasoning + 272K context', () => {
    for (const m of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
      expect(usesNativeReasoning(m)).toBe(true);
      expect(getContextWindowSize(m)).toBe(272_000);
    }
  });
});

describe('clientModelHasEncryptedReasoning: 仅 GPT(加密 reasoning)命中', () => {
  it('GPT 客户端名(含 Codex 别名 gpt-*-codex)→ true', () => {
    // handler 侧据此关掉 legacy <thinking> 扫描:GPT redacted reasoning 不置
    // sawReasoningContent,运行时无法关闭扫描,必须靠静态判定,否则字面 <thinking> 被误剥离。
    expect(clientModelHasEncryptedReasoning('gpt-5.6-sol')).toBe(true);
    // Codex 用 gpt-5-codex,mapModel 别名到 gpt-5.6-sol —— 未映射名也须命中
    expect(clientModelHasEncryptedReasoning('gpt-5-codex')).toBe(true);
  });

  it('Claude 原生 reasoning(明文,4.7/4.8)→ false —— 绝不能关其扫描/破坏块顺序', () => {
    // 回归护栏:Claude 原生 reasoning 是明文,靠运行时 sawReasoningContent 关闭扫描,
    // 且需 thinkingEnabled=true 维持 thinking→text 块顺序(否则 e2e 流式顺序断言失败)。
    expect(clientModelHasEncryptedReasoning('claude-opus-4.7')).toBe(false);
    expect(clientModelHasEncryptedReasoning('claude-opus-4.8')).toBe(false);
  });

  it('非原生 / 未知模型 → false', () => {
    expect(clientModelHasEncryptedReasoning('claude-opus-4.6')).toBe(false);
    expect(clientModelHasEncryptedReasoning('totally-unknown-model')).toBe(false);
  });
});

// ============================================================================
// converter: wire body 注入
// ============================================================================

describe('convertRequest: reasoning.effort 注入', () => {
  it('4.7 + adaptive + effort=max → currentMessage.userInputMessage.reasoning.effort=max', () => {
    const req = baseMessagesRequest({
      model: 'claude-opus-4-7',
      thinking: { type: 'adaptive', budget_tokens: 20000 },
      output_config: { effort: 'max' },
    });
    const result = convertRequest(req);
    const uim = result.conversationState.currentMessage.userInputMessage;
    expect(uim.reasoning).toEqual({ effort: 'max' });
    expect(mapModel(req.model)).toBe('claude-opus-4.7');
  });

  it('4.7 + enabled + budget_tokens=4096 → reasoning.effort=medium', () => {
    const req = baseMessagesRequest({
      model: 'claude-opus-4-7',
      thinking: { type: 'enabled', budget_tokens: 4096 },
    });
    const result = convertRequest(req);
    expect(result.conversationState.currentMessage.userInputMessage.reasoning).toEqual({
      effort: 'medium',
    });
  });

  it('4.8 + adaptive → reasoning.effort 注入', () => {
    const req = baseMessagesRequest({
      model: 'claude-opus-4-8',
      thinking: { type: 'adaptive', budget_tokens: 20000 },
      output_config: { effort: 'high' },
    });
    const result = convertRequest(req);
    expect(result.conversationState.currentMessage.userInputMessage.reasoning).toEqual({
      effort: 'high',
    });
  });

  it('4.6 + thinking → 不注入 reasoning 字段（走旧 prompt 注入路径）', () => {
    const req = baseMessagesRequest({
      model: 'claude-opus-4-6',
      thinking: { type: 'enabled', budget_tokens: 16000 },
    });
    const result = convertRequest(req);
    expect(result.conversationState.currentMessage.userInputMessage.reasoning).toBeUndefined();
  });

  it('4.7 不传 thinking → 不注入 reasoning 字段', () => {
    const req = baseMessagesRequest({
      model: 'claude-opus-4-7',
    });
    const result = convertRequest(req);
    expect(result.conversationState.currentMessage.userInputMessage.reasoning).toBeUndefined();
  });

  it('4.7 + thinking.type=disabled → 不注入 reasoning', () => {
    const req = baseMessagesRequest({
      model: 'claude-opus-4-7',
      thinking: { type: 'disabled', budget_tokens: 0 },
    });
    const result = convertRequest(req);
    expect(result.conversationState.currentMessage.userInputMessage.reasoning).toBeUndefined();
  });

  it('4.7 + thinking → 不注入 <thinking_mode> prompt 前缀（避免双重处理）', () => {
    const req = baseMessagesRequest({
      model: 'claude-opus-4-7',
      thinking: { type: 'enabled', budget_tokens: 8000 },
      messages: [{ role: 'user', content: 'compute 1+1' }],
    });
    const result = convertRequest(req);
    // history 里第一条若有 system directive，content 不应包含 <thinking_mode> 标签
    const allContent = result.conversationState.history
      .filter((m) => m.kind === 'user')
      .map((m) => (m.kind === 'user' ? m.userInputMessage.content : ''))
      .join('\n');
    expect(allContent).not.toMatch(/<thinking_mode>/);
    expect(allContent).not.toMatch(/<max_thinking_length>/);
  });

  it('4.6 + thinking → 旧路径仍注入 <thinking_mode> prompt 前缀', () => {
    const req = baseMessagesRequest({
      model: 'claude-opus-4-6',
      thinking: { type: 'enabled', budget_tokens: 8000 },
      messages: [{ role: 'user', content: 'compute 1+1' }],
    });
    const result = convertRequest(req);
    const allContent = result.conversationState.history
      .filter((m) => m.kind === 'user')
      .map((m) => (m.kind === 'user' ? m.userInputMessage.content : ''))
      .join('\n');
    expect(allContent).toMatch(/<thinking_mode>enabled<\/thinking_mode>/);
  });
});

// ============================================================================
// stream: ReasoningContent → thinking content block
// ============================================================================

describe('stream: processReasoningContent', () => {
  it('首个 ReasoningContent → content_block_start(thinking) + thinking_delta', () => {
    const ctx = makeContext(true);
    ctx.generateInitialEvents(); // 模拟 stream 启动
    const events = ctx.processKiroEvent({
      kind: 'ReasoningContent',
      text: 'Let me think.',
      signature: undefined,
    });

    const starts = blockStarts(events);
    expect(starts.length).toBe(1);
    expect(starts[0].type).toBe('thinking');

    expect(thinkingDeltas(events)).toEqual(['Let me think.']);
    expect(signatureDeltas(events)).toEqual([]);
  });

  it('多个 ReasoningContent → 共用同一 thinking block + 多个 thinking_delta', () => {
    const ctx = makeContext(true);
    ctx.generateInitialEvents();
    const all: SseEvent[] = [];
    for (const text of [' Hmm.', ' Continuing.', ' Done.']) {
      all.push(...ctx.processKiroEvent({ kind: 'ReasoningContent', text, signature: undefined }));
    }
    expect(blockStarts(all).filter((b) => b.type === 'thinking').length).toBe(1);
    expect(thinkingDeltas(all)).toEqual([' Hmm.', ' Continuing.', ' Done.']);
  });

  it('payload 带 signature → emit signature_delta', () => {
    const ctx = makeContext(true);
    ctx.generateInitialEvents();
    const sig = 'EuYBCkQIBhgC...';
    const events = ctx.processKiroEvent({
      kind: 'ReasoningContent',
      text: ' final fragment.',
      signature: sig,
    });
    expect(thinkingDeltas(events)).toEqual([' final fragment.']);
    expect(signatureDeltas(events)).toEqual([sig]);
  });

  it('ReasoningContent 后切到 AssistantResponse → 关 thinking block + 开 text block', () => {
    const ctx = makeContext(true);
    ctx.generateInitialEvents();
    const all: SseEvent[] = [];
    all.push(
      ...ctx.processKiroEvent({
        kind: 'ReasoningContent',
        text: 'reasoning',
        signature: 'sigval',
      }),
    );
    all.push(...ctx.processKiroEvent({ kind: 'AssistantResponse', content: 'final answer' }));

    const starts = blockStarts(all);
    const stops = blockStops(all);
    // 期望顺序：thinking start → thinking stop → text start
    const types = starts.map((s) => s.type);
    expect(types).toEqual(['thinking', 'text']);
    expect(stops.length).toBeGreaterThanOrEqual(1); // 至少一个 stop（thinking 关闭）

    // 最终 text content 不含 reasoning 文本
    expect(textDeltas(all)).toBe('final answer');
  });

  it('sawReasoningContent=true → 后续 AssistantResponse 不再扫 <thinking> 标签', () => {
    const ctx = makeContext(true);
    ctx.generateInitialEvents();
    // 先收到 reasoning
    ctx.processKiroEvent({ kind: 'ReasoningContent', text: 'r', signature: undefined });
    // 然后 AssistantResponse content 故意带 <thinking> 字面字符串
    const events = ctx.processKiroEvent({
      kind: 'AssistantResponse',
      content: 'The user asked about <thinking> tags.',
    });
    // 不应该解读成 thinking 标签——以 text_delta 输出原样
    expect(textDeltas(events)).toBe('The user asked about <thinking> tags.');
    // 不应再开 thinking block
    expect(blockStarts(events).filter((b) => b.type === 'thinking').length).toBe(0);
  });

  it('stream 结束时未关 thinking block → generateFinalEvents 补关', async () => {
    const ctx = makeContext(true);
    ctx.generateInitialEvents();
    ctx.processKiroEvent({ kind: 'ReasoningContent', text: 'only thinking', signature: undefined });
    const finals = await ctx.generateFinalEvents();
    // 必须有一个 content_block_stop 关闭 thinking
    expect(blockStops(finals).length).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================================
// 端到端：parser → stream 完整 SSE 序列
// ============================================================================

describe('e2e: reasoningContentEvent 帧 → stream SSE 序列', () => {
  it('真实帧 → 完整 SSE: thinking_delta x3 + signature_delta + text_delta', async () => {
    const ctx = makeContext(true);
    const all: SseEvent[] = [];
    all.push(...ctx.generateInitialEvents());

    // 模拟上游 stream：3 个 reasoning chunk + 1 个带 signature + 1 个 assistant response
    const frames = [
      buildReasoningContentFrame(' Step 1.'),
      buildReasoningContentFrame(' Step 2.'),
      buildReasoningContentFrame(' Done.', 'final-sig-value'),
      buildAssistantResponseFrame('The answer is 42.'),
    ];
    for (const buf of frames) {
      const ev = decodeFrame(buf);
      all.push(...ctx.processKiroEvent(ev));
    }
    all.push(...(await ctx.generateFinalEvents()));

    expect(thinkingDeltas(all)).toEqual([' Step 1.', ' Step 2.', ' Done.']);
    expect(signatureDeltas(all)).toEqual(['final-sig-value']);

    expect(textDeltas(all)).toBe('The answer is 42.');

    // block 顺序：thinking 然后 text（thinkingEnabled=true 时初始不开 text block）
    const starts = blockStarts(all);
    expect(starts.map((s) => s.type)).toEqual(['thinking', 'text']);
  });
});
