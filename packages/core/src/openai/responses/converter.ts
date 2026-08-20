/**
 * OpenAI Responses API 请求 → Claude MessagesRequest。
 *
 * 与 chat 端点一样,产出 Claude 内部请求后交 `convertRequest` 复用全链路。
 * Responses 特有:`input` 是 items 数组(message / function_call /
 * function_call_output / reasoning)、`instructions` 是 system、`tools` 扁平
 * (name 在顶层)、`reasoning.effort` 控 effort。
 *
 * ★ **code mode**(踩坑「Codex code mode」):Codex 对内部已知的模型名把工具挪进
 * `input` 的 `additional_tools` item,顶层 `tools` 与 `instructions` 双双消失。
 * 工具来源因此是**两处并集**(顶层 + additional_tools),判别只看字段在不在、
 * **不看模型名**。新版 Codex 还会把工具再折进一层 `functions` namespace 容器,展开
 * 规则见 `expandDefaultNamespace`——漏展开 = 零工具上送、模型永远不调工具。
 * 其中 `type:"custom"` 的 freeform 工具上游没有对应通道,包成
 * 单 `input` 字符串字段的 JSON 工具转发(见 FREEFORM_TOOL_SCHEMA);它们的名字必须
 * 随返回值传到响应侧,否则编码器会把 custom 调用错编成 `function_call`。
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
import {
  FREEFORM_ADAPTATION_NOTE,
  FREEFORM_TOOL_SCHEMA,
  wrapFreeformInput,
} from '../freeform-tool.js';
import type {
  ResponsesContentPart,
  ResponsesInputItem,
  ResponsesRequest,
  ResponsesTool,
} from './types.js';

/**
 * 判别「携带工具的 input item」。用**结构**(有没有 `tools` 数组)而非字面 type 名,这样
 * 上游再换 item 名(形状不变)仍接得住;形状不对的条目由 `convertTools` 的 name/type 校验
 * 兜住。收集与跳过两处共用它——漏改一处的后果不是报错,而是工具集被当成一条空 user 消息
 * 静默塞进历史。
 */
function isToolsCarrier(item: ResponsesInputItem): item is ResponsesInputItem & {
  tools: ResponsesTool[];
} {
  const it = item as { tools?: unknown; content?: unknown };
  // 带 content 的一律不算:宽松判别不能宽到吞掉一条**有内容**的消息(那是用户的话,
  // 丢了没有任何痕迹)。工具载体不携带 content。
  return Array.isArray(it.tools) && it.content === undefined;
}

/** content parts → 纯文本(system/instructions 与工具结果 `output` 共用)。 */
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

/**
 * 单个 input item → Claude Message(system/developer 返回 undefined,由上层收进 system[])。
 * 未识别的 type 记进 `unknownTypes`,由调用方**每请求汇总成一行**——Responses 客户端
 * 每轮重放全部历史,逐条打日志会随会话长度平方级增长。
 */
function convertInputItem(
  item: ResponsesInputItem,
  systemParts: string[],
  unknownTypes: Set<string>,
): ClaudeMessage | undefined {
  // 工具投递项(code mode):工具已由 collectTools 取走,这里显式吞掉。它带
  // role:'developer',若被下面的 message 分支接住会把整个工具集当 system 文本灌进去。
  if (isToolsCarrier(item)) return undefined;

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

  // freeform 工具调用历史:`input` 是裸文本(非 JSON),按上送时的替身 schema 包回,
  // 使历史里的调用与本轮工具定义同形。非字符串 input 落 ''(镜像上面 function_call 对
  // arguments 的守卫):替身 schema 声明 `required:['input']`,漏进 undefined 会被
  // JSON.stringify 丢键 → 上游收到不满足自己 schema 的 `{}`。
  if (item.type === 'custom_tool_call') {
    return {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: item.call_id,
          name: item.name,
          input: wrapFreeformInput(typeof item.input === 'string' ? item.input : ''),
        },
      ],
    };
  }

  // 工具结果(function / freeform 同一分支):`output` 的两种 wire 形态见 types.ts
  // `ResponsesToolOutputItem`;一律经 partsText 归一成纯文本——直接塞数组会让上游
  // 拿到非法 tool_result content。
  if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
    return {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: item.call_id, content: partsText(item.output) },
      ],
    };
  }

  // reasoning item:上游 GPT reasoning 加密不可复原,忽略(不影响正确性,仅少了多轮
  // reasoning 连续性)。其余未知 type 登记下来:不记的话客户端换形态(如 code mode)
  // 会零痕迹静默降级,只能等用户报障。
  if (item.type !== 'reasoning') unknownTypes.add(String(item.type));
  return undefined;
}

/**
 * 就地展开一层 `functions` namespace 容器(Codex 0.147+,踩坑「Codex code mode」)。
 *
 * 只认这一个名字:`functions` 是 OpenAI 工具协议的**默认命名空间**,实测其子工具仍按
 * **裸名**回调(Codex 侧 `with_default_namespace()` 把「无 namespace」与 `"functions"`
 * 归一,`functions.exec` 这种拼名反而不认),所以展开后名字、响应编码、历史 item 全都
 * 不用动。**只能按名字白名单**:「是不是默认命名空间」在 wire 上没有字段可表达,不像
 * 两套请求形态那样有结构可判。其余 namespace(collaboration 等)的子工具裸名与 `ns.名`
 * 均被 Codex 拒绝(unsupported call),原样留给 convertTools 丢弃——不展开就没有死工具。
 *
 * ★ **一层、不递归**:真实 wire 恰好一层,而自嵌套的畸形请求走递归就等于开了一条
 * 栈溢出→500 的通道。这里只摊平一遍,更深的 functions 容器原样落到 convertTools 按
 * 未支持 type 丢弃。
 */
function expandDefaultNamespace(list: ResponsesTool[]): ResponsesTool[] {
  return list.flatMap((t) => {
    if (t?.type !== 'namespace' || t.name !== 'functions') return [t];
    return Array.isArray(t.tools) ? t.tools : [];
  });
}

/**
 * 汇总本次请求的工具来源:顶层 `tools`(标准形态)+ `input` 里所有
 * `additional_tools` item(code mode)。两者互斥出现,但按并集处理才不依赖模型名;
 * 同名以**先出现**者为准(顶层先扫,故顶层优先)。两处来源都先过
 * `expandDefaultNamespace`,展开出的子工具与顶层工具共用同一套去重规则。
 */
function collectTools(req: ResponsesRequest): ResponsesTool[] {
  const merged: ResponsesTool[] = [];
  const seen = new Set<string>();
  const take = (list: ResponsesTool[] | undefined): void => {
    if (!Array.isArray(list)) return;
    for (const t of expandDefaultNamespace(list)) {
      if (!t || typeof t !== 'object') continue;
      // 只按 name 去重:无名工具反正会被 convertTools 丢弃,不必为它们编 key。
      if (t.name) {
        if (seen.has(t.name)) continue;
        seen.add(t.name);
      }
      merged.push(t);
    }
  };
  take(req.tools);
  for (const item of Array.isArray(req.input) ? req.input : []) {
    if (item && typeof item === 'object' && isToolsCarrier(item)) take(item.tools);
  }
  return merged;
}

/**
 * Responses 扁平 tools → Claude tools + freeform 工具名集合(供响应侧还原
 * `custom_tool_call`)。
 *
 * 分派而非白名单:`function` 直转;`custom` 用替身 schema 包成 JSON 工具;
 * `namespace` **不展开**(理由见 `expandDefaultNamespace`):`functions` 已在那里摊平,
 * 落到这里的只剩其余 namespace 与畸形的第二层容器,一律按未支持 type 丢弃。
 */
function convertTools(tools: ResponsesTool[]): { tools?: Tool[]; customToolNames: Set<string> } {
  const out: Tool[] = [];
  const customToolNames = new Set<string>();
  for (const t of tools) {
    if (typeof t.name !== 'string' || !t.name) {
      getLogger().warn({ msg: 'responses: unnamed tool ignored', tool_type: t.type });
      continue;
    }
    if (t.type === 'function') {
      out.push(buildClaudeTool(t.name, t.description, t.parameters));
      continue;
    }
    if (t.type === 'custom') {
      const description =
        (typeof t.description === 'string' ? t.description : '') + FREEFORM_ADAPTATION_NOTE;
      out.push(buildClaudeTool(t.name, description, FREEFORM_TOOL_SCHEMA));
      customToolNames.add(t.name);
      continue;
    }
    getLogger().warn({ msg: 'responses: unsupported tool type ignored', tool_type: t.type });
  }
  return { tools: out.length > 0 ? out : undefined, customToolNames };
}

/**
 * 转换结果。`customToolNames` 必须随 payload 一起交给响应侧:编码器据此判断该产
 * `custom_tool_call` 还是 `function_call`,漏传则 freeform 工具调用会被错编成
 * function_call、客户端拿不到工具文本。
 */
export interface ResponsesConversion {
  payload: MessagesRequest;
  customToolNames: Set<string>;
}

export function convertResponsesRequest(req: ResponsesRequest): ResponsesConversion {
  const systemParts: string[] = [];
  if (typeof req.instructions === 'string' && req.instructions) systemParts.push(req.instructions);

  const messages: ClaudeMessage[] = [];
  const unknownTypes = new Set<string>();
  const input = req.input;
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (!item || typeof item !== 'object') continue;
      const msg = convertInputItem(item, systemParts, unknownTypes);
      if (msg) messages.push(msg);
    }
  }
  // 每请求一行、按 type 去重(理由见 convertInputItem)。
  if (unknownTypes.size > 0) {
    getLogger().warn({
      msg: 'responses: unknown input item types ignored',
      item_types: [...unknownTypes],
    });
  }

  const system = systemParts.length > 0 ? systemParts.map((text) => ({ text })) : undefined;
  // tool_choice=none 复用同一条路径:空列表 → 无工具 + 空名字集合。
  const { tools, customToolNames } = convertTools(
    req.tool_choice === 'none' ? [] : collectTools(req),
  );

  const { thinking, output_config } = buildReasoningConfig(
    mapReasoningEffort(req.reasoning?.effort),
  );

  const max_tokens = req.max_output_tokens ?? 32000;

  return {
    payload: {
      model: req.model,
      max_tokens,
      messages: coalesceToolResultMessages(messages),
      stream: req.stream,
      system,
      tools,
      tool_choice: req.tool_choice,
      thinking,
      output_config,
    },
    customToolNames,
  };
}
