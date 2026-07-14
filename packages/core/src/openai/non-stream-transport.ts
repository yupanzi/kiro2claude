/**
 * OpenAI 层共享非流式传输(chat + responses 共用)。
 *
 * 重试循环 + reduceKiroResponse + upstreamError/silentFailure + 计费 hook 全在
 * 这里;协议差异只有「用归约结果构建响应对象」一处,通过 `buildResponse` 回调注入。
 * usage 用原始 token(见回调实现),不经 buildClaudeUsagePayload。
 */

import type { AxiosResponse } from 'axios';
import type { FastifyReply } from 'fastify';
import type { MessageHandlerResult } from '../claude/empty-capture.js';
import {
  type ReducedAttempt,
  reducedReasoning,
  reduceKiroResponse,
} from '../claude/non-stream-reduce.js';
import {
  buildKiroUsageFinishEvent,
  selectEmptyUpstreamMessage,
  upstreamErrorWire,
} from '../claude/stream.js';
import type { ToolTextRegistry } from '../claude/tool-call-text.js';
import type { KiroProvider } from '../kiro/provider.js';
import type { HookBus } from '../plugin-host/index.js';
import { getLogger } from '../shared/logger.js';
import { estimateOutputTokens } from '../token.js';
import { mapProviderErrorOpenAi } from './error-mapper.js';
import { createOpenAiError } from './types.js';

/** 从归约结果重建 Claude 风格 content 块(仅供输出 token 估算 + hook meta)。 */
function contentForEstimate(reduced: ReducedAttempt): Record<string, unknown>[] {
  const content: Record<string, unknown>[] = [];
  const reasoning = reducedReasoning(reduced);
  if (reasoning) content.push({ type: 'thinking', thinking: reasoning });
  if (reduced.textContent) content.push({ type: 'text', text: reduced.textContent });
  content.push(...reduced.toolUses);
  return content;
}

export async function runOpenAiNonStream(
  provider: KiroProvider,
  requestBody: string,
  model: string,
  inputTokens: number,
  thinkingEnabled: boolean,
  toolNameMap: Map<string, string>,
  hookBus: HookBus,
  reply: FastifyReply,
  emptyStreamRetries: number,
  rescueRegistry: ToolTextRegistry | undefined,
  /** 用归约结果 + 原始 token 构建协议响应体(chat.completion / response 对象)。 */
  buildResponse: (
    reduced: ReducedAttempt,
    promptTokens: number,
    completionTokens: number,
  ) => unknown,
): Promise<MessageHandlerResult> {
  const log = getLogger();
  const apiStart = Date.now();
  const maxAttempts = 1 + Math.max(0, emptyStreamRetries);
  let emptyAttempts = 0;

  const aborted = { value: false };
  reply.raw.on('close', () => {
    aborted.value = true;
  });

  for (let attempt = 1; ; attempt++) {
    let response: AxiosResponse;
    try {
      response = await provider.callApi(requestBody);
    } catch (e) {
      log.error({ msg: 'Kiro API non-stream call failed (openai)', attempt, error: String(e) });
      mapProviderErrorOpenAi(e, reply);
      return { emptyResponse: false, emptyAttempts };
    }

    let bodyBytes: Buffer;
    try {
      const data = response.data;
      bodyBytes = Buffer.isBuffer(data)
        ? data
        : typeof data === 'string'
          ? Buffer.from(data)
          : Buffer.from(JSON.stringify(data));
    } catch (e) {
      log.error({ msg: 'failed to read response body (openai)', error: String(e) });
      reply
        .status(502)
        .send(createOpenAiError('Service encountered an internal error.', 'api_error'));
      return { emptyResponse: false, emptyAttempts };
    }

    const reduced = reduceKiroResponse(
      bodyBytes,
      model,
      thinkingEnabled,
      toolNameMap,
      rescueRegistry,
    );
    const finalInputTokens = reduced.contextInputTokens ?? inputTokens;

    if (reduced.upstreamError) {
      if (reduced.kiroMetering) {
        const hookEvent = buildKiroUsageFinishEvent({
          model,
          inputTokens: finalInputTokens,
          outputTokens: 0,
          inputTokensFromUpstream: reduced.contextInputTokens !== undefined,
          kiroMetering: reduced.kiroMetering,
          logger: log,
        });
        await hookBus.runUsageFinish(hookEvent);
      }
      const { status, errorType, message } = upstreamErrorWire(reduced.upstreamError.retryable);
      log.warn({
        msg: 'openai non-stream: mid-stream error frame, surfacing error',
        downstream_status: status,
        total_duration_ms: Date.now() - apiStart,
      });
      reply.status(status).send(createOpenAiError(message, errorType));
      return { emptyResponse: false, emptyAttempts };
    }

    if (reduced.silentFailure) {
      emptyAttempts++;
      if (attempt < maxAttempts && !aborted.value) {
        log.warn({ msg: 'openai non-stream: empty response, retrying', attempt });
        continue;
      }
      log.warn({ msg: 'openai non-stream: empty response', empty_attempts: emptyAttempts });
      reply
        .status(503)
        .send(createOpenAiError(selectEmptyUpstreamMessage(emptyAttempts), 'overloaded_error'));
      return { emptyResponse: true, emptyAttempts };
    }

    const outputTokens = estimateOutputTokens(contentForEstimate(reduced));

    const hookEvent = buildKiroUsageFinishEvent({
      model,
      inputTokens: finalInputTokens,
      outputTokens,
      inputTokensFromUpstream: reduced.contextInputTokens !== undefined,
      kiroMetering: reduced.kiroMetering,
      logger: log,
    });
    await hookBus.runUsageFinish(hookEvent);

    const body = buildResponse(reduced, finalInputTokens, outputTokens);

    log.info({
      msg: 'openai non-stream completed',
      input_tokens: finalInputTokens,
      output_tokens: outputTokens,
      tool_use_count: reduced.toolUses.length,
      total_duration_ms: Date.now() - apiStart,
    });

    reply.send(body);
    return { emptyResponse: false, emptyAttempts };
  }
}
