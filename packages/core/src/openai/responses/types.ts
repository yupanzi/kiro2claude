/**
 * OpenAI **Responses API** wire 类型(与 Chat Completions 是**两套不同协议**)。
 *
 * Codex CLI 0.122+ 只说 Responses API(`wire_api=chat` 已移除)。请求用
 * `input`(items 数组)+ `instructions` + 扁平 `tools`;响应是 `output`(items)
 * + 语义 SSE 事件流。只覆盖网关实际读写的字段。
 *
 * ★ **两套请求形态**(踩坑「Codex code mode」):Codex 对**内部已知**的模型名
 * (实测 `gpt-5.6-sol`)切到 **code mode**——`tools` 与 `instructions` 顶层字段
 * 双双消失,工具改由 `input` 里的 `additional_tools` item 携带,且含 `type:"custom"`
 * 的 freeform 工具;不认识的名字(实测 `gpt-5-codex` / `o3`)才 fallback 到标准
 * 顶层 `tools`。两套都必须支持,判别只看**字段在不在**、不看模型名。
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

/**
 * 工具结果项的公共形状。★ `output` **两种形态并存**:code mode 下工具真实执行的结果是
 * **content part 数组**,而 Codex router 拒绝调用(unsupported call)与 fallback 形态是
 * **字符串**。两种 item 共用 converter.ts `convertInputItem` 的同一条归一路径(为什么
 * 必须归一,见那里)。
 */
interface ResponsesToolOutputItem {
  call_id: string;
  output: string | ResponsesContentPart[];
}

/** function 工具的结果项。 */
export interface ResponsesFunctionCallOutputItem extends ResponsesToolOutputItem {
  type: 'function_call_output';
}

export interface ResponsesReasoningItem {
  type: 'reasoning';
  id?: string;
  summary?: unknown[];
  encrypted_content?: string;
}

/**
 * code mode 的工具投递通道:工具不在顶层 `tools`,而是作为 `input` 的**第一个 item**
 * 送来(role 是 `developer`,但**不是** message——误当 message 会既丢工具又把它落进
 * 兜底分支)。见文件头「两套请求形态」。
 */
export interface ResponsesAdditionalToolsItem {
  type: 'additional_tools';
  role?: string;
  tools?: ResponsesTool[];
}

/**
 * freeform(`type:"custom"`)工具的调用历史项。★ `input` 是**裸字符串**(工具原始
 * 文本,如 JS 源码),不是 `function_call.arguments` 那样的 JSON 串。
 */
export interface ResponsesCustomToolCallItem {
  type: 'custom_tool_call';
  id?: string;
  call_id: string;
  name: string;
  input: string;
  status?: string;
}

/** freeform(`type:"custom"`)工具的结果项,形态与 function 侧一致。 */
export interface ResponsesCustomToolCallOutputItem extends ResponsesToolOutputItem {
  type: 'custom_tool_call_output';
}

export type ResponsesInputItem =
  | ResponsesMessageItem
  | ResponsesFunctionCallItem
  | ResponsesFunctionCallOutputItem
  | ResponsesReasoningItem
  | ResponsesAdditionalToolsItem
  | ResponsesCustomToolCallItem
  | ResponsesCustomToolCallOutputItem;

/**
 * Responses 工具定义(扁平:name/description/parameters 在顶层)。
 *
 * `type` 实测有四种:`function`(标准)、`custom`(freeform,带 `format` 语法约束、
 * **无** `parameters`)、`namespace`(容器,子工具在 `tools`)、`web_search`(hosted)。
 *
 * ★ 新版 Codex 的 code mode 会把 function/custom 工具再折进一层名为 **`functions`** 的
 * namespace 容器(`{type:'namespace',name:'functions',tools:[…]}`),子工具形状不变。
 * 两套形态都要接得住;展不展开、为什么只展开这一个,见 converter.ts
 * `expandDefaultNamespace`(唯一真相源)。
 */
export interface ResponsesTool {
  type: string;
  name?: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
  /** freeform 工具的语法约束(实测 `{type:'grammar',syntax:'lark',definition}`)。上游无对应通道,丢弃。 */
  format?: { type?: string; syntax?: string; definition?: string };
  /** `type:'namespace'` 的子工具。展开规则见 converter.ts `expandDefaultNamespace`。 */
  tools?: ResponsesTool[];
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
  // plugin 注入的命名空间扩展字段（`kiro_metering` / `kiro_derived`）。标准三字段
  // 恒为 number（显式声明优先）；索引签名只为 `addExtension` 的扩展开门。Codex serde
  // 忽略未知字段，安全。
  [key: string]: unknown;
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
 * (见踩坑「Codex 只说 Responses」 + response-stream.ts 头注)。GPT 加密 reasoning 无内容 → 不产此 item。
 */
export interface ResponsesReasoningOutputItemOut {
  id: string;
  type: 'reasoning';
  summary: ResponsesReasoningSummaryPart[];
}

/**
 * freeform 工具调用 output item(code mode)。与 `function_call` 的区别:载荷字段是
 * `input`(裸文本)而非 `arguments`(JSON 串),流式事件也换成
 * `custom_tool_call_input.delta/done`(见 response-stream.ts 头注释)。
 */
export interface ResponsesCustomToolCallOutItem {
  id: string;
  type: 'custom_tool_call';
  call_id: string;
  name: string;
  input: string;
  status: 'in_progress' | 'completed';
}

export type ResponsesOutputItem =
  | ResponsesMessageOutputItem
  | ResponsesFunctionCallOutputItemOut
  | ResponsesReasoningOutputItemOut
  | ResponsesCustomToolCallOutItem;

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
