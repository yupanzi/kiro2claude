import { describe, expect, it } from 'vitest';
import type { ReducedAttempt } from '../../../src/claude/non-stream-reduce.js';
import {
  buildResponsesObject,
  buildResponsesUsage,
} from '../../../src/openai/responses/response-nonstream.js';

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

  it('extensions → usage.kiro_* 内嵌;input_tokens 保持原始值(守 #16,不套 override)', () => {
    const ext = new Map<string, unknown>([['kiro_derived', { totalCostUsd: 0.3 }]]);
    const r = buildResponsesObject({
      reduced: reduced({ textContent: 'pong' }),
      model: 'gpt-5.6-sol',
      inputTokens: 50,
      outputTokens: 2,
      createdAt: 1,
      extensions: ext,
    });
    expect(r.usage).toEqual({
      input_tokens: 50,
      output_tokens: 2,
      total_tokens: 52,
      kiro_derived: { totalCostUsd: 0.3 },
    });
  });
});

describe('buildResponsesUsage', () => {
  it('extensions 内嵌,标准三字段不变', () => {
    const ext = new Map<string, unknown>([['kiro_metering', { unit: 'credit', usage: 7 }]]);
    expect(buildResponsesUsage(20, 4, ext)).toEqual({
      input_tokens: 20,
      output_tokens: 4,
      total_tokens: 24,
      kiro_metering: { unit: 'credit', usage: 7 },
    });
  });

  it('extensions=undefined → 只标准三字段(镜像端点剥离态)', () => {
    expect(buildResponsesUsage(20, 4, undefined)).toEqual({
      input_tokens: 20,
      output_tokens: 4,
      total_tokens: 24,
    });
  });
});

describe('buildResponsesObject: freeform(custom)工具', () => {
  it('customToolNames 命中 → custom_tool_call item(input 取回裸文本)', () => {
    const r = buildResponsesObject({
      reduced: reduced({
        toolUses: [
          { type: 'tool_use', id: 'tooluse_1', name: 'exec', input: { input: 'text("hi")' } },
          { type: 'tool_use', id: 'tooluse_2', name: 'wait', input: { cell_id: 'c1' } },
        ],
        hasToolUse: true,
      }),
      model: 'gpt-5.6-sol',
      inputTokens: 1,
      outputTokens: 1,
      createdAt: 0,
      customToolNames: new Set(['exec']),
    });
    // 同一响应里两种形态并存:custom 走 input 裸文本,其余仍是 function_call + arguments
    expect(r.output).toEqual([
      expect.objectContaining({
        type: 'custom_tool_call',
        call_id: 'tooluse_1',
        name: 'exec',
        input: 'text("hi")',
        status: 'completed',
      }),
      expect.objectContaining({
        type: 'function_call',
        call_id: 'tooluse_2',
        name: 'wait',
        arguments: '{"cell_id":"c1"}',
      }),
    ]);
  });

  it('替身字段缺失/非字符串 → input 空串(不塞 JSON 串)', () => {
    const r = buildResponsesObject({
      reduced: reduced({
        toolUses: [{ type: 'tool_use', id: 'c', name: 'exec', input: { input: { oops: 1 } } }],
        hasToolUse: true,
      }),
      model: 'gpt-5.6-sol',
      inputTokens: 1,
      outputTokens: 1,
      createdAt: 0,
      customToolNames: new Set(['exec']),
    });
    expect(r.output[0]).toMatchObject({ type: 'custom_tool_call', input: '' });
  });

  it('不传 customToolNames → 全部 function_call(标准形态不变)', () => {
    const r = buildResponsesObject({
      reduced: reduced({
        toolUses: [{ type: 'tool_use', id: 'c', name: 'exec', input: { input: 'x' } }],
        hasToolUse: true,
      }),
      model: 'gpt-5.6-sol',
      inputTokens: 1,
      outputTokens: 1,
      createdAt: 0,
    });
    expect(r.output[0]).toMatchObject({ type: 'function_call', arguments: '{"input":"x"}' });
  });
});
