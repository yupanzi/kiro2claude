import { describe, expect, it } from 'vitest';
import type { ReducedAttempt } from '../../src/claude/non-stream-reduce.js';
import { buildChatCompletion, buildOpenAiUsage } from '../../src/openai/response-nonstream.js';

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

describe('buildOpenAiUsage', () => {
  it('三字段 + total', () => {
    expect(buildOpenAiUsage(10, 3)).toEqual({
      prompt_tokens: 10,
      completion_tokens: 3,
      total_tokens: 13,
    });
  });

  it('extensions 内嵌进 usage,标准三字段不变', () => {
    const ext = new Map<string, unknown>([['kiro_metering', { unit: 'credit', usage: 5 }]]);
    expect(buildOpenAiUsage(10, 3, ext)).toEqual({
      prompt_tokens: 10,
      completion_tokens: 3,
      total_tokens: 13,
      kiro_metering: { unit: 'credit', usage: 5 },
    });
  });

  it('extensions=undefined → 只标准三字段(镜像端点剥离态)', () => {
    expect(buildOpenAiUsage(10, 3, undefined)).toEqual({
      prompt_tokens: 10,
      completion_tokens: 3,
      total_tokens: 13,
    });
  });
});

describe('buildChatCompletion', () => {
  it('纯文本 → content;finish_reason=stop', () => {
    const c = buildChatCompletion({
      reduced: reduced({ textContent: 'pong' }),
      model: 'gpt-5.6-sol',
      promptTokens: 5,
      completionTokens: 1,
    });
    expect(c.object).toBe('chat.completion');
    expect(c.model).toBe('gpt-5.6-sol');
    expect(c.choices[0].message).toEqual({ role: 'assistant', content: 'pong' });
    expect(c.choices[0].finish_reason).toBe('stop');
    expect(c.usage).toEqual({ prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 });
    expect(c.id.startsWith('chatcmpl-')).toBe(true);
  });

  it('仅 tool_use → content:null + tool_calls;finish_reason=tool_calls', () => {
    const c = buildChatCompletion({
      reduced: reduced({
        stopReason: 'tool_use',
        toolUses: [
          { type: 'tool_use', id: 'call_0', name: 'get_weather', input: { city: 'Tokyo' } },
        ],
      }),
      model: 'm',
      promptTokens: 1,
      completionTokens: 1,
    });
    expect(c.choices[0].message.content).toBeNull();
    expect(c.choices[0].message.tool_calls).toEqual([
      {
        id: 'call_0',
        type: 'function',
        function: { name: 'get_weather', arguments: '{"city":"Tokyo"}' },
      },
    ]);
    expect(c.choices[0].finish_reason).toBe('tool_calls');
  });

  it('reasoningText → reasoning_content(Claude 明文)', () => {
    const c = buildChatCompletion({
      reduced: reduced({ textContent: 'answer', reasoningText: 'let me think' }),
      model: 'm',
      promptTokens: 1,
      completionTokens: 1,
    });
    expect(c.choices[0].message.reasoning_content).toBe('let me think');
  });

  it('无 reasoning → 不含 reasoning_content 字段(GPT redacted 情形)', () => {
    const c = buildChatCompletion({
      reduced: reduced({ textContent: 'pong' }),
      model: 'gpt-5.6-sol',
      promptTokens: 1,
      completionTokens: 1,
    });
    expect('reasoning_content' in c.choices[0].message).toBe(false);
  });

  it('max_tokens → finish_reason=length', () => {
    const c = buildChatCompletion({
      reduced: reduced({ textContent: 'x', stopReason: 'max_tokens' }),
      model: 'm',
      promptTokens: 1,
      completionTokens: 1,
    });
    expect(c.choices[0].finish_reason).toBe('length');
  });

  it('extensions → usage.kiro_* 内嵌;prompt_tokens 保持原始值(守 #16,不套 override)', () => {
    const ext = new Map<string, unknown>([
      ['kiro_metering', { unit: 'credit', usage: 5 }],
      ['kiro_derived', { totalCostUsd: 0.2 }],
    ]);
    const c = buildChatCompletion({
      reduced: reduced({ textContent: 'pong' }),
      model: 'gpt-5.6-sol',
      promptTokens: 100,
      completionTokens: 10,
      extensions: ext,
    });
    expect(c.usage).toEqual({
      prompt_tokens: 100,
      completion_tokens: 10,
      total_tokens: 110,
      kiro_metering: { unit: 'credit', usage: 5 },
      kiro_derived: { totalCostUsd: 0.2 },
    });
  });
});
