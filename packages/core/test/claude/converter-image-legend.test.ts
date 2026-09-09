/**
 * 多图图例(prependImageLegend):一条 Kiro 消息里 ≥2 张图且至少一张来自 tool_result 时,
 * content 开头加一行「image k = …」。真实上游实测(2026-09-09,6 张图、不透明 id):
 * 只靠 tool_result 里的序号占位符两模型 4/4 错位,正文加图例 4/4 全对。
 */
import { describe, expect, it } from 'vitest';
import { convertRequest } from '../../src/claude/converter.js';
import type { MessagesRequest } from '../../src/claude/types.js';
import { serializeKiroRequest } from '../../src/kiro/model/requests/kiro.js';

const PNG = ['QUJDRA==', 'WllYWA==', 'Q0NDQw=='];
const image = (data: string) => ({
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data },
});

function wire(messages: unknown[]) {
  const { conversationState } = convertRequest(
    { model: 'claude-opus-5', max_tokens: 64, messages } as unknown as MessagesRequest,
    { identityOverride: false },
  );
  return JSON.parse(serializeKiroRequest({ conversationState })).conversationState;
}

type UserWire = { content: string; images: unknown[] };
const current = (state: { currentMessage: { userInputMessage: UserWire } }) =>
  state.currentMessage.userInputMessage;

describe('image legend in user content', () => {
  it('lists every tool-result image with its call id and input (Claude Code parallel Read shape)', () => {
    const state = wire([
      { role: 'user', content: 'read both' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_01AAA', name: 'Read', input: { file_path: '/ws/a.png' } },
          { type: 'tool_use', id: 'toolu_01BBB', name: 'Read', input: { file_path: '/ws/b.png' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_01AAA', content: [image(PNG[0])] },
          { type: 'tool_result', tool_use_id: 'toolu_01BBB', content: [image(PNG[1])] },
        ],
      },
    ]);

    expect(current(state).content).toBe(
      '[Attached images, in order: image 1 = result of tool call toolu_01AAA (Read {"file_path":"/ws/a.png"}); ' +
        'image 2 = result of tool call toolu_01BBB (Read {"file_path":"/ws/b.png"})]',
    );
    expect(current(state).images).toHaveLength(2);
  });

  it('uses the text printed right before each image as its label (Codex exec shape)', () => {
    const state = wire([
      { role: 'user', content: 'view all' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'call_x', name: 'exec', input: { code: 'for (...) {}' } },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_x',
            content: [
              { type: 'text', text: 'Script completed\nOutput:' },
              { type: 'text', text: '/workspace/img-1.png' },
              image(PNG[0]),
              { type: 'text', text: '/workspace/img-2.png' },
              image(PNG[1]),
            ],
          },
        ],
      },
    ]);

    expect(current(state).content).toBe(
      '[Attached images, in order: image 1 = /workspace/img-1.png (tool call call_x); ' +
        'image 2 = /workspace/img-2.png (tool call call_x)]',
    );
  });

  it('falls back to the call input when no text precedes the image, and forgets a label after use', () => {
    const state = wire([
      { role: 'user', content: 'view all' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_x', name: 'exec', input: {} }] },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_x',
            content: [{ type: 'text', text: 'first.png' }, image(PNG[0]), image(PNG[1])],
          },
        ],
      },
    ]);

    expect(current(state).content).toBe(
      '[Attached images, in order: image 1 = first.png (tool call call_x); ' +
        'image 2 = result of tool call call_x (exec {})]',
    );
  });

  it('is omitted for a single image and for images that all come from the user', () => {
    const single = wire([
      { role: 'user', content: 'read it' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [image(PNG[0])] }],
      },
    ]);
    expect(current(single).content).toBe('');

    const userOnly = wire([
      { role: 'user', content: [{ type: 'text', text: 'compare' }, image(PNG[0]), image(PNG[1])] },
    ]);
    expect(current(userOnly).content).toBe('compare');
  });

  it('numbers around a message-level image and keeps the user text after the legend', () => {
    const state = wire([
      { role: 'user', content: 'read it' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'x' } }],
      },
      {
        role: 'user',
        content: [
          image(PNG[0]),
          { type: 'text', text: 'here is mine too' },
          { type: 'tool_result', tool_use_id: 'toolu_1', content: [image(PNG[1])] },
        ],
      },
    ]);

    expect(current(state).content).toBe(
      '[Attached images, in order: image 2 = result of tool call toolu_1 (Read {"file_path":"x"})]\nhere is mine too',
    );
  });

  it('truncates a long call input and applies to merged history turns too', () => {
    const longPath = `/ws/${'x'.repeat(200)}.png`;
    const state = wire([
      { role: 'user', content: 'read both' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_a', name: 'Read', input: { file_path: longPath } },
          { type: 'tool_use', id: 'toolu_b', name: 'Read', input: { file_path: '/ws/b.png' } },
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

    expect(
      merged.content.startsWith(
        '[Attached images, in order: image 1 = result of tool call toolu_a (Read {"file_path":"/ws/xxx',
      ),
    ).toBe(true);
    expect(merged.content).toContain(
      '…); image 2 = result of tool call toolu_b (Read {"file_path":"/ws/b.png"})]',
    );
    expect(merged.content.length).toBeLessThan(400);
  });
});
