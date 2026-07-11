import { describe, expect, it } from 'vitest';
import {
  createAssistantMessage,
  createConversationState,
  createUserInputMessage,
  createUserMessage,
  type Message,
} from '../../../../src/kiro/model/requests/conversation.js';
import {
  type KiroRequest,
  serializeKiroRequest,
} from '../../../../src/kiro/model/requests/kiro.js';

describe('KiroRequest', () => {
  it('test_kiro_request_deserialize', () => {
    const json = `{
      "conversationState": {
        "conversationId": "conv-456",
        "currentMessage": {
          "userInputMessage": {
            "content": "Test message",
            "modelId": "claude-3-5-sonnet",
            "userInputMessageContext": {}
          }
        }
      }
    }`;

    const request = JSON.parse(json) as KiroRequest;
    expect(request.conversationState.conversationId).toBe('conv-456');
    expect(request.conversationState.currentMessage.userInputMessage.content).toBe('Test message');
  });

  // Regression for the "history kind discriminator leak" bug.
  //
  // The Kiro wire format for `Message` is an **untagged union**:
  // `{"userInputMessage": {...}}` or `{"assistantResponseMessage": {...}}`
  // — no discriminator field. We represent it as a TS discriminated union
  // keyed by `kind`, and a naive `JSON.stringify` would emit
  // `{"kind":"user", ...}`, polluting the wire protocol.
  // `serializeKiroRequest` must strip the `kind` field so the output
  // exactly matches the untagged wire format.
  it('test_kiro_request_serialize_strips_message_discriminator', () => {
    const state = createConversationState('conv-123');
    state.currentMessage = {
      userInputMessage: createUserInputMessage('Latest turn', 'claude-3-5-sonnet'),
    };
    const history: Message[] = [
      {
        kind: 'user',
        userInputMessage: createUserMessage('Hello', 'claude-3-5-sonnet'),
      },
      {
        kind: 'assistant',
        assistantResponseMessage: createAssistantMessage('Hi! How can I help you?'),
      },
    ];
    state.history = history;

    const req: KiroRequest = { conversationState: state };
    const json = serializeKiroRequest(req);
    const parsed = JSON.parse(json) as {
      conversationState: {
        history: Array<Record<string, unknown>>;
      };
    };

    // Must contain the untagged payload keys.
    expect(json).toContain('userInputMessage');
    expect(json).toContain('assistantResponseMessage');
    // Must NOT contain the TS-only discriminator.
    expect(json).not.toContain('"kind":"user"');
    expect(json).not.toContain('"kind":"assistant"');

    // Structural check: each history entry has exactly the variant payload keys.
    expect(parsed.conversationState.history).toHaveLength(2);
    expect(parsed.conversationState.history[0]).not.toHaveProperty('kind');
    expect(parsed.conversationState.history[0]).toHaveProperty('userInputMessage');
    expect(parsed.conversationState.history[1]).not.toHaveProperty('kind');
    expect(parsed.conversationState.history[1]).toHaveProperty('assistantResponseMessage');
  });

  // Regression for empty-history handling.
  //
  // The Kiro wire format omits `history` entirely when it is empty — the
  // backend has been observed to reject requests that carry both an empty
  // `"history": []` and a populated `currentMessage`. The TS interface has
  // `history: Message[]` as non-optional, so without a custom replacer,
  // `JSON.stringify` would always emit `"history": []`. `serializeKiroRequest`
  // strips empty history arrays to keep the wire format strict.
  it('test_kiro_request_serialize_omits_empty_history', () => {
    const state = createConversationState('conv-empty');
    state.currentMessage = {
      userInputMessage: createUserInputMessage('Single turn', 'claude-3-5-sonnet'),
    };
    // history starts as [] from createConversationState.

    const req: KiroRequest = { conversationState: state };
    const json = serializeKiroRequest(req);
    const parsed = JSON.parse(json) as {
      conversationState: Record<string, unknown>;
    };

    expect(json).not.toContain('"history"');
    expect(parsed.conversationState).not.toHaveProperty('history');
  });

  // Non-empty history must still serialize (negative control for the
  // empty-history stripping above — guard against an over-eager replacer).
  it('test_kiro_request_serialize_preserves_non_empty_history', () => {
    const state = createConversationState('conv-nonempty');
    state.currentMessage = {
      userInputMessage: createUserInputMessage('Turn N', 'claude-3-5-sonnet'),
    };
    state.history = [
      {
        kind: 'user',
        userInputMessage: createUserMessage('Turn N-1', 'claude-3-5-sonnet'),
      },
    ];

    const req: KiroRequest = { conversationState: state };
    const json = serializeKiroRequest(req);
    const parsed = JSON.parse(json) as {
      conversationState: { history?: Array<Record<string, unknown>> };
    };

    expect(parsed.conversationState.history).toBeDefined();
    expect(parsed.conversationState.history).toHaveLength(1);
  });
});
