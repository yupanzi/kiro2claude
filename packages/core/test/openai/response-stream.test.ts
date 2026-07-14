import { describe, expect, it } from 'vitest';
import type { SseEvent } from '../../src/claude/stream.js';
import { mapFinishReason, OpenAiChunkEncoder } from '../../src/openai/response-stream.js';
import type { ChatCompletionChunk } from '../../src/openai/types.js';

/** 解析一条 `data: {...}\n\n` 行为 chunk 对象。 */
function parse(line: string): ChatCompletionChunk {
  expect(line.startsWith('data: ')).toBe(true);
  expect(line.endsWith('\n\n')).toBe(true);
  return JSON.parse(line.slice('data: '.length).trim());
}

function ev(event: string, data: Record<string, unknown>): SseEvent {
  return { event, data };
}

describe('mapFinishReason', () => {
  it('映射四态', () => {
    expect(mapFinishReason('end_turn')).toBe('stop');
    expect(mapFinishReason('tool_use')).toBe('tool_calls');
    expect(mapFinishReason('max_tokens')).toBe('length');
    expect(mapFinishReason('model_context_window_exceeded')).toBe('length');
    expect(mapFinishReason(undefined)).toBe('stop');
  });
});

describe('OpenAiChunkEncoder', () => {
  it('message_start → role chunk(仅一次)', () => {
    const enc = new OpenAiChunkEncoder('gpt-5.6-sol');
    const lines = enc.push(ev('message_start', { type: 'message_start', message: {} }));
    expect(lines).toHaveLength(1);
    const c = parse(lines[0]);
    expect(c.object).toBe('chat.completion.chunk');
    expect(c.model).toBe('gpt-5.6-sol');
    expect(c.choices[0].delta).toEqual({ role: 'assistant', content: '' });
    // 再次 message_start 不重复发 role
    expect(enc.push(ev('message_start', {}))).toHaveLength(0);
  });

  it('text_delta → delta.content', () => {
    const enc = new OpenAiChunkEncoder('m');
    const lines = enc.push(
      ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'hello' } }),
    );
    expect(parse(lines[0]).choices[0].delta).toEqual({ content: 'hello' });
  });

  it('thinking_delta → delta.reasoning_content', () => {
    const enc = new OpenAiChunkEncoder('m');
    const lines = enc.push(
      ev('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } }),
    );
    expect(parse(lines[0]).choices[0].delta).toEqual({ reasoning_content: 'hmm' });
  });

  it('signature_delta 丢弃(无输出)', () => {
    const enc = new OpenAiChunkEncoder('m');
    expect(
      enc.push(
        ev('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 's' } }),
      ),
    ).toHaveLength(0);
  });

  it('tool_use start + input_json_delta → tool_calls 增量(同 index)', () => {
    const enc = new OpenAiChunkEncoder('m');
    const start = parse(
      enc.push(
        ev('content_block_start', {
          index: 2,
          content_block: { type: 'tool_use', id: 'call_0', name: 'get_weather' },
        }),
      )[0],
    );
    expect(start.choices[0].delta.tool_calls).toEqual([
      {
        index: 0,
        id: 'call_0',
        type: 'function',
        function: { name: 'get_weather', arguments: '' },
      },
    ]);
    const delta = parse(
      enc.push(
        ev('content_block_delta', {
          index: 2,
          delta: { type: 'input_json_delta', partial_json: '{"city":' },
        }),
      )[0],
    );
    expect(delta.choices[0].delta.tool_calls).toEqual([
      { index: 0, function: { arguments: '{"city":' } },
    ]);
  });

  it('多工具:index 按 tool_use 到达顺序递增', () => {
    const enc = new OpenAiChunkEncoder('m');
    const a = parse(
      enc.push(
        ev('content_block_start', {
          index: 1,
          content_block: { type: 'tool_use', id: 'a', name: 'fa' },
        }),
      )[0],
    );
    // 中间夹一个 text 块(Claude block index 3),不占 OpenAI tool index
    enc.push(ev('content_block_start', { index: 3, content_block: { type: 'text' } }));
    const b = parse(
      enc.push(
        ev('content_block_start', {
          index: 5,
          content_block: { type: 'tool_use', id: 'b', name: 'fb' },
        }),
      )[0],
    );
    expect(a.choices[0].delta.tool_calls?.[0].index).toBe(0);
    expect(b.choices[0].delta.tool_calls?.[0].index).toBe(1);
  });

  it('空输入工具:content_block_stop 补 arguments:"{}"(避免非法 JSON)', () => {
    const enc = new OpenAiChunkEncoder('m');
    // 无参数工具:content_block_start 后无 input_json_delta
    enc.push(
      ev('content_block_start', {
        index: 3,
        content_block: { type: 'tool_use', id: 't1', name: 'now' },
      }),
    );
    // 块结束:补一个 arguments:"{}" 增量,使累积成合法空对象
    const lines = enc.push(ev('content_block_stop', { index: 3 }));
    expect(lines).toHaveLength(1);
    expect(parse(lines[0]).choices[0].delta.tool_calls?.[0]).toEqual({
      index: 0,
      function: { arguments: '{}' },
    });
  });

  it('有参数工具:content_block_stop 不补 "{}"', () => {
    const enc = new OpenAiChunkEncoder('m');
    enc.push(
      ev('content_block_start', {
        index: 3,
        content_block: { type: 'tool_use', id: 't1', name: 'f' },
      }),
    );
    enc.push(
      ev('content_block_delta', {
        index: 3,
        delta: { type: 'input_json_delta', partial_json: '{"a":1}' },
      }),
    );
    expect(enc.push(ev('content_block_stop', { index: 3 }))).toHaveLength(0);
  });

  it('文本块 content_block_stop 不产 chunk', () => {
    const enc = new OpenAiChunkEncoder('m');
    enc.push(ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'hi' } }));
    expect(enc.push(ev('content_block_stop', { index: 0 }))).toHaveLength(0);
  });

  it('message_delta → finish chunk', () => {
    const enc = new OpenAiChunkEncoder('m');
    const line = enc.push(
      ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' } }),
    )[0];
    const c = parse(line);
    expect(c.choices[0].finish_reason).toBe('tool_calls');
    expect(c.choices[0].delta).toEqual({});
  });

  it('usageChunkLine:choices 空 + usage;doneLine=[DONE]', () => {
    const enc = new OpenAiChunkEncoder('m');
    const u = parse(
      enc.usageChunkLine({ prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 }),
    );
    expect(u.choices).toEqual([]);
    expect(u.usage).toEqual({ prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 });
    expect(enc.doneLine()).toBe('data: [DONE]\n\n');
  });

  it('整流 id 稳定', () => {
    const enc = new OpenAiChunkEncoder('m');
    const id1 = parse(enc.push(ev('message_start', {}))[0]).id;
    const id2 = parse(
      enc.push(
        ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'x' } }),
      )[0],
    ).id;
    expect(id1).toBe(id2);
    expect(id1.startsWith('chatcmpl-')).toBe(true);
  });
});
