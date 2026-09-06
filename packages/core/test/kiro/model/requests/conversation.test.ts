import { validate as isUuid, version as uuidVersion } from 'uuid';
import { describe, expect, it } from 'vitest';
import {
  attachToolUses,
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

/**
 * kiro-cli 2.21.1 实测：`messageId`（客户端生成的 UUID v4）**只出现在带 toolUses
 * 的 assistant 消息上**，纯文本那条没有。两者绑定，所以只有 `attachToolUses`
 * 一个设置点。
 *
 * ★ 同批探针实测还证明它是**每条消息一个、跨轮恒定**（同一条消息的 messageId 在
 * 246 轮工具往返请求里只有一个取值）。所以派生必须确定性——随机值会让历史前缀
 * 每轮变字节、打掉上游 prefix 缓存。守卫在下面两条。
 */
describe('attachToolUses', () => {
  const TOOL_USE = { toolUseId: 'tooluse_1', name: 'Read', input: { file_path: '/a' } };

  it('挂 toolUses 时一并生成 UUID v4 messageId', () => {
    const msg = createAssistantMessage('ok');
    attachToolUses(msg, [TOOL_USE]);

    expect(msg.toolUses).toEqual([TOOL_USE]);
    const id = msg.messageId ?? '';
    expect(isUuid(id) && uuidVersion(id) === 4).toBe(true);
  });

  it('反向守卫：无 toolUses 时不设 messageId，也不设空 toolUses 数组', () => {
    const msg = createAssistantMessage('纯文本回复');
    attachToolUses(msg, []);

    expect(msg.messageId).toBeUndefined();
    expect(msg.toolUses).toBeUndefined();
    expect(JSON.stringify(msg)).not.toContain('toolUses');
  });

  it('同一条消息跨轮恒定：相同 toolUseId → 相同 messageId（保住上游 prefix 缓存）', () => {
    const a = createAssistantMessage('x');
    const b = createAssistantMessage('x');
    attachToolUses(a, [TOOL_USE]);
    attachToolUses(b, [TOOL_USE]);

    // 每请求重新转换一遍历史,随机值会让历史前缀每轮换字节
    expect(a.messageId).toBe(b.messageId);
  });

  it('不同消息互不相同：不同 toolUseId → 不同 messageId', () => {
    const a = createAssistantMessage('x');
    const b = createAssistantMessage('y');
    attachToolUses(a, [TOOL_USE]);
    attachToolUses(b, [{ ...TOOL_USE, toolUseId: 'tooluse_2' }]);

    expect(a.messageId).not.toBe(b.messageId);
    expect(uuidVersion(b.messageId ?? '')).toBe(4);
  });
});
