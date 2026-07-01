import type { Tool, ToolResult, ToolUseEntry } from './tool.js';

/** 对话状态 */
export interface ConversationState {
  agentContinuationId?: string;
  agentTaskType?: string;
  chatTriggerType?: string;
  currentMessage: CurrentMessage;
  conversationId: string;
  history: Message[];
}

export function createConversationState(conversationId: string): ConversationState {
  return {
    conversationId,
    currentMessage: { userInputMessage: defaultUserInputMessage() },
    history: [],
  };
}

/** 当前消息容器 */
export interface CurrentMessage {
  userInputMessage: UserInputMessage;
}

/** 用户输入消息 */
export interface UserInputMessage {
  userInputMessageContext: UserInputMessageContext;
  content: string;
  modelId: string;
  images: KiroImage[];
  origin?: string;
  /**
   * kiro-cli 2.6.0+ 原生 reasoning 配置（仅 currentMessage 上设置）。
   * 等价于 kiro-cli `--effort <level>` flag，让上游决定 thinking 强度。
   * 仅对支持 native reasoning 的 model（4.7/4.8）有效，其它 model 上忽略。
   */
  reasoning?: ReasoningConfig;
}

/** Kiro 原生 reasoning effort 等级（与 kiro-cli `--effort` 取值一一对应） */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** kiro-cli wire format: `userInputMessage.reasoning` 字段 */
export interface ReasoningConfig {
  effort: EffortLevel;
}

// 工厂只铺结构占位：`content`、`modelId`、`images`、空 `userInputMessageContext`。
// 语义字段（`origin`、`envState`）全部由 converter 层在每次请求处理时注入——
// `origin` 来自 client-profile、`envState` 依赖 runtime 的 process.cwd()，
// 都不是工厂层能或应该决定的。converter 是 origin 的单一写入点，避免工厂
// 硬编码的默认值和 client-profile 漂移。
function defaultUserInputMessage(): UserInputMessage {
  return {
    userInputMessageContext: { toolResults: [], tools: [] },
    content: '',
    modelId: '',
    images: [],
  };
}

export function createUserInputMessage(content: string, modelId: string): UserInputMessage {
  return {
    ...defaultUserInputMessage(),
    content,
    modelId,
  };
}

/** 用户输入消息上下文 */
export interface UserInputMessageContext {
  toolResults: ToolResult[];
  tools: Tool[];
  /**
   * 环境状态，与 kiro-cli 实测的 payload 一致。
   * 不加这个字段上游也能工作，但客户端画像会偏离 kiro-cli；
   * 加上后 `operatingSystem` + `currentWorkingDirectory` 在两端都有。
   */
  envState?: {
    operatingSystem?: string;
    currentWorkingDirectory?: string;
  };
}

/** Kiro 图片 */
export interface KiroImage {
  format: string;
  source: KiroImageSource;
}

export interface KiroImageSource {
  bytes: string;
}

export function createKiroImage(format: string, base64Data: string): KiroImage {
  return { format, source: { bytes: base64Data } };
}

/** 历史消息（discriminated union） */
export type Message =
  | { kind: 'user'; userInputMessage: UserMessage }
  | { kind: 'assistant'; assistantResponseMessage: AssistantMessage };

/** 用户消息（历史记录中使用） */
export interface UserMessage {
  content: string;
  modelId: string;
  origin?: string;
  images: KiroImage[];
  userInputMessageContext: UserInputMessageContext;
}

export function createUserMessage(content: string, modelId: string): UserMessage {
  return {
    content,
    modelId,
    images: [],
    userInputMessageContext: { toolResults: [], tools: [] },
  };
}

/** 助手消息（历史记录中使用） */
export interface AssistantMessage {
  content: string;
  toolUses?: ToolUseEntry[];
}

export function createAssistantMessage(content: string): AssistantMessage {
  return { content };
}

/**
 * 序列化 Message 为 Kiro API 格式
 * 注意: Kiro API 使用 untagged union，所以不包含 kind 字段
 */
export function serializeMessage(msg: Message): Record<string, unknown> {
  if (msg.kind === 'user') {
    return { userInputMessage: msg.userInputMessage };
  }
  return { assistantResponseMessage: msg.assistantResponseMessage };
}

/** 反序列化 Kiro API 格式到 Message */
export function deserializeMessage(obj: Record<string, unknown>): Message {
  if ('userInputMessage' in obj) {
    return { kind: 'user', userInputMessage: obj.userInputMessage as UserMessage };
  }
  return {
    kind: 'assistant',
    assistantResponseMessage: obj.assistantResponseMessage as AssistantMessage,
  };
}
