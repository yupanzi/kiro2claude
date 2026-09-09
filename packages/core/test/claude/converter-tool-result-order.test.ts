/**
 * tool_result 顺序规范化(canonicalizeToolResultOrder)。
 *
 * 背景:Kiro ToolResult wire 没有图片通道,tool_result 里的图只能提升到消息级
 * `images[]`,归属全靠位置;真实上游实测两个模型都按 tool_use 顺序对应
 * `images[i]`,回执反序时图片张冠李戴。这里钉住:wire 上 toolResults 与 images
 * 都按 tool_use 顺序排列,且只有 tool_result 块会动。
 */
import { describe, expect, it } from 'vitest';
import { convertRequest } from '../../src/claude/converter.js';
import type { MessagesRequest } from '../../src/claude/types.js';
import { serializeKiroRequest } from '../../src/kiro/model/requests/kiro.js';

const PNG_A = 'QUJDRA==';
const PNG_B = 'WllYWA==';
const PNG_C = 'Q0NDQw==';

function image(data: string) {
  return { type: 'image', source: { type: 'base64', media_type: 'image/png', data } };
}

function toolResult(id: string, content: unknown) {
  return { type: 'tool_result', tool_use_id: id, content };
}

function toolUse(id: string) {
  return { type: 'tool_use', id, name: 'lookup', input: { key: id } };
}

function wire(messages: unknown[]) {
  const { conversationState } = convertRequest(
    { model: 'claude-opus-5', max_tokens: 64, messages } as unknown as MessagesRequest,
    { identityOverride: false },
  );
  return JSON.parse(serializeKiroRequest({ conversationState })).conversationState;
}

type UserWire = {
  content: string;
  images: { source: { bytes: string } }[];
  userInputMessageContext: { toolResults: { toolUseId: string; content: { text: string }[] }[] };
};

/** 多图消息 content 开头会有图例(见 converter-image-legend.test.ts),这里只看它之后的正文。 */
const LEGEND = /^\[Attached images, in order: [^\n]*\]\n?/;

function summarize(user: UserWire) {
  return {
    content: user.content.replace(LEGEND, ''),
    images: user.images.map((i) => i.source.bytes),
    results: user.userInputMessageContext.toolResults.map((r) => r.toolUseId),
  };
}

describe('tool_result order follows tool_use order', () => {
  it('reorders reversed results in the current message so images[] matches tool_use order', () => {
    const state = wire([
      { role: 'user', content: 'look up alpha and beta' },
      { role: 'assistant', content: [toolUse('toolu_alpha'), toolUse('toolu_beta')] },
      {
        role: 'user',
        content: [
          toolResult('toolu_beta', [image(PNG_B)]),
          toolResult('toolu_alpha', [image(PNG_A)]),
        ],
      },
    ]);

    expect(summarize(state.currentMessage.userInputMessage)).toEqual({
      content: '',
      images: [PNG_A, PNG_B],
      results: ['toolu_alpha', 'toolu_beta'],
    });
  });

  it('applies the same rule to history turns', () => {
    const state = wire([
      { role: 'user', content: 'look up alpha and beta' },
      { role: 'assistant', content: [toolUse('toolu_alpha'), toolUse('toolu_beta')] },
      {
        role: 'user',
        content: [
          toolResult('toolu_beta', [image(PNG_B)]),
          toolResult('toolu_alpha', [image(PNG_A)]),
        ],
      },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'thanks' },
    ]);
    const historyUser = state.history.find(
      (m: { userInputMessage?: UserWire }) => m.userInputMessage?.images?.length === 2,
    ).userInputMessage as UserWire;

    expect(summarize(historyUser)).toEqual({
      content: '',
      images: [PNG_A, PNG_B],
      results: ['toolu_alpha', 'toolu_beta'],
    });
  });

  it('treats a run of consecutive user messages inside the history as one turn (they merge)', () => {
    const state = wire([
      { role: 'user', content: 'look up alpha and beta' },
      { role: 'assistant', content: [toolUse('toolu_alpha'), toolUse('toolu_beta')] },
      { role: 'user', content: [toolResult('toolu_beta', [image(PNG_B)])] },
      { role: 'user', content: [toolResult('toolu_alpha', [image(PNG_A)])] },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'thanks' },
    ]);
    const merged = state.history.find(
      (m: { userInputMessage?: UserWire }) => m.userInputMessage?.images?.length === 2,
    ).userInputMessage as UserWire;

    expect(summarize(merged)).toEqual({
      content: '',
      images: [PNG_A, PNG_B],
      results: ['toolu_alpha', 'toolu_beta'],
    });
  });

  it('never moves blocks into the trailing message (buildHistory splits it off as currentMessage)', () => {
    const state = wire([
      { role: 'user', content: 'look up alpha and beta' },
      { role: 'assistant', content: [toolUse('toolu_alpha'), toolUse('toolu_beta')] },
      { role: 'user', content: [toolResult('toolu_beta', [image(PNG_B)])] },
      { role: 'user', content: [toolResult('toolu_alpha', [image(PNG_A)])] },
    ]);

    // 末尾两条 user 不合并:beta 进 history(自动补 OK),alpha 留在 currentMessage。
    // 每条 Kiro 消息只有一张图、一个结果,归属本就无歧义,所以不跨消息搬动。
    expect(summarize(state.currentMessage.userInputMessage)).toEqual({
      content: '',
      images: [PNG_A],
      results: ['toolu_alpha'],
    });
    const historyUser = state.history.find(
      (m: { userInputMessage?: UserWire }) => m.userInputMessage?.images?.length === 1,
    ).userInputMessage as UserWire;
    expect(summarize(historyUser).results).toEqual(['toolu_beta']);
  });

  it('follows the merged order of a run of consecutive assistant messages', () => {
    const state = wire([
      { role: 'user', content: 'look up alpha and beta' },
      { role: 'assistant', content: [toolUse('toolu_alpha')] },
      { role: 'assistant', content: [toolUse('toolu_beta')] },
      {
        role: 'user',
        content: [
          toolResult('toolu_beta', [image(PNG_B)]),
          toolResult('toolu_alpha', [image(PNG_A)]),
        ],
      },
    ]);

    expect(summarize(state.currentMessage.userInputMessage).results).toEqual([
      'toolu_alpha',
      'toolu_beta',
    ]);
  });

  it('only moves tool_result blocks: text and message-level images keep their slots', () => {
    const state = wire([
      { role: 'user', content: 'look up alpha and beta' },
      { role: 'assistant', content: [toolUse('toolu_alpha'), toolUse('toolu_beta')] },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'before' },
          toolResult('toolu_beta', 'beta text'),
          image(PNG_C),
          toolResult('toolu_alpha', [image(PNG_A)]),
          { type: 'text', text: 'after' },
        ],
      },
    ]);

    // 槽位 1 与 3 是 tool_result 的位置:alpha 进槽位 1,beta 进槽位 3。
    // 消息级图 PNG_C 在槽位 2,所以它仍夹在两个 tool_result 的图之间。
    expect(summarize(state.currentMessage.userInputMessage)).toEqual({
      content: 'before\nafter',
      images: [PNG_A, PNG_C],
      results: ['toolu_alpha', 'toolu_beta'],
    });
    expect(
      state.currentMessage.userInputMessage.userInputMessageContext.toolResults[1].content,
    ).toEqual([{ text: 'beta text' }]);
  });

  it('keeps ids the assistant never issued after the known ones, in their original order', () => {
    const state = wire([
      { role: 'user', content: 'look up alpha and beta' },
      { role: 'assistant', content: [toolUse('toolu_alpha'), toolUse('toolu_beta')] },
      {
        role: 'user',
        content: [
          toolResult('toolu_zeta', 'z'),
          toolResult('toolu_beta', 'b'),
          toolResult('toolu_eta', 'e'),
          toolResult('toolu_alpha', 'a'),
        ],
      },
    ]);

    // 未配对的结果会被 validateToolPairing 从结构化通道移走并以引用形式保留在正文里,
    // 这里只断言结构化通道内的顺序与正文里两条未配对结果的相对顺序。
    const user = state.currentMessage.userInputMessage as UserWire;
    expect(summarize(user).results).toEqual(['toolu_alpha', 'toolu_beta']);
    expect(user.content.indexOf('toolu_zeta')).toBeGreaterThanOrEqual(0);
    expect(user.content.indexOf('toolu_zeta')).toBeLessThan(user.content.indexOf('toolu_eta'));
  });

  it('leaves an already-canonical turn untouched', () => {
    const messages = [
      { role: 'user', content: 'look up alpha and beta' },
      { role: 'assistant', content: [toolUse('toolu_alpha'), toolUse('toolu_beta')] },
      {
        role: 'user',
        content: [
          toolResult('toolu_alpha', [image(PNG_A)]),
          toolResult('toolu_beta', [image(PNG_B)]),
        ],
      },
    ];
    const snapshot = JSON.stringify(messages);

    expect(summarize(wire(messages).currentMessage.userInputMessage)).toEqual({
      content: '',
      images: [PNG_A, PNG_B],
      results: ['toolu_alpha', 'toolu_beta'],
    });
    // 输入对象不被改写
    expect(JSON.stringify(messages)).toBe(snapshot);
  });

  it("does not mutate the caller's messages when it does reorder", () => {
    const messages = [
      { role: 'user', content: 'look up alpha and beta' },
      { role: 'assistant', content: [toolUse('toolu_alpha'), toolUse('toolu_beta')] },
      {
        role: 'user',
        content: [
          toolResult('toolu_beta', [image(PNG_B)]),
          toolResult('toolu_alpha', [image(PNG_A)]),
        ],
      },
    ];
    const snapshot = JSON.stringify(messages);
    wire(messages);
    expect(JSON.stringify(messages)).toBe(snapshot);
  });
});
