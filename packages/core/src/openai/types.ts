/**
 * OpenAI Chat Completions wire 类型。
 *
 * 只覆盖网关实际读写的字段;采样类参数(temperature/top_p/…)与不支持的特性
 * (n>1/logprobs/…)不建模,由 schema 的 passthrough 接住、converter 忽略
 * (见 openai/converter.ts 与方案「边界处置」)。
 *
 * `reasoning_content` 是非标准但通行的推理透传字段(DeepSeek-R1 / vLLM /
 * OpenRouter 约定):Claude 模型的明文 thinking 经此透传;GPT-5.6 的 reasoning
 * 是加密的(上游 redactedContent),无内容可透传,故 GPT 响应不含该字段。
 */

// ============================================================================
// 请求
// ============================================================================

/** content part(user 消息的多模态数组元素) */
export type ChatCompletionContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: string } };

/** 请求侧 assistant 消息里回填的工具调用 */
export interface ChatCompletionMessageToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** 一条 chat 消息 */
export interface ChatCompletionRequestMessage {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool';
  /** string | parts[] | null(assistant 仅带 tool_calls 时为 null) */
  content?: string | ChatCompletionContentPart[] | null;
  /** assistant 消息的工具调用 */
  tool_calls?: ChatCompletionMessageToolCall[];
  /** tool 消息:对应的 tool_call id */
  tool_call_id?: string;
  /** 可选,忽略(Claude 无 per-message name) */
  name?: string;
}

/** 工具定义(仅 function 类型) */
export interface ChatCompletionTool {
  type: string;
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

/** POST /chat/completions 请求体(宽松;未列字段经 passthrough 接住后忽略) */
export interface ChatCompletionRequest {
  model: string;
  messages: ChatCompletionRequestMessage[];
  tools?: ChatCompletionTool[];
  tool_choice?: unknown;
  reasoning_effort?: string;
  max_completion_tokens?: number;
  max_tokens?: number;
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  user?: string;
  /** 接受但忽略(上游无对应通道) */
  n?: number;
  temperature?: number;
  top_p?: number;
  response_format?: unknown;
}

// ============================================================================
// 响应:usage
// ============================================================================

export interface OpenAiUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

// ============================================================================
// 响应:非流式 chat.completion
// ============================================================================

/** finish_reason(Claude stop_reason 映射的结果) */
export type OpenAiFinishReason = 'stop' | 'tool_calls' | 'length' | 'content_filter';

export interface ChatCompletionResponseToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatCompletionResponseMessage {
  role: 'assistant';
  content: string | null;
  /** 非标准:明文推理透传(Claude thinking);GPT 加密 reasoning 时省略 */
  reasoning_content?: string;
  tool_calls?: ChatCompletionResponseToolCall[];
}

export interface ChatCompletionChoice {
  index: number;
  message: ChatCompletionResponseMessage;
  finish_reason: OpenAiFinishReason;
  logprobs: null;
}

export interface ChatCompletion {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage: OpenAiUsage;
}

// ============================================================================
// 响应:流式 chat.completion.chunk
// ============================================================================

/** 流式 delta 里的工具调用增量(name 整发、arguments 拼接、index 解复用) */
export interface ChatCompletionChunkToolCall {
  index: number;
  id?: string;
  type?: 'function';
  function?: { name?: string; arguments?: string };
}

export interface ChatCompletionChunkDelta {
  role?: 'assistant';
  content?: string | null;
  /** 非标准:推理增量透传 */
  reasoning_content?: string;
  tool_calls?: ChatCompletionChunkToolCall[];
}

export interface ChatCompletionChunkChoice {
  index: number;
  delta: ChatCompletionChunkDelta;
  finish_reason: OpenAiFinishReason | null;
  logprobs: null;
}

export interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: ChatCompletionChunkChoice[];
  /** 仅在 stream_options.include_usage 且为最后一个 usage-only chunk 时出现 */
  usage?: OpenAiUsage | null;
}

// ============================================================================
// /models
// ============================================================================

export interface OpenAiModel {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
}

export interface OpenAiModelsResponse {
  object: 'list';
  data: OpenAiModel[];
}

// ============================================================================
// 错误信封(OpenAI 形状)
// ============================================================================

export interface OpenAiErrorBody {
  error: {
    message: string;
    type: string;
    param: string | null;
    code: string | null;
  };
}

/**
 * 构造 OpenAI 形状的错误体。message 必须中性(防泄漏后端身份,与 claude/
 * error-mapper 同规矩)。type 常用值:invalid_request_error / api_error /
 * overloaded_error / authentication_error。
 */
export function createOpenAiError(
  message: string,
  type: string,
  code: string | null = null,
  param: string | null = null,
): OpenAiErrorBody {
  return { error: { message, type, param, code } };
}
