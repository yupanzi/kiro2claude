/**
 * OpenAI 层共享流式传输脚手架(chat + responses 共用)。
 *
 * 传输编排(deferred commit + 空流有界重试 + 断连 drain 计费 + keepalive)是
 * claude/stream-handler.ts 的结构复制,但**只服务 openai/ 两个新端点**,不碰
 * Claude 红线(坑#13)。语义核心复用 `StreamContext`(坑#14)。协议差异(chat
 * chunk vs responses 事件、终止行)通过 `OpenAiStreamProtocol` 注入。
 *
 * usage 用 StreamContext 原始 token(不经 buildClaudeUsagePayload)。错误信封
 * chat 与 responses 同形 `{error:{...}}`,共用 `createOpenAiError`。
 */

import type { AxiosResponse } from 'axios';
import type { FastifyReply } from 'fastify';
import type { MessageHandlerResult } from '../claude/empty-capture.js';
import {
  type SseEvent,
  StreamContext,
  safeEnd,
  safeWrite,
  selectEmptyUpstreamMessage,
  upstreamErrorWire,
} from '../claude/stream.js';
import type { ToolTextRegistry } from '../claude/tool-call-text.js';
import { eventFromFrame } from '../kiro/model/events/base.js';
import { EventStreamDecoder } from '../kiro/parser/decoder.js';
import type { KiroProvider } from '../kiro/provider.js';
import type { HookBus } from '../plugin-host/index.js';
import { getLogger } from '../shared/logger.js';
import { getRequestContext } from '../shared/request-context.js';
import { mapProviderErrorOpenAi } from './error-mapper.js';
import { createOpenAiError } from './types.js';

const PING_INTERVAL_MS = 25_000;
const STREAM_COMMIT_TIMEOUT_MS = 15_000;
const POST_DISCONNECT_DRAIN_IDLE_MS = 15_000;

/** 协议无关的流式 encoder:把 Claude SseEvent 翻成 wire 行。 */
export interface StreamEncoder {
  push(ev: SseEvent): string[];
}

/** 注入 chat / responses 的协议差异。 */
export interface OpenAiStreamProtocol<E extends StreamEncoder> {
  makeEncoder(model: string): E;
  /**
   * 成功终结:已把 `generateFinalEvents()` 的 SseEvent 逐个 push 过 encoder 后,
   * 追加的协议终止行。chat: (include_usage?)usage chunk + `[DONE]`;
   * responses: encoder.finalize(usage) → `response.completed`。
   * 传入 ctx 以读原始 token 构造 usage。
   */
  finalTerminal(encoder: E, ctx: StreamContext): string[];
  /** committed 后的 in-band 错误行(chat/responses 同形错误对象;responses 无 [DONE])。 */
  inbandError(encoder: E, message: string, type: string): string[];
}

function keepalive(): string {
  return ': keepalive\n\n';
}

export async function runOpenAiStream<E extends StreamEncoder>(
  protocol: OpenAiStreamProtocol<E>,
  provider: KiroProvider,
  requestBody: string,
  model: string,
  inputTokens: number,
  extractThinking: boolean,
  toolNameMap: Map<string, string>,
  hookBus: HookBus,
  reply: FastifyReply,
  emptyStreamRetries = 0,
  rescueRegistry?: ToolTextRegistry,
): Promise<MessageHandlerResult> {
  const log = getLogger();
  const apiStart = Date.now();

  const aborted = { value: false };
  let pingInterval: ReturnType<typeof setInterval> | undefined;
  let commitTimer: ReturnType<typeof setTimeout> | undefined;
  let drainGraceTimer: ReturnType<typeof setTimeout> | undefined;
  let committed = false;
  let upstreamData: { destroy?: (err?: Error) => void } | undefined;
  let draining = false;

  const armDrainGrace = (): void => {
    if (!draining || !upstreamData) return;
    if (drainGraceTimer) clearTimeout(drainGraceTimer);
    drainGraceTimer = setTimeout(() => {
      log.warn({
        msg: 'openai sse upstream drain grace expired after disconnect — destroying socket',
      });
      try {
        upstreamData?.destroy?.();
      } catch {
        /* already destroyed */
      }
    }, POST_DISCONNECT_DRAIN_IDLE_MS);
    drainGraceTimer.unref();
  };

  reply.raw.on('close', () => {
    if (!aborted.value && committed) log.info({ msg: 'openai sse client disconnected' });
    aborted.value = true;
    if (pingInterval) clearInterval(pingInterval);
    if (commitTimer) clearTimeout(commitTimer);
    armDrainGrace();
  });

  const sseHeaders: Record<string, string> = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  };
  const reqCtx = getRequestContext();
  if (reqCtx) sseHeaders['x-request-id'] = reqCtx.reqId;

  let ctx = new StreamContext(
    model,
    inputTokens,
    extractThinking,
    toolNameMap,
    hookBus,
    rescueRegistry,
  );
  let encoder = protocol.makeEncoder(model);
  let buffered: string[] = [];
  let streamStart = apiStart;

  const hasContent = (): boolean =>
    ctx.outputTokens > 0 || ctx.thinkingExtracted || ctx.sawCompletedToolUse;

  const commit = (): void => {
    if (committed || aborted.value) return;
    committed = true;
    if (commitTimer) {
      clearTimeout(commitTimer);
      commitTimer = undefined;
    }
    reply.raw.writeHead(200, sseHeaders);
    for (const line of buffered) {
      if (!safeWrite(reply.raw, line)) {
        aborted.value = true;
        break;
      }
    }
    buffered.length = 0;
    pingInterval = setInterval(() => {
      if (!safeWrite(reply.raw, keepalive())) {
        if (pingInterval) clearInterval(pingInterval);
        aborted.value = true;
      }
    }, PING_INTERVAL_MS);
  };

  const emit = (events: SseEvent[]): void => {
    for (const ev of events) {
      for (const line of encoder.push(ev)) {
        if (committed) {
          if (!aborted.value && !safeWrite(reply.raw, line)) aborted.value = true;
        } else {
          buffered.push(line);
        }
      }
    }
  };

  const maxAttempts = 1 + Math.max(0, emptyStreamRetries);
  let emptyAttempts = 0;

  for (let attempt = 1; ; attempt++) {
    if (aborted.value) break;

    let response: AxiosResponse;
    try {
      response = await provider.callApiStream(requestBody);
    } catch (e) {
      log.error({ msg: 'Kiro API stream call failed (openai)', attempt, error: String(e) });
      mapProviderErrorOpenAi(e, reply);
      return { emptyResponse: false, emptyAttempts };
    }
    log.info({
      msg: 'Kiro API stream connected (openai)',
      attempt,
      duration_ms: Date.now() - apiStart,
    });

    ctx = new StreamContext(
      model,
      inputTokens,
      extractThinking,
      toolNameMap,
      hookBus,
      rescueRegistry,
    );
    encoder = protocol.makeEncoder(model);
    buffered = [];
    emit(ctx.generateInitialEvents());
    upstreamData = undefined;
    draining = false;

    if (commitTimer) clearTimeout(commitTimer);
    commitTimer = setTimeout(() => {
      if (!committed && !aborted.value) {
        log.info({ msg: 'openai stream commit timeout — committing before content', attempt });
        commit();
      }
    }, STREAM_COMMIT_TIMEOUT_MS);

    const decoder = new EventStreamDecoder();
    streamStart = Date.now();

    try {
      const stream = response.data as AsyncIterable<Buffer>;
      upstreamData = response.data as { destroy?: (err?: Error) => void };
      draining = true;
      for await (const chunk of stream) {
        if (aborted.value) armDrainGrace();
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        try {
          decoder.feed(buf);
        } catch (e) {
          log.warn({ msg: 'buffer overflow in decoder (openai)', error: String(e) });
        }
        for (const result of decoder.drainAll()) {
          if (!('frame' in result)) {
            log.warn({ msg: 'event decode failed (openai)', error: String(result.error) });
            continue;
          }
          let sseEvents: SseEvent[];
          try {
            sseEvents = ctx.processKiroEvent(eventFromFrame(result.frame));
          } catch {
            continue;
          }
          emit(sseEvents);
          if (!committed && !aborted.value && hasContent()) commit();
        }
      }
    } catch (e) {
      log.error({ msg: 'error reading response stream (openai)', error: String(e) });
    } finally {
      draining = false;
    }

    if (commitTimer) {
      clearTimeout(commitTimer);
      commitTimer = undefined;
    }

    const attemptStop = ctx.stateManager.getStopReason();
    if (
      hasContent() ||
      attemptStop === 'max_tokens' ||
      attemptStop === 'model_context_window_exceeded' ||
      ctx.getPendingUpstreamError() !== undefined
    ) {
      break;
    }

    emptyAttempts++;
    if (committed || aborted.value || attempt >= maxAttempts) break;
    log.warn({
      msg: 'upstream returned empty stream, retrying (openai)',
      attempt,
      stop_reason: attemptStop,
    });
  }

  if (pingInterval) clearInterval(pingInterval);
  if (commitTimer) clearTimeout(commitTimer);
  if (drainGraceTimer) clearTimeout(drainGraceTimer);

  const silentFailure = !hasContent();
  const logFields = {
    output_tokens: ctx.outputTokens,
    input_tokens: ctx.contextInputTokens ?? ctx.inputTokens,
    stop_reason: ctx.stateManager.getStopReason(),
    committed,
    aborted: aborted.value,
    empty_attempts: emptyAttempts,
    total_duration_ms: Date.now() - apiStart,
    stream_duration_ms: Date.now() - streamStart,
  };

  const upstreamError = ctx.getPendingUpstreamError();
  if (upstreamError) {
    const { status, errorType, message } = upstreamErrorWire(upstreamError.retryable);
    if (!committed) {
      if (!aborted.value) {
        log.warn({
          msg: 'openai: mid-stream error frame, sending status',
          downstream_status: status,
          ...logFields,
        });
        reply.status(status).send(createOpenAiError(message, errorType));
      }
      return { emptyResponse: false, emptyAttempts };
    }
    log.warn({
      msg: 'openai: mid-stream error after commit, in-band',
      downstream_status: status,
      ...logFields,
    });
    // generateFinalEvents(false) 跑计费 hook(恰好一次)+ 关掉仍打开的 block
    // (content_block_stop 等)。这些关块事件**必须**过 encoder 写出:Responses
    // 编码器据此给 open output item 补 output_item.done,否则 Codex 收到悬空
    // in_progress item(踩坑#17)。镜像 claude/stream-handler.ts 的同路径。chat
    // 编码器对 content_block_stop 仅在「打开着的无参数工具块」补一个合法 `{}` 增量
    // (见 response-stream.ts 空输入工具兜底),其余情形不产 chunk——即把可能截断的
    // 半截工具参数补成合法 JSON 再收尾,输出仍有效。
    const closeEvents = await ctx.generateFinalEvents(false);
    if (!aborted.value) {
      for (const ev of closeEvents) {
        let broke = false;
        for (const line of encoder.push(ev)) {
          if (!safeWrite(reply.raw, line)) {
            broke = true;
            break;
          }
        }
        if (broke) break;
      }
      for (const line of protocol.inbandError(encoder, message, errorType))
        safeWrite(reply.raw, line);
    }
    safeEnd(reply.raw);
    return { emptyResponse: false, emptyAttempts };
  }

  if (silentFailure) {
    const emptyMessage = selectEmptyUpstreamMessage(emptyAttempts);
    if (!committed) {
      if (!aborted.value) {
        log.warn({ msg: 'openai: upstream empty stream, sending 503', ...logFields });
        reply.status(503).send(createOpenAiError(emptyMessage, 'overloaded_error'));
        return { emptyResponse: true, emptyAttempts };
      }
      return { emptyResponse: false, emptyAttempts };
    }
    log.warn({ msg: 'openai: upstream empty stream after commit, in-band', ...logFields });
    if (!aborted.value) {
      for (const line of protocol.inbandError(encoder, emptyMessage, 'overloaded_error')) {
        safeWrite(reply.raw, line);
      }
    }
    safeEnd(reply.raw);
    return { emptyResponse: true, emptyAttempts };
  }

  // 正常终结:generateFinalEvents 跑计费 hook(恰好一次),其 SseEvent 过 encoder,
  // 再由 protocol.finalTerminal 追加协议终止行(chat: usage+[DONE];responses: completed)。
  const finalEvents = await ctx.generateFinalEvents();
  if (committed && !aborted.value) {
    for (const ev of finalEvents) {
      let broke = false;
      for (const line of encoder.push(ev)) {
        if (!safeWrite(reply.raw, line)) {
          broke = true;
          break;
        }
      }
      if (broke) break;
    }
    for (const line of protocol.finalTerminal(encoder, ctx)) {
      if (!safeWrite(reply.raw, line)) break;
    }
  }

  log.info({ msg: 'openai stream completed', ...logFields });
  if (committed) safeEnd(reply.raw);
  return { emptyResponse: false, emptyAttempts };
}
