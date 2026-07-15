/**
 * SSE stream request handler.
 *
 * This module owns the provider stream call, deferred SSE header emission, the
 * ping interval + client-disconnect tracking, and the frame decode loop.
 *
 * ## Deferred commit (why headers are NOT sent eagerly)
 *
 * We do not write the HTTP 200 + SSE headers up front. Instead we buffer the
 * initial events and `commit` (write headers, flush the buffer, start pinging)
 * only when the first real content frame arrives — or when a keepalive timeout
 * (`STREAM_COMMIT_TIMEOUT_MS`) fires, whichever comes first. The payoff: if the
 * upstream returns a fully empty stream, we never committed, so we can answer
 * with a real `503 overloaded_error` (exactly like the non-stream path) instead
 * of an in-band `error` event that only retry-aware clients act on. A normal
 * stream is unaffected — the first content frame flushes message_start
 * immediately, so time-to-first-byte is essentially unchanged.
 *
 * ## Pre-commit bounded retry on empty streams
 *
 * The deferred-commit design also gives us a clean retry point: while still
 * uncommitted (no bytes on the wire), an empty upstream stream can simply be
 * discarded and the upstream call re-issued, up to `emptyStreamRetries` times.
 * This transparently absorbs the upstream's *transient* empty-200 streams (the
 * common case — a retry recovers) without the client ever seeing a 529. A
 * *deterministic* empty (every retry empty) still ends in the same 503/in-band
 * `overloaded_error` as before. A committed attempt is never retried (headers
 * are already on the wire). See `Config.emptyStreamRetries`.
 *
 * Concrete responsibilities:
 *   1. Track client-close from the very start (before any await) so a
 *      disconnect during the pre-commit window is noticed.
 *   2. Call `provider.callApiStream` and map any error via `mapProviderError`
 *      (still pre-commit, so a real status code is sent).
 *   3. Buffer initial events; on the first content frame (or the keepalive
 *      timeout) `commit`: write SSE headers (incl. x-request-id), flush the
 *      buffer, start the 25s ping keep-alive.
 *   4. Feed chunks into the `EventStreamDecoder`, convert frames into SSE events
 *      via `StreamContext`; write to `reply.raw` once committed.
 *   5. At end: empty + uncommitted → retry while budget remains, else a real
 *      503; empty + committed (timeout path) → in-band `overloaded_error` event;
 *      otherwise `generateFinalEvents()` (runs the usage-finish hook exactly
 *      once) then end the socket.
 */

import type { AxiosResponse } from 'axios';
import type { FastifyReply } from 'fastify';
import { eventFromFrame } from '../kiro/model/events/base.js';
import { EventStreamDecoder } from '../kiro/parser/decoder.js';
import type { KiroProvider } from '../kiro/provider.js';
import type { HookBus } from '../plugin-host/index.js';
import { getLogger } from '../shared/logger.js';
import { getRequestContext } from '../shared/request-context.js';
import type { MessageHandlerResult } from './empty-capture.js';
import { mapProviderError } from './error-mapper.js';
import {
  createSseErrorEvent,
  type SseEvent,
  StreamContext,
  safeEnd,
  safeWrite,
  selectEmptyUpstreamMessage,
  sseEventToString,
  upstreamErrorWire,
} from './stream.js';
import type { ToolTextRegistry } from './tool-call-text.js';
import { createErrorResponse } from './types.js';

/**
 * SSE keep-alive ping interval (25 seconds).
 *
 * Claude SDK clients and most HTTP/proxy infrastructures drop idle TCP
 * connections after 30-60 seconds without data. Sending a ping every 25s
 * leaves a comfortable safety margin before the shortest common idle timeout
 * while still being rare enough to not bloat the wire with noise events.
 */
const PING_INTERVAL_MS = 25_000;

/**
 * Keepalive safety net for deferred commit.
 *
 * Headers (and thus pings) are withheld until the first content frame so an
 * empty upstream can still be answered with a real 503. But if the upstream is
 * slow to produce its first token, the connection would sit header-less and
 * ping-less and risk being dropped by a proxy's idle timeout. So if no content
 * has arrived within this window we commit anyway — sending message_start and
 * starting the ping — and give up the real-503 option for this request (a
 * later-empty stream then falls back to an in-band error event). Chosen below
 * the ~30s shortest common idle timeout so the first byte lands in time.
 */
const STREAM_COMMIT_TIMEOUT_MS = 15_000;

/**
 * Idle deadline for the post-disconnect upstream drain.
 *
 * After the client disconnects we keep reading to capture the tail `Metering`
 * frame (the billed credit), but must not hold the upstream socket for the full
 * 720s axios timeout — under repeated disconnects that would exhaust the
 * connection pool. This timer is re-armed on every chunk, so an upstream that is
 * still actively producing is allowed to finish, while one that stalls for this
 * long after the client left has its socket destroyed.
 */
const POST_DISCONNECT_DRAIN_IDLE_MS = 15_000;

function createPingSse(): string {
  return 'event: ping\ndata: {"type": "ping"}\n\n';
}

/**
 * Handle a streaming `/claude/v1/messages` request.
 *
 * `emptyStreamRetries`: pre-commit 阶段检测到空流时,对同一请求最多重发这么多次
 * 来透明吸收瞬时空流(见 `Config.emptyStreamRetries`)。返回值标记最终是否为空,
 * 供上层诊断抓包。
 *
 * `rescueRegistry`: 泄漏工具调用文本救援的工具注册表(tool-call-text.ts),
 * undefined = 关闭。见 `Config.toolCallTextRescue`。
 */
export async function handleStreamRequest(
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
  abortUpstreamOnDisconnect = false,
): Promise<MessageHandlerResult> {
  const log = getLogger();
  const apiStart = Date.now();

  // Client-disconnect tracking. Registered BEFORE the first upstream await so a
  // disconnect during the pre-commit window (while we are still deciding whether
  // to answer with a 503) is noticed and we never write to a dead socket.
  // 'close' fires when the underlying TCP socket is torn down (Ctrl-C on the
  // client, proxy timeout, etc).
  const aborted = { value: false };
  // 客户端断连时,若 abortUpstreamOnDisconnect 开启,用它主动取消 in-flight 的上游
  // axios 请求(经 provider.callApiStream 的 signal 透传),让 Kiro 停止生成、停止
  // 计费。默认 false 时不触发,保持现有 drain-to-EOF 如实计费行为。
  const upstreamAbort = new AbortController();
  let pingInterval: ReturnType<typeof setInterval> | undefined;
  let commitTimer: ReturnType<typeof setTimeout> | undefined;
  let drainGraceTimer: ReturnType<typeof setTimeout> | undefined;
  let committed = false;
  // The upstream Readable + whether we are still draining it. Used to bound the
  // post-disconnect drain so a disconnected client can't pin an upstream socket
  // for the full 720s axios timeout (which would exhaust the connection pool).
  let upstreamData: { destroy?: (err?: Error) => void } | undefined;
  let draining = false;

  // Arm (or re-arm) the idle deadline for the post-disconnect drain. While the
  // upstream keeps producing chunks we extend it (so an actively-finishing
  // stream still delivers its tail Metering frame); once it goes idle for the
  // grace window we destroy the socket and stop waiting.
  const armDrainGrace = (): void => {
    if (!draining || !upstreamData) return;
    if (drainGraceTimer) clearTimeout(drainGraceTimer);
    drainGraceTimer = setTimeout(() => {
      log.warn({ msg: 'sse upstream drain grace expired after disconnect — destroying socket' });
      try {
        upstreamData?.destroy?.();
      } catch {
        /* already destroyed */
      }
    }, POST_DISCONNECT_DRAIN_IDLE_MS);
    drainGraceTimer.unref();
  };

  reply.raw.on('close', () => {
    if (!aborted.value && committed) {
      log.info({ msg: 'sse client disconnected' });
    }
    aborted.value = true;
    if (pingInterval) clearInterval(pingInterval);
    if (commitTimer) clearTimeout(commitTimer);
    if (abortUpstreamOnDisconnect) {
      // 主动取消上游:客户端已走,立即 abort in-flight 请求让 Kiro 停止生成、停止
      // 计费(实测断连即止,省下断连点之后的 credit)。代价:拿不到尾帧 Metering,
      // per-request 计费记账偏低。见 Config.abortUpstreamOnDisconnect。
      upstreamAbort.abort();
    } else {
      // 默认:bound the remaining upstream drain instead of holding the socket
      // open until the 720s axios timeout —— drain 到 EOF 拿 Metering 如实计费。
      armDrainGrace();
    }
  });

  // SSE headers (inject x-request-id for streaming responses). Computed once.
  const sseHeaders: Record<string, string> = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  };
  const reqCtx = getRequestContext();
  if (reqCtx) {
    sseHeaders['x-request-id'] = reqCtx.reqId;
  }

  // Per-attempt state. `ctx` and `buffered` are reassigned each retry attempt;
  // the `commit`/`hasContent` closures below bind to these `let`s so they always
  // see the current attempt's state. Initialized before the closures so the
  // single-attempt case is unchanged.
  let ctx: StreamContext = new StreamContext(
    model,
    inputTokens,
    extractThinking,
    toolNameMap,
    hookBus,
    rescueRegistry,
  );
  let buffered: SseEvent[] = [];
  let streamStart = apiStart;

  // "Has the upstream emitted any real content yet?" Drives both the commit
  // trigger (flush on the first content frame) and the silent-failure check (a
  // fully empty stream is its negation). One definition so the two can't drift.
  // Three ways to be non-empty:
  //   - outputTokens > 0     — text or tool-input bytes arrived
  //   - thinkingExtracted    — a reasoning-only stream (0 output tokens) is not silent
  //   - sawCompletedToolUse  — a COMPLETE tool_use, even with empty input (a
  //                            no-required-args tool like browser_snapshot the
  //                            model calls with `{}`). The non-stream path
  //                            surfaces such a call as a tool_use, so the stream
  //                            path must too — else the SAME request diverges into
  //                            "stream 503 vs non-stream 200" (2026-07).
  // A *truncated* tool frame (isComplete=false) sets none of these → still empty,
  // retried like any transient silent stream.
  const hasContent = (): boolean =>
    ctx.outputTokens > 0 || ctx.thinkingExtracted || ctx.sawCompletedToolUse;

  // Commit: write headers, flush the buffered events, start the ping keep-alive.
  // Idempotent and a no-op once the client is gone. Before commit nothing
  // touches reply.raw — that is exactly what lets the terminal path answer an
  // empty stream with a real 503 status (and what makes pre-commit retry safe).
  const commit = (): void => {
    if (committed || aborted.value) return;
    committed = true;
    if (commitTimer) {
      clearTimeout(commitTimer);
      commitTimer = undefined;
    }
    reply.raw.writeHead(200, sseHeaders);
    for (const event of buffered) {
      if (!safeWrite(reply.raw, sseEventToString(event))) {
        aborted.value = true;
        break;
      }
    }
    buffered.length = 0;
    pingInterval = setInterval(() => {
      if (!safeWrite(reply.raw, createPingSse())) {
        // Socket already gone: stop pinging and mark aborted so the loop exits
        if (pingInterval) clearInterval(pingInterval);
        aborted.value = true;
      }
    }, PING_INTERVAL_MS);
  };

  const maxAttempts = 1 + Math.max(0, emptyStreamRetries);
  let emptyAttempts = 0;

  // Pre-commit bounded retry loop. Each attempt is a fresh upstream call with a
  // fresh StreamContext/decoder/buffer. We only loop again when this attempt was
  // empty AND we never committed (no bytes on the wire) AND the client is still
  // here AND retries remain. A committed or content-bearing attempt breaks out.
  for (let attempt = 1; ; attempt++) {
    if (aborted.value) break;

    let response: AxiosResponse;
    try {
      response = await provider.callApiStream(requestBody, upstreamAbort.signal);
    } catch (e) {
      if (aborted.value && abortUpstreamOnDisconnect) {
        // 主动 abort 上游导致的取消:客户端已断开,这是预期内的取消而非 upstream
        // failure。不写已断的 reply、不当错误上报。见 Config.abortUpstreamOnDisconnect。
        log.info({ msg: 'upstream stream call aborted on client disconnect', attempt });
        return { emptyResponse: false, emptyAttempts };
      }
      // A THROW is a real upstream failure (4xx/5xx/network) classified by
      // retry-executor — forward it verbatim per the zero-retry-forwarding
      // contract (honours Retry-After, doesn't burn credit on non-recoverable
      // errors). The empty-stream retry below is ONLY for 200 streams that
      // decode to zero content frames, which never throw.
      log.error({
        msg: 'Kiro API stream call failed',
        attempt,
        duration_ms: Date.now() - apiStart,
        error: String(e),
      });
      mapProviderError(e, reply);
      return { emptyResponse: false, emptyAttempts };
    }
    log.info({ msg: 'Kiro API stream connected', attempt, duration_ms: Date.now() - apiStart });

    // Fresh per-attempt state. Initial events (message_start + optional text
    // block start) set up the ctx state machine; they are BUFFERED and flushed
    // at commit time, not written eagerly.
    ctx = new StreamContext(
      model,
      inputTokens,
      extractThinking,
      toolNameMap,
      hookBus,
      rescueRegistry,
    );
    buffered = ctx.generateInitialEvents();
    upstreamData = undefined;
    draining = false;

    // (Re-)arm the keepalive safety net: commit even without content if the
    // upstream is slow, so the connection is not dropped while still header-less.
    if (commitTimer) clearTimeout(commitTimer);
    commitTimer = setTimeout(() => {
      if (!committed && !aborted.value) {
        log.info({ msg: 'stream commit timeout — committing before any content', attempt });
        commit();
      }
    }, STREAM_COMMIT_TIMEOUT_MS);

    // Process Kiro response stream
    const decoder = new EventStreamDecoder();
    streamStart = Date.now();

    // IMPORTANT: even after the client disconnects (`aborted`) we keep DRAINING the
    // upstream to EOF. The tail `Metering` frame — the credit the account is billed
    // for — only arrives at the very end; breaking early would make the usage-finish
    // hook record zero credit for a billed request. So we ALWAYS
    // feed/decode/`processKiroEvent` (captures Metering, accumulates outputTokens)
    // and only WRITE to reply.raw while connected and committed. Bounded by the
    // provider's 720s axios timeout.
    try {
      const stream = response.data as AsyncIterable<Buffer>;
      upstreamData = response.data as { destroy?: (err?: Error) => void };
      draining = true;
      for await (const chunk of stream) {
        // If the client already left, keep draining for the tail Metering frame
        // but re-arm the idle deadline on each chunk so a stalled upstream is
        // reaped promptly while one that is still finishing is allowed to.
        if (aborted.value) armDrainGrace();
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        try {
          decoder.feed(buf);
        } catch (e) {
          log.warn({ msg: 'buffer overflow in decoder', error: String(e) });
        }

        for (const result of decoder.drainAll()) {
          if (!('frame' in result)) {
            log.warn({ msg: 'event decode failed', error: String(result.error) });
            continue;
          }

          let sseEvents: SseEvent[];
          try {
            const event = eventFromFrame(result.frame);
            // Always process — captures the Metering frame and accumulates
            // outputTokens, even after the client has gone.
            sseEvents = ctx.processKiroEvent(event);
          } catch {
            // Frame parse error, skip
            continue;
          }

          for (const sseEvent of sseEvents) {
            if (committed) {
              // Only forward while the client is still connected. After a
              // disconnect we keep draining (for Metering) but stop writing.
              if (!aborted.value && !safeWrite(reply.raw, sseEventToString(sseEvent))) {
                aborted.value = true;
              }
            } else {
              buffered.push(sseEvent);
            }
          }

          // Commit on the first real content (text / tool_use / reasoning). The
          // buffered events (initial + this frame's) flush in order.
          if (!committed && !aborted.value && hasContent()) {
            commit();
          }
        }
      }
    } catch (e) {
      if (aborted.value && abortUpstreamOnDisconnect) {
        // 主动 abort 上游:客户端已走,读流被取消是预期内的,不是错误(省了 credit)。
        log.info({ msg: 'upstream stream aborted on client disconnect (credit saved)' });
      } else {
        log.error({ msg: 'error reading response stream', error: String(e) });
      }
    } finally {
      draining = false;
    }

    // Attempt's commit timer no longer needed.
    if (commitTimer) {
      clearTimeout(commitTimer);
      commitTimer = undefined;
    }

    // Did this attempt produce billable content, OR a deterministic terminal
    // (max_tokens / context-window-exceeded) that retrying cannot fix? Either
    // way, stop — only transient empty streams are worth re-issuing. (Mirrors
    // the non-stream silentFailure exclusions; without this a deterministic
    // over-limit empty would burn `emptyStreamRetries` extra upstream calls.)
    const attemptStop = ctx.stateManager.getStopReason();
    if (
      hasContent() ||
      attemptStop === 'max_tokens' ||
      attemptStop === 'model_context_window_exceeded' ||
      // 上游发来显式 Error/Exception 帧 = 确定性终止,不当空流重试(会白烧
      // credit);由终结段的 getPendingUpstreamError() 明确报错。
      ctx.getPendingUpstreamError() !== undefined
    ) {
      break;
    }

    // Empty attempt. Retry only while we never committed, the client is still
    // here, and budget remains. A committed-then-empty attempt cannot be retried
    // (headers already on the wire) and falls through to the in-band path below.
    emptyAttempts++;
    if (committed || aborted.value || attempt >= maxAttempts) break;
    log.warn({
      msg: 'upstream returned empty stream, retrying',
      attempt,
      remaining: maxAttempts - attempt,
      // 诊断线索:落到这里的「空」是 *截断* 的 tool 帧(宣告了 tool_use 但完整帧
      // 从未到达,isComplete=false)或纯零帧流——*完整* 的空参数 tool_use
      // (browser_snapshot 等)已算作内容、正常提交,不会到这。工具名便于定位。
      stop_reason: attemptStop,
      event_counts: ctx.getEventCounts(),
      tool_use_names: [...ctx.seenToolUseNames],
    });
  }

  // Timers no longer needed (idempotent — the close handler may have cleared them).
  if (pingInterval) clearInterval(pingInterval);
  if (commitTimer) clearTimeout(commitTimer);
  if (drainGraceTimer) clearTimeout(drainGraceTimer);

  // Silent-failure detection: a 200 OK stream that produced zero content frames
  // (the negation of `hasContent`). Mirrors the non-stream-handler check. Only a
  // FULLY empty stream qualifies — an upstream that emits some content then goes
  // silent has already committed, so it surfaces as a normal (if truncated)
  // message_stop.
  const silentFailure = !hasContent();

  const logFields = {
    output_tokens: ctx.outputTokens,
    input_tokens: ctx.contextInputTokens ?? ctx.inputTokens,
    stop_reason: ctx.stateManager.getStopReason(),
    thinking_detected: ctx.thinkingExtracted,
    kiro_metering: ctx.kiroMeteringRaw,
    committed,
    aborted: aborted.value,
    // 断连成本观测:客户端已断开(aborted)但网关仍 drain 到上游 EOF、拿到了计费
    // (output_tokens>0)。实测(kiro-cli, 2026-07)Kiro 对客户端 TCP 断开会停止生成
    // 计费,但网关当前 drain 维持了上游连接,使这部分仍被全额计费——此字段量化
    // 「断连后仍付费」的成本,便于 grep 统计。开启 abortUpstreamOnDisconnect 可消除。
    drained_after_disconnect: aborted.value && !abortUpstreamOnDisconnect && ctx.outputTokens > 0,
    empty_attempts: emptyAttempts,
    // 空流诊断:事件计数区分「纯零帧」与「宣告了 tool_use 却没吐完整帧的截断流」;
    // 工具名把这类截断空流的范围缩小到具体调用点(完整的空参数 tool_use 已不再落空)。
    event_counts: ctx.getEventCounts(),
    tool_use_names: [...ctx.seenToolUseNames],
    // 前向兼容观测:上游若发来未识别 event-type,在此显形(当前为良性 metadata)。
    unknown_event_types: [...ctx.unknownEventTypes],
    stream_duration_ms: Date.now() - streamStart,
    total_duration_ms: Date.now() - apiStart,
  };

  // Mid-stream upstream Error/Exception frame: surface it explicitly instead of
  // silently truncating into a clean message_stop. Takes precedence over the
  // empty/silent-failure path — an explicit upstream error is more specific than
  // "looks empty". The client message is neutral; the raw code/message was already
  // logged at the Error/Exception case (leak rule).
  const upstreamError = ctx.getPendingUpstreamError();
  if (upstreamError) {
    // Retryable (throttle/internal/unavailable) → 503/overloaded_error so the SDK
    // retries; fatal → 502/api_error hard-stop. Client message is neutral; the raw
    // code/message was already logged at the Error/Exception case (leak rule).
    const { status, errorType, message } = upstreamErrorWire(upstreamError.retryable);
    if (!committed) {
      // Never committed → we can still send a real HTTP status, like the non-stream path.
      if (!aborted.value) {
        log.warn({
          msg: 'upstream sent mid-stream error frame, sending status',
          upstream_error: upstreamError,
          downstream_status: status,
          ...logFields,
        });
        reply.status(status).send(createErrorResponse(errorType, message));
        return { emptyResponse: false, emptyAttempts };
      }
      log.info({ msg: 'client disconnected before mid-stream error surfaced', ...logFields });
      return { emptyResponse: false, emptyAttempts };
    }
    // Committed → headers already on the wire, so send a terminal in-band `error`
    // event. `generateFinalEvents(false)` still runs the usage-finish hook (bills
    // the credit captured before the error) and closes open blocks, but suppresses
    // the success-signalling message_delta/message_stop — so every returned event
    // is safe to forward, then the terminal error event follows.
    log.warn({
      msg: 'upstream sent mid-stream error frame after commit, in-band error',
      upstream_error: upstreamError,
      downstream_status: status,
      ...logFields,
    });
    const finalEvents = await ctx.generateFinalEvents(false);
    if (!aborted.value) {
      for (const ev of finalEvents) {
        if (!safeWrite(reply.raw, sseEventToString(ev))) break;
      }
      safeWrite(reply.raw, sseEventToString(createSseErrorEvent(errorType, message)));
    }
    safeEnd(reply.raw);
    return { emptyResponse: false, emptyAttempts };
  }

  if (silentFailure) {
    // 重试预算耗尽仍每次都空 → 确定性空流:失败绑定在请求内容上,再让客户端
    // 「please retry」只会烧 credit(实测 33 次同请求全空)。文案改为提示
    // 压缩/裁剪会话——唯一有效的用户侧自救。单次尝试(retries=0)保留原文案。
    const emptyMessage = selectEmptyUpstreamMessage(emptyAttempts);

    // No billable content → no usage-finish hook (matches the historical empty
    // path). How we signal it depends on whether headers are already on the wire.
    if (!committed) {
      if (!aborted.value) {
        // Never committed → we can still send a real status code, exactly like
        // the non-stream path. This is the core win: a retryable 503 the SDK's
        // built-in HTTP retry acts on, not an in-band event the app must catch.
        log.warn({ msg: 'upstream returned empty stream, sending 503', ...logFields });
        reply.status(503).send(createErrorResponse('overloaded_error', emptyMessage));
        return { emptyResponse: true, emptyAttempts };
      }
      // Client left during the pre-commit window — nothing to send.
      log.info({ msg: 'sse client disconnected before any content', ...logFields });
      return { emptyResponse: false, emptyAttempts };
    }

    // Committed via the keepalive timeout, then turned out empty → fall back to
    // an in-band error event (headers are already sent, can't send a status).
    log.warn({ msg: 'upstream returned empty stream after commit, in-band error', ...logFields });
    if (!aborted.value) {
      safeWrite(reply.raw, sseEventToString(createSseErrorEvent('overloaded_error', emptyMessage)));
    }
    safeEnd(reply.raw);
    return { emptyResponse: true, emptyAttempts };
  }

  // Billable content exists. Run the usage-finish hook EXACTLY ONCE — even after a
  // disconnect (so plugins record the credit captured during the drain) and even
  // in the rare race where content arrived but the client aborted before commit.
  const finalEvents = await ctx.generateFinalEvents();

  // Only forward while the client is still connected. After a disconnect the
  // billing data is already captured, so these events are simply discarded.
  if (committed && !aborted.value) {
    for (const event of finalEvents) {
      if (!safeWrite(reply.raw, sseEventToString(event))) break;
    }
  }

  log.info({ msg: 'stream completed', ...logFields });

  if (committed) {
    safeEnd(reply.raw);
  }
  return { emptyResponse: false, emptyAttempts };
}
