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
 * 规则见 `expandNamespaces`——漏展开 = 零工具上送、模型永远不调工具。
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
  ResponsesAgentMessageItem,
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

/** content parts → 纯文本(system/instructions)。 */
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
 * 工具 output 先转 Claude blocks:Codex 的 view_image/image() 会把 input_image 放在
 * 工具结果里,不能经 partsText 静默丢掉。图片留在 tool_result 内,由 Claude converter
 * 的 extractToolResultContent 提升到 Kiro message-level images,并保留结果与图片的关联。
 * 纯文本仍压成字符串,兼容既有文本归一行为;远程图片复用显式占位提示。
 */
function toolOutputContent(output: string | ResponsesContentPart[]): string | ContentBlock[] {
  const content = partsToBlocks(output);
  if (typeof content === 'string' || content.some((block) => block.type === 'image')) {
    return content;
  }
  return content.map((block) => block.text ?? '').join('\n');
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
  // `ResponsesToolOutputItem`;OpenAI parts 转 Claude blocks 后保留图片,不能直接塞原数组
  // (input_text/input_image 不是 Claude block 类型),也不能只抽文本导致看图工具失效。
  if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
    return {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: item.call_id, content: toolOutputContent(item.output) },
      ],
    };
  }

  // Only the explicit plaintext summary has a replayable representation. Keep
  // it as assistant thinking, not a user instruction or a completed action.
  // Opaque encrypted_content has no Kiro input channel and is never decoded or
  // substituted for missing plaintext. Summary-less items therefore stay absent.
  if (item.type === 'reasoning') {
    const summary: string[] = [];
    if (Array.isArray(item.summary)) {
      for (const part of item.summary) {
        if (
          part &&
          typeof part === 'object' &&
          'type' in part &&
          part.type === 'summary_text' &&
          'text' in part &&
          typeof part.text === 'string' &&
          part.text.length > 0
        ) {
          summary.push(part.text);
        }
      }
    }
    if (summary.length === 0) return undefined;
    return {
      role: 'assistant',
      content: [{ type: 'thinking', thinking: summary.join('\n\n') }],
    };
  }

  if (item.type === 'agent_message') {
    const converted = convertAgentMessage(item);
    if (converted) return converted;
    // 认不出的 agent_message 仍按未知登记,别静默吞掉一条线程间消息。
    unknownTypes.add('agent_message');
    return undefined;
  }

  // 其余未知 type 登记下来:不记的话客户端换形态(如 code mode)
  // 会零痕迹静默降级,只能等用户报障。
  unknownTypes.add(String(item.type));
  return undefined;
}

/**
 * multi-agent v2 线程间信封的结构化头。**两个方向都必须转**(0.153.4 实测):
 * `NEW_TASK`(父 → 子,派活)与 `FINAL_ANSWER`(子 → 父,交活)。
 */
const AGENT_ENVELOPE_MARKER = 'Message Type:';
const NEW_TASK_MARKER = 'Message Type: NEW_TASK';

/**
 * multi-agent v2 的 `agent_message` 信封 → 一条普通 user message。
 *
 * Kiro 只有 user/assistant 通道,信封没有对应类型,不转换就整条落进 `unknownTypes`。
 * 两个方向各自的实测后果:
 *   - `NEW_TASK`(父 → 子,正文在 `encrypted_content`)丢了 → **子线程收到空 Payload**,
 *     拿着一个没有任务的 prompt 开工。
 *   - `FINAL_ANSWER`(子 → 父,正文在 `input_text` 的 `Payload:` 段)丢了 → **父线程模型
 *     永远看不到子 agent 的答案**。★ 这条尤其隐蔽:`wait_agent` 的工具结果只有
 *     `{"message":"Wait completed.","timed_out":false}`,**不含**答案本身,所以链路看起来
 *     全绿、父线程却在空手总结。别以为 wait 成功就等于结果拿到了。
 *
 * ★ 判据分两层,**别合并**:
 *   1. 转不转这条信封 —— 看有没有结构化的 `Message Type:` 头。够窄(普通消息没有它),
 *      又不必逐个 Message Type 白名单——新增类型丢弃 = 模型失明,是更糟的失败模式。
 *   2. `encrypted_content` 转不转明文 —— **只在 `NEW_TASK` 信封里**。这是任务正文、
 *      子线程非看不到不可;其余信封的同名字段语义网关并不掌握,转出去是信息泄漏而非
 *      兼容(`reasoning.encrypted_content` 更是真正不可解码的密文,永不转)。
 *
 * 元信息头与正文都保留、且**保持原顺序**:头里有 Sender / Task name / Payload 分段,
 * 只留正文会让接收方不知道这是谁发来的、是派活还是交活。
 * 正文本身不进日志(CLAUDE.md 日志红线:不记 prompt / 子任务正文)。
 */
function convertAgentMessage(item: ResponsesAgentMessageItem): ClaudeMessage | undefined {
  const parts: ResponsesContentPart[] = Array.isArray(item.content) ? item.content : [];
  const headerText = parts
    .filter((p) => p?.type === 'input_text' && typeof p.text === 'string')
    .map((p) => (p as { text: string }).text)
    .join('\n');
  if (!headerText.includes(AGENT_ENVELOPE_MARKER)) return undefined;
  const isNewTask = headerText.includes(NEW_TASK_MARKER);

  const blocks: ContentBlock[] = [];
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'encrypted_content') {
      // 非 NEW_TASK 的 encrypted_content 跳过(见上「判据分两层」),不记内容。
      if (!isNewTask) continue;
      if (typeof part.encrypted_content === 'string' && part.encrypted_content) {
        blocks.push({ type: 'text', text: part.encrypted_content });
      }
      continue;
    }
    const converted = partsToBlocks([part]);
    if (typeof converted !== 'string') blocks.push(...converted);
  }
  if (blocks.length === 0) return undefined;
  getLogger().info({
    msg: 'responses: converted multi-agent envelope',
    // 只记路由信息与类别,不记 Payload(日志红线)。
    envelope_kind: isNewTask ? 'new_task' : 'other',
    author: item.author,
    recipient: item.recipient,
  });
  return { role: 'user', content: blocks };
}

/**
 * Kiro 的 `inputSchema.json` 只吃标准 JSON Schema。`encrypted` 是 Codex 给
 * multi-agent 参数加的私有关键字(实测在 `spawn_agent.message` 上),留着可能让上游
 * 拒收或让模型看不懂而吐空参数。
 *
 * ★ **只在被展开的 namespace 工具 schema 内递归剥这一个键**。别升级成「全局清洗所有
 * 请求的未知关键字」:普通工具的 schema 是客户端与模型之间的约定,网关擅自改写等于
 * 悄悄换掉工具语义。同理只认键名、不看值。
 */
function stripEncryptedKeyword(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripEncryptedKeyword);
  if (!node || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === 'encrypted') continue;
    out[key] = stripEncryptedKeyword(value);
  }
  return out;
}

/**
 * 摊平后的一个工具 + 它的来源 namespace(`undefined` = 顶层或默认 `functions`)。
 *
 * ★ 来源**标在工具上**、映射表由 `collectTools` 去重后再建。别在展开时直接写映射:
 * 去重会丢掉后来的同名工具,而映射不会跟着回滚,结果是「保留了 A 的工具、却按 B 的
 * namespace 路由」——客户端会去执行另一个 handler。
 */
interface NamespacedTool {
  tool: ResponsesTool;
  namespace?: string;
}

/**
 * 就地展开一层 namespace 容器(Codex 0.147+,踩坑「Codex code mode」)。
 *
 * **`functions` 与其余 namespace 展开方式相同、回程方式不同**,这是本函数的全部要点:
 *
 * - `functions` 是 OpenAI 工具协议的**默认命名空间**,实测其子工具按**裸名**回调
 *   (Codex 侧 `with_default_namespace()` 把「无 namespace」与 `"functions"` 归一,
 *   `functions.exec` 这种拼名反而不认)→ 展开后不记映射,响应侧照旧发裸名。
 * - 其余 namespace(subagent 的 `collaboration`)必须**记下映射**,响应侧把
 *   `namespace` 字段写回 `function_call`,否则客户端 router 按裸名查不到 handler,
 *   一律回 `unsupported call`。⚠ 这里曾长期写着「绝不展开、网关侧无解」,**该结论
 *   2026-09-07 被四组对照实验推翻**(`tools/codex/README.md` subagent 节):真因就是
 *   少了这一个字段,补上后同一个调用立刻被受理并真的创建了子 agent。
 *
 * 「是不是默认命名空间」在 wire 上没有字段可表达,只能按名字白名单认 `functions`。
 *
 * ★ **同名冲突交给 `collectTools` 的「先出现者优先」去重**,这里不自己裁决:两个
 * namespace 出现同名工具时,无法从裸名反推该发哪个 `namespace`,发错等于让客户端执行
 * 另一个动作。保留先出现的那一个连同它的来源,是唯一不引入错误路由的选择。真实 wire
 * 至今无冲突(functions 三个 / collaboration 六个,名字不重)。
 *
 * ★ **一层、不递归**:真实 wire 恰好一层,而自嵌套的畸形请求走递归就等于开了一条
 * 栈溢出→500 的通道。这里只摊平一遍,更深的容器原样落到 convertTools 按未支持 type 丢弃。
 */
function expandNamespaces(list: ResponsesTool[]): NamespacedTool[] {
  const out: NamespacedTool[] = [];
  for (const t of list) {
    if (t?.type !== 'namespace' || !Array.isArray(t.tools)) {
      if (t) out.push({ tool: t });
      continue;
    }
    // 默认命名空间的子工具按裸名回调,不带 namespace 回程。
    const namespace = t.name === 'functions' ? undefined : t.name;
    for (const sub of t.tools) {
      if (!sub || typeof sub !== 'object') continue;
      if (namespace === undefined) {
        out.push({ tool: sub });
        continue;
      }
      out.push({
        tool: sub.parameters
          ? { ...sub, parameters: stripEncryptedKeyword(sub.parameters) as Record<string, unknown> }
          : sub,
        namespace: String(namespace),
      });
    }
  }
  return out;
}

/**
 * 汇总本次请求的工具来源:顶层 `tools`(标准形态)+ `input` 里所有
 * `additional_tools` item(code mode)。两者互斥出现,但按并集处理才不依赖模型名;
 * 同名以**先出现**者为准(顶层先扫,故顶层优先)。两处来源都先过
 * `expandNamespaces`,展开出的子工具与顶层工具共用同一套去重规则。
 *
 * `namespaces` 在**去重之后**才落表,因此表里每个名字对应的一定是最终真的上送了的
 * 那个工具(理由见 `NamespacedTool`)。映射是**每请求**新建的局部量,绝不能提到模块级
 * ——并发请求的工具集互不相同,共享一份表会让 A 的调用按 B 的 namespace 路由。
 */
function collectTools(req: ResponsesRequest): {
  tools: ResponsesTool[];
  namespaces: Map<string, string>;
} {
  const merged: ResponsesTool[] = [];
  const namespaces = new Map<string, string>();
  const seen = new Set<string>();
  const take = (list: ResponsesTool[] | undefined): void => {
    if (!Array.isArray(list)) return;
    for (const { tool, namespace } of expandNamespaces(list)) {
      if (!tool || typeof tool !== 'object') continue;
      // 只按 name 去重:无名工具反正会被 convertTools 丢弃,不必为它们编 key。
      if (tool.name) {
        if (seen.has(tool.name)) continue;
        seen.add(tool.name);
        if (namespace) namespaces.set(tool.name, namespace);
      }
      merged.push(tool);
    }
  };
  take(req.tools);
  for (const item of Array.isArray(req.input) ? req.input : []) {
    if (item && typeof item === 'object' && isToolsCarrier(item)) take(item.tools);
  }
  return { tools: merged, namespaces };
}

/**
 * Responses 扁平 tools → Claude tools + freeform 工具名集合(供响应侧还原
 * `custom_tool_call`)。
 *
 * 分派而非白名单:`function` 直转;`custom` 用替身 schema 包成 JSON 工具;
 * `namespace` 在这里**不该再出现**(`expandNamespaces` 已摊平 `functions` 与
 * `collaboration`):落到这里的只剩畸形的第二层容器,一律按未支持 type 丢弃。
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
 * 请求侧算出、**必须**随 payload 一起交给响应侧的工具元数据。两项都是「只有转换时
 * 才知道、编码时才用得上」的信息,漏传任一项都不会报错,只会让客户端拒绝执行工具:
 *
 * - `customToolNames`:该产 `custom_tool_call` 还是 `function_call`。漏传 → freeform
 *   调用被错编成 function_call,客户端拿不到工具文本。
 * - `toolNamespaces`:`function_call` 上要不要写 `namespace` 字段。漏传 → 客户端 router
 *   按裸名查不到 handler,回 `unsupported call`(subagent 六个工具全废)。
 *
 * ★ 打包成一个对象传,别拆成两个平行参数:它们经过同一条 handler → transport → encoder
 * 的长链路,拆开就多一条「传了 A 忘了 B」的静默分叉通道。
 */
export interface ResponsesToolCodec {
  customToolNames: ReadonlySet<string>;
  /** 工具名 → namespace。**每请求**新建,绝不共享(见 `collectTools`)。 */
  toolNamespaces: ReadonlyMap<string, string>;
}

/** 无工具元数据时的共享空值(只读,可安全共享)。 */
export const NO_TOOL_CODEC: ResponsesToolCodec = {
  customToolNames: new Set<string>(),
  toolNamespaces: new Map<string, string>(),
};

export interface ResponsesConversion {
  payload: MessagesRequest;
  codec: ResponsesToolCodec;
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
  // tool_choice=none 复用同一条路径:空列表 → 无工具、空名字集合、空 namespace 表。
  const collected =
    req.tool_choice === 'none'
      ? { tools: [] as ResponsesTool[], namespaces: new Map<string, string>() }
      : collectTools(req);
  const { tools, customToolNames } = convertTools(collected.tools);

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
    // namespace 表按**实际上送的工具**收窄:convertTools 丢掉的工具(无名 / 不支持的
    // type)不可能被调用,留在表里只会让一个同名的历史 item 被误加 namespace。
    codec: {
      customToolNames,
      toolNamespaces: new Map(
        [...collected.namespaces].filter(([name]) => tools?.some((t) => t.name === name)),
      ),
    },
  };
}
