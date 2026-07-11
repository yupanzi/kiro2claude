/**
 * Non-streaming request handler.
 *
 * Owns the non-streaming code path:
 * call provider → read raw Buffer response → decode into frames →
 * reduce frames into a single Claude `message` response JSON.
 *
 * The reducer in the middle of this file is the core of the non-stream
 * semantics: it accumulates text content, tool-use JSON deltas, and
 * stop-reason hints from the frame sequence.
 */

import type { AxiosResponse } from 'axios';
import type { FastifyReply } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import type { Event, KiroMeteringData } from '../kiro/model/events/base.js';
import { eventFromFrame } from '../kiro/model/events/base.js';
import { EventStreamDecoder } from '../kiro/parser/decoder.js';
import type { KiroProvider } from '../kiro/provider.js';
import { type HookBus, UsageFinishEventImpl } from '../plugin-host/index.js';
import { getLogger } from '../shared/logger.js';
import { estimateOutputTokens } from '../token.js';
import { resolveContextUsage } from './converter.js';
import type { MessageHandlerResult } from './empty-capture.js';
import { mapProviderError } from './error-mapper.js';
import {
  assertNever,
  buildClaudeUsagePayload,
  classifyUpstreamErrorEvent,
  extractThinkingFromCompleteText,
  type PendingUpstreamError,
  selectEmptyUpstreamMessage,
  upstreamErrorWire,
} from './stream.js';
import { extractToolCallsFromCompleteText, type ToolTextRegistry } from './tool-call-text.js';
import { createErrorResponse } from './types.js';

/**
 * Handle a non-streaming `/claude/v1/messages` request.
 *
 * `emptyStreamRetries`: 上游返回「200 + 零内容帧」空响应时,对同一请求最多重发
 * 这么多次来吸收瞬时空流(见 `Config.emptyStreamRetries`)。耗尽仍空 → 503
 * `overloaded_error`(现状)。返回值标记最终是否为空,供上层诊断抓包。
 *
 * `rescueRegistry`: 泄漏工具调用文本救援的工具注册表(tool-call-text.ts),
 * undefined = 关闭。见 `Config.toolCallTextRescue`。
 */
export async function handleNonStreamRequest(
  provider: KiroProvider,
  requestBody: string,
  model: string,
  inputTokens: number,
  thinkingEnabled: boolean,
  toolNameMap: Map<string, string>,
  hookBus: HookBus,
  reply: FastifyReply,
  emptyStreamRetries = 0,
  rescueRegistry?: ToolTextRegistry,
): Promise<MessageHandlerResult> {
  const log = getLogger();
  const apiStart = Date.now();
  const maxAttempts = 1 + Math.max(0, emptyStreamRetries);
  let emptyAttempts = 0;

  // Client-disconnect tracking so an aborted client never drives further
  // empty-stream retries (each retry is a real upstream call that spends
  // credit for a response no one will read). Mirrors the stream handler.
  const aborted = { value: false };
  reply.raw.on('close', () => {
    aborted.value = true;
  });

  // 每个 attempt 独立解码 + 归约;空响应(silent failure)且仍有重试额度时重发
  // 同一 requestBody。所有累加状态都在循环内声明,天然每次重置。
  for (let attempt = 1; ; attempt++) {
    let response: AxiosResponse;
    try {
      response = await provider.callApi(requestBody);
    } catch (e) {
      // A THROW is a real upstream failure classified by retry-executor —
      // forward it verbatim (zero-retry-forwarding contract). Only empty 200
      // responses (the silentFailure path below) retry.
      log.error({
        msg: 'Kiro API non-stream call failed',
        attempt,
        duration_ms: Date.now() - apiStart,
        error: String(e),
      });
      mapProviderError(e, reply);
      return { emptyResponse: false, emptyAttempts };
    }
    log.info({ msg: 'Kiro API non-stream call succeeded', duration_ms: Date.now() - apiStart });

    // Read response body
    let bodyBytes: Buffer;
    try {
      const data = response.data;
      if (Buffer.isBuffer(data)) {
        bodyBytes = data;
      } else if (typeof data === 'string') {
        bodyBytes = Buffer.from(data);
      } else {
        bodyBytes = Buffer.from(JSON.stringify(data));
      }
    } catch (e) {
      // Raw `e` goes to the log only — never into the client body (leak rule):
      // it can carry internal/upstream detail. Client gets a neutral message.
      log.error({ msg: 'failed to read response body', error: String(e) });
      reply
        .status(502)
        .send(createErrorResponse('api_error', 'Service encountered an internal error.'));
      return { emptyResponse: false, emptyAttempts };
    }

    log.debug({ msg: 'response body received', body_size: bodyBytes.length });

    // Parse event stream
    const decoder = new EventStreamDecoder();
    try {
      decoder.feed(bodyBytes);
    } catch (e) {
      log.warn({ msg: 'buffer overflow in decoder', error: String(e) });
    }

    let textContent = '';
    const toolUses: Record<string, unknown>[] = [];
    let hasToolUse = false;
    let stopReason = 'end_turn';
    let contextInputTokens: number | undefined;
    let thinkingDetected = false;
    let kiroMetering: KiroMeteringData | undefined;
    // kiro-cli 2.6.0+ 原生 reasoning 累积。一旦 reasoningText 非空就走新路径
    // （直接塞 thinking content block），跳过 `<thinking>` 标签的 regex 提取。
    let reasoningText = '';
    let reasoningSignature: string | undefined;

    // Collect tool call incremental JSON
    const toolJsonBuffers = new Map<string, string>();
    const eventCounts = new Map<string, number>();
    // 上游宣告过的 tool_use 名字(含没吐完参数的空壳帧)——空流诊断线索
    const announcedToolNames = new Set<string>();
    // 上游 mid-stream Error/Exception 帧(非 ContentLength)。命中 → drain 后明确
    // 报错(retryable→503 / fatal→502),而非静默返回部分内容或被误判成空流。
    let upstreamError: PendingUpstreamError | undefined;
    // 未识别 event-type(前向兼容诊断,进「完成」日志)
    const unknownEventTypes = new Set<string>();

    for (const result of decoder.drainAll()) {
      if (!('frame' in result)) {
        log.warn({ msg: 'event decode failed', error: String(result.error) });
        continue;
      }

      let event: Event;
      try {
        event = eventFromFrame(result.frame);
      } catch {
        continue;
      }

      eventCounts.set(event.kind, (eventCounts.get(event.kind) ?? 0) + 1);

      switch (event.kind) {
        case 'AssistantResponse':
          textContent += event.content;
          break;

        case 'ReasoningContent':
          reasoningText += event.text;
          if (event.signature) reasoningSignature = event.signature;
          break;

        case 'ToolUse': {
          hasToolUse = true;
          announcedToolNames.add(toolNameMap.get(event.name) ?? event.name);

          // Accumulate tool JSON input
          let buffer = toolJsonBuffers.get(event.toolUseId) ?? '';
          buffer += event.input;
          toolJsonBuffers.set(event.toolUseId, buffer);

          // If complete tool call, add to list
          if (event.isComplete) {
            let input: unknown;
            if (!buffer) {
              input = {};
            } else {
              try {
                input = JSON.parse(buffer);
              } catch (e) {
                log.warn({
                  msg: 'tool input JSON parse failed',
                  tool_use_id: event.toolUseId,
                  error: String(e),
                });
                input = {};
              }
            }

            const originalName = toolNameMap.get(event.name) ?? event.name;

            toolUses.push({
              type: 'tool_use',
              id: event.toolUseId,
              name: originalName,
              input,
            });
          }
          break;
        }

        case 'ContextUsage': {
          const { inputTokens: ctxInput, exceeded } = resolveContextUsage(
            model,
            event.contextUsagePercentage,
          );
          contextInputTokens = ctxInput;
          if (exceeded) {
            stopReason = 'model_context_window_exceeded';
          }
          break;
        }

        case 'Metering': {
          const { kind: _, ...metering } = event;
          kiroMetering = metering;
          break;
        }

        case 'Error':
          // 上游 error 帧:此前落 default 被静默吞掉(无日志、无客户端错误)。
          // 现在记日志 + 分类(retryable),drain 后明确报错。
          log.error({
            msg: 'received error event from upstream (non-stream)',
            error_code: event.errorCode,
            error_message: event.errorMessage,
          });
          upstreamError = classifyUpstreamErrorEvent(event);
          break;

        case 'Exception': {
          const classified = classifyUpstreamErrorEvent(event);
          if (classified === undefined) {
            // ContentLengthExceededException = 合法的 max_tokens 终止,保持原行为
            // (不记为错误、不打日志)。
            stopReason = 'max_tokens';
          } else {
            log.warn({
              msg: 'received exception event from upstream (non-stream)',
              exception_type: event.exceptionType,
              exception_message: event.message,
            });
            upstreamError = classified;
          }
          break;
        }

        case 'Unknown':
          unknownEventTypes.add(event.eventType);
          break;

        default:
          // Event 是封闭联合:新增一个 kind 会在此变成编译错误,而非被静默丢弃。
          assertNever(event);
      }
    }

    // Mid-stream upstream Error/Exception frame → surface as a real error instead
    // of silently returning partial content (or being misread as an empty stream
    // and burning retries). Non-stream never mid-commits (single reply.send at the
    // end), so discarding partial content and sending an error is always safe.
    // retryable → 503/overloaded_error (SDK retries); fatal → 502/api_error.
    if (upstreamError) {
      // Bill any credit already consumed before the error (a Metering frame may
      // have preceded it): the old code reached the usage-finish hook on this
      // input, so the early error return must not silently drop that credit from
      // the local quota tracker. Only when a Metering frame was actually captured.
      if (kiroMetering) {
        const finalInputTokens = contextInputTokens ?? inputTokens;
        const hookEvent = new UsageFinishEventImpl({
          model,
          source: 'http-direct',
          inputTokensSource:
            contextInputTokens !== undefined ? 'upstream-reported' : 'client-estimate',
          meta: {
            'kiro.inputTokens': finalInputTokens,
            'kiro.outputTokens': 0,
            'kiro.creditsUsed': kiroMetering.usage,
            'kiro.pricedModel': model,
            'kiro.upstreamRaw': kiroMetering,
          },
          logger: log,
        });
        await hookBus.runUsageFinish(hookEvent);
      }
      const { status, errorType, message } = upstreamErrorWire(upstreamError.retryable);
      log.warn({
        msg: 'upstream sent mid-stream error frame (non-stream), surfacing error',
        upstream_error: upstreamError,
        downstream_status: status,
        input_tokens: contextInputTokens ?? inputTokens,
        event_counts: Object.fromEntries(eventCounts),
        unknown_event_types: [...unknownEventTypes],
        total_duration_ms: Date.now() - apiStart,
      });
      reply.status(status).send(createErrorResponse(errorType, message));
      return { emptyResponse: false, emptyAttempts };
    }

    // 先做 legacy `<thinking>` 标签提取（非原生 reasoning 且开启 thinking 时），
    // 让下面的救援只作用于**非 thinking** 文本——模型在思考里起草的调用不是
    // 真实调用，物化它会造成幻影执行。与流式路径行为对齐（流式的 thinking
    // 内容走 thinking_delta，从不经过救援检测器）。
    let thinkingText: string | undefined;
    if (!reasoningText && thinkingEnabled && textContent) {
      const [thinking, remainingText] = extractThinkingFromCompleteText(textContent);
      if (thinking) {
        thinkingText = thinking;
        textContent = remainingText;
      }
    }

    // 泄漏工具调用文本救援：上游偶发把模型的工具调用当纯文本发下来（而非
    // toolUseEvent）。对聚合后的完整文本做一次检测,格式完整的泄漏块转成
    // 真正的 tool_use block（名字经 toolNameMap 反映射）,其余文本原样保留
    // ——包括结构悬空的截断尾巴（永不丢弃,见 tool-call-text.ts 文件头）,
    // 因此 rescued.text 变化 ⟺ 有完整调用被救援。放在 stop_reason 判定和
    // silent-failure 检测之前:纯泄漏 turn 救援后 stop_reason 应为 tool_use,
    // 且不算空响应。
    if (rescueRegistry && textContent) {
      const rescued = extractToolCallsFromCompleteText(textContent, rescueRegistry);
      if (rescued.calls.length > 0) {
        log.warn({
          msg: 'rescued leaked tool-call text into tool_use blocks',
          rescued_calls: rescued.calls.length,
          tools: rescued.calls.map((c) => c.name),
        });
        textContent = rescued.text;
        hasToolUse = true;
        for (const call of rescued.calls) {
          toolUses.push({
            type: 'tool_use',
            id: `toolu_${uuidv4().replace(/-/g, '')}`,
            name: toolNameMap.get(call.name) ?? call.name,
            input: call.input,
          });
        }
      }
    }

    // Determine stop_reason
    if (hasToolUse && stopReason === 'end_turn') {
      stopReason = 'tool_use';
    }

    // Silent-failure detection: upstream occasionally returns a 200 OK
    // event-stream body that decodes into zero content frames (typical sign:
    // only a `messageStop` frame, optionally a `meteringEvent`, no
    // `assistantResponseEvent`, `toolUseEvent`, or `reasoningContentEvent`).
    // We translate this into a 503 `overloaded_error` so the downstream Claude
    // SDK retries via its normal upstream-503 path.
    //
    // 判空 = 无 text、无 toolUses、无 reasoning。旧实现额外要求 `stopReason ===
    // 'end_turn'`,会**漏检** `stopReason: tool_use` 的空响应(上游声明要调工具却
    // 没吐完整 toolUse 帧,正是实测的形态);故不再要求 end_turn。
    //
    // 但要**排除**两个有意义的终止信号——它们带空 content 是合法的、不该重试:
    //   - `model_context_window_exceeded`(ContextUsage 超限)
    //   - `max_tokens`(ContentLengthExceededException)
    // 否则会把"上下文超限"误判成可重试空流。
    // `!reasoningText` guard:纯原生-reasoning 响应(只有 ReasoningContent)仍产
    // thinking content block,不算空。
    const silentFailure =
      textContent === '' &&
      toolUses.length === 0 &&
      !reasoningText &&
      !thinkingText &&
      stopReason !== 'model_context_window_exceeded' &&
      stopReason !== 'max_tokens';

    if (silentFailure) {
      emptyAttempts++;
      // 还有重试额度、且客户端仍在 → 重发同一请求吸收瞬时空流。客户端已断开则
      // 不再重试(避免为没人读的响应继续烧上游 credit)。
      if (attempt < maxAttempts && !aborted.value) {
        log.warn({
          msg: 'upstream returned empty non-stream response, retrying',
          attempt,
          remaining: maxAttempts - attempt,
          input_tokens: contextInputTokens ?? inputTokens,
          stop_reason: stopReason,
          event_counts: Object.fromEntries(eventCounts),
          tool_use_names: [...announcedToolNames],
        });
        continue;
      }
      // 重试耗尽仍空 → 503 overloaded_error。多次尝试全空 = 确定性空流,
      // 失败绑定在请求内容上,文案改为提示压缩/裁剪会话(与流式路径一致)。
      log.warn({
        msg: 'upstream returned empty non-stream response',
        empty_attempts: emptyAttempts,
        input_tokens: contextInputTokens ?? inputTokens,
        stop_reason: stopReason,
        event_counts: Object.fromEntries(eventCounts),
        tool_use_names: [...announcedToolNames],
        total_duration_ms: Date.now() - apiStart,
      });
      const emptyMessage = selectEmptyUpstreamMessage(emptyAttempts);
      reply.status(503).send(createErrorResponse('overloaded_error', emptyMessage));
      return { emptyResponse: true, emptyAttempts };
    }

    // Build response content
    const content: Record<string, unknown>[] = [];

    // 原生 reasoning 路径优先：上游显式给出 ReasoningContent → 直接产 thinking block
    // （含 signature，可被下游用作 Anthropic multi-turn thinking continuation）。
    // 与 `<thinking>` 标签扫描路径互斥：reasoningText 非空时跳过该扫描。
    if (reasoningText) {
      thinkingDetected = true;
      const thinkingBlock: Record<string, unknown> = { type: 'thinking', thinking: reasoningText };
      if (reasoningSignature) thinkingBlock.signature = reasoningSignature;
      content.push(thinkingBlock);
    } else {
      // legacy `<thinking>` 已在救援之前提取到 thinkingText（见上）
      thinkingDetected = !!thinkingText;
      if (thinkingText) {
        content.push({ type: 'thinking', thinking: thinkingText });
      }
    }

    // thinking 块（两条路径二选一）之后统一追加 text，再追加 toolUses——顺序不变。
    if (textContent) {
      content.push({ type: 'text', text: textContent });
    }

    content.push(...toolUses);

    // Estimate output tokens
    const outputTokens = estimateOutputTokens(content);

    // Use contextUsageEvent input_tokens if available
    const finalInputTokens = contextInputTokens ?? inputTokens;

    // Run hook bus so plugins can shape wire usage
    const hookEvent = new UsageFinishEventImpl({
      model,
      source: 'http-direct',
      inputTokensSource: contextInputTokens !== undefined ? 'upstream-reported' : 'client-estimate',
      meta: {
        'kiro.inputTokens': finalInputTokens,
        'kiro.outputTokens': outputTokens,
        'kiro.creditsUsed': kiroMetering?.usage,
        'kiro.pricedModel': model,
        'kiro.upstreamRaw': kiroMetering,
      },
      logger: log,
    });
    await hookBus.runUsageFinish(hookEvent);

    const usage = buildClaudeUsagePayload({
      hookEvent,
      inputTokens: finalInputTokens,
      outputTokens,
    });

    const responseBody = {
      id: `msg_${uuidv4().replace(/-/g, '')}`,
      type: 'message',
      role: 'assistant',
      content,
      model,
      stop_reason: stopReason,
      stop_sequence: null,
      usage,
    };

    log.info({
      msg: 'non-stream completed',
      stop_reason: stopReason,
      input_tokens: finalInputTokens,
      output_tokens: outputTokens,
      tool_use_count: toolUses.length,
      thinking_detected: thinkingDetected,
      // 前向兼容观测:上游若发来未识别 event-type,在此显形(当前为良性 metadata)。
      unknown_event_types: [...unknownEventTypes],
      total_duration_ms: Date.now() - apiStart,
    });

    log.debug({
      msg: 'non-stream event distribution',
      event_counts: Object.fromEntries(eventCounts),
    });

    reply.send(responseBody);
    return { emptyResponse: false, emptyAttempts };
  }
}
