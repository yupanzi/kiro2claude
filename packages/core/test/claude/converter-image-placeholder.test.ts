/**
 * tool_result 里的图片占位符带序号 = 它在该 Kiro 消息 images[] 里的位置(1-based)。
 *
 * 背景:Codex code mode 的 exec 一次看多张图,回执是 text(path) / image(...) 交错的
 * parts;占位符全都一样时 GPT-5.6 真实运行里数错序号、把两个文件的数字对调。
 * 序号跨「同一条 Kiro 消息里的一切」连续:消息级 image 块也占一个位置,连续 user
 * 消息合并时接着数。
 */
import { describe, expect, it } from 'vitest';
import { convertRequest } from '../../src/claude/converter.js';
import type { MessagesRequest } from '../../src/claude/types.js';
import { serializeKiroRequest } from '../../src/kiro/model/requests/kiro.js';

const PNG = ['QUJDRA==', 'WllYWA==', 'Q0NDQw==', 'RERERA=='];

function image(data: string) {
  return { type: 'image', source: { type: 'base64', media_type: 'image/png', data } };
}

function wire(messages: unknown[]) {
  const { conversationState } = convertRequest(
    { model: 'claude-opus-5', max_tokens: 64, messages } as unknown as MessagesRequest,
    { identityOverride: false },
  );
  return JSON.parse(serializeKiroRequest({ conversationState })).conversationState;
}

type UserWire = {
  images: { source: { bytes: string } }[];
  userInputMessageContext: { toolResults: { toolUseId: string; content: { text: string }[] }[] };
};

const resultText = (u: UserWire, i: number) =>
  u.userInputMessageContext.toolResults[i].content[0].text;

describe('tool_result image placeholders carry their images[] ordinal', () => {
  it('numbers interleaved text/image parts of one tool result in order (Codex exec shape)', () => {
    const state = wire([
      { role: 'user', content: 'view all' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_view', name: 'exec', input: {} }],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_view',
            content: [
              { type: 'text', text: 'Output:' },
              { type: 'text', text: '/workspace/img-1.png' },
              image(PNG[0]),
              { type: 'text', text: '/workspace/img-2.png' },
              image(PNG[1]),
              { type: 'text', text: '/workspace/img-3.png' },
              image(PNG[2]),
            ],
          },
        ],
      },
    ]);
    const user = state.currentMessage.userInputMessage as UserWire;

    expect(user.images.map((i) => i.source.bytes)).toEqual([PNG[0], PNG[1], PNG[2]]);
    expect(resultText(user, 0)).toBe(
      [
        'Output:',
        '/workspace/img-1.png',
        '[image 1 attached to this message]',
        '/workspace/img-2.png',
        '[image 2 attached to this message]',
        '/workspace/img-3.png',
        '[image 3 attached to this message]',
      ].join('\n'),
    );
  });

  it('keeps counting across tool results and skips the slot taken by a message-level image', () => {
    const state = wire([
      { role: 'user', content: 'look' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_a', name: 'Read', input: {} },
          { type: 'tool_use', id: 'toolu_b', name: 'Read', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          image(PNG[0]),
          { type: 'tool_result', tool_use_id: 'toolu_a', content: [image(PNG[1])] },
          { type: 'tool_result', tool_use_id: 'toolu_b', content: [image(PNG[2])] },
        ],
      },
    ]);
    const user = state.currentMessage.userInputMessage as UserWire;

    expect(user.images.map((i) => i.source.bytes)).toEqual([PNG[0], PNG[1], PNG[2]]);
    expect(resultText(user, 0)).toBe('[image 2 attached to this message]');
    expect(resultText(user, 1)).toBe('[image 3 attached to this message]');
  });

  it('continues the ordinal across a merged run of consecutive history user messages', () => {
    const state = wire([
      { role: 'user', content: 'look' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_a', name: 'Read', input: {} },
          { type: 'tool_use', id: 'toolu_b', name: 'Read', input: {} },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: [image(PNG[0])] }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_b', content: [image(PNG[1])] }],
      },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'thanks' },
    ]);
    const merged = state.history.find(
      (m: { userInputMessage?: UserWire }) => m.userInputMessage?.images?.length === 2,
    ).userInputMessage as UserWire;

    expect(resultText(merged, 0)).toBe('[image 1 attached to this message]');
    expect(resultText(merged, 1)).toBe('[image 2 attached to this message]');
  });

  it('restarts at 1 for every Kiro message', () => {
    const state = wire([
      { role: 'user', content: 'first' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_a', name: 'Read', input: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: [image(PNG[0])] }],
      },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_b', name: 'Read', input: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_b', content: [image(PNG[1])] }],
      },
    ]);
    const historyUser = state.history.find(
      (m: { userInputMessage?: UserWire }) => m.userInputMessage?.images?.length === 1,
    ).userInputMessage as UserWire;

    expect(resultText(historyUser, 0)).toBe('[image 1 attached to this message]');
    expect(resultText(state.currentMessage.userInputMessage as UserWire, 0)).toBe(
      '[image 1 attached to this message]',
    );
  });
});
