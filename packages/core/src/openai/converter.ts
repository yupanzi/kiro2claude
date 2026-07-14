/**
 * OpenAI ChatCompletionRequest → Claude MessagesRequest。
 *
 * 产出 Claude 内部请求对象后,交给现有 `convertRequest`(claude/converter.ts)
 * 复用全部下游处理:历史构建、tool_use/tool_result 配对校验、native
 * reasoning.effort 注入、envState 回填、身份覆写等。**不重复**这些逻辑。
 *
 * 映射要点:
 *   - system/developer 消息 → `system[]`(developer 是 GPT 对 system 的改名)。
 *   - user string/parts(image_url data: → image 块;远程 URL → 中性占位)。
 *   - assistant.tool_calls → tool_use 块(arguments 字符串 JSON.parse → input)。
 *   - tool 消息 → user 消息带 tool_result 块(tool_call_id → tool_use_id)。
 *   - tools[].function → {name,description,input_schema}。tool_choice='none' → 丢 tools。
 *   - reasoning_effort(minimal→low,其余透传) → thinking(adaptive)+output_config.effort
 *     → 经 mapThinkingToEffort 出 reasoning.effort。缺省不注入。
 */

import type {
  Message as ClaudeMessage,
  ContentBlock,
  MessagesRequest,
  Tool,
} from '../claude/types.js';
import { getLogger } from '../shared/logger.js';
import type {
  ChatCompletionContentPart,
  ChatCompletionRequest,
  ChatCompletionRequestMessage,
} from './types.js';

/**
 * 远程 http(s) image_url 无法转发:上游只吃 base64 image,网关不代抓外链。
 * 留中性文本占位,让模型知道「这里有张读不了的图」而非静默丢弃后幻觉。
 * Chat 与 Responses 两端共用(单一真相源,responses/converter.ts 直接 import)。
 */
export const REMOTE_IMAGE_PLACEHOLDER =
  '[An image URL was provided here, but this service only accepts inline base64 image data, ' +
  'not remote URLs, so the image was not delivered to the model.]';

/**
 * OpenAI reasoning_effort → Kiro effort 等级字符串(供 output_config.effort)。
 * Chat Completions 与 Responses 两个端点共用(单一真相源)。
 */
export function mapReasoningEffort(effort: string | undefined): string | undefined {
  if (!effort) return undefined;
  const e = effort.toLowerCase();
  if (e === 'minimal') return 'low';
  if (e === 'low' || e === 'medium' || e === 'high' || e === 'xhigh' || e === 'max') return e;
  return undefined; // 未知取值:不注入,走 baseline
}

/**
 * Kiro effort 等级 → MessagesRequest 的 reasoning 注入(adaptive thinking +
 * output_config.effort)。effort 缺省 → 两者皆 undefined(走 baseline)。
 * Chat 与 Responses 两端共用。注:adaptive 路径的 effort **完全**由
 * output_config.effort 决定;budget_tokens 只在 type:'enabled' 分支被
 * mapThinkingToEffort 读取,故此处 20000 是占位值(adaptive 下不参与 effort 计算)。
 */
export function buildReasoningConfig(
  effort: string | undefined,
): Pick<MessagesRequest, 'thinking' | 'output_config'> {
  if (!effort) return { thinking: undefined, output_config: undefined };
  return {
    thinking: { type: 'adaptive', budget_tokens: 20000 },
    output_config: { effort },
  };
}

/**
 * OpenAI 工具字段(两端 wire 形态不同:chat 嵌在 function 下、responses 扁平)
 * → Claude Tool。仅收敛 description/input_schema 的类型守卫这段两端一致的构造;
 * 各端只负责抽出各自 wire 位置的 name/description/parameters 传入。
 */
export function buildClaudeTool(name: string, description: unknown, parameters: unknown): Tool {
  return {
    name,
    description: typeof description === 'string' ? description : undefined,
    input_schema:
      parameters && typeof parameters === 'object'
        ? (parameters as Record<string, unknown>)
        : undefined,
  };
}

/**
 * 把连续的「仅含 tool_result 块」user 消息合并成一条(镜像 Anthropic wire:并行
 * 工具结果打包进单条 user 消息)。OpenAI Chat 的 `tool` 消息、Responses 的
 * `function_call_output` item 都是**每结果一条**独立消息;不合并会让 convertRequest
 * 的 buildHistory 把靠前的结果当「trailing orphan user」、补一个模型从未产出的
 * 幻影 assistant('OK'),破坏并行工具调用(Codex 常见)的多轮语义。两端共用。
 */
export function coalesceToolResultMessages(messages: ClaudeMessage[]): ClaudeMessage[] {
  const isToolResultOnly = (m: ClaudeMessage): boolean =>
    m.role === 'user' &&
    Array.isArray(m.content) &&
    m.content.length > 0 &&
    m.content.every((b) => b.type === 'tool_result');

  const out: ClaudeMessage[] = [];
  for (const m of messages) {
    const last = out[out.length - 1];
    if (last && isToolResultOnly(last) && isToolResultOnly(m)) {
      (last.content as ContentBlock[]).push(...(m.content as ContentBlock[]));
    } else {
      out.push(m);
    }
  }
  return out;
}

/**
 * 解析 data: base64 URI → {media_type, data};非 data URI 返回 undefined。两端共用。
 * 容忍媒体类型与 `;base64` 之间的可选参数段(如 `data:image/png;charset=utf-8;base64,`)
 * ——media_type 仍只取基础类型(首个 `;` 前),参数对 base64 图片解码无意义,丢弃。
 */
export function parseDataUri(url: string): { media_type: string; data: string } | undefined {
  const m = /^data:([^;,]+)(?:;[^;,]+)*;base64,([\s\S]*)$/.exec(url);
  if (!m) return undefined;
  return { media_type: m[1], data: m[2] };
}

/** 从 OpenAI content(string | parts[])抽纯文本(忽略非 text part)。 */
function extractTextContent(content: ChatCompletionRequestMessage['content']): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const p of content) {
      if (p && typeof p === 'object' && p.type === 'text' && typeof p.text === 'string') {
        parts.push(p.text);
      }
    }
    return parts.join('\n');
  }
  return '';
}

/** user 消息 content → Claude content(string 原样;parts → ContentBlock[])。 */
function convertUserContent(
  content: ChatCompletionRequestMessage['content'],
): string | ContentBlock[] {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const blocks: ContentBlock[] = [];
  for (const part of content as ChatCompletionContentPart[]) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text' && typeof part.text === 'string') {
      blocks.push({ type: 'text', text: part.text });
    } else if (part.type === 'image_url' && part.image_url?.url) {
      const parsed = parseDataUri(part.image_url.url);
      if (parsed) {
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: parsed.media_type, data: parsed.data },
        });
      } else {
        blocks.push({ type: 'text', text: REMOTE_IMAGE_PLACEHOLDER });
        getLogger().warn({ msg: 'openai: remote image_url unsupported, inserted placeholder' });
      }
    }
  }
  return blocks;
}

/** assistant 消息 → Claude assistant(text 块 + tool_calls → tool_use 块)。 */
function convertAssistantMessage(msg: ChatCompletionRequestMessage): ClaudeMessage {
  const blocks: ContentBlock[] = [];

  const text = extractTextContent(msg.content);
  if (text) blocks.push({ type: 'text', text });

  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      if (!tc || tc.type !== 'function' || !tc.function) continue;
      let input: unknown = {};
      const args = tc.function.arguments;
      if (typeof args === 'string' && args.trim()) {
        try {
          input = JSON.parse(args);
        } catch (e) {
          getLogger().warn({
            msg: 'openai: assistant tool_call arguments JSON parse failed',
            tool_call_id: tc.id,
            error: String(e),
          });
          input = {};
        }
      }
      blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
    }
  }

  // 无任何块(content=null 且无 tool_calls)→ 空字符串,Claude converter 会兜底占位。
  return { role: 'assistant', content: blocks.length > 0 ? blocks : '' };
}

/** tool 消息 → Claude user 消息带 tool_result 块(配对由 convertRequest 处理)。 */
function convertToolMessage(msg: ChatCompletionRequestMessage): ClaudeMessage {
  const text = extractTextContent(msg.content);
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: msg.tool_call_id, content: text }],
  };
}

/** OpenAI function tools → Claude tools(丢弃非 function 类型)。 */
function convertTools(tools: ChatCompletionRequest['tools']): Tool[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const out: Tool[] = [];
  for (const t of tools) {
    if (!t || typeof t !== 'object' || t.type !== 'function' || !t.function) {
      getLogger().warn({
        msg: 'openai: non-function tool ignored',
        tool_type: (t as { type?: unknown } | undefined)?.type,
      });
      continue;
    }
    if (typeof t.function.name !== 'string') continue;
    out.push(buildClaudeTool(t.function.name, t.function.description, t.function.parameters));
  }
  return out.length > 0 ? out : undefined;
}

/**
 * 主转换:ChatCompletionRequest → MessagesRequest。
 */
export function convertOpenAiRequest(req: ChatCompletionRequest): MessagesRequest {
  const systemParts: string[] = [];
  const messages: ClaudeMessage[] = [];

  for (const msg of req.messages ?? []) {
    if (!msg || typeof msg !== 'object') continue;
    switch (msg.role) {
      case 'system':
      case 'developer': {
        const text = extractTextContent(msg.content);
        if (text) systemParts.push(text);
        break;
      }
      case 'user':
        messages.push({ role: 'user', content: convertUserContent(msg.content) });
        break;
      case 'assistant':
        messages.push(convertAssistantMessage(msg));
        break;
      case 'tool':
        messages.push(convertToolMessage(msg));
        break;
      default:
        getLogger().warn({ msg: 'openai: unknown message role ignored', role: msg.role });
    }
  }

  const system = systemParts.length > 0 ? systemParts.map((text) => ({ text })) : undefined;

  // tool_choice='none' → 模型无工具可调,直接丢 tools。其余(auto/required/具名)
  // 仅 advisory:上游 Kiro 无 tool_choice 通道,无法强制,照常转发 tools。
  const tools = req.tool_choice === 'none' ? undefined : convertTools(req.tools);

  // reasoning_effort → adaptive thinking + output_config.effort(→ reasoning.effort)
  const { thinking, output_config } = buildReasoningConfig(
    mapReasoningEffort(req.reasoning_effort),
  );

  // 上游 wire 不含 max_tokens,仅用于 token 计数/占位;取 OpenAI 两个别名之一或默认。
  const max_tokens = req.max_completion_tokens ?? req.max_tokens ?? 32000;

  return {
    model: req.model,
    max_tokens,
    messages: coalesceToolResultMessages(messages),
    stream: req.stream,
    system,
    tools,
    tool_choice: req.tool_choice,
    thinking,
    output_config,
    metadata: req.user ? { user_id: req.user } : undefined,
  };
}
