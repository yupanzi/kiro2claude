import { describe, expect, it } from 'vitest';
import {
  type ConversationState,
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

describe('ConversationState', () => {
  it('test_conversation_state_new', () => {
    const state = createConversationState('conv-123');
    state.agentTaskType = 'vibe';
    state.chatTriggerType = 'MANUAL';

    expect(state.conversationId).toBe('conv-123');
    expect(state.agentTaskType).toBe('vibe');
    expect(state.chatTriggerType).toBe('MANUAL');
  });

  it('returns a bare structural shell with no origin/envState', () => {
    // 工厂层只铺结构占位——语义字段（origin / envState）一律由 converter
    // 在每次请求处理时注入。origin 来自 client-profile，envState 依赖
    // runtime 的 process.cwd()，两者都不是工厂层能决定的。
    const msg = createUserInputMessage('Hello', 'claude-3-5-sonnet');

    expect(msg.content).toBe('Hello');
    expect(msg.modelId).toBe('claude-3-5-sonnet');
    expect(msg.origin).toBeUndefined();
    expect(msg.userInputMessageContext.envState).toBeUndefined();
  });

  // The Kiro wire format for conversation history is an **untagged union**:
  // each message is serialized directly as its variant payload, with no
  // discriminator field. Our internal `Message` type is a discriminated
  // union keyed by `kind`, so `serializeKiroRequest` must strip the `kind`
  // field before emitting JSON. Going through the real serializer here
  // (instead of hand-calling `serializeMessage`) is critical — otherwise
  // the test can silently pass while production code still leaks the tag.
  it('test_history_serialize', () => {
    const history: Message[] = [
      { kind: 'user', userInputMessage: createUserMessage('Hello', 'claude-3-5-sonnet') },
      {
        kind: 'assistant',
        assistantResponseMessage: createAssistantMessage('Hi! How can I help you?'),
      },
    ];

    const state = createConversationState('conv-123');
    state.history = history;
    const req: KiroRequest = { conversationState: state };
    const json = serializeKiroRequest(req);

    expect(json).toContain('userInputMessage');
    expect(json).toContain('assistantResponseMessage');
    // The untagged wire format must never emit the `kind` discriminator.
    expect(json).not.toContain('"kind"');
  });

  // Asserts the `ConversationState` wire format: `conversationId`,
  // `agentTaskType`, and `currentMessage` are all present with the
  // expected JSON shape. Additionally, an empty `history: []` MUST be
  // omitted from the wire output — the Kiro upstream rejects requests
  // that carry an empty history array alongside a `currentMessage`.
  it('test_conversation_state_serialize', () => {
    const state: ConversationState = createConversationState('conv-123');
    state.agentTaskType = 'vibe';
    state.currentMessage = {
      userInputMessage: {
        ...createUserInputMessage('Hello', 'claude-3-5-sonnet'),
      },
    };

    const req: KiroRequest = { conversationState: state };
    const json = serializeKiroRequest(req);

    expect(json).toContain('"conversationId":"conv-123"');
    expect(json).toContain('"agentTaskType":"vibe"');
    expect(json).toContain('"content":"Hello"');
    // Empty history must be stripped from the wire output entirely.
    expect(json).not.toContain('"history"');
  });
});
