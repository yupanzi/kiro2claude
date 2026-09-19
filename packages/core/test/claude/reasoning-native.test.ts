/**
 * 契约测试：原生 reasoning 路径（请求顶层 `additionalModelRequestFields` 字段 +
 * `reasoningContentEvent` 响应事件 + `signature_delta` SSE delta）。
 *
 * 四层覆盖：
 *   - parser  (`src/kiro/model/events/base.ts`)
 *   - stream  (`src/claude/stream.ts` 的 `StreamContext.processReasoningContent`)
 *   - convert (`src/claude/converter.ts` 的 `resolveEffort` / `buildAdditionalModelRequestFields`)
 *   - 端到端：parser → stream 完整 SSE 序列断言
 *
 * 响应侧 `<thinking>` 标签提取(`test/claude/stream.test.ts`)只对非原生模型(opus-4.6 及
 * 以下、haiku)保留;请求侧没有任何前缀注入。
 */

import { describe, expect, it } from 'vitest';
import {
  clientModelHasEncryptedReasoning,
  convertRequest,
  getContextWindowSize,
  initGptContextWindow,
  MODELS_WITH_NATIVE_REASONING,
  mapModel,
  resolveContextUsage,
  resolveEffort,
  toKiroRequest,
  usesNativeReasoning,
} from '../../src/claude/converter.js';
import { type SseEvent, StreamContext } from '../../src/claude/stream.js';
import { buildToolTextRegistry } from '../../src/claude/tool-call-text.js';
import { type MessagesRequest, normalizeThinking, type Tool } from '../../src/claude/types.js';
import { eventFromFrame } from '../../src/kiro/model/events/base.js';
import { serializeKiroRequest } from '../../src/kiro/model/requests/kiro.js';
import { parseFrame } from '../../src/kiro/parser/frame.js';
import { DEFAULT_GPT_CONTEXT_WINDOW } from '../../src/model/schemas/config-schema.js';
import { HookBus } from '../../src/plugin-host/index.js';
import {
  buildAssistantResponseFrame,
  buildReasoningContentFrame,
  buildRedactedReasoningFrame,
} from '../helpers/event-stream.js';
import { collectThinkingDeltas } from '../helpers/sse-blocks.js';

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
    expect(collectThinkingDeltas(all)).toEqual([]);
    expect(blockStarts(all).some((b) => b.type === 'thinking')).toBe(false);
  });

  it('redacted reasoning 会锁定 native 模式，后续完整 legacy-looking 文本仍原样可见', () => {
    const ctx = makeContext(true);
    const all: SseEvent[] = [];
    all.push(...ctx.processKiroEvent(decodeFrame(buildRedactedReasoningFrame())));
    const literal = '<thinking>literal.</thinking>\n\nVisible literal.';
    all.push(...ctx.processKiroEvent(decodeFrame(buildAssistantResponseFrame(literal))));

    expect(textDeltas(all)).toBe(literal);
    expect(collectThinkingDeltas(all)).toEqual([]);
    expect(blockStarts(all).some((block) => block.type === 'thinking')).toBe(false);
  });

  it('空 native 帧后首个有内容的 native 帧仍会正常开启 thinking block', () => {
    const ctx = makeContext(true);
    expect(ctx.processKiroEvent(decodeFrame(buildReasoningContentFrame('')))).toEqual([]);

    const events = ctx.processKiroEvent(
      decodeFrame(buildReasoningContentFrame('surfaceable reasoning', 'sig-after-empty')),
    );
    expect(blockStarts(events).map((block) => block.type)).toEqual(['thinking']);
    expect(collectThinkingDeltas(events)).toEqual(['surfaceable reasoning']);
    expect(signatureDeltas(events)).toEqual(['sig-after-empty']);
  });

  it('Claude 明文 reasoning 不受守卫影响(回归)', () => {
    const ctx = makeContext(true);
    const all: SseEvent[] = [];
    all.push(...ctx.processKiroEvent(decodeFrame(buildReasoningContentFrame('thinking...'))));
    all.push(...ctx.processKiroEvent(decodeFrame(buildReasoningContentFrame(' more', 'sig123'))));
    expect(collectThinkingDeltas(all).join('')).toContain('thinking...');
    expect(signatureDeltas(all)).toContain('sig123');
    expect(blockStarts(all).some((b) => b.type === 'thinking')).toBe(true);
  });
});

// ============================================================================
// converter: thinking → effort(只有 adaptive 一种语义)
// ============================================================================

describe('resolveEffort: 只有 adaptive 一种语义', () => {
  it('adaptive + output_config.effort 直接同步', () => {
    for (const e of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
      expect(resolveEffort({ type: 'adaptive' }, { effort: e })).toBe(e);
    }
  });

  it('adaptive 无 effort / 未知 effort 落到默认 high', () => {
    expect(resolveEffort({ type: 'adaptive' }, undefined)).toBe('high');
    expect(resolveEffort({ type: 'adaptive' }, {})).toBe('high');
    expect(resolveEffort({ type: 'adaptive' }, { effort: 'mega' })).toBe('high');
  });

  it('客户端的 enabled 在入口归一成 adaptive(budget_tokens 丢弃),下游只见 adaptive', () => {
    expect(normalizeThinking({ type: 'enabled', budget_tokens: 100000 })).toEqual({
      type: 'adaptive',
    });
    expect(resolveEffort(normalizeThinking({ type: 'enabled' }), { effort: 'low' })).toBe('low');
    expect(resolveEffort(normalizeThinking({ type: 'enabled' }), undefined)).toBe('high');
  });

  it('disabled / 未提 → undefined', () => {
    expect(resolveEffort({ type: 'disabled' }, { effort: 'max' })).toBeUndefined();
    expect(resolveEffort(undefined, undefined)).toBeUndefined();
  });
});

describe('usesNativeReasoning: 模型能力探测', () => {
  it('4.7 / 4.8 / 5 / sonnet-5 / sonnet-4.6 走原生', () => {
    expect(usesNativeReasoning('claude-opus-4.7')).toBe(true);
    expect(usesNativeReasoning('claude-opus-4.8')).toBe(true);
    expect(usesNativeReasoning('claude-opus-5')).toBe(true);
    expect(usesNativeReasoning('claude-sonnet-5')).toBe(true);
    expect(usesNativeReasoning('claude-sonnet-4.6')).toBe(true);
  });

  it('opus-4.6 / 4.5 / sonnet-4.5 / haiku 非原生:不做 thinking 控制', () => {
    // opus-4.6:上游 schema 有 thinking,但发了字段既无 reasoning 帧也无 signature,没有可回传的
    // 东西,不入集合。其余无 schema。
    expect(usesNativeReasoning('claude-opus-4.6')).toBe(false);
    expect(usesNativeReasoning('claude-opus-4.5')).toBe(false);
    expect(usesNativeReasoning('claude-sonnet-4.5')).toBe(false);
    expect(usesNativeReasoning('claude-haiku-4.5')).toBe(false);
  });

  it('MODELS_WITH_NATIVE_REASONING 是 exhaustive list', () => {
    expect([...MODELS_WITH_NATIVE_REASONING].sort()).toEqual(
      [
        'claude-opus-4.7',
        'claude-opus-4.8',
        // Opus 5 比照 4.7/4.8 走原生（上游 modelId claude-opus-5，摘要 thinking + signature）
        'claude-opus-5',
        // 2026-09-19 抓包:schema 同 opus-5;sonnet-4.6 加字段后回明文 reasoning + signature
        'claude-sonnet-5',
        'claude-sonnet-4.6',
        // GPT-5.6 系列走 additionalModelRequestFields.reasoning（内容加密不可 surface）
        'gpt-5.6-sol',
        'gpt-5.6-terra',
        'gpt-5.6-luna',
      ].sort(),
    );
  });

  it('GPT-5.6 走原生 reasoning + 1M context(上游 2026-09-14 起)', () => {
    for (const m of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
      expect(usesNativeReasoning(m)).toBe(true);
      expect(getContextWindowSize(m)).toBe(1_000_000);
    }
  });

  it('GPT-5.6 窗口可运行时覆盖(未拿到 1M 的账号设回 272K),只影响 GPT', () => {
    try {
      initGptContextWindow(272_000);
      expect(getContextWindowSize('gpt-5.6-sol')).toBe(272_000);
      expect(getContextWindowSize('claude-opus-5')).toBe(1_000_000);
      // 百分比 → token 的乘数必须跟着变:同一个 3.1548% 在 272K 与 1M 下相差 3.68 倍
      expect(resolveContextUsage('gpt-5.6-sol', 3.1548).inputTokens).toBe(8581);
      initGptContextWindow(DEFAULT_GPT_CONTEXT_WINDOW);
      expect(resolveContextUsage('gpt-5.6-sol', 3.1548).inputTokens).toBe(31_548);
    } finally {
      initGptContextWindow(DEFAULT_GPT_CONTEXT_WINDOW);
    }
  });
});

describe('clientModelHasEncryptedReasoning: 仅 GPT(加密 reasoning)命中', () => {
  it('GPT 客户端名(含 Codex 别名 gpt-*-codex)→ true', () => {
    // handler 侧据此从响应开始就关掉 legacy 解码；即使 redacted event 缺失/晚到，
    // 字面 <thinking> 也不会被暂存或误解。
    expect(clientModelHasEncryptedReasoning('gpt-5.6-sol')).toBe(true);
    // Codex 用 gpt-5-codex,mapModel 别名到 gpt-5.6-sol —— 未映射名也须命中
    expect(clientModelHasEncryptedReasoning('gpt-5-codex')).toBe(true);
  });

  it('Claude 原生 reasoning(明文,4.7/4.8)→ false —— 绝不能关其扫描/破坏块顺序', () => {
    // 回归护栏:Claude 原生 reasoning 是明文,靠运行时 native event 锁定模式,
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

describe('convertRequest: 顶层 additionalModelRequestFields(effort 唯一生效位置)', () => {
  const uim = (r: ReturnType<typeof convertRequest>) =>
    r.conversationState.currentMessage.userInputMessage as unknown as Record<string, unknown>;
  const adaptive = (effort?: string) => ({
    thinking: { type: 'adaptive' as const },
    ...(effort ? { output_config: { effort } } : {}),
  });

  it('4.7 + adaptive + effort=max → {thinking:adaptive, output_config.effort:max};userInputMessage 不带 reasoning', () => {
    const req = baseMessagesRequest({ model: 'claude-opus-4-7', ...adaptive('max') });
    const result = convertRequest(req);
    expect(result.additionalModelRequestFields).toEqual({
      thinking: { type: 'adaptive' },
      output_config: { effort: 'max' },
    });
    expect(uim(result).reasoning).toBeUndefined();
    expect(mapModel(req.model)).toBe('claude-opus-4.7');
  });

  it('4.7 + 客户端 enabled(入口归一为 adaptive)→ 上 wire 是 adaptive,effort 取 output_config 或默认 high', () => {
    const noEffort = baseMessagesRequest({
      model: 'claude-opus-4-7',
      thinking: normalizeThinking({ type: 'enabled', budget_tokens: 4096 }),
    });
    expect(convertRequest(noEffort).additionalModelRequestFields).toEqual({
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
    });
    const withEffort = baseMessagesRequest({
      model: 'claude-opus-4-7',
      thinking: normalizeThinking({ type: 'enabled' }),
      output_config: { effort: 'low' },
    });
    expect(convertRequest(withEffort).additionalModelRequestFields).toEqual({
      thinking: { type: 'adaptive' },
      output_config: { effort: 'low' },
    });
  });

  it('4.8 / 5 + adaptive → 同形态(上游 modelId claude-opus-5,无小数点)', () => {
    for (const model of ['claude-opus-4-8', 'claude-opus-5']) {
      expect(
        convertRequest(baseMessagesRequest({ model, ...adaptive('high') }))
          .additionalModelRequestFields,
      ).toEqual({ thinking: { type: 'adaptive' }, output_config: { effort: 'high' } });
    }
    expect(mapModel('claude-opus-5')).toBe('claude-opus-5');
  });

  it('5 + adaptive + display:omitted → thinking.display 原样透传(Claude Code 发这个)', () => {
    const req = baseMessagesRequest({
      model: 'claude-opus-5',
      thinking: { type: 'adaptive', display: 'omitted' },
      output_config: { effort: 'high' },
    });
    expect(convertRequest(req).additionalModelRequestFields).toEqual({
      thinking: { type: 'adaptive', display: 'omitted' },
      output_config: { effort: 'high' },
    });
  });

  it('sonnet-4.6 + xhigh → 降为 high(上游 schema 无 xhigh);其它等级原样', () => {
    const at = (effort: string) =>
      convertRequest(baseMessagesRequest({ model: 'claude-sonnet-4-6', ...adaptive(effort) }))
        .additionalModelRequestFields;
    expect(at('xhigh')).toEqual({
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
    });
    expect(at('max')).toEqual({ thinking: { type: 'adaptive' }, output_config: { effort: 'max' } });
  });

  it('gpt-5.6-sol + adaptive + max → {reasoning:{effort:max}};disabled → effort none', () => {
    const on = baseMessagesRequest({ model: 'gpt-5.6-sol', ...adaptive('max') });
    expect(convertRequest(on).additionalModelRequestFields).toEqual({
      reasoning: { effort: 'max' },
    });
    const off = baseMessagesRequest({ model: 'gpt-5.6-sol', thinking: { type: 'disabled' } });
    expect(convertRequest(off).additionalModelRequestFields).toEqual({
      reasoning: { effort: 'none' },
    });
  });

  it('4.7 不传 thinking → 不发顶层字段(沿用上游默认,行为不变)', () => {
    const result = convertRequest(baseMessagesRequest({ model: 'claude-opus-4-7' }));
    expect(result.additionalModelRequestFields).toBeUndefined();
    expect(uim(result).reasoning).toBeUndefined();
  });

  it('4.7 + thinking.type=disabled → {thinking:{type:disabled}}(真关,不是不发)', () => {
    const req = baseMessagesRequest({ model: 'claude-opus-4-7', thinking: { type: 'disabled' } });
    expect(convertRequest(req).additionalModelRequestFields).toEqual({
      thinking: { type: 'disabled' },
    });
  });

  it('toKiroRequest + serializeKiroRequest:字段落在 wire 顶层,与 conversationState 平级', () => {
    const req = baseMessagesRequest({ model: 'claude-opus-5', ...adaptive('low') });
    const wire = JSON.parse(serializeKiroRequest(toKiroRequest(convertRequest(req))));
    expect(Object.keys(wire).sort()).toEqual(['additionalModelRequestFields', 'conversationState']);
    expect(wire.additionalModelRequestFields).toEqual({
      thinking: { type: 'adaptive' },
      output_config: { effort: 'low' },
    });
    // 非原生模型 / 未提 thinking:顶层不多出一个 undefined 键
    const plain = JSON.parse(
      serializeKiroRequest(
        toKiroRequest(convertRequest(baseMessagesRequest({ model: 'claude-opus-4-6' }))),
      ),
    );
    expect(Object.keys(plain)).toEqual(['conversationState']);
  });

  it('4.6 + thinking → 不注入任何前缀、不发顶层字段(旧模型用上游默认)', () => {
    const req = baseMessagesRequest({
      model: 'claude-opus-4-6',
      ...adaptive('max'),
      messages: [{ role: 'user', content: 'compute 1+1' }],
    });
    const result = convertRequest(req);
    expect(result.conversationState.history).toHaveLength(0);
    expect(result.conversationState.currentMessage.userInputMessage.content).toBe('compute 1+1');
    expect(result.additionalModelRequestFields).toBeUndefined();
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

    expect(collectThinkingDeltas(events)).toEqual(['Let me think.']);
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
    expect(collectThinkingDeltas(all)).toEqual([' Hmm.', ' Continuing.', ' Done.']);
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
    expect(collectThinkingDeltas(events)).toEqual([' final fragment.']);
    expect(signatureDeltas(events)).toEqual([sig]);
  });

  it('signature-only payload 也算可用 reasoning 并开启 thinking block', () => {
    const ctx = makeContext(true);
    const events = ctx.processKiroEvent({
      kind: 'ReasoningContent',
      text: '',
      signature: 'signature-only',
    });

    expect(blockStarts(events).map((block) => block.type)).toEqual(['thinking']);
    expect(collectThinkingDeltas(events)).toEqual([]);
    expect(signatureDeltas(events)).toEqual(['signature-only']);
    expect(ctx.thinkingExtracted).toBe(true);
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

    expect(collectThinkingDeltas(all)).toEqual([' Step 1.', ' Step 2.', ' Done.']);
    expect(signatureDeltas(all)).toEqual(['final-sig-value']);

    expect(textDeltas(all)).toBe('The answer is 42.');

    // block 顺序：thinking 然后 text（thinkingEnabled=true 时初始不开 text block）
    const starts = blockStarts(all);
    expect(starts.map((s) => s.type)).toEqual(['thinking', 'text']);
  });
});

describe('空/redacted native 帧只能作废尚未落定的 legacy 分类', () => {
  // 锁 native 模式是静态判定的运行时兜底（见上面的「redacted reasoning 会锁定
  // native 模式」），但空帧不能越过两条边界，否则代价比它防的问题更大。
  it('不打断已经开着的 legacy thinking 块', () => {
    const ctx = makeContext(true);
    const all: SseEvent[] = [];
    all.push(
      ...ctx.processKiroEvent({ kind: 'AssistantResponse', content: '<thinking>part one ' }),
    );
    all.push(...ctx.processKiroEvent(decodeFrame(buildRedactedReasoningFrame())));
    all.push(
      ...ctx.processKiroEvent({
        kind: 'AssistantResponse',
        content: 'part two</thinking>\n\nanswer',
      }),
    );

    // 强行关块会把 'part two' 连同字面 `</thinking>` 推进可见文本通道。
    expect(collectThinkingDeltas(all).join('')).toBe('part one part two');
    expect(textDeltas(all)).toBe('answer');
  });

  it('不 flush 救援检测器，跨帧的泄漏工具调用候选仍能救回', async () => {
    const tools: Tool[] = [
      {
        name: 'Read',
        description: 'read a file',
        input_schema: {
          type: 'object',
          properties: { file_path: { type: 'string' } },
          required: ['file_path'],
        },
      },
    ];
    const ctx = new StreamContext(
      'test-model',
      1,
      false,
      new Map(),
      new HookBus(),
      buildToolTextRegistry(tools),
    );
    const all: SseEvent[] = [];
    all.push(
      ...ctx.processKiroEvent({
        kind: 'AssistantResponse',
        content: '<invoke name="Read">\n<parameter name="file_path">/tmp/x',
      }),
    );
    all.push(...ctx.processKiroEvent(decodeFrame(buildRedactedReasoningFrame())));
    all.push(
      ...ctx.processKiroEvent({
        kind: 'AssistantResponse',
        content: '.txt</parameter>\n</invoke>',
      }),
    );
    all.push(...(await ctx.generateFinalEvents()));

    const toolBlocks = blockStarts(all).filter((b) => b.type === 'tool_use');
    expect(toolBlocks).toHaveLength(1);
    expect(textDeltas(all)).toBe('');
  });
});
