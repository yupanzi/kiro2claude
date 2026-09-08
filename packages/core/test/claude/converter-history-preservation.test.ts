import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_CONTINUATION_TEXT,
  convertRequest,
  DUPLICATE_TOOL_RESULT_TEXT,
  INTERRUPTED_TOOL_RESULT_TEXT,
  UNPAIRED_TOOL_RESULT_TEXT,
} from '../../src/claude/converter.js';
import type { ContentBlock, Message, MessagesRequest } from '../../src/claude/types.js';
import type { UserInputMessage } from '../../src/kiro/model/requests/conversation.js';
import type { ToolResult } from '../../src/kiro/model/requests/tool.js';

function convert(messages: Message[]) {
  const request: MessagesRequest = {
    model: 'claude-opus-4-6',
    max_tokens: 1024,
    messages,
  };
  return convertRequest(request, { identityOverride: false }).conversationState;
}

function assistant(text: string): Message {
  return { role: 'assistant', content: text };
}

function invocation(id = 'call_1'): Message {
  return {
    role: 'assistant',
    content: [{ type: 'tool_use', id, name: 'write_file', input: { literal: '\\u0000' } }],
  };
}

function result(id: string, text: string, isError = false): ContentBlock {
  return { type: 'tool_result', tool_use_id: id, content: text, is_error: isError };
}

function users(state: ReturnType<typeof convert>): UserInputMessage[] {
  return [
    ...state.history.flatMap((message) =>
      message.kind === 'user' ? [message.userInputMessage] : [],
    ),
    state.currentMessage.userInputMessage,
  ];
}

function calls(state: ReturnType<typeof convert>) {
  return state.history.flatMap((message) =>
    message.kind === 'assistant' ? (message.assistantResponseMessage.toolUses ?? []) : [],
  );
}

function quoted(user: UserInputMessage): { kind: string; result: ToolResult }[] {
  return user.content
    .split('\n')
    .filter((line) => line.startsWith('{"kind":'))
    .map((line) => JSON.parse(line));
}

describe('assistant continuation retains client history', () => {
  it('retains partial text on the immediate retry without duplicating the original user task', () => {
    const prefix = '  Existing checks passed.\nNext I will inspect the reservation state.  ';
    const messages: Message[] = [
      { role: 'user', content: 'Inspect the repository.' },
      assistant(prefix),
    ];
    const before = structuredClone(messages);
    const state = convert(messages);
    expect(state.history.map((message) => message.kind)).toEqual(['user', 'assistant']);
    expect(state.history[1]).toMatchObject({ assistantResponseMessage: { content: prefix } });
    expect(state.currentMessage.userInputMessage.content).toBe(ASSISTANT_CONTINUATION_TEXT);
    expect(users(state).filter((user) => user.content === 'Inspect the repository.')).toHaveLength(
      1,
    );
    expect(calls(state)).toEqual([]);
    expect(messages).toEqual(before);
    expect(convert(messages).history).toEqual(state.history);
  });

  it('keeps a genuine literal prefill as assistant content without claiming it was interrupted', () => {
    const state = convert([{ role: 'user', content: 'Return JSON.' }, assistant('{"name":')]);
    expect(state.history[1]).toMatchObject({ assistantResponseMessage: { content: '{"name":' } });
    expect(state.currentMessage.userInputMessage.content).toContain('may be');
    expect(state.currentMessage.userInputMessage.content).not.toContain('was interrupted');
  });

  it('keeps consecutive text/thinking/tool messages and marks missing results as unknown errors', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Write only if needed.' },
      assistant('I will check first.'),
      {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'Inspect the current state.' }],
      },
      invocation(),
    ];
    const state = convert(messages);
    expect(state.history.map((message) => message.kind)).toEqual(['user', 'assistant']);
    expect(JSON.stringify(state.history)).toContain('I will check first.');
    expect(JSON.stringify(state.history)).toContain(
      '<thinking>Inspect the current state.</thinking>',
    );
    expect(calls(state)).toEqual([
      { toolUseId: 'call_1', name: 'write_file', input: { literal: '\\u0000' } },
    ]);
    expect(state.currentMessage.userInputMessage.userInputMessageContext.toolResults).toEqual([
      {
        toolUseId: 'call_1',
        content: [{ text: INTERRUPTED_TOOL_RESULT_TEXT }],
        status: 'error',
        isError: true,
      },
    ]);
    expect(INTERRUPTED_TOOL_RESULT_TEXT).toContain('execution status and effects are unknown');
    expect(INTERRUPTED_TOOL_RESULT_TEXT).not.toContain('re-run it');
  });

  it('keeps a real result before another trailing invocation without changing it into success', () => {
    const state = convert([
      { role: 'user', content: 'Inspect both.' },
      invocation('first'),
      { role: 'user', content: [result('first', 'permission denied', true)] },
      invocation('second'),
    ]);
    const results = users(state).flatMap((user) => user.userInputMessageContext.toolResults);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      toolUseId: 'first',
      isError: true,
      content: [{ text: 'permission denied' }],
    });
    expect(results[1]).toMatchObject({ toolUseId: 'second', isError: true, status: 'error' });
  });

  it('keeps Kiro content nonempty for an empty assistant prefill', () => {
    const state = convert([{ role: 'user', content: 'Continue.' }, assistant('')]);
    expect(state.history[1]).toMatchObject({ assistantResponseMessage: { content: ' ' } });
  });

  it('does not add a bridge to a request already ending with a user turn', () => {
    const state = convert([
      { role: 'user', content: 'First.' },
      assistant('Previous.'),
      { role: 'user', content: 'Next.' },
    ]);
    expect(state.currentMessage.userInputMessage.content).toBe('Next.');
    expect(JSON.stringify(state)).not.toContain(ASSISTANT_CONTINUATION_TEXT);
  });

  it('still rejects assistant-only input without inventing an original user task', () => {
    expect(() => convert([assistant('prefix')])).toThrow('No user message found');
  });
});

describe('unpaired and conflicting tool results remain quoted evidence', () => {
  it('retains all result text, identifier and error state without inventing a tool invocation', () => {
    const output = 'line one\n"quoted"\\u0000\n\u0000\t尾';
    const messages: Message[] = [{ role: 'user', content: [result('missing_call', output, true)] }];
    const before = structuredClone(messages);
    const state = convert(messages);
    const current = state.currentMessage.userInputMessage;
    expect(current.userInputMessageContext.toolResults).toEqual([]);
    expect(current.userInputMessageContext.tools).toEqual([]);
    expect(calls(state)).toEqual([]);
    expect(current.content).toContain(UNPAIRED_TOOL_RESULT_TEXT);
    expect(quoted(current)).toEqual([
      {
        kind: 'unpaired_tool_result',
        result: {
          toolUseId: 'missing_call',
          content: [{ text: output }],
          isError: true,
          status: 'error',
        },
      },
    ]);
    expect(messages).toEqual(before);
  });

  it.each([
    false,
    true,
  ])('retains orphan result images in their original user turn (historical=%s)', (historical) => {
    const orphan: Message = {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'missing_image_call',
          content: [
            { type: 'text', text: 'Captured output.' },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'QUJDRA==' },
            },
          ],
        },
      ],
    };
    const state = convert(
      historical
        ? [orphan, assistant('Inspecting.'), { role: 'user', content: 'Continue.' }]
        : [orphan],
    );
    const containing = users(state).find((user) =>
      user.content.includes(UNPAIRED_TOOL_RESULT_TEXT),
    );
    expect(containing?.images).toEqual([{ format: 'png', source: { bytes: 'QUJDRA==' } }]);
    expect(quoted(containing!)[0].result.content).toEqual([
      { text: 'Captured output.\n[image attached to this message]' },
    ]);
    expect(calls(state)).toEqual([]);
    expect(users(state).flatMap((user) => user.userInputMessageContext.toolResults)).toEqual([]);
  });

  it.each([
    ['different output', false],
    ['original output', true],
  ])('preserves a conflicting current duplicate (%s, error=%s)', (text, isError) => {
    const state = convert([
      { role: 'user', content: 'Inspect.' },
      invocation(),
      {
        role: 'user',
        content: [result('call_1', 'original output'), result('call_1', text, isError)],
      },
    ]);
    const current = state.currentMessage.userInputMessage;
    expect(current.userInputMessageContext.toolResults).toHaveLength(1);
    expect(current.userInputMessageContext.toolResults[0]).toMatchObject({
      content: [{ text: 'original output' }],
      isError: false,
    });
    expect(current.content).toContain(DUPLICATE_TOOL_RESULT_TEXT);
    expect(quoted(current)).toEqual([
      {
        kind: 'duplicate_tool_result',
        result: {
          toolUseId: 'call_1',
          content: [{ text }],
          isError,
          status: isError ? 'error' : 'success',
        },
      },
    ]);
    expect(calls(state)).toHaveLength(1);
  });

  it('deduplicates identical values while retaining a distinct historical duplicate in place', () => {
    const state = convert([
      { role: 'user', content: 'Inspect.' },
      invocation(),
      { role: 'user', content: [result('call_1', 'first')] },
      assistant('Recorded.'),
      {
        role: 'user',
        content: [result('call_1', 'conflicting', true), result('call_1', 'conflicting', true)],
      },
      assistant('Reviewing the conflict.'),
      { role: 'user', content: [result('call_1', 'first')] },
    ]);
    expect(users(state).flatMap((user) => user.userInputMessageContext.toolResults)).toHaveLength(
      1,
    );
    const evidence = users(state).flatMap(quoted);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      kind: 'duplicate_tool_result',
      result: { content: [{ text: 'conflicting' }], isError: true },
    });
    expect(state.currentMessage.userInputMessage.content).not.toContain(DUPLICATE_TOOL_RESULT_TEXT);
  });

  it('deduplicates identical results within the current turn without adding conflicting evidence', () => {
    const state = convert([
      { role: 'user', content: 'Inspect.' },
      invocation(),
      { role: 'user', content: [result('call_1', 'same'), result('call_1', 'same')] },
    ]);
    const current = state.currentMessage.userInputMessage;
    expect(current.userInputMessageContext.toolResults).toHaveLength(1);
    expect(quoted(current)).toEqual([]);
  });

  it('keeps a conflicting duplicate image attached while retaining the original structured result', () => {
    const state = convert([
      { role: 'user', content: 'Inspect.' },
      invocation(),
      { role: 'user', content: [result('call_1', 'original')] },
      assistant('Recorded.'),
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_1',
            is_error: true,
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: 'WllYWA==' },
              },
            ],
          },
        ],
      },
    ]);
    const current = state.currentMessage.userInputMessage;
    expect(current.images).toEqual([{ format: 'png', source: { bytes: 'WllYWA==' } }]);
    expect(current.userInputMessageContext.toolResults).toEqual([]);
    expect(quoted(current)[0]).toMatchObject({
      kind: 'duplicate_tool_result',
      result: {
        toolUseId: 'call_1',
        isError: true,
        content: [{ text: '[image attached to this message]' }],
      },
    });
    expect(users(state).flatMap((user) => user.userInputMessageContext.toolResults)).toHaveLength(
      1,
    );
    expect(calls(state)).toHaveLength(1);
  });
});
