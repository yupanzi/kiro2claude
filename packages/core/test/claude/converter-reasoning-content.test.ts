/**
 * history 里的 thinking → Kiro 原生 `assistantResponseMessage.reasoningContent`(红线见 PITFALLS
 * 「原生 reasoning / effort / system 的 wire 真相」):带签名的 `thinking` → `reasoningText`,
 * `redacted_thinking` → `redactedContent`,无签名的丢弃而不是拼成 `<thinking>` 文本,一条 Kiro
 * 消息一个槽位、多块取最后一块。
 */

import { describe, expect, it } from 'vitest';
import { convertRequest, toKiroRequest } from '../../src/claude/converter.js';
import type { Message, MessagesRequest } from '../../src/claude/types.js';
import { serializeKiroRequest } from '../../src/kiro/model/requests/kiro.js';

function req(messages: Message[], model = 'claude-opus-5'): MessagesRequest {
  return { model, max_tokens: 1024, messages } as MessagesRequest;
}

/** 三轮脚手架:user q → 一条 assistant(只有 `blocks` 不同)→ user next。 */
function convertTurn(blocks: Message['content'], model?: string) {
  return convertRequest(
    req(
      [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: blocks },
        { role: 'user', content: 'next' },
      ],
      model,
    ),
  );
}

function assistantAt(result: ReturnType<typeof convertRequest>, index: number) {
  const entry = result.conversationState.history[index];
  if (entry?.kind !== 'assistant') throw new Error(`history[${index}] is not assistant`);
  return entry.assistantResponseMessage;
}

describe('history thinking → reasoningContent', () => {
  it('signed thinking + text → reasoningText carries text and signature; content is the text only', () => {
    const result = convertTurn([
      { type: 'thinking', thinking: 'private reasoning', signature: 'sig-abc' },
      { type: 'text', text: 'visible answer' },
    ]);
    const am = assistantAt(result, 1);
    expect(am.content).toBe('visible answer');
    expect(am.reasoningContent).toEqual({
      reasoningText: { text: 'private reasoning', signature: 'sig-abc' },
    });
    expect(JSON.stringify(am)).not.toContain('<thinking>');
  });

  it('unsigned thinking is dropped: no reasoningContent, no tag-stitched text', () => {
    const result = convertTurn([
      { type: 'thinking', thinking: 'private reasoning' },
      { type: 'text', text: 'visible answer' },
    ]);
    const am = assistantAt(result, 1);
    expect(am.content).toBe('visible answer');
    expect(am.reasoningContent).toBeUndefined();
    expect(JSON.stringify(result.conversationState)).not.toContain('private reasoning');
  });

  it('empty-string signature counts as unsigned', () => {
    const result = convertTurn([
      { type: 'thinking', thinking: 'x', signature: '' },
      { type: 'text', text: 'a' },
    ]);
    expect(assistantAt(result, 1).reasoningContent).toBeUndefined();
  });

  it('redacted_thinking → redactedContent (base64 passthrough)', () => {
    const result = convertTurn(
      [
        { type: 'redacted_thinking', data: 'LktUUn5+ZW5j' },
        { type: 'text', text: 'a' },
      ],
      'gpt-5.6-sol',
    );
    expect(assistantAt(result, 1).reasoningContent).toEqual({ redactedContent: 'LktUUn5+ZW5j' });
  });

  it('signed thinking with empty text (display: omitted round trip) still rides reasoningText', () => {
    const result = convertTurn([
      { type: 'thinking', thinking: '', signature: 'sig-only' },
      { type: 'text', text: 'a' },
    ]);
    expect(assistantAt(result, 1).reasoningContent).toEqual({
      reasoningText: { text: '', signature: 'sig-only' },
    });
  });

  it('multiple signed blocks in one message → the last one wins (single slot)', () => {
    const result = convertTurn([
      { type: 'thinking', thinking: 'first', signature: 'sig-1' },
      { type: 'text', text: 'a' },
      { type: 'thinking', thinking: 'second', signature: 'sig-2' },
      { type: 'text', text: 'b' },
    ]);
    const am = assistantAt(result, 1);
    expect(am.reasoningContent).toEqual({ reasoningText: { text: 'second', signature: 'sig-2' } });
    expect(am.content).toBe('ab');
  });

  it('consecutive assistant messages merge: last reasoning wins, tool uses and text are kept', () => {
    const result = convertRequest(
      req([
        { role: 'user', content: 'q' },
        {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'plan', signature: 'sig-plan' }],
        },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'act', signature: 'sig-act' },
            { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { path: 'a' } },
          ],
        },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
      ]),
    );
    const am = assistantAt(result, 1);
    expect(am.reasoningContent).toEqual({ reasoningText: { text: 'act', signature: 'sig-act' } });
    expect(am.toolUses?.map((t) => t.toolUseId)).toEqual(['toolu_1']);
    expect(am.content).toBe(' ');
  });

  it('serialized wire shape: reasoningContent sits inside assistantResponseMessage, no discriminator', () => {
    const result = convertTurn([
      { type: 'thinking', thinking: 'r', signature: 's' },
      { type: 'text', text: 'a' },
    ]);
    const wire = JSON.parse(serializeKiroRequest(toKiroRequest(result)));
    expect(wire.conversationState.history[1]).toEqual({
      assistantResponseMessage: {
        content: 'a',
        reasoningContent: { reasoningText: { text: 'r', signature: 's' } },
      },
    });
  });
});
