import type { UsageFinishEvent } from '@kiro2claude/plugin-api';
import { describe, expect, it } from 'vitest';
import {
  __testing__,
  createSseEvent,
  type SseEvent,
  SseStateManager,
  StreamContext,
  sseEventToString,
} from '../../src/claude/stream.js';
import type { Event } from '../../src/kiro/model/events/base.js';
import { HookBus, UsageFinishEventImpl } from '../../src/plugin-host/index.js';
import { getLogger } from '../../src/shared/logger.js';

const { findRealThinkingStartTag, findRealThinkingEndTag, estimateTokens } = __testing__;

function makeContext(
  thinkingEnabled: boolean,
  toolNameMap = new Map<string, string>(),
  hookBus: HookBus = new HookBus(),
): StreamContext {
  return new StreamContext('test-model', 1, thinkingEnabled, toolNameMap, hookBus);
}

function makeHookEvent(meta: Record<string, unknown> = {}): UsageFinishEventImpl {
  return new UsageFinishEventImpl({
    model: 'test-model',
    source: 'http-direct',
    inputTokensSource: 'client-estimate',
    meta,
    logger: getLogger(),
  });
}

function makeToolUse(
  name: string,
  id: string,
  input = '{}',
  isComplete = false,
): Extract<Event, { kind: 'ToolUse' }> {
  return { kind: 'ToolUse', name, toolUseId: id, input, isComplete };
}

function collectThinkingContent(events: SseEvent[]): string {
  return events
    .filter(
      (e) => e.event === 'content_block_delta' && (e.data.delta as any)?.type === 'thinking_delta',
    )
    .map((e) => ((e.data.delta as any)?.thinking as string) ?? '')
    .filter((s) => s.length > 0)
    .join('');
}

function collectTextContent(events: SseEvent[]): string {
  return events
    .filter(
      (e) => e.event === 'content_block_delta' && (e.data.delta as any)?.type === 'text_delta',
    )
    .map((e) => ((e.data.delta as any)?.text as string) ?? '')
    .join('');
}

describe('SSE event format', () => {
  it('test_sse_event_format', () => {
    const event = createSseEvent('message_start', { type: 'message_start' });
    const sseStr = sseEventToString(event);
    expect(sseStr.startsWith('event: message_start\n')).toBe(true);
    expect(sseStr.includes('data: ')).toBe(true);
    expect(sseStr.endsWith('\n\n')).toBe(true);
  });
});

describe('SseStateManager', () => {
  it('test_sse_state_manager_message_start', () => {
    const manager = new SseStateManager();
    const event1 = manager.handleMessageStart({ type: 'message_start' });
    expect(event1).toBeDefined();

    const event2 = manager.handleMessageStart({ type: 'message_start' });
    expect(event2).toBeUndefined();
  });

  it('test_sse_state_manager_block_lifecycle', () => {
    const manager = new SseStateManager();

    const events = manager.handleContentBlockStart(0, 'text', {});
    expect(events.length).toBe(1);

    const delta = manager.handleContentBlockDelta(0, {});
    expect(delta).toBeDefined();

    const stop1 = manager.handleContentBlockStop(0);
    expect(stop1).toBeDefined();

    const stop2 = manager.handleContentBlockStop(0);
    expect(stop2).toBeUndefined();
  });
});

describe('Tool name reverse mapping', () => {
  it('test_tool_name_reverse_mapping_in_stream', () => {
    const map = new Map<string, string>();
    map.set('short_abc12345', 'mcp__very_long_original_tool_name');

    const ctx = makeContext(false, map);
    ctx.generateInitialEvents();

    const toolEvent: Extract<Event, { kind: 'ToolUse' }> = {
      kind: 'ToolUse',
      name: 'short_abc12345',
      toolUseId: 'toolu_01',
      input: '{"key":"value"}',
      isComplete: true,
    };

    const events = ctx.processKiroEvent(toolEvent);
    const startEvent = events.find((e) => e.event === 'content_block_start');
    expect(startEvent).toBeDefined();
    expect((startEvent!.data.content_block as any).name).toBe('mcp__very_long_original_tool_name');
  });
});

describe('text_delta after tool_use', () => {
  it('test_text_delta_after_tool_use_restarts_text_block', () => {
    const ctx = makeContext(false);
    const initialEvents = ctx.generateInitialEvents();
    expect(
      initialEvents.some(
        (e) => e.event === 'content_block_start' && (e.data.content_block as any)?.type === 'text',
      ),
    ).toBe(true);

    const initialTextIndex = ctx.textBlockIndex!;
    expect(initialTextIndex).toBeDefined();

    const toolEvents = ctx.processToolUse(makeToolUse('test_tool', 'tool_1'));
    expect(
      toolEvents.some((e) => e.event === 'content_block_stop' && e.data.index === initialTextIndex),
    ).toBe(true);

    const textEvents = ctx.processKiroEvent({ kind: 'AssistantResponse', content: 'hello' });
    const newStart = textEvents.find(
      (e) => e.event === 'content_block_start' && (e.data.content_block as any)?.type === 'text',
    );
    expect(newStart).toBeDefined();
    expect(newStart!.data.index).not.toBe(initialTextIndex);

    expect(
      textEvents.some(
        (e) =>
          e.event === 'content_block_delta' &&
          (e.data.delta as any)?.type === 'text_delta' &&
          (e.data.delta as any)?.text === 'hello',
      ),
    ).toBe(true);
  });
});

describe('Tool use flushes pending thinking buffer', () => {
  it('test_tool_use_flushes_pending_thinking_buffer_text_before_tool_block', () => {
    const ctx = makeContext(true);
    ctx.generateInitialEvents();

    // Two short text chunks under thinking mode -> buffered
    const ev1 = ctx.processKiroEvent({ kind: 'AssistantResponse', content: '有修' });
    expect(ev1.every((e) => e.event !== 'content_block_delta')).toBe(true);
    const ev2 = ctx.processKiroEvent({ kind: 'AssistantResponse', content: '改：' });
    expect(ev2.every((e) => e.event !== 'content_block_delta')).toBe(true);

    const events = ctx.processToolUse(makeToolUse('Write', 'tool_1'));

    let textStartIndex: number | undefined;
    let posTextDelta = -1;
    let posTextStop = -1;
    let posToolStart = -1;
    events.forEach((e, i) => {
      if (e.event === 'content_block_start' && (e.data.content_block as any)?.type === 'text') {
        textStartIndex = e.data.index as number;
      }
      if (e.event === 'content_block_delta' && (e.data.delta as any)?.type === 'text_delta') {
        posTextDelta = i;
      }
      if (
        e.event === 'content_block_stop' &&
        textStartIndex !== undefined &&
        e.data.index === textStartIndex
      ) {
        posTextStop = i;
      }
      if (e.event === 'content_block_start' && (e.data.content_block as any)?.type === 'tool_use') {
        posToolStart = i;
      }
    });

    expect(textStartIndex).toBeDefined();
    expect(posTextDelta).toBeGreaterThanOrEqual(0);
    expect(posTextStop).toBeGreaterThanOrEqual(0);
    expect(posToolStart).toBeGreaterThanOrEqual(0);
    expect(posTextDelta).toBeLessThan(posTextStop);
    expect(posTextStop).toBeLessThan(posToolStart);

    expect(
      events.some(
        (e) =>
          e.event === 'content_block_delta' &&
          (e.data.delta as any)?.type === 'text_delta' &&
          (e.data.delta as any)?.text === '有修改：',
      ),
    ).toBe(true);
  });
});

describe('estimateTokens', () => {
  it('test_estimate_tokens', () => {
    expect(estimateTokens('Hello')).toBeGreaterThan(0);
    expect(estimateTokens('你好')).toBeGreaterThan(0);
    expect(estimateTokens('Hello 你好')).toBeGreaterThan(0);
  });
});

describe('findRealThinkingStartTag', () => {
  it('test_find_real_thinking_start_tag_basic', () => {
    expect(findRealThinkingStartTag('<thinking>')).toBe(0);
    expect(findRealThinkingStartTag('prefix<thinking>')).toBe(6);
  });

  it('test_find_real_thinking_start_tag_with_backticks', () => {
    expect(findRealThinkingStartTag('`<thinking>`')).toBeUndefined();
    expect(findRealThinkingStartTag('use `<thinking>` tag')).toBeUndefined();
    expect(findRealThinkingStartTag('about `<thinking>` tag<thinking>content')).toBe(22);
  });

  it('test_find_real_thinking_start_tag_with_quotes', () => {
    expect(findRealThinkingStartTag('"<thinking>"')).toBeUndefined();
    expect(findRealThinkingStartTag('the "<thinking>" tag')).toBeUndefined();
    expect(findRealThinkingStartTag("'<thinking>'")).toBeUndefined();
    expect(findRealThinkingStartTag('about "<thinking>" and \'<thinking>\' then<thinking>')).toBe(
      40,
    );
  });
});

describe('findRealThinkingEndTag', () => {
  it('test_find_real_thinking_end_tag_basic', () => {
    expect(findRealThinkingEndTag('</thinking>\n\n')).toBe(0);
    expect(findRealThinkingEndTag('content</thinking>\n\n')).toBe(7);
    expect(findRealThinkingEndTag('some text</thinking>\n\nmore text')).toBe(9);
    expect(findRealThinkingEndTag('</thinking>')).toBeUndefined();
    expect(findRealThinkingEndTag('</thinking>\n')).toBeUndefined();
    expect(findRealThinkingEndTag('</thinking> more')).toBeUndefined();
  });

  it('test_find_real_thinking_end_tag_with_backticks', () => {
    expect(findRealThinkingEndTag('`</thinking>`\n\n')).toBeUndefined();
    expect(findRealThinkingEndTag('mention `</thinking>` in code\n\n')).toBeUndefined();
    expect(findRealThinkingEndTag('`</thinking>\n\n')).toBeUndefined();
    expect(findRealThinkingEndTag('</thinking>`\n\n')).toBeUndefined();
  });

  it('test_find_real_thinking_end_tag_with_quotes', () => {
    expect(findRealThinkingEndTag('"</thinking>"\n\n')).toBeUndefined();
    expect(findRealThinkingEndTag('the string "</thinking>" is a tag\n\n')).toBeUndefined();
    expect(findRealThinkingEndTag("'</thinking>'\n\n")).toBeUndefined();
    expect(findRealThinkingEndTag("use '</thinking>' as marker\n\n")).toBeUndefined();
    expect(findRealThinkingEndTag('about "</thinking>" tag</thinking>\n\n')).toBe(23);
    expect(findRealThinkingEndTag("about '</thinking>' tag</thinking>\n\n")).toBe(23);
  });

  it('test_find_real_thinking_end_tag_mixed', () => {
    expect(findRealThinkingEndTag('discussing `</thinking>` tag</thinking>\n\n')).toBe(28);
    expect(findRealThinkingEndTag('`</thinking>` and `</thinking>` done</thinking>\n\n')).toBe(36);
    expect(
      findRealThinkingEndTag(
        '`</thinking>` and "</thinking>" and \'</thinking>\' done</thinking>\n\n',
      ),
    ).toBe(54);
  });
});

describe('Tool use after thinking', () => {
  it('test_tool_use_immediately_after_thinking_filters_end_tag_and_closes_thinking_block', async () => {
    const ctx = makeContext(true);
    ctx.generateInitialEvents();

    const all: SseEvent[] = [];
    all.push(
      ...ctx.processKiroEvent({ kind: 'AssistantResponse', content: '<thinking>abc</thinking>' }),
    );
    const toolEvents = ctx.processToolUse(makeToolUse('Write', 'tool_1'));
    all.push(...toolEvents);
    all.push(...(await ctx.generateFinalEvents()));

    // </thinking> should not be emitted as thinking_delta
    expect(
      all.every(
        (e) =>
          !(
            e.event === 'content_block_delta' &&
            (e.data.delta as any)?.type === 'thinking_delta' &&
            (e.data.delta as any)?.thinking === '</thinking>'
          ),
      ),
    ).toBe(true);

    const thinkingIndex = ctx.thinkingBlockIndex!;
    expect(thinkingIndex).toBeDefined();

    const posThinkingStop = all.findIndex(
      (e) => e.event === 'content_block_stop' && e.data.index === thinkingIndex,
    );
    const posToolStart = all.findIndex(
      (e) =>
        e.event === 'content_block_start' && (e.data.content_block as any)?.type === 'tool_use',
    );

    expect(posThinkingStop).toBeGreaterThanOrEqual(0);
    expect(posToolStart).toBeGreaterThanOrEqual(0);
    expect(posThinkingStop).toBeLessThan(posToolStart);
  });

  it('test_final_flush_filters_standalone_thinking_end_tag', async () => {
    const ctx = makeContext(true);
    ctx.generateInitialEvents();

    const all: SseEvent[] = [];
    all.push(
      ...ctx.processKiroEvent({ kind: 'AssistantResponse', content: '<thinking>abc</thinking>' }),
    );
    all.push(...(await ctx.generateFinalEvents()));

    expect(
      all.every(
        (e) =>
          !(
            e.event === 'content_block_delta' &&
            (e.data.delta as any)?.type === 'thinking_delta' &&
            (e.data.delta as any)?.thinking === '</thinking>'
          ),
      ),
    ).toBe(true);
  });
});

describe('Thinking newline stripping', () => {
  it('test_thinking_strips_leading_newline_same_chunk', () => {
    const ctx = makeContext(true);
    ctx.generateInitialEvents();
    const events = ctx.processKiroEvent({
      kind: 'AssistantResponse',
      content: '<thinking>\nHello world',
    });
    const fullThinking = collectThinkingContent(events);
    expect(fullThinking.startsWith('\n')).toBe(false);
  });

  it('test_thinking_strips_leading_newline_cross_chunk', () => {
    const ctx = makeContext(true);
    ctx.generateInitialEvents();
    const events1 = ctx.processKiroEvent({ kind: 'AssistantResponse', content: '<thinking>' });
    const events2 = ctx.processKiroEvent({ kind: 'AssistantResponse', content: '\nHello world' });
    const all = [...events1, ...events2];
    const fullThinking = collectThinkingContent(all);
    expect(fullThinking.startsWith('\n')).toBe(false);
  });

  it('test_thinking_no_strip_when_no_leading_newline', () => {
    const ctx = makeContext(true);
    ctx.generateInitialEvents();
    const events = ctx.processKiroEvent({
      kind: 'AssistantResponse',
      content: '<thinking>abc</thinking>\n\ntext',
    });
    const fullThinking = collectThinkingContent(events);
    expect(fullThinking).toBe('abc');
  });

  it('test_text_after_thinking_strips_leading_newlines', () => {
    const ctx = makeContext(true);
    ctx.generateInitialEvents();
    const events = ctx.processKiroEvent({
      kind: 'AssistantResponse',
      content: '<thinking>\nabc</thinking>\n\n你好',
    });
    const fullText = collectTextContent(events);
    expect(fullText.startsWith('\n')).toBe(false);
    expect(fullText).toBe('你好');
  });
});

describe('Thinking split across chunks', () => {
  it('test_end_tag_newlines_split_across_events', async () => {
    const ctx = makeContext(true);
    ctx.generateInitialEvents();

    const all: SseEvent[] = [];
    all.push(
      ...ctx.processKiroEvent({
        kind: 'AssistantResponse',
        content: '<thinking>\nabc</thinking>\n',
      }),
    );
    all.push(...ctx.processKiroEvent({ kind: 'AssistantResponse', content: '\n' }));
    all.push(...ctx.processKiroEvent({ kind: 'AssistantResponse', content: '你好' }));
    all.push(...(await ctx.generateFinalEvents()));

    expect(collectThinkingContent(all)).toBe('abc');
    expect(collectTextContent(all)).toBe('你好');
  });

  it('test_end_tag_alone_in_chunk_then_newlines_in_next', async () => {
    const ctx = makeContext(true);
    ctx.generateInitialEvents();

    const all: SseEvent[] = [];
    all.push(
      ...ctx.processKiroEvent({ kind: 'AssistantResponse', content: '<thinking>\nabc</thinking>' }),
    );
    all.push(...ctx.processKiroEvent({ kind: 'AssistantResponse', content: '\n\n你好' }));
    all.push(...(await ctx.generateFinalEvents()));

    expect(collectThinkingContent(all)).toBe('abc');
    expect(collectTextContent(all)).toBe('你好');
  });

  it('test_start_tag_newline_split_across_events', async () => {
    const ctx = makeContext(true);
    ctx.generateInitialEvents();

    const all: SseEvent[] = [];
    all.push(...ctx.processKiroEvent({ kind: 'AssistantResponse', content: '\n\n' }));
    all.push(...ctx.processKiroEvent({ kind: 'AssistantResponse', content: '<thinking>' }));
    all.push(...ctx.processKiroEvent({ kind: 'AssistantResponse', content: '\n' }));
    all.push(
      ...ctx.processKiroEvent({ kind: 'AssistantResponse', content: 'abc</thinking>\n\ntext' }),
    );
    all.push(...(await ctx.generateFinalEvents()));

    expect(collectThinkingContent(all)).toBe('abc');
    expect(collectTextContent(all)).toBe('text');
  });

  it('test_full_flow_maximally_split', async () => {
    const ctx = makeContext(true);
    ctx.generateInitialEvents();

    const all: SseEvent[] = [];
    const chunks = [
      '\n',
      '\n',
      '<thin',
      'king>',
      '\n',
      'hello',
      '</thi',
      'nking>',
      '\n',
      '\n',
      'world',
    ];
    for (const chunk of chunks) {
      all.push(...ctx.processKiroEvent({ kind: 'AssistantResponse', content: chunk }));
    }
    all.push(...(await ctx.generateFinalEvents()));

    expect(collectThinkingContent(all)).toBe('hello');
    expect(collectTextContent(all)).toBe('world');
  });
});

describe('metering raw event capture (HookBus integration)', () => {
  it('processKiroEvent stores Metering event on StreamContext.kiroMeteringRaw', () => {
    const ctx = makeContext(false);
    ctx.generateInitialEvents();

    const events = ctx.processKiroEvent({
      kind: 'Metering',
      unit: 'credit',
      unitPlural: 'credits',
      usage: 0.0048,
    });

    // Metering events produce no SSE output
    expect(events).toHaveLength(0);
    expect(ctx.kiroMeteringRaw).toEqual({ unit: 'credit', unitPlural: 'credits', usage: 0.0048 });
  });

  it('generateFinalEvents publishes metering credit to hook bus via kiro.creditsUsed meta', async () => {
    const hookBus = new HookBus();
    let captured: UsageFinishEvent | undefined;
    hookBus.registerUsageFinish('capture', (e) => {
      captured = e;
    });
    const ctx = makeContext(false, undefined, hookBus);
    ctx.generateInitialEvents();
    ctx.processKiroEvent({
      kind: 'Metering',
      unit: 'credit',
      unitPlural: 'credits',
      usage: 0.0048,
    });
    await ctx.generateFinalEvents();
    expect(captured).toBeDefined();
    expect(captured!.getMeta<number>('kiro.creditsUsed')).toBe(0.0048);
    expect(captured!.getMeta('kiro.upstreamRaw')).toEqual({
      unit: 'credit',
      unitPlural: 'credits',
      usage: 0.0048,
    });
  });

  it('generateFinalEvents publishes undefined creditsUsed when no Metering received', async () => {
    const hookBus = new HookBus();
    let captured: UsageFinishEvent | undefined;
    hookBus.registerUsageFinish('capture', (e) => {
      captured = e;
    });
    const ctx = makeContext(false, undefined, hookBus);
    ctx.generateInitialEvents();
    await ctx.generateFinalEvents();
    expect(captured!.getMeta('kiro.creditsUsed')).toBeUndefined();
  });

  it('plugin can addExtension to inject namespaced fields in wire payload', async () => {
    const hookBus = new HookBus();
    hookBus.registerUsageFinish('demo', (event) => {
      event.addExtension('kiro_metering', { credit: 0.005 });
    });
    const ctx = makeContext(false, undefined, hookBus);
    ctx.generateInitialEvents();
    const finals = await ctx.generateFinalEvents();
    const messageDelta = finals.find((e) => e.event === 'message_delta');
    expect((messageDelta!.data.usage as any).kiro_metering).toEqual({ credit: 0.005 });
  });

  it('plugin can overrideStandardField to mutate standard Anthropic fields', async () => {
    const hookBus = new HookBus();
    hookBus.registerUsageFinish('demo', (event) => {
      event.overrideStandardField('input_tokens', 9999, 'test');
      event.overrideStandardField('cache_read_input_tokens', 1234, 'test');
    });
    const ctx = makeContext(false, undefined, hookBus);
    ctx.generateInitialEvents();
    const finals = await ctx.generateFinalEvents();
    const usage = finals.find((e) => e.event === 'message_delta')!.data.usage as any;
    expect(usage.input_tokens).toBe(9999);
    expect(usage.cache_read_input_tokens).toBe(1234);
  });

  it('last Metering event wins when multiple are received', async () => {
    const hookBus = new HookBus();
    let credits: number | undefined;
    hookBus.registerUsageFinish('capture', (e) => {
      credits = e.getMeta<number>('kiro.creditsUsed');
    });
    const ctx = makeContext(false, undefined, hookBus);
    ctx.generateInitialEvents();
    ctx.processKiroEvent({ kind: 'Metering', unit: 'credit', unitPlural: 'credits', usage: 0.001 });
    ctx.processKiroEvent({ kind: 'Metering', unit: 'credit', unitPlural: 'credits', usage: 0.005 });
    await ctx.generateFinalEvents();
    expect(credits).toBe(0.005);
  });
});

describe('SseStateManager.generateFinalEvents (hook bus shape)', () => {
  it('emits standard Anthropic usage when no plugin patches', () => {
    const manager = new SseStateManager();
    manager.handleMessageStart({ type: 'message_start' });

    const hookEvent = makeHookEvent();
    const events = manager.generateFinalEvents(100, 50, hookEvent);
    const messageDelta = events.find((e) => e.event === 'message_delta');
    expect(messageDelta).toBeDefined();
    const usage = messageDelta!.data.usage as any;
    expect(usage.input_tokens).toBe(100);
    expect(usage.output_tokens).toBe(50);
    expect(usage.cache_creation_input_tokens).toBe(0);
    expect(usage.cache_read_input_tokens).toBe(0);
    expect('kiro_metering' in usage).toBe(false);
    expect('kiro_derived' in usage).toBe(false);
  });

  it('merges plugin extensions over standard Anthropic shape', () => {
    const manager = new SseStateManager();
    manager.handleMessageStart({ type: 'message_start' });

    const hookEvent = makeHookEvent();
    hookEvent._setActivePlugin('test');
    hookEvent.addExtension('kiro_metering', { unit: 'token', unitPlural: 'tokens', usage: 1.5 });
    const events = manager.generateFinalEvents(100, 50, hookEvent);
    const usage = events.find((e) => e.event === 'message_delta')!.data.usage as any;
    expect(usage.input_tokens).toBe(100);
    expect(usage.output_tokens).toBe(50);
    expect(usage.kiro_metering).toEqual({ unit: 'token', unitPlural: 'tokens', usage: 1.5 });
  });

  it('applies plugin overrideStandardField over original counts', () => {
    const manager = new SseStateManager();
    manager.handleMessageStart({ type: 'message_start' });

    const hookEvent = makeHookEvent();
    hookEvent._setActivePlugin('test');
    hookEvent.overrideStandardField('input_tokens', 4242, 'test override');
    const events = manager.generateFinalEvents(100, 50, hookEvent);
    const usage = events.find((e) => e.event === 'message_delta')!.data.usage as any;
    expect(usage.input_tokens).toBe(4242);
    expect(usage.output_tokens).toBe(50);
  });
});

describe('Stop reasons', () => {
  it('test_thinking_only_sets_max_tokens_stop_reason', async () => {
    const ctx = makeContext(true);
    ctx.generateInitialEvents();

    const all: SseEvent[] = [];
    all.push(
      ...ctx.processKiroEvent({ kind: 'AssistantResponse', content: '<thinking>\nabc</thinking>' }),
    );
    all.push(...(await ctx.generateFinalEvents()));

    const messageDelta = all.find((e) => e.event === 'message_delta');
    expect(messageDelta).toBeDefined();
    expect((messageDelta!.data.delta as any).stop_reason).toBe('max_tokens');

    expect(
      all.some(
        (e) => e.event === 'content_block_start' && (e.data.content_block as any)?.type === 'text',
      ),
    ).toBe(true);
    expect(
      all.some(
        (e) =>
          e.event === 'content_block_delta' &&
          (e.data.delta as any)?.type === 'text_delta' &&
          (e.data.delta as any)?.text === ' ',
      ),
    ).toBe(true);

    const textBlockIndex = all.find(
      (e) => e.event === 'content_block_start' && (e.data.content_block as any)?.type === 'text',
    )!.data.index;
    expect(
      all.some((e) => e.event === 'content_block_stop' && e.data.index === textBlockIndex),
    ).toBe(true);
  });

  it('test_thinking_with_text_keeps_end_turn_stop_reason', async () => {
    const ctx = makeContext(true);
    ctx.generateInitialEvents();

    const all: SseEvent[] = [];
    all.push(
      ...ctx.processKiroEvent({
        kind: 'AssistantResponse',
        content: '<thinking>\nabc</thinking>\n\nHello',
      }),
    );
    all.push(...(await ctx.generateFinalEvents()));

    const messageDelta = all.find((e) => e.event === 'message_delta');
    expect(messageDelta).toBeDefined();
    expect((messageDelta!.data.delta as any).stop_reason).toBe('end_turn');
  });

  it('test_thinking_with_tool_use_keeps_tool_use_stop_reason', async () => {
    const ctx = makeContext(true);
    ctx.generateInitialEvents();

    const all: SseEvent[] = [];
    all.push(
      ...ctx.processKiroEvent({ kind: 'AssistantResponse', content: '<thinking>\nabc</thinking>' }),
    );
    all.push(...ctx.processToolUse(makeToolUse('test_tool', 'tool_1', '{}', true)));
    all.push(...(await ctx.generateFinalEvents()));

    const messageDelta = all.find((e) => e.event === 'message_delta');
    expect(messageDelta).toBeDefined();
    expect((messageDelta!.data.delta as any).stop_reason).toBe('tool_use');
  });
});
