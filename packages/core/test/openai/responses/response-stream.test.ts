import { describe, expect, it } from 'vitest';
import type { SseEvent } from '../../../src/claude/stream.js';
import { ResponsesEventEncoder } from '../../../src/openai/responses/response-stream.js';

function ev(event: string, data: Record<string, unknown>): SseEvent {
  return { event, data };
}
/** parse `data: {...}\n\n` 行 → 事件对象。 */
function parse(lines: string[]): Record<string, unknown>[] {
  return lines.map((l) => JSON.parse(l.slice('data: '.length).trim()));
}
function types(lines: string[]): string[] {
  return parse(lines).map((e) => e.type as string);
}

// 常用 Claude SseEvent 片段
const START = ev('message_start', { type: 'message_start', message: {} });
const textStart = (i: number) =>
  ev('content_block_start', { index: i, content_block: { type: 'text' } });
const textDelta = (i: number, text: string) =>
  ev('content_block_delta', { index: i, delta: { type: 'text_delta', text } });
const stop = (i: number) => ev('content_block_stop', { index: i });
const thinkingDelta = (i: number, thinking: string) =>
  ev('content_block_delta', { index: i, delta: { type: 'thinking_delta', thinking } });
const sigDelta = (i: number, signature: string) =>
  ev('content_block_delta', { index: i, delta: { type: 'signature_delta', signature } });

describe('ResponsesEventEncoder: 文本流', () => {
  it('严格事件序列 + content_part.added 在 delta 之前', () => {
    const enc = new ResponsesEventEncoder('gpt-5.6-sol');
    const all: string[] = [];
    all.push(...enc.push(START));
    all.push(...enc.push(textStart(0))); // 惰性:不产事件
    all.push(...enc.push(textDelta(0, 'po')));
    all.push(...enc.push(textDelta(0, 'ng')));
    all.push(...enc.push(stop(0)));
    all.push(...enc.finalize({ input_tokens: 5, output_tokens: 1, total_tokens: 6 }));

    expect(types(all)).toEqual([
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.completed',
    ]);
    const evs = parse(all);
    // content_part.added 必须在第一个 delta 之前(Codex 硬要求)
    expect(evs.findIndex((e) => e.type === 'response.content_part.added')).toBeLessThan(
      evs.findIndex((e) => e.type === 'response.output_text.delta'),
    );
    // done 回填完整文本
    expect(evs.find((e) => e.type === 'response.output_text.done')?.text).toBe('pong');
    // completed 带完整 output + usage
    const completed = evs.find((e) => e.type === 'response.completed')?.response as {
      output: { type: string; content: { text: string }[] }[];
      usage: { input_tokens: number };
    };
    expect(completed.output[0].type).toBe('message');
    expect(completed.output[0].content[0].text).toBe('pong');
    expect(completed.usage.input_tokens).toBe(5);
  });

  it('sequence_number 单调递增', () => {
    const enc = new ResponsesEventEncoder('m');
    const all = [
      ...enc.push(START),
      ...enc.push(textDelta(0, 'x')),
      ...enc.finalize({ input_tokens: 1, output_tokens: 1, total_tokens: 2 }),
    ];
    const seqs = parse(all).map((e) => e.sequence_number as number);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
  });

  it('finalize:response.completed 的 usage 携带 plugin 扩展字段', () => {
    const enc = new ResponsesEventEncoder('m');
    const all = [
      ...enc.push(START),
      ...enc.push(textDelta(0, 'x')),
      ...enc.finalize({
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2,
        kiro_metering: { unit: 'credit', usage: 5 },
      }),
    ];
    const completed = parse(all).find((e) => e.type === 'response.completed')?.response as {
      usage: Record<string, unknown>;
    };
    expect(completed.usage).toMatchObject({ kiro_metering: { unit: 'credit', usage: 5 } });
  });
});

describe('ResponsesEventEncoder: 工具调用', () => {
  it('function_call 事件序列 + arguments 拼接;无空 message', () => {
    const enc = new ResponsesEventEncoder('m');
    const all: string[] = [];
    all.push(...enc.push(START));
    // 直接 tool_use(无前导文本)→ 不应产生空 message item
    all.push(
      ...enc.push(
        ev('content_block_start', {
          index: 1,
          content_block: { type: 'tool_use', id: 'call_0', name: 'get_weather' },
        }),
      ),
    );
    all.push(
      ...enc.push(
        ev('content_block_delta', {
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '{"city":' },
        }),
      ),
    );
    all.push(
      ...enc.push(
        ev('content_block_delta', {
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '"Tokyo"}' },
        }),
      ),
    );
    all.push(...enc.push(stop(1)));
    all.push(...enc.finalize({ input_tokens: 1, output_tokens: 1, total_tokens: 2 }));

    const t = types(all);
    expect(t).toContain('response.function_call_arguments.delta');
    expect(t).toContain('response.function_call_arguments.done');
    // 无 message item(纯工具调用)
    expect(t).not.toContain('response.content_part.added');
    const evs = parse(all);
    const added = evs.find((e) => e.type === 'response.output_item.added')?.item as {
      type: string;
      call_id: string;
      name: string;
    };
    expect(added).toMatchObject({ type: 'function_call', call_id: 'call_0', name: 'get_weather' });
    const done = evs.find((e) => e.type === 'response.function_call_arguments.done');
    expect(done?.arguments).toBe('{"city":"Tokyo"}');
    const completed = evs.find((e) => e.type === 'response.completed')?.response as {
      output: { type: string }[];
    };
    expect(completed.output.map((o) => o.type)).toEqual(['function_call']);
  });

  it('空输入工具:arguments 归一为 "{}"(避免非法 JSON)', () => {
    const enc = new ResponsesEventEncoder('m');
    const all: string[] = [];
    all.push(...enc.push(START));
    // 无参数工具:content_block_start 后无 input_json_delta
    all.push(
      ...enc.push(
        ev('content_block_start', {
          index: 1,
          content_block: { type: 'tool_use', id: 'call_0', name: 'now' },
        }),
      ),
    );
    all.push(...enc.push(stop(1)));
    all.push(...enc.finalize({ input_tokens: 1, output_tokens: 1, total_tokens: 2 }));

    const evs = parse(all);
    // 补了 delta "{}" 且 done/item 的 arguments 均为合法空对象
    const done = evs.find((e) => e.type === 'response.function_call_arguments.done');
    expect(done?.arguments).toBe('{}');
    const itemDone = evs.find(
      (e) =>
        e.type === 'response.output_item.done' &&
        (e.item as { type: string }).type === 'function_call',
    )?.item as { arguments: string };
    expect(itemDone.arguments).toBe('{}');
  });
});

describe('ResponsesEventEncoder: reasoning(thinking)', () => {
  it('thinking → reasoning item + 完整 summary 事件序列;signature 丢弃', () => {
    const enc = new ResponsesEventEncoder('claude-opus-4-6');
    const all: string[] = [];
    all.push(...enc.push(START));
    all.push(...enc.push(thinkingDelta(0, 'Let me '))); // 惰性开 reasoning item
    all.push(...enc.push(thinkingDelta(0, 'think.')));
    all.push(...enc.push(sigDelta(0, 'sig-abc'))); // continuation 凭证,丢弃
    all.push(...enc.push(stop(0)));
    all.push(...enc.finalize({ input_tokens: 5, output_tokens: 2, total_tokens: 7 }));

    expect(types(all)).toEqual([
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.reasoning_summary_part.added',
      'response.reasoning_summary_text.delta',
      'response.reasoning_summary_text.delta',
      'response.reasoning_summary_text.done',
      'response.reasoning_summary_part.done',
      'response.output_item.done',
      'response.completed',
    ]);
    const evs = parse(all);
    // added item 是 reasoning、summary 初始空
    expect(evs.find((e) => e.type === 'response.output_item.added')?.item).toMatchObject({
      type: 'reasoning',
      summary: [],
    });
    // part.added 必须在首个 summary delta 之前
    expect(evs.findIndex((e) => e.type === 'response.reasoning_summary_part.added')).toBeLessThan(
      evs.findIndex((e) => e.type === 'response.reasoning_summary_text.delta'),
    );
    // done 回填完整摘要
    expect(evs.find((e) => e.type === 'response.reasoning_summary_text.done')?.text).toBe(
      'Let me think.',
    );
    // completed.output 含完整 reasoning item
    const completed = evs.find((e) => e.type === 'response.completed')?.response as {
      output: { type: string; summary: { text: string }[] }[];
    };
    expect(completed.output[0].type).toBe('reasoning');
    expect(completed.output[0].summary[0].text).toBe('Let me think.');
  });

  it('reasoning + text → reasoning item 在 message item 之前(output_index 0 < 1)', () => {
    const enc = new ResponsesEventEncoder('claude-opus-4-6');
    const all: string[] = [];
    all.push(...enc.push(START));
    all.push(...enc.push(thinkingDelta(0, 'hmm')));
    all.push(...enc.push(stop(0))); // 关 reasoning(模拟 AssistantResponse 边界)
    all.push(...enc.push(textDelta(1, 'answer')));
    all.push(...enc.push(stop(1)));
    all.push(...enc.finalize({ input_tokens: 3, output_tokens: 2, total_tokens: 5 }));

    const evs = parse(all);
    const completed = evs.find((e) => e.type === 'response.completed')?.response as {
      output: { type: string }[];
    };
    expect(completed.output.map((o) => o.type)).toEqual(['reasoning', 'message']);
    const doneItems = evs.filter((e) => e.type === 'response.output_item.done');
    const reasoningDone = doneItems.find((e) => (e.item as { type: string }).type === 'reasoning');
    const msgDone = doneItems.find((e) => (e.item as { type: string }).type === 'message');
    expect(reasoningDone?.output_index).toBe(0);
    expect(msgDone?.output_index).toBe(1);
  });

  it('signature_delta 单独 → 丢弃(无输出)', () => {
    const enc = new ResponsesEventEncoder('m');
    expect(enc.push(sigDelta(0, 's'))).toEqual([]);
  });

  it('纯 text(无 thinking)→ 不产任何 reasoning 事件(GPT/Codex 路径不变)', () => {
    const enc = new ResponsesEventEncoder('gpt-5.6-sol');
    const all = [
      ...enc.push(START),
      ...enc.push(textDelta(0, 'hi')),
      ...enc.push(stop(0)),
      ...enc.finalize({ input_tokens: 1, output_tokens: 1, total_tokens: 2 }),
    ];
    expect(types(all).some((x) => x.includes('reasoning'))).toBe(false);
  });
});
