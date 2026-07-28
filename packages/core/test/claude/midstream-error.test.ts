/**
 * Mid-stream upstream Error/Exception surfacing tests.
 *
 * An upstream `error`/`exception` message-type frame arriving mid-response was
 * previously DROPPED (streaming: silent clean `message_stop`; non-stream: no
 * `case 'Error'` at all → no log, no client error). Now surfaced explicitly and
 * classified:
 *   - transient codes (Throttling/InternalServer/…) → 503 `overloaded_error`
 *     (client SDK retries the whole request);
 *   - other codes → 502 `api_error` (hard stop, no retry);
 *   - streaming post-commit → terminal in-band `error` event (no `message_stop`);
 *   - `ContentLengthExceededException` stays a benign 200 `max_tokens`.
 *
 * Asserts: real client-visible error (never a silent 200), correct retryable
 * classification, partial content discarded (non-stream), no server-side retry
 * of an explicit error, credit captured before the error is still billed, and a
 * neutral (non-leaking) client message.
 */

import type { AxiosResponse } from 'axios';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { KiroProvider } from '../../src/kiro/provider.js';
import { HookBus } from '../../src/plugin-host/index.js';
import { registerClaudeRoutes } from '../../src/routes/claude.js';
import {
  buildAssistantResponseFrame,
  buildErrorFrame,
  buildExceptionFrame,
  buildMeteringFrame,
  buildRedactedReasoningFrame,
  parseSseEvents,
} from '../helpers/event-stream.js';

const API_KEY = 'sk-test-midstream-error';
const MODEL = 'claude-sonnet-4-5-20250929';

// A retryable (transient) and a fatal code, per RETRYABLE_UPSTREAM_ERROR_CODES.
const RETRYABLE_CODE = 'ThrottlingException';
const RETRYABLE_CODE_2 = 'InternalServerException';
const FATAL_CODE = 'ValidationException';

async function* bufferStream(buffers: Buffer[]): AsyncIterable<Buffer> {
  for (const buf of buffers) yield buf;
}
function makeStreamResponse(body: AsyncIterable<Buffer>): AxiosResponse {
  return {
    data: body as unknown as AxiosResponse['data'],
    status: 200,
    statusText: 'OK',
    headers: {},
    config: {} as AxiosResponse['config'],
  };
}
function makeBufferResponse(frames: Buffer[]): AxiosResponse {
  return {
    data: Buffer.concat(frames),
    status: 200,
    statusText: 'OK',
    headers: {},
    config: {} as AxiosResponse['config'],
  };
}

function queueProvider(opts: {
  stream?: Array<() => AxiosResponse>;
  buffer?: Array<() => AxiosResponse>;
}): KiroProvider {
  let si = 0;
  let bi = 0;
  return {
    callApiStream: vi.fn(async () => {
      const fns = opts.stream ?? [];
      const f = fns[Math.min(si, fns.length - 1)];
      si++;
      return f();
    }),
    callApi: vi.fn(async () => {
      const fns = opts.buffer ?? [];
      const f = fns[Math.min(bi, fns.length - 1)];
      bi++;
      return f();
    }),
    callMcp: vi.fn(),
  } as unknown as KiroProvider;
}

/** A HookBus that records how many times usage-finish ran + the last credits. */
function countingBus() {
  const bus = new HookBus();
  const state = { runs: 0, credits: undefined as number | undefined };
  bus.registerUsageFinish('t', (e) => {
    state.runs += 1;
    state.credits = e.getMeta<number>('kiro.creditsUsed');
  });
  return { bus, state };
}

async function buildApp(
  provider: KiroProvider,
  emptyStreamRetries = 2,
  hookBus: HookBus = new HookBus(),
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(
    async (instance) => {
      await registerClaudeRoutes(instance, {
        apiKey: API_KEY,
        kiroProvider: provider,
        extractThinking: true,
        identityOverride: false,
        rejectUnsupportedDocuments: true,
        emptyStreamRetries,
        hookBus,
      });
    },
    { prefix: '/claude/v1' },
  );
  await app.ready();
  return app;
}

const inject = (app: FastifyInstance, payload: unknown) =>
  app.inject({
    method: 'POST',
    url: '/claude/v1/messages',
    headers: { 'x-api-key': API_KEY },
    payload,
  });

const STREAM_BODY = {
  model: MODEL,
  max_tokens: 1024,
  stream: true,
  messages: [{ role: 'user', content: 'hello' }],
};
const NON_STREAM_BODY = { ...STREAM_BODY, stream: false };

/** No kiro/aws/upstream/backend-identifying wording may reach the client. The
 *  upstream frames below deliberately carry such words in their payloads. */
const LEAK_RE = /kiro|aws|upstream|backend|codewhisperer|smithy/i;

describe('mid-stream error surfacing: non-stream (app.inject)', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
  });

  /**
   * 零帧拒绝 = 上游没开工 → 走有界重试。
   *
   * 原契约是「上游发来显式 Error/Exception 帧一律不重试」,理由是重试白烧 credit。
   * 但那个理由只在上游**已经开工**时成立:生产上另有一类 1ms 内零帧拒绝
   * (`event_counts` 只有 `Exception:1`),没有任何 credit 可烧,重发几乎必然恢复。
   * 判据是 `sawBillableWork`,与错误码的 retryable 分类**无关** —— 那个集合被实测
   * 证明不完整(真实世界最常见的是泛化 `code:"error"`,不在集合里)。代价是一个真·
   * 确定性的零帧拒绝会多打两次上游,但每次都在毫秒级被拒、零成本,下游结果不变。
   */
  it('fatal exception, zero frames → 502 api_error, neutral, retried (no credit to burn)', async () => {
    const provider = queueProvider({
      buffer: [
        () => makeBufferResponse([buildExceptionFrame(FATAL_CODE, 'kiro validation blew up')]),
      ],
    });
    app = await buildApp(provider, 2);
    const res = await inject(app, NON_STREAM_BODY);
    // 下游 wire 结果与旧契约完全一致 —— 变的只是尝试次数。
    expect(res.statusCode).toBe(502);
    const err = res.json() as { error: { type: string; message: string } };
    expect(err.error.type).toBe('api_error');
    expect(err.error.message).not.toMatch(LEAK_RE);
    expect(provider.callApi).toHaveBeenCalledTimes(3);
  });

  it('transient exception, zero frames → 503 overloaded_error, retried', async () => {
    const provider = queueProvider({
      buffer: [() => makeBufferResponse([buildExceptionFrame(RETRYABLE_CODE, 'aws throttled')])],
    });
    app = await buildApp(provider, 2);
    const res = await inject(app, NON_STREAM_BODY);
    expect(res.statusCode).toBe(503);
    const err = res.json() as { error: { type: string; message: string } };
    expect(err.error.type).toBe('overloaded_error');
    expect(err.error.message).not.toMatch(LEAK_RE);
    expect(provider.callApi).toHaveBeenCalledTimes(3);
  });

  it('★ zero-frame reject recovers transparently when a retry succeeds', async () => {
    // 这才是这条改动的收益:客户端根本看不到那次失败。
    const provider = queueProvider({
      buffer: [
        () => makeBufferResponse([buildExceptionFrame(FATAL_CODE, 'kiro transient reject')]),
        () => makeBufferResponse([buildAssistantResponseFrame('recovered')]),
      ],
    });
    app = await buildApp(provider, 2);
    const res = await inject(app, NON_STREAM_BODY);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('recovered');
    expect(provider.callApi).toHaveBeenCalledTimes(2);
  });

  it('transient error frame (kind Error) → 503 overloaded_error', async () => {
    const provider = queueProvider({
      buffer: [() => makeBufferResponse([buildErrorFrame(RETRYABLE_CODE_2, 'kiro internal boom')])],
    });
    app = await buildApp(provider, 2);
    const res = await inject(app, NON_STREAM_BODY);
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: { type: string } }).error.type).toBe('overloaded_error');
  });

  it('fatal error AFTER partial content → 502 (partial content discarded, not a 200)', async () => {
    const provider = queueProvider({
      buffer: [
        () =>
          makeBufferResponse([
            buildAssistantResponseFrame('partial answer that should NOT reach the client'),
            buildErrorFrame(FATAL_CODE),
          ]),
      ],
    });
    app = await buildApp(provider, 2);
    const res = await inject(app, NON_STREAM_BODY);
    expect(res.statusCode).toBe(502);
    expect(res.body).not.toContain('partial answer');
    expect((res.json() as { error: { type: string } }).error.type).toBe('api_error');
  });

  it('credit consumed before the error is still billed (Metering frame precedes error)', async () => {
    const { bus, state } = countingBus();
    const provider = queueProvider({
      buffer: [
        () =>
          makeBufferResponse([
            buildAssistantResponseFrame('partial'),
            buildMeteringFrame({ unit: 'credit', unitPlural: 'credits', usage: 0.42 }),
            buildErrorFrame(FATAL_CODE),
          ]),
      ],
    });
    app = await buildApp(provider, 2, bus);
    const res = await inject(app, NON_STREAM_BODY);
    expect(res.statusCode).toBe(502);
    // Regression guard: the old 200 path billed this; the error path must too.
    expect(state.runs).toBe(1);
    expect(state.credits).toBeCloseTo(0.42);
  });

  it('ContentLengthExceededException stays a 200 max_tokens terminal (regression: NOT an error)', async () => {
    const provider = queueProvider({
      buffer: [() => makeBufferResponse([buildExceptionFrame('ContentLengthExceededException')])],
    });
    app = await buildApp(provider, 2);
    const res = await inject(app, NON_STREAM_BODY);
    expect(res.statusCode).toBe(200);
    expect((res.json() as { stop_reason: string }).stop_reason).toBe('max_tokens');
    expect(provider.callApi).toHaveBeenCalledTimes(1);
  });
});

describe('mid-stream error surfacing: streaming (app.inject)', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
  });

  it('fatal error AFTER commit → in-band api_error event, no message_stop, neutral', async () => {
    const provider = queueProvider({
      stream: [
        () =>
          makeStreamResponse(
            bufferStream([
              buildAssistantResponseFrame('streamed so far'),
              buildMeteringFrame({ unit: 'credit', unitPlural: 'credits', usage: 0.5 }),
              buildErrorFrame(FATAL_CODE, 'kiro boom'),
            ]),
          ),
      ],
    });
    app = await buildApp(provider, 2);
    const res = await inject(app, STREAM_BODY);
    expect(res.statusCode).toBe(200); // headers already committed
    const events = parseSseEvents(res.body);
    const errIdx = events.findIndex((e) => e.event === 'error');
    expect(errIdx, 'must emit an in-band error event').toBeGreaterThanOrEqual(0);
    const errEvent = events[errIdx];
    expect((errEvent.data as { error: { type: string } }).error.type).toBe('api_error');
    expect((errEvent.data as { error: { message: string } }).error.message).not.toMatch(LEAK_RE);
    const stopAfter = events.slice(errIdx + 1).some((e) => e.event === 'message_stop');
    expect(stopAfter, 'no message_stop may follow the error').toBe(false);
    expect(provider.callApiStream).toHaveBeenCalledTimes(1);
  });

  it('transient error AFTER commit → in-band overloaded_error event', async () => {
    const provider = queueProvider({
      stream: [
        () =>
          makeStreamResponse(
            bufferStream([
              buildAssistantResponseFrame('streamed'),
              buildErrorFrame(RETRYABLE_CODE),
            ]),
          ),
      ],
    });
    app = await buildApp(provider, 2);
    const res = await inject(app, STREAM_BODY);
    const events = parseSseEvents(res.body);
    const errEvent = events.find((e) => e.event === 'error');
    expect(errEvent, 'must emit an in-band error event').toBeTruthy();
    expect((errEvent?.data as { error: { type: string } }).error.type).toBe('overloaded_error');
  });

  it('fatal error, zero frames (uncommitted) → 502 status, neutral, retried', async () => {
    // 与非流式对称,理由见那边的块注释。下游结果不变,变的只是尝试次数。
    const provider = queueProvider({
      stream: [() => makeStreamResponse(bufferStream([buildErrorFrame(FATAL_CODE, 'kiro boom')]))],
    });
    app = await buildApp(provider, 2);
    const res = await inject(app, STREAM_BODY);
    expect(res.statusCode).toBe(502);
    const err = res.json() as { error: { type: string; message: string } };
    expect(err.error.type).toBe('api_error');
    expect(err.error.message).not.toMatch(LEAK_RE);
    expect(provider.callApiStream).toHaveBeenCalledTimes(3);
  });

  it('transient error, zero frames (uncommitted) → 503 status (retryable), retried', async () => {
    const provider = queueProvider({
      stream: [() => makeStreamResponse(bufferStream([buildExceptionFrame(RETRYABLE_CODE)]))],
    });
    app = await buildApp(provider, 2);
    const res = await inject(app, STREAM_BODY);
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: { type: string } }).error.type).toBe('overloaded_error');
    expect(provider.callApiStream).toHaveBeenCalledTimes(3);
  });

  it('★ zero-frame reject recovers transparently when a retry succeeds', async () => {
    const provider = queueProvider({
      stream: [
        () => makeStreamResponse(bufferStream([buildErrorFrame(FATAL_CODE, 'kiro boom')])),
        () => makeStreamResponse(bufferStream([buildAssistantResponseFrame('recovered')])),
      ],
    });
    app = await buildApp(provider, 2);
    const res = await inject(app, STREAM_BODY);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('recovered');
    // 客户端不该看到任何 error 事件 —— 那次失败被透明吸收了。
    expect(parseSseEvents(res.body).some((e) => e.event === 'error')).toBe(false);
    expect(provider.callApiStream).toHaveBeenCalledTimes(2);
  });

  it('★ 反向守卫:上游已开工(GPT 加密 reasoning)后报错 → 绝不重试', async () => {
    // 这是这条改动最危险的失误模式。GPT 的 reasoning 是加密的 redactedContent,
    // processReasoningContent 整块丢弃(踩坑 #15)→ 既没有 output_tokens 也没有
    // thinking,`hasContent()` 谎报为「空」。若拿 hasContent() 当重试判据,一个已经
    // 烧掉数千帧 reasoning 的流会被重发,正好在最贵的失败上白烧 credit。
    // 判据必须是 sawBillableWork(看上游发过什么帧),这里钉死它。
    const provider = queueProvider({
      stream: [
        () =>
          makeStreamResponse(
            bufferStream([
              buildRedactedReasoningFrame(),
              buildRedactedReasoningFrame(),
              buildErrorFrame(RETRYABLE_CODE_2, 'kiro internal boom'),
            ]),
          ),
      ],
    });
    app = await buildApp(provider, 2);
    const res = await inject(app, STREAM_BODY);
    expect(res.statusCode).toBe(503);
    // 上游已开工 = 确定性终止,单次定案。
    expect(provider.callApiStream).toHaveBeenCalledTimes(1);
  });
});
