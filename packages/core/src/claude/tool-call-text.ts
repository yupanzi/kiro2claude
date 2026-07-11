/**
 * Leaked tool-call text detection & rescue.
 *
 * ## 为什么存在
 *
 * Claude 的工具调用在 wire 层本质是「带特殊标记的文本」：模型生成
 * `<function_calls>` / `<invoke>` / `<parameter>` 标记流，由上游服务层
 * (Kiro / CodeWhisperer) 解析成结构化 toolUseEvent。上游解析偶发失败时，
 * 这段标记会以**纯文本**形态从 assistantResponseEvent 泄漏下来——下游
 * (Claude Code) 看到的是一段 `<invoke name="Edit">...` 文本，工具调用
 * 等于丢失。更糟的是：泄漏文本留在会话历史里会被模型当作正确示范模仿，
 * 之后同一会话内**确定性复发**（自我污染循环）。
 *
 * 本模块被三处使用：
 *  - 流式响应（stream.ts）：`ToolCallTextDetector` 增量扫描文本通道，
 *    检出泄漏块并**就地解析回真正的 tool_use**（救援），下游行为与上游
 *    解析成功时一致；
 *  - 非流式响应（non-stream-handler.ts）：`extractToolCallsFromCompleteText`
 *    对聚合后的完整文本做同样的救援；
 *  - 请求侧（converter.ts）：`ToolCallTextStripper` 把历史 assistant
 *    文本里的泄漏块剥掉（去污染），阻断模仿循环，让已污染的会话自愈。
 *
 * ## 误报防护
 *
 * 把普通文本误判成工具调用的代价 = 幻影工具执行，必须极低概率。四重门：
 *  1. 触发标记必须出现在**行首**（该行此前至多 3 个空格；4+ 空格/tab 缩进
 *     按 CommonMark 是缩进代码块）——真实泄漏总在行首，prose 里引用这些
 *     标记几乎总在句中、缩进示例或代码围栏里；
 *  2. **代码围栏外**——``` / ~~~ 围栏内的示例永不触发。围栏判定跟随
 *     CommonMark 的关键规则（每条都对应一个实测过的误报/漏报路径）：
 *     闭围栏长度必须 ≥ 开围栏（```` 围栏内的裸 ``` 是内容行）、行尾 \r
 *     剥掉再判（CRLF 历史）、列表项同行围栏（`- ``` `）也开围栏、
 *     backtick 围栏的 info string 含反引号时是普通段落不开围栏；
 *  3. 工具名必须在本次请求注册的工具表里（含 63 字符缩短名，见
 *     converter/tool-name-map.ts）；
 *  4. 语法必须完整解析（invoke 开标签 → parameter 序列 → 闭标签），
 *     任何偏差都原样透传文本。
 *
 * ## 永不丢弃（信息完整性 > 去污染强度）
 *
 * 结构不完整的悬空候选块（流尾截断、永不闭合的前缀）**一律按文本原样吐回**，
 * 绝不丢弃：结构不完整意味着无法证明它是泄漏块，而 capture 可能已经吞进了
 * 恰好跟在「像块开头的前缀」之后的真实内容——丢弃 = 静默数据丢失（对抗评审
 * 实测：悬空前缀后的全部散文会被一路吞到消息末尾）。宁可让下游看到一段
 * 泄漏残片（与无此功能时的基线一致），也不能让用户信息不完整。
 *
 * ## 解析预算熔断（session 级隔离）
 *
 * capture 每次 feed 从头重解析，病态输入（大量假闭合字面量 + 小帧）会让
 * 累计成本呈二次方（对抗评审实测 103KB 恶意内容 / 64B 帧 → 27 秒同步阻塞）。
 * 每个检测器实例带累计解析耗时预算，超限后**本次响应**的救援退化为纯透传
 * （不丢内容，打 warn 日志）——单个会话的毒内容最多烧掉自己的预算，不能
 * 阻塞事件循环拖累其它会话。
 *
 * ## 命名空间变体
 *
 * 泄漏标记有裸标签和带 `antml:` 命名空间前缀两种形态。前缀变体在本文件里
 * **全部动态拼接**（见 `NS`）——源文件绝不包含字面的前缀标记序列，避免这段
 * 代码本身经模型/上游解析器传输时被误识别为真实工具调用。
 */

import { getLogger } from '../shared/logger.js';
import { shortenToolName, TOOL_NAME_MAX_LEN } from './converter/tool-name-map.js';
import type { Tool } from './types.js';

// ============================================================================
// Tag templates
// ============================================================================

/** 上游内部标记的命名空间前缀。动态拼接，理由见文件头注释。 */
const NS = 'antml';

const WRAPPER_OPEN_TPLS = ['<function_calls>', `<${NS}:function_calls>`] as const;
const WRAPPER_CLOSE_TPLS = ['</function_calls>', `</${NS}:function_calls>`] as const;
const INVOKE_OPEN_TPLS = ['<invoke name="', `<${NS}:invoke name="`] as const;
const INVOKE_CLOSE_TPLS = ['</invoke>', `</${NS}:invoke>`] as const;
const PARAM_OPEN_TPLS = ['<parameter name="', `<${NS}:parameter name="`] as const;
const PARAM_CLOSE_TPLS = ['</parameter>', `</${NS}:parameter>`] as const;

/** 触发候选模板:行首的 wrapper 开标签或 invoke 开标签。模块级合并一次,避免每次 classifyTrigger 重建数组。 */
const TRIGGER_OPEN_TPLS = [...WRAPPER_OPEN_TPLS, ...INVOKE_OPEN_TPLS];

/** 工具名/参数名的长度上限（防病态输入把 partial 状态卡死） */
const MAX_TAG_NAME_LEN = 200;

/** capture 缓冲上限。超过仍未定型 → 放弃救援，原样吐回文本（守内存） */
const MAX_CAPTURE_LEN = 512 * 1024;

/**
 * 当前行前缀的跟踪上限。围栏/触发判定只需要行首一小段；超长行截断存储，
 * 截断只可能让「围栏字符 + 数百空白 + 内容」这种病态行被误判——可接受。
 */
const MAX_LINE_TRACK_LEN = 512;

/**
 * 单个检测器实例的累计解析 CPU 预算（毫秒）。合法泄漏块（哪怕 512KB 大参数
 * 按小帧流入）的累计解析在几十毫秒量级；只有「大量假闭合字面量 + 小帧重解析」
 * 的病态输入才会逼近预算。超限后退化为纯透传（见文件头「解析预算熔断」）。
 */
const DEFAULT_PARSE_BUDGET_MS = 250;

// ============================================================================
// Tool registry（本次请求注册了哪些工具、参数类型是什么）
// ============================================================================

/**
 * tool name（原名或 63 字符缩短名）→ param name → JSON-schema type。
 *
 * 泄漏文本里的工具名是**模型视角**的名字：converter 上送 Kiro 前会把超长名
 * 缩短（converter/tool-name-map.ts），所以两种名字都要注册。参数类型用于
 * 把文本参数值还原成 schema 期望的 JSON 类型（标记格式约定：标量原样写，
 * 数组/对象写 JSON）。
 */
export interface ToolTextRegistry {
  readonly paramTypes: ReadonlyMap<string, ReadonlyMap<string, string>>;
}

export function buildToolTextRegistry(tools: readonly Tool[] | undefined): ToolTextRegistry {
  const paramTypes = new Map<string, Map<string, string>>();
  for (const t of tools ?? []) {
    if (!t.name) continue;
    const types = new Map<string, string>();
    const props = (t.input_schema as { properties?: unknown } | undefined)?.properties;
    if (props && typeof props === 'object' && !Array.isArray(props)) {
      for (const [param, spec] of Object.entries(props as Record<string, unknown>)) {
        const ty = spec && typeof spec === 'object' ? (spec as { type?: unknown }).type : undefined;
        if (typeof ty === 'string') types.set(param, ty);
      }
    }
    paramTypes.set(t.name, types);
    if (t.name.length > TOOL_NAME_MAX_LEN) {
      paramTypes.set(shortenToolName(t.name), types);
    }
  }
  return { paramTypes };
}

// ============================================================================
// Parsed call + param coercion
// ============================================================================

export interface ParsedTextToolCall {
  /** 泄漏文本里出现的名字（可能是缩短名）；调用方经 toolNameMap 映射回原名 */
  name: string;
  input: Record<string, unknown>;
}

export type DetectorItem =
  | { type: 'text'; text: string }
  | { type: 'call'; call: ParsedTextToolCall };

/**
 * 按 schema 类型把文本参数值还原成 JSON 值。还原失败一律回退原始字符串——
 * 下游（Claude Code）自己会做 schema 校验并给模型报错，比这里猜错更安全。
 * string 类型**绝不 trim**：Edit 的 old_string 需要逐字节精确匹配。
 */
function coerceParamValue(raw: string, type: string | undefined): unknown {
  switch (type) {
    case 'integer':
    case 'number': {
      const t = raw.trim();
      if (t === '') return raw;
      const n = Number(t);
      return Number.isFinite(n) ? n : raw;
    }
    case 'boolean': {
      const t = raw.trim();
      if (t === 'true') return true;
      if (t === 'false') return false;
      return raw;
    }
    case 'array':
    case 'object': {
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        return raw;
      }
    }
    default:
      return raw;
  }
}

// ============================================================================
// 底层匹配原语
// ============================================================================

type PrefixMatch = { kind: 'no' } | { kind: 'partial' } | { kind: 'match'; end: number };

/** buf[pos..] 与固定模板匹配：完整命中 / 仍是前缀（等更多数据）/ 不匹配 */
function matchFixed(buf: string, pos: number, tpl: string): PrefixMatch {
  const avail = buf.length - pos;
  if (avail >= tpl.length) {
    return buf.startsWith(tpl, pos) ? { kind: 'match', end: pos + tpl.length } : { kind: 'no' };
  }
  return avail === 0 || tpl.startsWith(buf.slice(pos)) ? { kind: 'partial' } : { kind: 'no' };
}

/** 多模板匹配，优先级 match > partial > no */
function matchAnyFixed(buf: string, pos: number, tpls: readonly string[]): PrefixMatch {
  let sawPartial = false;
  for (const tpl of tpls) {
    const m = matchFixed(buf, pos, tpl);
    if (m.kind === 'match') return m;
    if (m.kind === 'partial') sawPartial = true;
  }
  return sawPartial ? { kind: 'partial' } : { kind: 'no' };
}

type NamedOpenMatch =
  | { kind: 'no' }
  | { kind: 'partial' }
  | { kind: 'match'; name: string; end: number };

/**
 * 匹配带 name 属性的开标签（invoke / parameter，含 ns 变体）。
 *
 * `requireNewline`：invoke 开标签后必须紧跟换行（标记格式如此）；parameter
 * 的值从 `>` 后立即开始，不吃换行。
 */
function matchNamedOpen(
  buf: string,
  pos: number,
  prefixes: readonly string[],
  requireNewline: boolean,
): NamedOpenMatch {
  let sawPartial = false;
  for (const tpl of prefixes) {
    const m = matchFixed(buf, pos, tpl);
    if (m.kind === 'partial') {
      sawPartial = true;
      continue;
    }
    if (m.kind === 'no') continue;

    // 模板命中，读 name（到闭引号为止；禁止换行/超长）
    let i = m.end;
    while (i < buf.length) {
      if (i - m.end > MAX_TAG_NAME_LEN) return { kind: 'no' };
      const ch = buf[i];
      if (ch === '"') {
        const name = buf.slice(m.end, i);
        if (!name) return { kind: 'no' };
        if (i + 1 >= buf.length) return { kind: 'partial' };
        if (buf[i + 1] !== '>') return { kind: 'no' };
        let end = i + 2;
        if (requireNewline) {
          if (end >= buf.length) return { kind: 'partial' };
          if (buf[end] === '\r') {
            end++;
            if (end >= buf.length) return { kind: 'partial' };
          }
          if (buf[end] !== '\n') return { kind: 'no' };
          end++;
        }
        return { kind: 'match', name, end };
      }
      if (ch === '\n' || ch === '<' || ch === '>') return { kind: 'no' };
      i++;
    }
    return { kind: 'partial' };
  }
  return sawPartial ? { kind: 'partial' } : { kind: 'no' };
}

/** 吞掉紧随其后的一个换行（含 \r\n），没有就原样返回。纯装饰性消费。 */
function consumeTrailingNewline(buf: string, end: number): number {
  const e = end;
  if (buf[e] === '\r' && buf[e + 1] === '\n') return e + 2;
  if (buf[e] === '\n') return e + 1;
  return e;
}

function isWs(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n';
}

/**
 * 从 `from` 开始找参数值的真实闭合位置。
 *
 * 值是自由文本（可含换行、XML 片段），所以不能取第一个闭合模板了事：一个
 * 闭合只有在其后（跳过任意空白，与 invoke 之间的空白容忍度**对称**——模型
 * 格式化时参数间可能有空行/缩进）紧跟下一个 parameter 开标签或 invoke 闭标签
 * 时才算数，否则视为值内容继续向后找。这个 lookahead 规则天然处理了「值里
 * 恰好包含闭合模板字面量」的常见形态；值里恰好包含「闭合 + 紧跟合法开标签」
 * 完整序列的仍会误切——这是文本标记格式的固有歧义，上游自己的解析器同样无解。
 */
function findParamClose(
  buf: string,
  from: number,
): { kind: 'found'; valueEnd: number; closeEnd: number } | { kind: 'need-more' } {
  let search = from;
  while (true) {
    let idx = -1;
    let len = 0;
    for (const tpl of PARAM_CLOSE_TPLS) {
      const i = buf.indexOf(tpl, search);
      if (i !== -1 && (idx === -1 || i < idx)) {
        idx = i;
        len = tpl.length;
      }
    }
    if (idx === -1) return { kind: 'need-more' };

    let after = idx + len;
    while (after < buf.length && isWs(buf[after])) after++;
    if (after >= buf.length) return { kind: 'need-more' };

    const nextParam = matchNamedOpen(buf, after, PARAM_OPEN_TPLS, false);
    const nextClose = matchAnyFixed(buf, after, INVOKE_CLOSE_TPLS);
    if (nextParam.kind === 'partial' || nextClose.kind === 'partial') {
      return { kind: 'need-more' };
    }
    if (nextParam.kind === 'match' || nextClose.kind === 'match') {
      return { kind: 'found', valueEnd: idx, closeEnd: idx + len };
    }
    search = idx + 1;
  }
}

// ============================================================================
// 块解析器（每次 feed 从头重扫 capture 缓冲；缓冲有 MAX_CAPTURE_LEN 上界）
// ============================================================================

interface RawCall {
  name: string;
  params: Array<[string, string]>;
}

interface CaptureScan {
  status: 'need-more' | 'fail' | 'done';
  /** 已完整解析出的 invoke（need-more 状态下也有效） */
  calls: RawCall[];
  /** 最后一个完整 invoke 之后的偏移（含尾随换行）；流结束掉尾时从这里切 */
  consumed: number;
  /** status === 'done' 时块的总长度（含 wrapper close / 尾随换行） */
  doneEnd: number;
}

function parseCapturedBlock(buf: string, isKnownTool: (n: string) => boolean): CaptureScan {
  const calls: RawCall[] = [];
  let consumed = 0;

  const needMore = (): CaptureScan => ({ status: 'need-more', calls, consumed, doneEnd: 0 });
  const fail = (): CaptureScan => ({ status: 'fail', calls: [], consumed: 0, doneEnd: 0 });
  /** 语法外内容：已有完整 invoke → 块在 consumed 处结束（其余是普通文本）；否则整体不是泄漏块 */
  const doneOrFail = (): CaptureScan =>
    calls.length > 0 ? { status: 'done', calls, consumed, doneEnd: consumed } : fail();

  let pos = 0;

  // 可选 wrapper 开标签（后面必须紧跟换行）
  const w = matchAnyFixed(buf, 0, WRAPPER_OPEN_TPLS);
  if (w.kind === 'partial') return needMore();
  if (w.kind === 'match') {
    let end = w.end;
    if (end >= buf.length) return needMore();
    if (buf[end] === '\r') {
      end++;
      if (end >= buf.length) return needMore();
    }
    if (buf[end] !== '\n') return fail();
    pos = end + 1;
  }

  while (true) {
    // invoke 之间允许空白
    let p = pos;
    while (p < buf.length && isWs(buf[p])) p++;
    if (p >= buf.length) return needMore();

    // wrapper 闭标签？（wrapperless 模式也接受——上游可能已吃掉开标签）
    const wc = matchAnyFixed(buf, p, WRAPPER_CLOSE_TPLS);
    if (wc.kind === 'partial') return needMore();
    if (wc.kind === 'match') {
      if (calls.length === 0) return fail();
      const end = consumeTrailingNewline(buf, wc.end);
      return { status: 'done', calls, consumed: end, doneEnd: end };
    }

    // invoke 开标签
    const inv = matchNamedOpen(buf, p, INVOKE_OPEN_TPLS, true);
    if (inv.kind === 'partial') return needMore();
    if (inv.kind === 'no') return doneOrFail();
    if (!isKnownTool(inv.name)) return doneOrFail();

    // parameter 序列 → invoke 闭标签
    const params: Array<[string, string]> = [];
    let q = inv.end;
    let invokeClosed = false;
    while (!invokeClosed) {
      while (q < buf.length && isWs(buf[q])) q++;
      if (q >= buf.length) return needMore();

      const ic = matchAnyFixed(buf, q, INVOKE_CLOSE_TPLS);
      if (ic.kind === 'partial') return needMore();
      if (ic.kind === 'match') {
        const end = consumeTrailingNewline(buf, ic.end);
        calls.push({ name: inv.name, params });
        consumed = end;
        pos = end;
        invokeClosed = true;
        break;
      }

      const po = matchNamedOpen(buf, q, PARAM_OPEN_TPLS, false);
      if (po.kind === 'partial') return needMore();
      if (po.kind === 'no') return doneOrFail();

      const vc = findParamClose(buf, po.end);
      if (vc.kind === 'need-more') return needMore();
      params.push([po.name, buf.slice(po.end, vc.valueEnd)]);
      q = vc.closeEnd;
    }
  }
}

// ============================================================================
// 流式检测器
// ============================================================================

/** 触发候选：行首的 wrapper 开标签或 invoke 开标签（名字合法性由解析器判） */
function classifyTrigger(rest: string): 'no' | 'partial' | 'match' {
  const m = matchAnyFixed(rest, 0, TRIGGER_OPEN_TPLS);
  return m.kind === 'match' ? 'match' : m.kind;
}

/** 相邻 text 项合并，减少下游 SSE delta 数量 */
function coalesceText(items: DetectorItem[]): DetectorItem[] {
  const out: DetectorItem[] = [];
  for (const it of items) {
    const prev = out[out.length - 1];
    if (it.type === 'text' && prev?.type === 'text') {
      prev.text += it.text;
    } else if (it.type !== 'text' || it.text) {
      out.push(it);
    }
  }
  return out;
}

/**
 * 增量扫描文本通道，检出泄漏的 tool-call 块。
 *
 * 用法：每个文本片段 `feed()`，需要定型时 `flush()`——流结束、或真实的
 * 结构化 toolUseEvent 到达时（保证已缓冲的文本在真实 tool_use block
 * **之前**发射，时序正确）。两者都返回有序的 text / call 项；text 项在
 * 无泄漏时与输入逐字节一致（纯透传）。
 *
 * 定型时仍悬空的**结构不完整**块（如 max_tokens 截断的半个 invoke、永不
 * 闭合的前缀）按文本原样吐回，**绝不丢弃**（理由见文件头「永不丢弃」）。
 */
export class ToolCallTextDetector {
  private readonly registry: ToolTextRegistry;
  private mode: 'idle' | 'capture' = 'idle';
  /** capture 模式下积累的候选块文本 */
  private capture = '';
  /** idle 模式下持留的「可能是 trigger 前缀」的尾巴（行首 '<' 起） */
  private idleTail = '';
  /** 当前行前缀（触发资格 + 围栏判定用，截断存储见 MAX_LINE_TRACK_LEN） */
  private lineBuf = '';
  private inFence = false;
  /** 当前开着的围栏字符（` 或 ~），闭围栏必须同字符 */
  private fenceChar: '`' | '~' | undefined;
  /** 当前开围栏的长度，闭围栏必须 ≥ 它（CommonMark） */
  private fenceLen = 0;
  /** 累计解析耗时（毫秒），超预算触发熔断 */
  private parseElapsedMs = 0;
  private readonly parseBudgetMs: number;
  /** 熔断后为 true：不再触发新 capture，纯透传（见文件头「解析预算熔断」） */
  private disabled = false;

  constructor(registry: ToolTextRegistry, opts?: { parseBudgetMs?: number }) {
    this.registry = registry;
    this.parseBudgetMs = opts?.parseBudgetMs ?? DEFAULT_PARSE_BUDGET_MS;
  }

  feed(text: string): DetectorItem[] {
    const items: DetectorItem[] = [];
    this.consume(text, items);
    return coalesceText(items);
  }

  /**
   * 结算所有待定状态。悬空的不完整候选块按文本吐回；流没结束时可以继续
   * `feed()`（围栏/行首状态延续，capture 缓冲已清空）。
   */
  flush(): DetectorItem[] {
    const items: DetectorItem[] = [];
    // scanCapture(eof) 的 fail/done 分支可能吐回 leftover，其中又可能有新
    // trigger 再次进入 capture。每轮至少消费一个字符，循环必然终止；guard
    // 只是防御性护栏。
    let guard = 0;
    while (this.mode === 'capture' && guard++ < 100_000) {
      const leftover = this.scanCapture(items, true);
      if (leftover !== undefined) this.consume(leftover, items);
    }
    if (this.idleTail) {
      items.push({ type: 'text', text: this.idleTail });
      this.idleTail = '';
    }
    return coalesceText(items);
  }

  // --------------------------------------------------------------------------

  /**
   * 迭代驱动器（绝不递归——泄漏形态由模型输出决定，假触发可能成百上千个，
   * 递归会在病态输入下爆栈）。scanIdle / scanCapture 返回「还需要重新处理
   * 的 leftover 文本」，由本循环继续驱动；每轮至少消费一个字符。
   */
  private consume(text: string, items: DetectorItem[]): void {
    let queue: string | undefined = text;
    while (queue !== undefined) {
      if (this.mode === 'capture') {
        this.capture += queue;
        queue = this.scanCapture(items, false);
      } else {
        queue = this.scanIdle(queue, items);
      }
    }
  }

  /**
   * idle 扫描：透传普通文本，寻找行首触发。返回值语义：
   *  - undefined：本段处理完毕（可能持留了 partial trigger 到 idleTail）
   *  - string：命中触发，已切换到 capture 模式，返回触发点起的剩余文本
   *    （由 consume 驱动器追加进 capture）
   */
  private scanIdle(text: string, items: DetectorItem[]): string | undefined {
    if (!text && !this.idleTail) return undefined;
    const s = this.idleTail + text;
    this.idleTail = '';
    let i = 0;
    const emitStart = 0;
    while (i < s.length) {
      const lt = s.indexOf('<', i);
      if (lt === -1) {
        this.trackLineState(s, i, s.length);
        break;
      }
      this.trackLineState(s, i, lt);

      if (!this.disabled && this.isTriggerablePosition() && !this.inFence) {
        const rest = s.slice(lt);
        const t = classifyTrigger(rest);
        if (t === 'partial') {
          if (lt > emitStart) items.push({ type: 'text', text: s.slice(emitStart, lt) });
          this.idleTail = rest;
          return undefined;
        }
        if (t === 'match') {
          if (lt > emitStart) items.push({ type: 'text', text: s.slice(emitStart, lt) });
          this.mode = 'capture';
          this.capture = '';
          return rest;
        }
      }

      this.trackLineState(s, lt, lt + 1);
      i = lt + 1;
    }
    if (s.length > emitStart) items.push({ type: 'text', text: s.slice(emitStart) });
    return undefined;
  }

  /**
   * '<' 出现在当前位置是否具备触发资格：行到目前为止只有 0-3 个空格。
   * 4+ 空格或含 tab 的行首缩进按 CommonMark 是缩进代码块——那里的示例
   * 绝不能触发（否则文档里缩进书写的示例块会变成幻影工具调用）。
   */
  private isTriggerablePosition(): boolean {
    return this.lineBuf.length <= 3 && /^ *$/.test(this.lineBuf);
  }

  /**
   * 跟踪当前行前缀与代码围栏开合（只对**透传**文本调用）。
   *
   * 围栏语义按 CommonMark 收紧过（每条都对应对抗评审实测过的误报/漏报路径）：
   *  - ``` 与 ~~~ 都是合法围栏字符,且开/闭必须同字符（``` 不关 ~~~）；
   *  - 闭围栏长度必须 ≥ 开围栏——```` 围栏内的裸 ``` 是内容行，不闭合
   *    （否则嵌套围栏演示里的示例块会被误救援/误剥）；
   *  - 行尾 \r 剥掉再判——CRLF 历史里 "```\r" 也是围栏行（trackLineState
   *    只在 \n 处结算，\r 会留在 lineBuf 尾部）；
   *  - 列表项同行围栏（`- ``` ` / `1. ``` `）开围栏——CommonMark 容器块语义
   *    的最小子集，挡住「列表围栏内 2-3 空格缩进示例」的触发路径；闭围栏
   *    不接受列表前缀（围栏内的 "- ```" 是内容行）；
   *  - backtick 围栏的 info string 不得含反引号（CommonMark 4.5）——那是
   *    含内联代码的普通段落，误开围栏会把其后的真实泄漏漏救；~~~ 无此限制；
   *  - 开围栏行允许 info string（如 ```js）；闭围栏行除围栏字符和空白外
   *    不得有其它内容——围栏内的 "``` trailing" 是内容行，不翻转状态。
   */
  private trackLineState(s: string, from: number, to: number): void {
    for (let j = from; j < to; j++) {
      const ch = s[j];
      if (ch === '\n') {
        this.evalFenceLine();
        this.lineBuf = '';
      } else if (this.lineBuf.length < MAX_LINE_TRACK_LEN) {
        this.lineBuf += ch;
      }
    }
  }

  private evalFenceLine(): void {
    const line = this.lineBuf.endsWith('\r') ? this.lineBuf.slice(0, -1) : this.lineBuf;
    const m = /^ {0,3}((?:[-*+]|\d{1,9}[.)])[ \t]{1,4})?(`{3,}|~{3,})(.*)$/.exec(line);
    if (!m) return;
    const listPrefix = m[1] !== undefined;
    const fence = m[2];
    const char = fence[0] as '`' | '~';
    const info = m[3];
    if (!this.inFence) {
      if (char === '`' && info.includes('`')) return;
      this.inFence = true;
      this.fenceChar = char;
      this.fenceLen = fence.length;
    } else if (
      !listPrefix &&
      char === this.fenceChar &&
      fence.length >= this.fenceLen &&
      info.trim() === ''
    ) {
      this.inFence = false;
      this.fenceChar = undefined;
      this.fenceLen = 0;
    }
    // 围栏内的异字符/过短围栏行、带尾随内容或列表前缀的行是普通内容，不翻转状态
  }

  /** 把解析出的调用推入 items 并打救援日志。空调用列表是无操作(不打日志)。 */
  private emitRescuedCalls(calls: RawCall[], items: DetectorItem[]): void {
    if (calls.length === 0) return;
    for (const c of calls) items.push({ type: 'call', call: this.toParsedCall(c) });
    getLogger().warn({
      msg: 'rescued leaked tool-call text into tool_use',
      rescued_calls: calls.length,
      tools: calls.map((c) => c.name),
    });
  }

  /**
   * capture 扫描：对当前缓冲做一次完整重解析并按结果定型。返回值语义：
   *  - undefined：留在 capture 模式等更多数据，或已全部定型无剩余
   *  - string：已切回 idle 模式，返回需要重新走 idle 扫描的 leftover 文本
   *    （fail 时 = 吐回的候选块去掉已发射的首字符；done 时 = 块后的尾随文本）
   */
  private scanCapture(items: DetectorItem[], eofFlush: boolean): string | undefined {
    const parseStart = Date.now();
    const scan = parseCapturedBlock(this.capture, (n) => this.registry.paramTypes.has(n));
    this.parseElapsedMs += Date.now() - parseStart;
    if (!this.disabled && this.parseElapsedMs > this.parseBudgetMs) {
      // 熔断：不再触发新 capture。本次扫描已定型的结果照常交付（done 的
      // 救援调用是有效的），只有仍未定型的 need-more 缓冲立即按文本放弃。
      this.disabled = true;
      getLogger().warn({
        msg: 'tool-call text rescue parse budget exceeded, degrading to passthrough',
        parse_elapsed_ms: this.parseElapsedMs,
        capture_chars: this.capture.length,
      });
    }

    if (scan.status === 'need-more' && !eofFlush) {
      if (this.disabled) return this.abandonCaptureAsText(items);
      if (this.capture.length > MAX_CAPTURE_LEN) {
        getLogger().warn({
          msg: 'tool-call text capture exceeded size limit, passing through as text',
          capture_chars: this.capture.length,
        });
        return this.abandonCaptureAsText(items);
      }
      return undefined;
    }

    if (scan.status === 'fail') {
      return this.abandonCaptureAsText(items);
    }

    if (scan.status === 'done') {
      this.emitRescuedCalls(scan.calls, items);
      const rest = this.capture.slice(scan.doneEnd);
      this.capture = '';
      this.mode = 'idle';
      // 块的闭标签吞掉了尾随换行 → 下一段从新行开始
      this.lineBuf = '';
      return rest || undefined;
    }

    // need-more + eofFlush：吐出已完整的 invoke，结构悬空的尾巴按文本原样
    // 吐回——**绝不丢弃**（capture 可能吞了跟在假前缀后的真实内容，见文件头
    // 「永不丢弃」）。吐回时**不**重新扫描：它仍是合法的块前缀，再扫会立刻
    // 重新进 capture 死循环。
    this.emitRescuedCalls(scan.calls, items);
    const dangling = this.capture.slice(scan.consumed);
    this.capture = '';
    this.mode = 'idle';
    if (dangling) {
      if (dangling.trim()) {
        getLogger().warn({
          msg: 'passing through dangling leaked tool-call text as-is',
          dangling_chars: dangling.length,
          rescued_calls: scan.calls.length,
        });
      }
      items.push({ type: 'text', text: dangling });
      this.trackLineState(dangling, 0, dangling.length);
    }
    return undefined;
  }

  /**
   * capture 判定为「不是泄漏块」后原样吐回：先发射首字符（并跟踪其行状态），
   * 返回剩余部分给驱动器重新走 idle 扫描——保证不会在同一位置重复触发，
   * 同时剩余文本里的围栏状态和后续 trigger 仍被正确处理。
   */
  private abandonCaptureAsText(items: DetectorItem[]): string | undefined {
    const text = this.capture;
    this.capture = '';
    this.mode = 'idle';
    if (!text) return undefined;
    items.push({ type: 'text', text: text[0] });
    this.trackLineState(text, 0, 1);
    return text.length > 1 ? text.slice(1) : undefined;
  }

  private toParsedCall(c: RawCall): ParsedTextToolCall {
    const types = this.registry.paramTypes.get(c.name);
    const input: Record<string, unknown> = {};
    for (const [k, v] of c.params) {
      input[k] = coerceParamValue(v, types?.get(k));
    }
    return { name: c.name, input };
  }
}

// ============================================================================
// 完整文本便捷入口（非流式响应 / 请求侧去污染共用同一状态机）
// ============================================================================

export interface ToolCallTextExtraction {
  /** 移除泄漏块后的文本；无泄漏时与输入逐字节一致 */
  text: string;
  calls: ParsedTextToolCall[];
}

export function extractToolCallsFromCompleteText(
  text: string,
  registry: ToolTextRegistry,
): ToolCallTextExtraction {
  const detector = new ToolCallTextDetector(registry);
  const items = [...detector.feed(text), ...detector.flush()];
  let out = '';
  const calls: ParsedTextToolCall[] = [];
  for (const item of items) {
    if (item.type === 'text') out += item.text;
    else calls.push(item.call);
  }
  return { text: out, calls };
}

/**
 * 跨多个 text 块共享围栏/行首状态的剥离器。
 *
 * 单条 assistant 消息的 content 可以是多个 text 块（中间可能夹 tool_use），
 * 下游把它们拼成一段连续文本——代码围栏完全可能开在块 1、闭在块 2。每块
 * 独立 new 检测器会丢围栏状态，导致「围栏内的示例」在第二个块里被误剥
 * （对抗评审实测路径）。本类让同一消息的所有 text 块共享一个检测器：
 * 每块结束时就地 flush 结算（候选块**不跨** text 块边界——块与块之间可能
 * 隔着 tool_use 等其它时间点的内容），只有围栏/行首状态延续。
 */
export class ToolCallTextStripper {
  private readonly detector: ToolCallTextDetector;

  constructor(registry: ToolTextRegistry) {
    this.detector = new ToolCallTextDetector(registry);
  }

  /** 剥掉本块里格式完整的泄漏块；无泄漏时返回与输入逐字节一致的文本 */
  stripBlock(text: string): string {
    let out = '';
    for (const item of [...this.detector.feed(text), ...this.detector.flush()]) {
      if (item.type === 'text') out += item.text;
    }
    return out;
  }
}
