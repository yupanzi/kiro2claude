/**
 * Non-streaming request handler.
 *
 * Owns the non-streaming code path:
 * call provider → read raw Buffer response → `reduceKiroResponse` (帧归约 +
 * thinking 提取 + 工具救援 + silent-failure 判定,见 non-stream-reduce.ts) →
 * 组装成一条 Claude `message` 响应 JSON。
 *
 * 重试循环、计费 hook、reply 形状留在本文件;归约语义抽到 non-stream-reduce.ts
 * 与 OpenAI 非流式 handler 共用(单一真相源,杜绝漂移)。
 */

import type { AxiosResponse } from 'axios';
import type { FastifyReply } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import type { KiroProvider } from '../kiro/provider.js';
import type { HookBus } from '../plugin-host/index.js';
import { getLogger } from '../shared/logger.js';
import { estimateOutputTokens } from '../token.js';
import type { MessageHandlerResult } from './empty-capture.js';
import { mapProviderError } from './error-mapper.js';
import { reduceKiroResponse } from './non-stream-reduce.js';
import {
  buildClaudeUsagePayload,
  buildKiroUsageFinishEvent,
  selectEmptyUpstreamMessage,
  upstreamErrorWire,
} from './stream.js';
import type { ToolTextRegistry } from './tool-call-text.js';
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

    // 帧归约 + 后处理(thinking 提取 / 工具救援 / stop_reason 定稿 / 判空)。
    const {
      textContent,
      toolUses,
      stopReason,
      contextInputTokens,
      kiroMetering,
      reasoningText,
      reasoningSignature,
      thinkingText,
      upstreamError,
      silentFailure,
      eventCounts,
      announcedToolNames,
      unknownEventTypes,
    } = reduceKiroResponse(bodyBytes, model, thinkingEnabled, toolNameMap, rescueRegistry);

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
        const hookEvent = buildKiroUsageFinishEvent({
          model,
          inputTokens: finalInputTokens,
          outputTokens: 0,
          inputTokensFromUpstream: contextInputTokens !== undefined,
          kiroMetering,
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
    let thinkingDetected = false;

    // 原生 reasoning 路径优先：上游显式给出 ReasoningContent → 直接产 thinking block
    // （含 signature，可被下游用作 Anthropic multi-turn thinking continuation）。
    // 与 `<thinking>` 标签扫描路径互斥：reasoningText 非空时跳过该扫描。
    if (reasoningText) {
      thinkingDetected = true;
      const thinkingBlock: Record<string, unknown> = { type: 'thinking', thinking: reasoningText };
      if (reasoningSignature) thinkingBlock.signature = reasoningSignature;
      content.push(thinkingBlock);
    } else {
      // legacy `<thinking>` 已在 reduceKiroResponse 里提取到 thinkingText
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
    const hookEvent = buildKiroUsageFinishEvent({
      model,
      inputTokens: finalInputTokens,
      outputTokens,
      inputTokensFromUpstream: contextInputTokens !== undefined,
      kiroMetering,
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
