/**
 * OpenAI Responses API 请求 → Claude MessagesRequest。
 *
 * 与 chat 端点一样,产出 Claude 内部请求后交 `convertRequest` 复用全链路。
 * Responses 特有:`input` 是 items 数组(message / function_call /
 * function_call_output / reasoning)、`instructions` 是 system、`tools` 扁平
 * (name 在顶层)、`reasoning.effort` 控 effort。
 */

import type {
  Message as ClaudeMessage,
  ContentBlock,
  MessagesRequest,
  Tool,
} from '../../claude/types.js';
import { getLogger } from '../../shared/logger.js';
import {
  buildClaudeTool,
  buildReasoningConfig,
  coalesceToolResultMessages,
  mapReasoningEffort,
  parseDataUri,
  REMOTE_IMAGE_PLACEHOLDER,
} from '../converter.js';
import type { ResponsesContentPart, ResponsesInputItem, ResponsesRequest } from './types.js';

/** content parts → 纯文本(system/instructions 用)。 */
function partsText(content: string | ResponsesContentPart[]): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const p of content) {
    if (p && typeof p === 'object') {
      if ((p.type === 'input_text' || p.type === 'output_text') && typeof p.text === 'string') {
        parts.push(p.text);
      } else if (p.type === 'refusal' && typeof p.refusal === 'string') {
        parts.push(p.refusal);
      }
    }
  }
  return parts.join('\n');
}

/** content parts → Claude ContentBlock[](text/image)。 */
function partsToBlocks(content: string | ResponsesContentPart[]): string | ContentBlock[] {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const blocks: ContentBlock[] = [];
  for (const p of content) {
    if (!p || typeof p !== 'object') continue;
    if ((p.type === 'input_text' || p.type === 'output_text') && typeof p.text === 'string') {
      blocks.push({ type: 'text', text: p.text });
    } else if (p.type === 'refusal' && typeof p.refusal === 'string') {
      blocks.push({ type: 'text', text: p.refusal });
    } else if (p.type === 'input_image') {
      const url = typeof p.image_url === 'string' ? p.image_url : p.image_url?.url;
      const parsed = url ? parseDataUri(url) : undefined;
      if (parsed) {
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: parsed.media_type, data: parsed.data },
        });
      } else {
        blocks.push({ type: 'text', text: REMOTE_IMAGE_PLACEHOLDER });
        getLogger().warn({
          msg: 'responses: remote input_image unsupported, placeholder inserted',
        });
      }
    }
  }
  return blocks;
}

/** 单个 input item → Claude Message(system/developer 返回 undefined,由上层收进 system[])。 */
function convertInputItem(
  item: ResponsesInputItem,
  systemParts: string[],
): ClaudeMessage | undefined {
  // message item(type 缺省即 message)
  if (!('type' in item) || item.type === undefined || item.type === 'message') {
    const m = item as Extract<ResponsesInputItem, { role: string }>;
    if (m.role === 'system' || m.role === 'developer') {
      const t = partsText(m.content);
      if (t) systemParts.push(t);
      return undefined;
    }
    return {
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: partsToBlocks(m.content),
    };
  }

  if (item.type === 'function_call') {
    let input: unknown = {};
    if (typeof item.arguments === 'string' && item.arguments.trim()) {
      try {
        input = JSON.parse(item.arguments);
      } catch {
        input = {};
      }
    }
    return {
      role: 'assistant',
      content: [{ type: 'tool_use', id: item.call_id, name: item.name, input }],
    };
  }

  if (item.type === 'function_call_output') {
    return {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: item.call_id, content: item.output }],
    };
  }

  // reasoning item:上游 GPT reasoning 加密不可复原,忽略(不影响正确性,仅少了多轮 reasoning 连续性)
  return undefined;
}

/** Responses 扁平 tools → Claude tools。 */
function convertTools(tools: ResponsesRequest['tools']): Tool[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const out: Tool[] = [];
  for (const t of tools) {
    if (!t || typeof t !== 'object' || t.type !== 'function' || typeof t.name !== 'string') {
      getLogger().warn({ msg: 'responses: non-function tool ignored', tool_type: t?.type });
      continue;
    }
    out.push(buildClaudeTool(t.name, t.description, t.parameters));
  }
  return out.length > 0 ? out : undefined;
}

export function convertResponsesRequest(req: ResponsesRequest): MessagesRequest {
  const systemParts: string[] = [];
  if (typeof req.instructions === 'string' && req.instructions) systemParts.push(req.instructions);

  const messages: ClaudeMessage[] = [];
  const input = req.input;
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (!item || typeof item !== 'object') continue;
      const msg = convertInputItem(item, systemParts);
      if (msg) messages.push(msg);
    }
  }

  const system = systemParts.length > 0 ? systemParts.map((text) => ({ text })) : undefined;
  const tools = req.tool_choice === 'none' ? undefined : convertTools(req.tools);

  const { thinking, output_config } = buildReasoningConfig(
    mapReasoningEffort(req.reasoning?.effort),
  );

  const max_tokens = req.max_output_tokens ?? 32000;

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
  };
}
