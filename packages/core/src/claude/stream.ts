/**
 * SSE stream processing module
 *
 * Implements Kiro -> Claude streaming response conversion and SSE state management.
 */

import { v4 as uuidv4 } from 'uuid';
import type { Event, KiroMeteringData } from '../kiro/model/events/base.js';
import { type HookBus, UsageFinishEventImpl } from '../plugin-host/index.js';
import { getLogger } from '../shared/logger.js';
import { getRequestContext } from '../shared/request-context.js';
import { resolveContextUsage } from './converter.js';
import {
  extractThinkingFromCompleteText,
  findCharBoundary,
  findRealThinkingEndTag,
  findRealThinkingEndTagAtBufferEnd,
  findRealThinkingStartTag,
} from './stream/thinking-detector.js';
import {
  type DetectorItem,
  ToolCallTextDetector,
  type ToolTextRegistry,
} from './tool-call-text.js';

// Re-export thinking-detector symbols so existing consumers
// (`import { extractThinkingFromCompleteText } from './stream.js'`) keep
// working without needing to know that the implementation lives in
// `./stream/thinking-detector.js`.
export { extractThinkingFromCompleteText };

// ============================================================================
// Claude usage wire format
// ============================================================================

/**
 * Wire-level usage payload. Standard Anthropic fields are first-class
 * properties; plugins may inject additional namespaced fields via the
 * `addExtension` hook or override standard fields via `overrideStandardField`.
 */
export interface ClaudeUsagePayload {
  input_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens: number;
  // Plugins are free to inject namespaced extension fields (e.g. `kiro_usage`,
  // `kiro_derived`). Core never references these by name.
  [key: string]: unknown;
}

/**
 * 解析本次请求应上 wire 的 plugin usage 扩展（`addExtension` 注入的命名空间字段，
 * 如 `kiro_metering` / `kiro_derived`）。
 *
 * 「去泄漏」镜像端点（`/api/claude/v1`、`/api/openai/v1`）的请求级标记
 * `stripPluginUsage`（经 AsyncLocalStorage 传入）置位时返回 `undefined`——只留标准
 * 字段、剥掉泄漏后端身份的 `kiro_*` 键。plugin 的 usage-finish hook 仍照常运行
 * （累计计数器照进），只是扩展输出不落到 `/api` 的 wire 上。默认（无标记）= 完整扩展。
 *
 * **单一真相源**：Claude（`buildClaudeUsagePayload`）与 OpenAI 两协议共用此函数，
 * strip 语义不再各写一份。注意此处只解析 `addExtension` 扩展；`overrideStandardField`
 * 的标准字段覆写不经此路（OpenAI 侧刻意不套用 override，守踩坑 #16）。
 */
/** plugin 注入的命名空间 usage 扩展（`addExtension` 通道）——`resolvePluginUsageExtensions` 的产物类型。 */
export type PluginUsageExtensions = ReadonlyMap<string, unknown>;

export function resolvePluginUsageExtensions(
  hookEvent: UsageFinishEventImpl | undefined,
): PluginUsageExtensions | undefined {
  if (!hookEvent || getRequestContext()?.stripPluginUsage) return undefined;
  return hookEvent.getExtensions();
}

/**
 * 把 plugin 扩展命名空间字段并入 usage 对象。Claude（`buildClaudeUsagePayload`）与
 * OpenAI 两协议的 usage builder 共用此单一实现，杜绝「spread extensions onto usage」
 * 逻辑三份漂移。`undefined`（镜像端点剥离态）= 空操作。
 */
export function mergeUsageExtensions(
  target: Record<string, unknown>,
  extensions: PluginUsageExtensions | undefined,
): void {
  if (!extensions) return;
  for (const [namespace, value] of extensions) target[namespace] = value;
}

/**
 * Build the wire payload. Core writes the standard Anthropic fields based on
 * the metering raw data (if any) and the host's own counts, then merges
 * plugin-injected extensions and standard-field overrides on top.
 */
export function buildClaudeUsagePayload(args: {
  hookEvent: UsageFinishEventImpl;
  inputTokens: number;
  outputTokens: number;
}): ClaudeUsagePayload {
  const { hookEvent, inputTokens, outputTokens } = args;
  const overrides = hookEvent.getOverrides();

  const payload: ClaudeUsagePayload = {
    input_tokens: overrides.get('input_tokens') ?? inputTokens,
    output_tokens: overrides.get('output_tokens') ?? outputTokens,
    cache_creation_input_tokens: overrides.get('cache_creation_input_tokens') ?? 0,
    cache_read_input_tokens: overrides.get('cache_read_input_tokens') ?? 0,
  };

  // 标准字段 override 保留——改的是标准字段值、不新增泄漏后端身份的 `kiro_*` 键。
  // 扩展合并 + stripPluginUsage 剥离裁决见 resolvePluginUsageExtensions / mergeUsageExtensions。
  mergeUsageExtensions(payload, resolvePluginUsageExtensions(hookEvent));

  return payload;
}

/**
 * 组装 usage-finish hook 事件——`kiro.*` 计费 meta 形状的唯一真相源。
 * 流式(StreamContext.generateFinalEvents)+ 两端非流式 handler 共 5 处构造点
 * 复用此函数,杜绝 kiro.* 键漂移与 claude/openai 计费分叉。
 *
 * `inputTokensFromUpstream`:上游 ContextUsage 是否还原出了 input_tokens
 * (决定 inputTokensSource: upstream-reported / client-estimate)。
 */
export function buildKiroUsageFinishEvent(args: {
  model: string;
  inputTokens: number;
  outputTokens: number;
  inputTokensFromUpstream: boolean;
  kiroMetering: KiroMeteringData | undefined;
  logger: ReturnType<typeof getLogger>;
}): UsageFinishEventImpl {
  return new UsageFinishEventImpl({
    model: args.model,
    source: 'http-direct',
    inputTokensSource: args.inputTokensFromUpstream ? 'upstream-reported' : 'client-estimate',
    meta: {
      'kiro.inputTokens': args.inputTokens,
      'kiro.outputTokens': args.outputTokens,
      'kiro.creditsUsed': args.kiroMetering?.usage,
      'kiro.pricedModel': args.model,
      'kiro.upstreamRaw': args.kiroMetering,
    },
    logger: args.logger,
  });
}

// ============================================================================
// SSE Event
// ============================================================================

export interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

export function createSseEvent(event: string, data: Record<string, unknown>): SseEvent {
  return { event, data };
}

/**
 * Anthropic's terminal in-band `error` SSE event: `event: error` /
 * `data: { type:'error', error:{ type, message } }`. Used once headers are on the
 * wire (committed) so no HTTP status can be sent — both the empty-stream fallback
 * (`overloaded_error`) and the mid-stream upstream-error path (`api_error`) share
 * this single envelope shape. `message` must be neutral (leak rule).
 */
export function createSseErrorEvent(errorType: string, message: string): SseEvent {
  return createSseEvent('error', { type: 'error', error: { type: errorType, message } });
}

/**
 * Message returned when the upstream produced a 200 with zero content frames
 * (silent failure). Shared by both handlers: the stream path wraps it in an
 * `overloaded_error` SSE event, the non-stream path in a 503 `overloaded_error`
 * JSON body. Neutral wording — names neither the backend nor the cause.
 */
export const EMPTY_UPSTREAM_RESPONSE_MESSAGE =
  'The service returned an empty response, please retry.';

/**
 * Message for a *deterministic* empty response — the in-request retry budget
 * was spent and every attempt came back empty. Retrying the identical request
 * is pointless by then (observed: 33 identical attempts, all
 * empty); the failure is tied to the request content itself, and the only
 * user-side remedy is changing the content. Says so, neutrally.
 */
export const EMPTY_UPSTREAM_DETERMINISTIC_MESSAGE =
  'The service returned an empty response for this request repeatedly. ' +
  'This usually means some content in the conversation history cannot be processed — ' +
  'compact or trim the conversation and try again.';

/**
 * Client message for a *fatal* mid-stream upstream error (a non-transient
 * `error`/`exception` frame). Surfaced as 502 `api_error` (streaming: in-band
 * `error` event; non-stream: 502 status) — deliberately NO "please retry"
 * wording, since retrying a determinate upstream error just burns credit.
 * Neutral: speaks only of "the service", never the backend (leak rule); the raw
 * errorCode/message is logged, never sent.
 */
export const MIDSTREAM_UPSTREAM_ERROR_MESSAGE =
  'The service encountered an error while generating this response.';

/**
 * Client message for a *transient* mid-stream upstream error (throttling /
 * internal / unavailable). Surfaced as 503 `overloaded_error` so the downstream
 * SDK retries the whole request — same recovery contract as an empty stream.
 */
export const RETRYABLE_UPSTREAM_ERROR_MESSAGE =
  'The service is temporarily unavailable. Please retry.';

/**
 * Upstream error/exception codes that are *transient* — a retry may recover.
 * These surface as a retryable 503/`overloaded_error` (client SDK re-issues the
 * request) instead of a hard 502/`api_error`. Everything else is treated as
 * fatal. (`ContentLengthExceededException` is handled separately as a benign
 * max_tokens terminal, never reaching this set.)
 */
const RETRYABLE_UPSTREAM_ERROR_CODES = new Set([
  'ThrottlingException',
  'InternalServerException',
  'ServiceUnavailableException',
  'ServiceUnavailable',
  'InternalFailure',
]);

/** A classified mid-stream upstream error awaiting downstream surfacing. */
export interface PendingUpstreamError {
  code: string;
  message: string;
  /** Transient → retryable 503; otherwise fatal 502. */
  retryable: boolean;
}

/**
 * Classify an upstream `Error`/`Exception` event — the single source of the
 * benign-vs-retryable-vs-fatal knowledge, shared by the streaming
 * (`processKiroEvent`) and non-stream reducers so the two can't drift.
 *
 * Returns `undefined` for the benign `ContentLengthExceededException` (a
 * legitimate max_tokens terminal, not an error); otherwise the pending error to
 * surface, with `retryable` set from {@link RETRYABLE_UPSTREAM_ERROR_CODES}.
 */
export function classifyUpstreamErrorEvent(
  event:
    | { kind: 'Error'; errorCode: string; errorMessage: string }
    | { kind: 'Exception'; exceptionType: string; message: string },
): PendingUpstreamError | undefined {
  if (event.kind === 'Exception') {
    if (event.exceptionType === 'ContentLengthExceededException') return undefined;
    return {
      code: event.exceptionType,
      message: event.message,
      retryable: RETRYABLE_UPSTREAM_ERROR_CODES.has(event.exceptionType),
    };
  }
  return {
    code: event.errorCode,
    message: event.errorMessage,
    retryable: RETRYABLE_UPSTREAM_ERROR_CODES.has(event.errorCode),
  };
}

/**
 * Downstream wire form for a classified mid-stream upstream error. Retryable →
 * 503 / `overloaded_error` (client retries the whole request); fatal → 502 /
 * `api_error` (hard stop, no retry). Shared by both handlers so the streaming
 * in-band event and the non-stream HTTP status stay consistent.
 */
export function upstreamErrorWire(retryable: boolean): {
  status: number;
  errorType: string;
  message: string;
} {
  return retryable
    ? { status: 503, errorType: 'overloaded_error', message: RETRYABLE_UPSTREAM_ERROR_MESSAGE }
    : { status: 502, errorType: 'api_error', message: MIDSTREAM_UPSTREAM_ERROR_MESSAGE };
}

/**
 * Compile-time exhaustiveness guard for discriminated-union switches. A new
 * `Event` kind that isn't handled makes this a `tsc` error at the `default` arm,
 * instead of the value being silently dropped. Unreachable at runtime (the union
 * is closed); throws defensively if somehow reached.
 */
export function assertNever(x: never): never {
  throw new Error(`unhandled discriminated-union case: ${JSON.stringify(x)}`);
}

/**
 * 选择空流文案。多次尝试仍空 = *确定性*空流(失败绑定在请求内容上,再重试
 * 只烧 credit)→ 提示压缩会话;单次尝试(retries=0)是瞬时空流 → 保留可重试
 * 文案。流式与非流式 handler 共用,阈值不再各写一份。
 */
export function selectEmptyUpstreamMessage(emptyAttempts: number): string {
  return emptyAttempts >= 2
    ? EMPTY_UPSTREAM_DETERMINISTIC_MESSAGE
    : EMPTY_UPSTREAM_RESPONSE_MESSAGE;
}

/** Format SSE event as string */
export function sseEventToString(e: SseEvent): string {
  return `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`;
}

/**
 * Write to a raw Node stream, swallowing EPIPE / already-ended errors.
 *
 * When an SSE client disconnects mid-stream, any further `reply.raw.write`
 * throws `EPIPE` (or `ERR_STREAM_WRITE_AFTER_END`). We don't want the stream
 * handler's hot loop to crash the process over this — by the time we notice,
 * the client is gone and there's nothing to recover.
 *
 * Returns `true` if the write succeeded, `false` if the socket is gone.
 * Callers should use the return value to break out of their loops instead of
 * polling `aborted` state, so resource cleanup happens at the first sign of
 * trouble.
 */
export function safeWrite(raw: NodeJS.WritableStream, chunk: string): boolean {
  try {
    return raw.write(chunk);
  } catch (e) {
    getLogger().debug({ msg: 'sse write failed (client likely disconnected)', error: String(e) });
    return false;
  }
}

/**
 * End a raw Node stream, swallowing the throw from an already-closed socket
 * (`ERR_STREAM_WRITE_AFTER_END` / EPIPE). Companion to {@link safeWrite} for the
 * terminal path of an SSE response.
 */
export function safeEnd(raw: NodeJS.WritableStream): void {
  try {
    raw.end();
  } catch {
    // socket already closed
  }
}

// ============================================================================
// Block state
// ============================================================================

interface BlockState {
  blockType: string;
  started: boolean;
  stopped: boolean;
}

function createBlockState(blockType: string): BlockState {
  return { blockType, started: false, stopped: false };
}

// ============================================================================
// SSE State Manager
// ============================================================================

/**
 * SSE state manager.
 *
 * Ensures SSE event sequence conforms to Claude API spec:
 * 1. message_start appears exactly once
 * 2. content_block must: start -> delta -> stop
 * 3. message_delta appears exactly once, after all content_block_stop
 * 4. message_stop comes last
 */
export class SseStateManager {
  private messageStarted = false;
  private messageDeltaSent = false;
  private activeBlocks = new Map<number, BlockState>();
  private messageEnded = false;
  private nextBlockIdx = 0;
  private stopReason: string | undefined;
  private hasToolUse = false;

  /** Check if a block is open and of expected type */
  isBlockOpenOfType(index: number, expectedType: string): boolean {
    const block = this.activeBlocks.get(index);
    return !!block && block.started && !block.stopped && block.blockType === expectedType;
  }

  /** Get next block index */
  nextBlockIndex(): number {
    return this.nextBlockIdx++;
  }

  /** Record tool use */
  setHasToolUse(has: boolean): void {
    this.hasToolUse = has;
  }

  /** Set stop_reason */
  setStopReason(reason: string): void {
    this.stopReason = reason;
  }

  /** Check if there are non-thinking content blocks */
  hasNonThinkingBlocks(): boolean {
    for (const block of this.activeBlocks.values()) {
      if (block.blockType !== 'thinking') return true;
    }
    return false;
  }

  /** Get final stop_reason */
  getStopReason(): string {
    if (this.stopReason) return this.stopReason;
    if (this.hasToolUse) return 'tool_use';
    return 'end_turn';
  }

  /** Handle message_start event */
  handleMessageStart(event: Record<string, unknown>): SseEvent | undefined {
    if (this.messageStarted) {
      return undefined;
    }
    this.messageStarted = true;
    return createSseEvent('message_start', event);
  }

  /** Handle content_block_start event */
  handleContentBlockStart(
    index: number,
    blockType: string,
    data: Record<string, unknown>,
  ): SseEvent[] {
    const events: SseEvent[] = [];

    // If tool_use block, auto-close previous text blocks
    if (blockType === 'tool_use') {
      this.hasToolUse = true;
      for (const [blockIndex, block] of this.activeBlocks) {
        if (block.blockType === 'text' && block.started && !block.stopped) {
          events.push(
            createSseEvent('content_block_stop', {
              type: 'content_block_stop',
              index: blockIndex,
            }),
          );
          block.stopped = true;
        }
      }
    }

    // Check if block already exists
    const existing = this.activeBlocks.get(index);
    if (existing) {
      if (existing.started) {
        return events;
      }
      existing.started = true;
    } else {
      const block = createBlockState(blockType);
      block.started = true;
      this.activeBlocks.set(index, block);
    }

    events.push(createSseEvent('content_block_start', data));
    return events;
  }

  /** Handle content_block_delta event */
  handleContentBlockDelta(index: number, data: Record<string, unknown>): SseEvent | undefined {
    const block = this.activeBlocks.get(index);
    if (!block) {
      getLogger().warn(`Received delta for unknown block ${index}`);
      return undefined;
    }
    if (!block.started || block.stopped) {
      getLogger().warn(
        `Block ${index} state abnormal: started=${block.started}, stopped=${block.stopped}`,
      );
      return undefined;
    }
    return createSseEvent('content_block_delta', data);
  }

  /** Handle content_block_stop event */
  handleContentBlockStop(index: number): SseEvent | undefined {
    const block = this.activeBlocks.get(index);
    if (!block) return undefined;
    if (block.stopped) return undefined;
    block.stopped = true;
    return createSseEvent('content_block_stop', {
      type: 'content_block_stop',
      index,
    });
  }

  /**
   * Close all open (started, not stopped) content blocks, returning their
   * `content_block_stop` events. Shared by the normal terminal (`generateFinalEvents`)
   * and the error terminal (which closes blocks but emits NO message_delta/message_stop).
   */
  closeOpenBlocks(): SseEvent[] {
    const events: SseEvent[] = [];
    for (const [index, block] of this.activeBlocks) {
      if (block.started && !block.stopped) {
        events.push(
          createSseEvent('content_block_stop', {
            type: 'content_block_stop',
            index,
          }),
        );
        block.stopped = true;
      }
    }
    return events;
  }

  /** Generate final event sequence */
  generateFinalEvents(
    inputTokens: number,
    outputTokens: number,
    hookEvent: UsageFinishEventImpl,
  ): SseEvent[] {
    const events: SseEvent[] = this.closeOpenBlocks();

    // Send message_delta
    if (!this.messageDeltaSent) {
      this.messageDeltaSent = true;
      const usage = buildClaudeUsagePayload({
        hookEvent,
        inputTokens,
        outputTokens,
      });
      events.push(
        createSseEvent('message_delta', {
          type: 'message_delta',
          delta: {
            stop_reason: this.getStopReason(),
            stop_sequence: null,
          },
          usage,
        }),
      );
    }

    // Send message_stop
    if (!this.messageEnded) {
      this.messageEnded = true;
      events.push(createSseEvent('message_stop', { type: 'message_stop' }));
    }

    return events;
  }
}

// ============================================================================
// Stream Context
// ============================================================================

export class StreamContext {
  stateManager: SseStateManager;
  model: string;
  messageId: string;
  inputTokens: number;
  contextInputTokens: number | undefined;
  outputTokens: number;
  /**
   * True once a *complete* tool_use (isComplete) has been processed — even one
   * whose input object is empty, e.g. a no-required-args tool like
   * `browser_snapshot` the model calls with `{}`. Mirrors the non-stream path,
   * which pushes a tool_use only on isComplete and thus surfaces such a call as
   * real content. `hasContent()` reads it so a complete empty-input tool call is
   * NOT misclassified as a silent empty stream (which would retry then bogus-503,
   * while the non-stream path returns 200). A *truncated* tool frame
   * (isComplete=false) never sets this → still treated as empty and retried.
   */
  sawCompletedToolUse: boolean;
  toolBlockIndices: Map<string, number>;
  toolNameMap: Map<string, string>;
  thinkingEnabled: boolean;
  thinkingBuffer: string;
  inThinkingBlock: boolean;
  thinkingExtracted: boolean;
  thinkingBlockIndex: number | undefined;
  textBlockIndex: number | undefined;
  private stripThinkingLeadingNewline: boolean;
  /**
   * kiro-cli 2.6.0+ 原生 reasoning 路径状态。
   *
   * 收到第一个 `reasoningContentEvent` 时置 true，后续：
   *   1. `processContentWithThinking` 跳过 `<thinking>` 标签扫描——上游已经
   *      用独立 event-type 给出 thinking 内容，再走 prompt 提取就会双重处理；
   *   2. `processReasoningContent` 自己管理 thinking content block（包括 signature）。
   *
   * `reasoningBlockIndex` 记录当前 thinking content block 的 SSE index。
   */
  sawReasoningContent: boolean;
  reasoningBlockIndex: number | undefined;
  /**
   * Raw kiro metering payload from upstream. Surfaced to plugins via the
   * UsageFinishEvent meta keys (`kiro.creditsUsed`, etc.); core itself does
   * NOT consume this for wire format.
   */
  kiroMeteringRaw: KiroMeteringData | undefined;
  /** Plugin hook bus — invoked on finalization to let plugins shape wire usage. */
  readonly hookBus: HookBus;
  /**
   * 最后一次 usage-finish hook 事件（`generateFinalEvents` 内构造并 run 后存下）。
   * 供 OpenAI 流式 `finalTerminal` 经 `resolvePluginUsageExtensions` 取 plugin 扩展——
   * 因为 hookEvent 在 `generateFinalEvents` 内部创建，transport 外部拿不到。Claude 侧
   * 不读它（直接用 `generateFinalEvents` 内的局部 hookEvent）。
   */
  usageFinishEvent: UsageFinishEventImpl | undefined;
  /**
   * 泄漏工具调用文本救援（tool-call-text.ts）。上游偶发把模型的工具调用当
   * 纯文本从 assistantResponseEvent 发下来；检测器把文本通道里格式完整的
   * 泄漏块就地解析回真正的 tool_use block。undefined = 关闭（纯透传）。
   */
  private readonly toolCallDetector: ToolCallTextDetector | undefined;
  /** 事件类型计数器（debug 日志用） */
  private eventCounts: Map<string, number> = new Map();
  /**
   * 本次流里上游宣告过的 tool_use 名字（已反映射回原名）。空流诊断的关键
   * 线索：确定性空流的实测形态是「toolUseEvent 空壳帧（有名字无参数）+
   * 立即断流」——名字能把毒源范围从整个会话缩小到某个具体工具的调用点。
   */
  readonly seenToolUseNames = new Set<string>();
  /**
   * 上游在流中途发来的 Error / Exception 帧(非 ContentLength)。置位后由
   * handler 终结段判定 committed:已 commit → 发 in-band `error` 事件、未 commit
   * → 发 502,绝不再静默截断成「看似完整的 message_stop」。原始 code/message
   * 只在 case 里记日志,不进 wire(防泄漏)。processKiroEvent 看不到 committed,
   * 故置标志、由 handler 收口。
   */
  private pendingUpstreamError: PendingUpstreamError | undefined;
  /**
   * 上游出现过的未识别 event-type 字符串(去重)。前向兼容诊断:当前良性
   * metadata 帧会稳定出现;上游若新增*带内容的* event-type,会在「完成」日志的
   * `unknown_event_types` 字段冒出来,而非无声落入 Unknown 被丢。
   */
  readonly unknownEventTypes = new Set<string>();

  constructor(
    model: string,
    inputTokens: number,
    thinkingEnabled: boolean,
    toolNameMap: Map<string, string>,
    hookBus: HookBus,
    rescueRegistry?: ToolTextRegistry,
  ) {
    this.stateManager = new SseStateManager();
    this.model = model;
    this.messageId = `msg_${uuidv4().replace(/-/g, '')}`;
    this.inputTokens = inputTokens;
    this.contextInputTokens = undefined;
    this.outputTokens = 0;
    this.sawCompletedToolUse = false;
    this.toolBlockIndices = new Map();
    this.toolNameMap = toolNameMap;
    this.thinkingEnabled = thinkingEnabled;
    this.thinkingBuffer = '';
    this.inThinkingBlock = false;
    this.thinkingExtracted = false;
    this.thinkingBlockIndex = undefined;
    this.textBlockIndex = undefined;
    this.stripThinkingLeadingNewline = false;
    this.sawReasoningContent = false;
    this.reasoningBlockIndex = undefined;
    this.kiroMeteringRaw = undefined;
    this.pendingUpstreamError = undefined;
    this.hookBus = hookBus;
    this.usageFinishEvent = undefined;
    this.toolCallDetector = rescueRegistry ? new ToolCallTextDetector(rescueRegistry) : undefined;
  }

  /** Create message_start event data */
  createMessageStartEvent(): Record<string, unknown> {
    return {
      type: 'message_start',
      message: {
        id: this.messageId,
        type: 'message',
        role: 'assistant',
        content: [],
        model: this.model,
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: this.inputTokens,
          output_tokens: 1,
        },
      },
    };
  }

  /**
   * Generate initial events (message_start + optional text block start).
   *
   * When thinking is enabled, don't create text block at init time.
   * Thinking block (index 0) must come before text block (index 1).
   */
  generateInitialEvents(): SseEvent[] {
    const events: SseEvent[] = [];

    // message_start
    const msgStart = this.createMessageStartEvent();
    const event = this.stateManager.handleMessageStart(msgStart);
    if (event) events.push(event);

    // If thinking enabled, don't create text block here
    if (this.thinkingEnabled) return events;

    // Create initial text block (only when thinking is not enabled)
    const textBlockIndex = this.stateManager.nextBlockIndex();
    this.textBlockIndex = textBlockIndex;
    const textBlockEvents = this.stateManager.handleContentBlockStart(textBlockIndex, 'text', {
      type: 'content_block_start',
      index: textBlockIndex,
      content_block: {
        type: 'text',
        text: '',
      },
    });
    events.push(...textBlockEvents);

    return events;
  }

  /** 事件类型计数快照（空流诊断日志用） */
  getEventCounts(): Record<string, number> {
    return Object.fromEntries(this.eventCounts);
  }

  /**
   * 本次 attempt 收到过的上游 Error/Exception 帧(非 ContentLength);undefined
   * 表示没有。纯读——`ctx` 每 attempt 重建、读后即弃,无需清空。两处消费:重试
   * 循环 break 条件(显式上游错误是确定性终止、不当空流重试,免白烧 credit),
   * 以及终结段决定向客户端明确报错(而非静默截断)。
   */
  getPendingUpstreamError(): PendingUpstreamError | undefined {
    return this.pendingUpstreamError;
  }

  /** Process Kiro event and convert to Claude SSE events */
  processKiroEvent(event: Event): SseEvent[] {
    this.eventCounts.set(event.kind, (this.eventCounts.get(event.kind) ?? 0) + 1);

    switch (event.kind) {
      case 'AssistantResponse':
        return this.processAssistantResponse(event.content);

      case 'ReasoningContent':
        return this.processReasoningContent(event.text, event.signature);

      case 'ToolUse': {
        // 真实的结构化 toolUseEvent 到达：先让救援检测器结算待定缓冲（悬空
        // 候选按文本吐回，保证时序——被缓冲的文本在真实 tool_use 之前发射），
        // 再处理事件本身。合成救援调用不走这里（直接调 processToolUse）。
        if (this.toolCallDetector) {
          const settled = this.processDetectorItems(this.toolCallDetector.flush());
          return settled.concat(this.processToolUse(event));
        }
        return this.processToolUse(event);
      }

      case 'Metering': {
        const { kind: _, ...metering } = event;
        this.kiroMeteringRaw = metering;
        return [];
      }

      case 'ContextUsage': {
        const { inputTokens, exceeded } = resolveContextUsage(
          this.model,
          event.contextUsagePercentage,
        );
        this.contextInputTokens = inputTokens;
        if (exceeded) {
          this.stateManager.setStopReason('model_context_window_exceeded');
        }
        return [];
      }

      case 'Error':
        getLogger().error({
          msg: 'received error event from upstream',
          error_code: event.errorCode,
          error_message: event.errorMessage,
        });
        // 记下待发错误(含 retryable 分类),由 handler 终结段按 committed 状态明确
        // 报错(in-band error 或 502/503),不再 `return []` 静默截断成 message_stop。
        this.pendingUpstreamError = classifyUpstreamErrorEvent(event);
        return [];

      case 'Exception': {
        getLogger().warn(`Received exception event: ${event.exceptionType} - ${event.message}`);
        // 分类器把 ContentLengthExceededException 判为良性(返回 undefined)= 合法的
        // max_tokens 终止;其余归为待发错误,由 handler 终结段明确报错。
        const classified = classifyUpstreamErrorEvent(event);
        if (classified === undefined) {
          this.stateManager.setStopReason('max_tokens');
        } else {
          this.pendingUpstreamError = classified;
        }
        return [];
      }

      case 'Unknown':
        // 未识别 event-type:记下类型名供「完成」日志观测(前向兼容),payload
        // 无对应下游语义,不下发(与旧 default 行为一致,只是不再无声)。
        this.unknownEventTypes.add(event.eventType);
        return [];

      default:
        // Event 是封闭联合:新增一个 kind 会在此变成编译错误,而非被静默丢弃。
        return assertNever(event);
    }
  }

  /** Process assistant response event */
  private processAssistantResponse(content: string): SseEvent[] {
    if (!content) return [];

    // Estimate tokens
    this.outputTokens += estimateTokens(content);

    // 原生 reasoning 路径已经发了 thinking content block。第一次切到普通文本
    // 时先关 thinking block，让 text block 正确接续在它后面（index 顺序保证）。
    const prefixEvents = this.closeReasoningBlockIfOpen();

    // thinking enabled 走 legacy `<thinking>` 标签路径，否则走统一 text_delta。
    const textEvents = this.thinkingEnabled
      ? this.processContentWithThinking(content)
      : this.createTextDeltaEvents(content);

    // closeReasoningBlockIfOpen() 绝大多数帧返回空数组（没有待关的 reasoning
    // block），此时直接返回 textEvents，省掉每帧一次 concat 的数组分配。
    return prefixEvents.length === 0 ? textEvents : prefixEvents.concat(textEvents);
  }

  /**
   * 处理 kiro-cli 2.6.0+ 的 `reasoningContentEvent`。
   *
   * 与"手搓 `<thinking>` 标签"路径区别：
   *   - 上游用独立 event-type 显式给出 thinking 内容，不需要 regex 扫描
   *   - payload 可能带 signature 字段（最后一个 chunk），对应 Anthropic
   *     `signature_delta` 协议——透传给下游可用于 multi-turn thinking continuation
   *
   * 首次到达时关闭可能已开的 text block（防止 thinking block 出现在 text 之后），
   * 然后开 thinking block。`sawReasoningContent` 置 true 后，
   * `processContentWithThinking` 入口会跳过 `<thinking>` 标签扫描，避免双重处理。
   */
  private processReasoningContent(text: string, signature: string | undefined): SseEvent[] {
    // GPT-5.6 的 reasoningContentEvent 只带 redactedContent(加密隐藏思维链,无
    // text/signature)——无内容可 surface。直接丢弃,不开 thinking 块(否则会产一个
    // 空 thinking content block,且 sawReasoningContent 误置为 true)。顺带修掉
    // 「上游偶发空 reasoning 帧开空块」的既有 bug。对 Claude 明文 reasoning 零影响:
    // 其首帧带 text、尾帧带 signature,守卫都不触发。
    if (!text && !signature) return [];

    const events: SseEvent[] = [];

    if (!this.sawReasoningContent) {
      this.sawReasoningContent = true;

      // 关闭可能已开的 text block（理论上 thinkingEnabled 时初始不会开 text，
      // 这里保险起见做检查）
      if (
        this.textBlockIndex !== undefined &&
        this.stateManager.isBlockOpenOfType(this.textBlockIndex, 'text')
      ) {
        const stop = this.stateManager.handleContentBlockStop(this.textBlockIndex);
        if (stop) events.push(stop);
        this.textBlockIndex = undefined;
      }

      // 开 thinking block
      const idx = this.stateManager.nextBlockIndex();
      this.reasoningBlockIndex = idx;
      const startEvents = this.stateManager.handleContentBlockStart(idx, 'thinking', {
        type: 'content_block_start',
        index: idx,
        content_block: {
          type: 'thinking',
          thinking: '',
        },
      });
      events.push(...startEvents);
    }

    if (text && this.reasoningBlockIndex !== undefined) {
      events.push(this.createThinkingDeltaEvent(this.reasoningBlockIndex, text));
      this.outputTokens += estimateTokens(text);
    }

    if (signature && this.reasoningBlockIndex !== undefined) {
      const sigEvent = this.stateManager.handleContentBlockDelta(this.reasoningBlockIndex, {
        type: 'content_block_delta',
        index: this.reasoningBlockIndex,
        delta: {
          type: 'signature_delta',
          signature,
        },
      });
      if (sigEvent) events.push(sigEvent);
    }

    return events;
  }

  /** 关闭原生 reasoning thinking block（若已开）。在 AssistantResponse / ToolUse 边界调用。 */
  private closeReasoningBlockIfOpen(): SseEvent[] {
    if (
      this.reasoningBlockIndex !== undefined &&
      this.stateManager.isBlockOpenOfType(this.reasoningBlockIndex, 'thinking')
    ) {
      const stop = this.stateManager.handleContentBlockStop(this.reasoningBlockIndex);
      this.reasoningBlockIndex = undefined;
      return stop ? [stop] : [];
    }
    return [];
  }

  /** Process content with thinking blocks */
  private processContentWithThinking(content: string): SseEvent[] {
    // 已经走原生 reasoning 路径——上游显式区分了 reasoning vs assistant content,
    // 不应再用 regex 从 assistantResponseEvent.content 里抠 `<thinking>` 标签,
    // 否则会把模型正常输出里偶然出现的 `<thinking>` 串误判成 reasoning。
    if (this.sawReasoningContent) {
      return this.createTextDeltaEvents(content);
    }

    const events: SseEvent[] = [];
    this.thinkingBuffer += content;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (!this.inThinkingBlock && !this.thinkingExtracted) {
        // Look for <thinking> start tag
        const startPos = findRealThinkingStartTag(this.thinkingBuffer);
        if (startPos !== undefined) {
          // Send content before <thinking> as text_delta
          const beforeThinking = this.thinkingBuffer.slice(0, startPos);
          if (beforeThinking?.trim()) {
            events.push(...this.createTextDeltaEvents(beforeThinking));
          }

          // Enter thinking block
          this.inThinkingBlock = true;
          this.stripThinkingLeadingNewline = true;
          this.thinkingBuffer = this.thinkingBuffer.slice(startPos + '<thinking>'.length);

          // Create thinking block content_block_start
          const thinkingIndex = this.stateManager.nextBlockIndex();
          this.thinkingBlockIndex = thinkingIndex;
          const startEvents = this.stateManager.handleContentBlockStart(thinkingIndex, 'thinking', {
            type: 'content_block_start',
            index: thinkingIndex,
            content_block: {
              type: 'thinking',
              thinking: '',
            },
          });
          events.push(...startEvents);
        } else {
          // No <thinking> found, check if partial tag possible
          const targetLen = Math.max(0, this.thinkingBuffer.length - '<thinking>'.length);
          const safeLen = findCharBoundary(this.thinkingBuffer, targetLen);
          if (safeLen > 0) {
            const safeContent = this.thinkingBuffer.slice(0, safeLen);
            // Skip pure whitespace to avoid creating text block before thinking
            if (safeContent?.trim()) {
              events.push(...this.createTextDeltaEvents(safeContent));
              this.thinkingBuffer = this.thinkingBuffer.slice(safeLen);
            }
          }
          break;
        }
      } else if (this.inThinkingBlock) {
        // Strip <thinking> tag's trailing newline (may span chunks)
        if (this.stripThinkingLeadingNewline) {
          if (this.thinkingBuffer.startsWith('\n')) {
            this.thinkingBuffer = this.thinkingBuffer.slice(1);
            this.stripThinkingLeadingNewline = false;
          } else if (this.thinkingBuffer.length > 0) {
            this.stripThinkingLeadingNewline = false;
          }
          // If buffer empty, keep flag for next chunk
        }

        // In thinking block, look for </thinking> end tag
        const endPos = findRealThinkingEndTag(this.thinkingBuffer);
        if (endPos !== undefined) {
          // Extract thinking content
          const thinkingContent = this.thinkingBuffer.slice(0, endPos);
          if (thinkingContent && this.thinkingBlockIndex !== undefined) {
            events.push(this.createThinkingDeltaEvent(this.thinkingBlockIndex, thinkingContent));
          }

          // End thinking block
          this.inThinkingBlock = false;
          this.thinkingExtracted = true;

          if (this.thinkingBlockIndex !== undefined) {
            // Send empty thinking_delta then content_block_stop
            events.push(this.createThinkingDeltaEvent(this.thinkingBlockIndex, ''));
            const stopEvent = this.stateManager.handleContentBlockStop(this.thinkingBlockIndex);
            if (stopEvent) events.push(stopEvent);
          }

          // Strip `</thinking>\n\n`
          this.thinkingBuffer = this.thinkingBuffer.slice(endPos + '</thinking>\n\n'.length);
        } else {
          // No end tag found, send safe portion as thinking_delta
          // Reserve enough for `</thinking>\n\n` (13 bytes)
          const targetLen = Math.max(0, this.thinkingBuffer.length - '</thinking>\n\n'.length);
          const safeLen = findCharBoundary(this.thinkingBuffer, targetLen);
          if (safeLen > 0) {
            const safeContent = this.thinkingBuffer.slice(0, safeLen);
            if (safeContent && this.thinkingBlockIndex !== undefined) {
              events.push(this.createThinkingDeltaEvent(this.thinkingBlockIndex, safeContent));
            }
            this.thinkingBuffer = this.thinkingBuffer.slice(safeLen);
          }
          break;
        }
      } else {
        // Thinking already extracted, remaining content as text_delta
        if (this.thinkingBuffer) {
          const remaining = this.thinkingBuffer;
          this.thinkingBuffer = '';
          events.push(...this.createTextDeltaEvents(remaining));
        }
        break;
      }
    }

    return events;
  }

  /**
   * Create text_delta events.
   *
   * 文本通道的统一入口：救援检测器开启时，所有文本先经过它——普通文本原样
   * 透传，检出的泄漏工具调用块被转成真正的 tool_use block（复用
   * processToolUse 的全部 block 管理与名字反映射）。
   */
  createTextDeltaEvents(text: string): SseEvent[] {
    if (!this.toolCallDetector) return this.emitTextDeltaEventsRaw(text);
    return this.processDetectorItems(this.toolCallDetector.feed(text));
  }

  /** 把检测器输出的有序 text/call 项转成 SSE 事件 */
  private processDetectorItems(items: DetectorItem[]): SseEvent[] {
    const events: SseEvent[] = [];
    for (const item of items) {
      if (item.type === 'text') {
        if (item.text) events.push(...this.emitTextDeltaEventsRaw(item.text));
      } else {
        // 合成一个完整的 ToolUse 事件走标准路径。name 是模型视角的名字
        // （可能是缩短名），processToolUse 里会经 toolNameMap 反映射。
        // 注：这段文本的 token 已在 processAssistantResponse 按原文估算过，
        // processToolUse 会再按 input 长度累一次——输出估算轻微偏高，可接受
        // （usage 以上游 contextUsage / metering 为准）。
        events.push(
          ...this.processToolUse({
            kind: 'ToolUse',
            name: item.call.name,
            toolUseId: `toolu_${uuidv4().replace(/-/g, '')}`,
            input: JSON.stringify(item.call.input),
            isComplete: true,
          }),
        );
      }
    }
    return events;
  }

  /**
   * 底层 text_delta 发射（不经过救援检测器）。
   *
   * Creates text block if not yet created.
   * When tool_use auto-closes text block, subsequent text auto-creates a new block.
   */
  private emitTextDeltaEventsRaw(text: string): SseEvent[] {
    const events: SseEvent[] = [];

    // If current text_block_index points to a closed block, discard and create new
    if (this.textBlockIndex !== undefined) {
      if (!this.stateManager.isBlockOpenOfType(this.textBlockIndex, 'text')) {
        this.textBlockIndex = undefined;
      }
    }

    // Get or create text block index
    let textIndex: number;
    if (this.textBlockIndex !== undefined) {
      textIndex = this.textBlockIndex;
    } else {
      textIndex = this.stateManager.nextBlockIndex();
      this.textBlockIndex = textIndex;

      const startEvents = this.stateManager.handleContentBlockStart(textIndex, 'text', {
        type: 'content_block_start',
        index: textIndex,
        content_block: {
          type: 'text',
          text: '',
        },
      });
      events.push(...startEvents);
    }

    // Send content_block_delta
    const deltaEvent = this.stateManager.handleContentBlockDelta(textIndex, {
      type: 'content_block_delta',
      index: textIndex,
      delta: {
        type: 'text_delta',
        text,
      },
    });
    if (deltaEvent) events.push(deltaEvent);

    return events;
  }

  /** Create thinking_delta event */
  private createThinkingDeltaEvent(index: number, thinking: string): SseEvent {
    return createSseEvent('content_block_delta', {
      type: 'content_block_delta',
      index,
      delta: {
        type: 'thinking_delta',
        thinking,
      },
    });
  }

  /** Process tool use event */
  processToolUse(toolUse: Extract<Event, { kind: 'ToolUse' }>): SseEvent[] {
    const events: SseEvent[] = [];

    this.stateManager.setHasToolUse(true);

    // 原生 reasoning 路径：tool_use 出现前先关 thinking block
    events.push(...this.closeReasoningBlockIfOpen());

    // Handle boundary case: </thinking> at buffer end before tool_use
    if (this.thinkingEnabled && this.inThinkingBlock) {
      const endPos = findRealThinkingEndTagAtBufferEnd(this.thinkingBuffer);
      if (endPos !== undefined) {
        const thinkingContent = this.thinkingBuffer.slice(0, endPos);
        if (thinkingContent && this.thinkingBlockIndex !== undefined) {
          events.push(this.createThinkingDeltaEvent(this.thinkingBlockIndex, thinkingContent));
        }

        // End thinking block
        this.inThinkingBlock = false;
        this.thinkingExtracted = true;

        if (this.thinkingBlockIndex !== undefined) {
          events.push(this.createThinkingDeltaEvent(this.thinkingBlockIndex, ''));
          const stopEvent = this.stateManager.handleContentBlockStop(this.thinkingBlockIndex);
          if (stopEvent) events.push(stopEvent);
        }

        // Text after end tag (usually empty/whitespace)
        // 工具边界的 flush 直接走 raw 发射（绕过救援检测器）：这里的文本紧贴
        // tool_use block 之前发出，不可能是泄漏块的一部分；绕过也消除了
        // 合成救援调用 → processToolUse → 再喂检测器的重入路径。
        const afterPos = endPos + '</thinking>'.length;
        const remaining = this.thinkingBuffer.slice(afterPos).trimStart();
        this.thinkingBuffer = '';
        if (remaining) {
          events.push(...this.emitTextDeltaEventsRaw(remaining));
        }
      }
    }

    // Flush pending thinking buffer text before tool_use block（raw，理由同上）
    if (
      this.thinkingEnabled &&
      !this.inThinkingBlock &&
      !this.thinkingExtracted &&
      this.thinkingBuffer
    ) {
      const buffered = this.thinkingBuffer;
      this.thinkingBuffer = '';
      events.push(...this.emitTextDeltaEventsRaw(buffered));
    }

    // Get or allocate block index
    let blockIndex = this.toolBlockIndices.get(toolUse.toolUseId);
    if (blockIndex === undefined) {
      blockIndex = this.stateManager.nextBlockIndex();
      this.toolBlockIndices.set(toolUse.toolUseId, blockIndex);
    }

    // Restore original tool name if mapped
    const originalName = this.toolNameMap.get(toolUse.name) ?? toolUse.name;
    this.seenToolUseNames.add(originalName);

    // Send content_block_start
    const startEvents = this.stateManager.handleContentBlockStart(blockIndex, 'tool_use', {
      type: 'content_block_start',
      index: blockIndex,
      content_block: {
        type: 'tool_use',
        id: toolUse.toolUseId,
        name: originalName,
        input: {},
      },
    });
    events.push(...startEvents);

    // Send input increments
    if (toolUse.input) {
      this.outputTokens += Math.floor((toolUse.input.length + 3) / 4);

      const deltaEvent = this.stateManager.handleContentBlockDelta(blockIndex, {
        type: 'content_block_delta',
        index: blockIndex,
        delta: {
          type: 'input_json_delta',
          partial_json: toolUse.input,
        },
      });
      if (deltaEvent) events.push(deltaEvent);
    }

    // If complete tool call, send content_block_stop. Mark that a *complete*
    // tool_use was produced so hasContent() counts it as content even when the
    // input object is empty (no-args tool) — matches the non-stream path, which
    // pushes the tool_use on isComplete regardless of input.
    if (toolUse.isComplete) {
      this.sawCompletedToolUse = true;
      const stopEvent = this.stateManager.handleContentBlockStop(blockIndex);
      if (stopEvent) events.push(stopEvent);
    }

    return events;
  }

  /**
   * Generate the final event sequence and run the usage-finish (billing) hook.
   *
   * `emitMessageTerminal` (default true) → the normal success terminal
   * (message_delta + message_stop). Pass `false` when an in-band `error` event
   * will follow (mid-stream upstream error, post-commit): open blocks are still
   * closed and the billing hook still runs, but the success-signalling
   * message_delta/message_stop are suppressed.
   */
  async generateFinalEvents(emitMessageTerminal = true): Promise<SseEvent[]> {
    const events: SseEvent[] = [];

    // 原生 reasoning 路径兜底：如果上游只发了 reasoningContentEvent，
    // 没有 assistantResponseEvent / toolUseEvent，thinking block 还开着。
    // stream 结束前先补关。
    events.push(...this.closeReasoningBlockIfOpen());

    // Flush thinking_buffer remaining content
    if (this.thinkingEnabled && this.thinkingBuffer) {
      if (this.inThinkingBlock) {
        // End-of-stream: check for </thinking> at buffer end
        const endPos = findRealThinkingEndTagAtBufferEnd(this.thinkingBuffer);
        if (endPos !== undefined) {
          const thinkingContent = this.thinkingBuffer.slice(0, endPos);
          if (thinkingContent && this.thinkingBlockIndex !== undefined) {
            events.push(this.createThinkingDeltaEvent(this.thinkingBlockIndex, thinkingContent));
          }

          // Close thinking block
          if (this.thinkingBlockIndex !== undefined) {
            events.push(this.createThinkingDeltaEvent(this.thinkingBlockIndex, ''));
            const stopEvent = this.stateManager.handleContentBlockStop(this.thinkingBlockIndex);
            if (stopEvent) events.push(stopEvent);
          }

          const afterPos = endPos + '</thinking>'.length;
          const remaining = this.thinkingBuffer.slice(afterPos).trimStart();
          this.thinkingBuffer = '';
          this.inThinkingBlock = false;
          this.thinkingExtracted = true;
          if (remaining) {
            events.push(...this.createTextDeltaEvents(remaining));
          }
        } else {
          // Still in thinking block, send remaining as thinking_delta
          if (this.thinkingBlockIndex !== undefined) {
            events.push(
              this.createThinkingDeltaEvent(this.thinkingBlockIndex, this.thinkingBuffer),
            );
            events.push(this.createThinkingDeltaEvent(this.thinkingBlockIndex, ''));
            const stopEvent = this.stateManager.handleContentBlockStop(this.thinkingBlockIndex);
            if (stopEvent) events.push(stopEvent);
          }
        }
      } else {
        // Send remaining as text_delta
        events.push(...this.createTextDeltaEvents(this.thinkingBuffer));
      }
      this.thinkingBuffer = '';
    }

    // 救援检测器收尾：流结束时仍在缓冲的候选块在这里定型——完整的泄漏块
    // 转成 tool_use（真实泄漏几乎总是终止在流尾），非泄漏候选与结构悬空的
    // 截断块都按文本原样吐回（永不丢弃，见 tool-call-text.ts 文件头）。
    if (this.toolCallDetector) {
      events.push(...this.processDetectorItems(this.toolCallDetector.flush()));
    }

    // If only thinking was produced (no text, no tool_use),
    // set stop_reason to max_tokens and emit a placeholder text block.
    // 包括两条 thinking 路径：旧的 `<thinking>` 标签扫描 + 新的原生 reasoningContentEvent。
    const sawAnyThinking = this.thinkingBlockIndex !== undefined || this.sawReasoningContent;
    if (this.thinkingEnabled && sawAnyThinking && !this.stateManager.hasNonThinkingBlocks()) {
      this.stateManager.setStopReason('max_tokens');
      events.push(...this.createTextDeltaEvents(' '));
    }

    // Use contextUsageEvent input_tokens if available, otherwise estimated
    const finalInputTokens = this.contextInputTokens ?? this.inputTokens;

    // Build the hook event surface for plugins
    const hookEvent = buildKiroUsageFinishEvent({
      model: this.model,
      inputTokens: finalInputTokens,
      outputTokens: this.outputTokens,
      inputTokensFromUpstream: this.contextInputTokens !== undefined,
      kiroMetering: this.kiroMeteringRaw,
      logger: getLogger(),
    });
    await this.hookBus.runUsageFinish(hookEvent);
    // 存下供 OpenAI 流式 finalTerminal 取 plugin 扩展（见字段注释）。Claude 侧不读。
    this.usageFinishEvent = hookEvent;

    events.push(
      ...(emitMessageTerminal
        ? this.stateManager.generateFinalEvents(finalInputTokens, this.outputTokens, hookEvent)
        : this.stateManager.closeOpenBlocks()),
    );

    getLogger().debug({
      msg: 'stream statistics',
      event_counts: Object.fromEntries(this.eventCounts),
      thinking_detected: this.thinkingExtracted,
      output_tokens: this.outputTokens,
      input_tokens: finalInputTokens,
    });

    return events;
  }
}

// ============================================================================
// Token estimation
// ============================================================================

// Test-only exports (not part of stable public API)
export const __testing__ = {
  findRealThinkingStartTag,
  findRealThinkingEndTag,
  findRealThinkingEndTagAtBufferEnd,
  estimateTokens: (text: string): number => estimateTokens(text),
};

/** Simple token estimation */
function estimateTokens(text: string): number {
  let chineseCount = 0;
  let otherCount = 0;

  for (const c of text) {
    // for-of 字符串迭代的每个元素都是完整 code point，`codePointAt(0)` 永远有值
    const code = c.codePointAt(0) ?? 0;
    if (code >= 0x4e00 && code <= 0x9fff) {
      chineseCount++;
    } else {
      otherCount++;
    }
  }

  // Chinese: ~1.5 chars/token, English: ~4 chars/token
  const chineseTokens = Math.floor((chineseCount * 2 + 2) / 3);
  const otherTokens = Math.floor((otherCount + 3) / 4);

  return Math.max(chineseTokens + otherTokens, 1);
}
