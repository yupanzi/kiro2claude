/**
 * freeform 工具的替身编解码器 —— 「freeform = `{input: string}`」这条约定的**单一真相源**
 * (字段名 `input` 全仓只在本文件出现;守卫 `test/static/freeform-tool-contract.test.ts`)。
 *
 * OpenAI 协议里 `type:"custom"` 的 freeform 工具载荷是一段裸文本 + 可选 grammar 约束
 * (Codex 的 `exec` 就是)。上游只吃 JSON Schema、无 freeform 通道,故把裸文本表达成
 * 唯一字符串字段 `input` 转发,响应侧再取回。编解码必须成对。
 *
 * 放 `openai/` 而非 `openai/responses/`:Chat Completions 也有 `type:"custom"`(嵌套在
 * `custom` 下,Responses 是扁平),目前无客户端故未实现(CLAUDE.md 踩坑「Codex code mode」
 * 末段),将来接入只需再加一层 wire 形状适配。
 */

/**
 * 替身 schema:唯一的字符串字段 `input` 承载原始文本。
 *
 * 按引用共享给所有 custom 工具与并发请求(下游 `normalizeJsonSchema` 只浅拷贝后写副本)。
 * `freeze` 把「只读」变成运行时保证:就地改写当场失败,而非静默污染进程内所有在途请求。
 */
export const FREEFORM_TOOL_SCHEMA: Record<string, unknown> = Object.freeze({
  type: 'object',
  properties: Object.freeze({ input: Object.freeze({ type: 'string' }) }),
  required: Object.freeze(['input']),
  additionalProperties: false,
});

/**
 * 追加给 freeform 工具 description 的适配说明。**必需**:这类工具的原始描述明确要求
 * 「raw text, not JSON, no code fences」(Codex 的 `exec` 逐字如此),与替身包裹直接冲突,
 * 不说明则模型吐裸文本。只在末尾追加,不改原描述。
 *
 * ⚠ 它是**载荷性**的(丢了工具就坏),而 `claude/converter.ts` 的 description cap 从**尾部**
 * 截断——这段是第一个被切掉的东西。默认 cap 32K 对已知最大的 freeform 描述(~10K)足够;
 * 守卫见 `test/openai/responses/converter.test.ts` 的 cap 用例。
 */
export const FREEFORM_ADAPTATION_NOTE =
  '\n\n---\n[Gateway adaptation] This freeform tool is exposed as a JSON tool. ' +
  'Put the raw tool text (unquoted, no code fences) into the `input` string field.';

/** 「本次请求没有 freeform 工具」的共享空集,给两个编码器当默认值。 */
export const NO_FREEFORM_TOOLS: ReadonlySet<string> = new Set<string>();

/** 裸文本 → 替身形态(历史里的 freeform 调用包回,与上送的 schema 同形)。 */
export function wrapFreeformInput(text: string): Record<string, unknown> {
  return { input: text };
}

/**
 * 读替身对象的 `input` 字段。★ 返回 `undefined` 只表示**字段不在**(或不是字符串),与
 * 「字段在、值是空串」严格区分:两个 unwrap 的回退都建立在这个区分上,换成真值判断
 * (`||`)会把合法空输入误当缺失,把 wrapper JSON 本身当裸文本发出去。
 */
function readFreeformField(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const v = (value as Record<string, unknown>).input;
  return typeof v === 'string' ? v : undefined;
}

/**
 * 替身对象 → 裸文本。取不到字符串就给空串:非流式侧 reducer 在参数 JSON 解析失败时把
 * buffer 丢成 `{}`(`claude/non-stream-reduce.ts`),原文到不了这里,没有可回退的东西。
 * 流式侧还留着原始累积串,故另走 `unwrapFreeformArgs`。
 */
export function unwrapFreeformInput(value: unknown): string {
  return readFreeformField(value) ?? '';
}

/**
 * 累积的替身 JSON 串 → 裸文本。解析失败或字段缺失时回退**原串**——模型可能直接吐裸文本
 * 而非 JSON,那时原串就是它想传的内容,丢掉等于把一次有效调用变成空调用。
 *
 * ⚠ 回退判据必须是 `?? args`(字段在不在)而非 `|| args`(值真不真),理由见
 * `readFreeformField`;此处的具体后果是 `{"input":""}` 会退成 wrapper JSON 发给客户端,
 * 而 Codex 拿它当 JavaScript 执行。反向守卫在 test/static/freeform-tool-contract.test.ts。
 */
export function unwrapFreeformArgs(args: string): string {
  if (!args) return '';
  try {
    return readFreeformField(JSON.parse(args)) ?? args;
  } catch {
    return args; // 非 JSON:按裸文本处理
  }
}
