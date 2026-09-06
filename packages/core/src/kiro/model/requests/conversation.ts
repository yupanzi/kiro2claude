import { createHash } from 'node:crypto';
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
  /**
   * 客户端生成的 UUID v4。kiro-cli 2.21.1 实测：**只在带 `toolUses` 的那条** assistant
   * 消息上出现；用伪造的 event-stream 驱动、流里没有该字段时它照样生成，可见是本地产的
   * 而非上游回传。用途看着是遥测关联（与 `SendTelemetryEvent` 的
   * `chatAddMessageEvent.messageId` 同名），网关不发遥测、功能上不依赖它——补它只为
   * 伪装画像不漏字段。由 `attachToolUses` 统一设置。
   *
   * ★ **每条消息一个,不是每次请求一个**。2.21.1 探针实测(伪造 event-stream 驱动 246 轮
   * 工具往返):同一条 assistant 消息的 messageId 在**全部 246 个**请求里恒为同一个值
   * ——kiro-cli 收到消息时铸一次、随历史持久化。故本项目也必须**确定性派生**,见
   * `deriveMessageId`。
   */
  messageId?: string;
}

export function createAssistantMessage(content: string): AssistantMessage {
  return { content };
}

/**
 * 从 `toolUseId` 确定性派生一个 UUID v4 **形状**的 messageId。
 *
 * ★ 为什么不能用 `uuidv4()`:网关每收到一个请求就把整段历史重新转换一次,随机 id
 * 会让**历史前缀的字节**每轮都变。上游的缓存红利正是按相同 prefix / session 给的
 * (踩坑「core 不发 cachePoint」),于是从第一次工具调用起,越长的 agentic 会话越
 * 稳定地丢缓存——为一个功能上根本不被使用的字段付真金白银。
 *
 * kiro-cli 那边是**每条消息铸一次并随历史持久化**(2.21.1 探针实测:同一条消息的
 * messageId 在 246 轮请求里恒定),所以「稳定」才是忠于原形态的做法,不是取巧。
 *
 * 种子取 `toolUses[0].toolUseId`:它由上游生成、经客户端原样回传,在同一条消息上
 * 天然稳定且跨消息唯一——正好是「消息身份」的现成载体。加前缀是防止这个派生值与
 * 别处可能出现的裸 hash 撞用途。
 */
function deriveMessageId(seed: string): string {
  const bytes = createHash('sha256').update(`kiro2claude:messageId:${seed}`).digest();
  const b = Buffer.from(bytes.subarray(0, 16));
  // RFC 4122：version 4 + variant 10xx，让派生值与真 uuidv4 在形状上不可区分
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = b.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * 挂载 toolUses，并按 kiro-cli 的形态一并补 `messageId`——两者绑定出现，故这里是
 * 唯一设置点。`converter.ts` 有两处构造 assistant 历史消息（单条与合并多条），各写
 * 一遍 `if (len>0) msg.toolUses = …` 的话，补字段时必然漏一处。
 *
 * 空数组是 no-op：Kiro 对 `toolUses: []` 与不发该字段的处理未验证，保持不发。
 */
export function attachToolUses(msg: AssistantMessage, toolUses: ToolUseEntry[]): void {
  if (toolUses.length === 0) return;
  msg.toolUses = toolUses;
  msg.messageId = deriveMessageId(toolUses[0].toolUseId);
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
