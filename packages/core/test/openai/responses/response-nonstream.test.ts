import { describe, expect, it } from 'vitest';
import type { ReducedAttempt } from '../../../src/claude/non-stream-reduce.js';
import { buildResponsesObject } from '../../../src/openai/responses/response-nonstream.js';

function reduced(overrides: Partial<ReducedAttempt> = {}): ReducedAttempt {
  return {
    reasoningText: '',
    reasoningSignature: undefined,
    thinkingText: undefined,
    textContent: '',
    toolUses: [],
    hasToolUse: false,
    stopReason: 'end_turn',
    contextInputTokens: undefined,
    kiroMetering: undefined,
    upstreamError: undefined,
    silentFailure: false,
    eventCounts: new Map(),
    announcedToolNames: new Set(),
    unknownEventTypes: new Set(),
    ...overrides,
  };
}

describe('buildResponsesObject', () => {
  it('文本 → message output item + usage', () => {
    const r = buildResponsesObject({
      reduced: reduced({ textContent: 'pong' }),
      model: 'gpt-5.6-sol',
      inputTokens: 10,
      outputTokens: 1,
      createdAt: 123,
    });
    expect(r.object).toBe('response');
    expect(r.status).toBe('completed');
    expect(r.model).toBe('gpt-5.6-sol');
    expect(r.created_at).toBe(123);
    expect(r.output[0]).toMatchObject({
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'pong', annotations: [] }],
    });
    expect(r.usage).toEqual({ input_tokens: 10, output_tokens: 1, total_tokens: 11 });
    expect(r.id.startsWith('resp_')).toBe(true);
  });

  it('tool_use → function_call output item(arguments 字符串化)', () => {
    const r = buildResponsesObject({
      reduced: reduced({
        stopReason: 'tool_use',
        toolUses: [
          { type: 'tool_use', id: 'call_0', name: 'get_weather', input: { city: 'Tokyo' } },
        ],
      }),
      model: 'm',
      inputTokens: 1,
      outputTokens: 1,
      createdAt: 1,
    });
    expect(r.output).toEqual([
      {
        id: expect.stringMatching(/^fc_/),
        type: 'function_call',
        call_id: 'call_0',
        name: 'get_weather',
        arguments: '{"city":"Tokyo"}',
        status: 'completed',
      },
    ]);
  });

  it('文本 + 工具都有 → output 两个 item', () => {
    const r = buildResponsesObject({
      reduced: reduced({
        textContent: 'let me check',
        toolUses: [{ type: 'tool_use', id: 'c', name: 'f', input: {} }],
      }),
      model: 'm',
      inputTokens: 1,
      outputTokens: 1,
      createdAt: 1,
    });
    expect(r.output.map((o) => o.type)).toEqual(['message', 'function_call']);
  });

  it('reasoningText → reasoning output item(在 message 前)', () => {
    const r = buildResponsesObject({
      reduced: reduced({ reasoningText: 'my chain', textContent: 'answer' }),
      model: 'claude-opus-4-6',
      inputTokens: 5,
      outputTokens: 2,
      createdAt: 1,
    });
    expect(r.output.map((o) => o.type)).toEqual(['reasoning', 'message']);
    expect(r.output[0]).toMatchObject({
      id: expect.stringMatching(/^rs_/),
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: 'my chain' }],
    });
  });

  it('thinkingText(legacy 标签)也 surface 成 reasoning item', () => {
    const r = buildResponsesObject({
      reduced: reduced({ thinkingText: 'legacy think', textContent: 'a' }),
      model: 'm',
      inputTokens: 1,
      outputTokens: 1,
      createdAt: 1,
    });
    expect(r.output[0]).toMatchObject({
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: 'legacy think' }],
    });
  });

  it('无 reasoning → 不产 reasoning item(GPT/Codex 不变)', () => {
    const r = buildResponsesObject({
      reduced: reduced({ textContent: 'pong' }),
      model: 'gpt-5.6-sol',
      inputTokens: 1,
      outputTokens: 1,
      createdAt: 1,
    });
    expect(r.output.map((o) => o.type)).toEqual(['message']);
  });
});
