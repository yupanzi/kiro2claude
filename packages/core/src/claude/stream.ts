/**
 * SSE stream processing module
 *
 * Implements Kiro -> Claude streaming response conversion and SSE state management.
 */

import { v4 as uuidv4 } from 'uuid';
import type { Event, KiroMeteringData } from '../kiro/model/events/base.js';
import { type HookBus, UsageFinishEventImpl } from '../plugin-host/index.js';
import { getLogger } from '../shared/logger.js';
import { resolveContextUsage } from './converter.js';
import {
  extractThinkingFromCompleteText,
  findCharBoundary,
  findRealThinkingEndTag,
  findRealThinkingEndTagAtBufferEnd,
  findRealThinkingStartTag,
} from './stream/thinking-detector.js';

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

  for (const [namespace, value] of hookEvent.getExtensions()) {
    payload[namespace] = value;
  }

  return payload;
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
 * Message returned when the upstream produced a 200 with zero content frames
 * (silent failure). Shared by both handlers: the stream path wraps it in an
 * `overloaded_error` SSE event, the non-stream path in a 503 `overloaded_error`
 * JSON body. Neutral wording — names neither the backend nor the cause.
 */
export const EMPTY_UPSTREAM_RESPONSE_MESSAGE =
  'The service returned an empty response, please retry.';

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

  /** Generate final event sequence */
  generateFinalEvents(
    inputTokens: number,
    outputTokens: number,
    hookEvent: UsageFinishEventImpl,
  ): SseEvent[] {
    const events: SseEvent[] = [];

    // Close all unclosed blocks
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
  /** 事件类型计数器（debug 日志用） */
  private eventCounts: Map<string, number> = new Map();

  constructor(
    model: string,
    inputTokens: number,
    thinkingEnabled: boolean,
    toolNameMap: Map<string, string>,
    hookBus: HookBus,
  ) {
    this.stateManager = new SseStateManager();
    this.model = model;
    this.messageId = `msg_${uuidv4().replace(/-/g, '')}`;
    this.inputTokens = inputTokens;
    this.contextInputTokens = undefined;
    this.outputTokens = 0;
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
    this.hookBus = hookBus;
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

  /** Process Kiro event and convert to Claude SSE events */
  processKiroEvent(event: Event): SseEvent[] {
    this.eventCounts.set(event.kind, (this.eventCounts.get(event.kind) ?? 0) + 1);

    switch (event.kind) {
      case 'AssistantResponse':
        return this.processAssistantResponse(event.content);

      case 'ReasoningContent':
        return this.processReasoningContent(event.text, event.signature);

      case 'ToolUse':
        return this.processToolUse(event);

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
        return [];

      case 'Exception':
        if (event.exceptionType === 'ContentLengthExceededException') {
          this.stateManager.setStopReason('max_tokens');
        }
        getLogger().warn(`Received exception event: ${event.exceptionType} - ${event.message}`);
        return [];

      default:
        return [];
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
   * Creates text block if not yet created.
   * When tool_use auto-closes text block, subsequent text auto-creates a new block.
   */
  createTextDeltaEvents(text: string): SseEvent[] {
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
        const afterPos = endPos + '</thinking>'.length;
        const remaining = this.thinkingBuffer.slice(afterPos).trimStart();
        this.thinkingBuffer = '';
        if (remaining) {
          events.push(...this.createTextDeltaEvents(remaining));
        }
      }
    }

    // Flush pending thinking buffer text before tool_use block
    if (
      this.thinkingEnabled &&
      !this.inThinkingBlock &&
      !this.thinkingExtracted &&
      this.thinkingBuffer
    ) {
      const buffered = this.thinkingBuffer;
      this.thinkingBuffer = '';
      events.push(...this.createTextDeltaEvents(buffered));
    }

    // Get or allocate block index
    let blockIndex = this.toolBlockIndices.get(toolUse.toolUseId);
    if (blockIndex === undefined) {
      blockIndex = this.stateManager.nextBlockIndex();
      this.toolBlockIndices.set(toolUse.toolUseId, blockIndex);
    }

    // Restore original tool name if mapped
    const originalName = this.toolNameMap.get(toolUse.name) ?? toolUse.name;

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

    // If complete tool call, send content_block_stop
    if (toolUse.isComplete) {
      const stopEvent = this.stateManager.handleContentBlockStop(blockIndex);
      if (stopEvent) events.push(stopEvent);
    }

    return events;
  }

  /** Generate final event sequence */
  async generateFinalEvents(): Promise<SseEvent[]> {
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
    const hookEvent = new UsageFinishEventImpl({
      model: this.model,
      source: 'http-direct',
      inputTokensSource:
        this.contextInputTokens !== undefined ? 'upstream-reported' : 'client-estimate',
      meta: {
        'kiro.inputTokens': finalInputTokens,
        'kiro.outputTokens': this.outputTokens,
        'kiro.creditsUsed': this.kiroMeteringRaw?.usage,
        'kiro.pricedModel': this.model,
        'kiro.upstreamRaw': this.kiroMeteringRaw,
      },
      logger: getLogger(),
    });
    await this.hookBus.runUsageFinish(hookEvent);

    events.push(
      ...this.stateManager.generateFinalEvents(finalInputTokens, this.outputTokens, hookEvent),
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
