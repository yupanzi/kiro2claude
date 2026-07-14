/**
 * OpenAI **Responses API** wire 类型(与 Chat Completions 是**两套不同协议**)。
 *
 * Codex CLI 0.122+ 只说 Responses API(`wire_api=chat` 已移除)。请求用
 * `input`(items 数组)+ `instructions` + 扁平 `tools`;响应是 `output`(items)
 * + 语义 SSE 事件流。只覆盖网关实际读写的字段。
 */

// ============================================================================
// 请求
// ============================================================================

/** input message item 的 content part */
export type ResponsesContentPart =
  | { type: 'input_text'; text: string }
  | { type: 'output_text'; text: string }
  | { type: 'input_image'; image_url?: string | { url?: string } }
  | { type: 'refusal'; refusal: string };

export interface ResponsesMessageItem {
  type?: 'message';
  role: 'system' | 'developer' | 'user' | 'assistant';
  content: string | ResponsesContentPart[];
}

export interface ResponsesFunctionCallItem {
  type: 'function_call';
  id?: string;
  call_id: string;
  name: string;
  arguments: string;
}

export interface ResponsesFunctionCallOutputItem {
  type: 'function_call_output';
  call_id: string;
  output: string;
}

export interface ResponsesReasoningItem {
  type: 'reasoning';
  id?: string;
  summary?: unknown[];
  encrypted_content?: string;
}

export type ResponsesInputItem =
  | ResponsesMessageItem
  | ResponsesFunctionCallItem
  | ResponsesFunctionCallOutputItem
  | ResponsesReasoningItem;

/** Responses 工具定义(扁平:name/description/parameters 在顶层) */
export interface ResponsesTool {
  type: string;
  name?: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
}

export interface ResponsesRequest {
  model: string;
  input: string | ResponsesInputItem[];
  instructions?: string;
  tools?: ResponsesTool[];
  tool_choice?: unknown;
  reasoning?: { effort?: string; summary?: string | null };
  max_output_tokens?: number;
  stream?: boolean;
  // 接受但忽略(上游无对应通道 / 网关无状态)
  store?: boolean;
  previous_response_id?: string;
  temperature?: number;
  top_p?: number;
  parallel_tool_calls?: boolean;
}

// ============================================================================
// 响应:output items + response 对象
// ============================================================================

export interface ResponsesUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export interface ResponsesOutputTextPart {
  type: 'output_text';
  text: string;
  annotations: unknown[];
}

/** assistant 文本消息 output item */
export interface ResponsesMessageOutputItem {
  id: string;
  type: 'message';
  role: 'assistant';
  status: 'in_progress' | 'completed';
  content: ResponsesOutputTextPart[];
}

/** 工具调用 output item */
export interface ResponsesFunctionCallOutputItemOut {
  id: string;
  type: 'function_call';
  call_id: string;
  name: string;
  arguments: string;
  status: 'in_progress' | 'completed';
}

/** reasoning summary part(summary_text 通道) */
export interface ResponsesReasoningSummaryPart {
  type: 'summary_text';
  text: string;
}

/**
 * reasoning output item:Claude 明文思维链经 **summary 通道** surface。
 * 只做下行显示(summary 文本);signature/encrypted_content 的多轮 continuation 不做
 * (见踩坑 #17 + response-stream.ts 头注)。GPT 加密 reasoning 无内容 → 不产此 item。
 */
export interface ResponsesReasoningOutputItemOut {
  id: string;
  type: 'reasoning';
  summary: ResponsesReasoningSummaryPart[];
}

export type ResponsesOutputItem =
  | ResponsesMessageOutputItem
  | ResponsesFunctionCallOutputItemOut
  | ResponsesReasoningOutputItemOut;

export interface ResponsesObject {
  id: string;
  object: 'response';
  created_at: number;
  status: 'in_progress' | 'completed' | 'failed' | 'incomplete';
  model: string;
  output: ResponsesOutputItem[];
  usage: ResponsesUsage | null;
  // Codex/SDK 常读这几个;给中性默认值避免解析报错
  error: null;
  incomplete_details: null;
  metadata: Record<string, unknown>;
}

// 错误信封:Responses 与 Chat Completions 同形 {error:{...}},复用 chat 层的
// createOpenAiError / OpenAiErrorBody(../types.js),不再重复定义。committed 后的
// 流式 in-band 错误走 ResponsesEventEncoder.errorLine(不同:type:"error" 事件)。
