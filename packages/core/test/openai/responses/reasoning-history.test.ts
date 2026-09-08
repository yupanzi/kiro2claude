import { describe, expect, it } from 'vitest';
import { ASSISTANT_CONTINUATION_TEXT, convertRequest } from '../../../src/claude/converter.js';
import { convertResponsesRequest } from '../../../src/openai/responses/converter.js';
import type { ResponsesInputItem } from '../../../src/openai/responses/types.js';

function convert(input: ResponsesInputItem[]) {
  return convertResponsesRequest({ model: 'gpt-5.6-sol', input }).payload;
}

describe('Responses plaintext reasoning history', () => {
  it('retains explicit summary text, including whitespace and Unicode, without exposing ciphertext', () => {
    const first = '  Check the existing state.\n';
    const second = 'Then validate the reservation: 库存.  ';
    const request = convert([
      { role: 'user', content: 'Continue inspecting.' },
      {
        type: 'reasoning',
        encrypted_content: 'opaque-secret-sentinel',
        summary: [
          { type: 'summary_text', text: first },
          { type: 'summary_text', text: second },
        ],
      },
    ]);
    expect(request.messages[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'thinking', thinking: `${first}\n\n${second}` }],
    });
    const state = convertRequest(request, { identityOverride: false }).conversationState;
    expect(state.history[1]).toMatchObject({
      assistantResponseMessage: { content: `<thinking>${first}\n\n${second}</thinking>` },
    });
    expect(state.currentMessage.userInputMessage.content).toBe(ASSISTANT_CONTINUATION_TEXT);
    expect(JSON.stringify(state)).not.toContain('opaque-secret-sentinel');
    expect(state.currentMessage.userInputMessage.userInputMessageContext.toolResults).toEqual([]);
  });

  it('keeps reasoning with its assistant tool call and preserves the real result on the user turn', () => {
    const request = convert([
      { role: 'user', content: 'Inspect the file.' },
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Check before modifying.' }] },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Reading now.' }],
      },
      {
        type: 'function_call',
        call_id: 'read_1',
        name: 'read_file',
        arguments: '{"path":"a.txt"}',
      },
      { type: 'function_call_output', call_id: 'read_1', output: 'Exact file output.\n' },
    ]);
    const state = convertRequest(request, { identityOverride: false }).conversationState;
    expect(state.history.map((message) => message.kind)).toEqual(['user', 'assistant']);
    expect(state.history[1]).toMatchObject({
      assistantResponseMessage: {
        content: '<thinking>Check before modifying.</thinking>\n\nReading now.',
        toolUses: [{ toolUseId: 'read_1', name: 'read_file', input: { path: 'a.txt' } }],
      },
    });
    expect(state.currentMessage.userInputMessage.userInputMessageContext.toolResults).toEqual([
      {
        toolUseId: 'read_1',
        content: [{ text: 'Exact file output.\n' }],
        status: 'success',
        isError: false,
      },
    ]);
  });

  it('does not manufacture plaintext from encrypted-only or malformed summary items', () => {
    const request = convert([
      {
        type: 'reasoning',
        encrypted_content: 'opaque-only',
        summary: [
          null,
          'not a summary block',
          { type: 'summary_text', text: 12 },
          { type: 'output_text', text: 'wrong channel' },
          { type: 'summary_text', text: '' },
        ],
      },
      { role: 'user', content: 'Continue.' },
    ]);
    expect(request.messages).toEqual([{ role: 'user', content: 'Continue.' }]);
    expect(JSON.stringify(convertRequest(request).conversationState)).not.toContain('opaque-only');
  });

  it('does not mutate caller-owned reasoning items or reorder the following user request', () => {
    const input: ResponsesInputItem[] = [
      { role: 'user', content: 'First task.' },
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'A prior observation.' }] },
      { role: 'user', content: 'Second task.' },
    ];
    const before = structuredClone(input);
    const request = convert(input);
    const state = convertRequest(request, { identityOverride: false }).conversationState;
    expect(state.currentMessage.userInputMessage.content).toBe('Second task.');
    expect(state.history[1]).toMatchObject({
      assistantResponseMessage: { content: '<thinking>A prior observation.</thinking>' },
    });
    expect(input).toEqual(before);
  });
});
