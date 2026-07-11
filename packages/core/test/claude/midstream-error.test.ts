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

  it('fatal exception, no content → 502 api_error, neutral, one upstream call (no retry)', async () => {
    const provider = queueProvider({
      buffer: [
        () => makeBufferResponse([buildExceptionFrame(FATAL_CODE, 'kiro validation blew up')]),
      ],
    });
    app = await buildApp(provider, 2);
    const res = await inject(app, NON_STREAM_BODY);
    expect(res.statusCode).toBe(502);
    const err = res.json() as { error: { type: string; message: string } };
    expect(err.error.type).toBe('api_error');
    expect(err.error.message).not.toMatch(LEAK_RE);
    expect(provider.callApi).toHaveBeenCalledTimes(1);
  });

  it('transient exception, no content → 503 overloaded_error (retryable), neutral, no server retry', async () => {
    const provider = queueProvider({
      buffer: [() => makeBufferResponse([buildExceptionFrame(RETRYABLE_CODE, 'aws throttled')])],
    });
    app = await buildApp(provider, 2);
    const res = await inject(app, NON_STREAM_BODY);
    expect(res.statusCode).toBe(503);
    const err = res.json() as { error: { type: string; message: string } };
    expect(err.error.type).toBe('overloaded_error');
    expect(err.error.message).not.toMatch(LEAK_RE);
    // Surfaced as retryable to the client, but the gateway itself does not retry.
    expect(provider.callApi).toHaveBeenCalledTimes(1);
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

  it('fatal error BEFORE any content (uncommitted) → 502 status, neutral, not retried', async () => {
    const provider = queueProvider({
      stream: [() => makeStreamResponse(bufferStream([buildErrorFrame(FATAL_CODE, 'kiro boom')]))],
    });
    app = await buildApp(provider, 2);
    const res = await inject(app, STREAM_BODY);
    expect(res.statusCode).toBe(502);
    const err = res.json() as { error: { type: string; message: string } };
    expect(err.error.type).toBe('api_error');
    expect(err.error.message).not.toMatch(LEAK_RE);
    expect(provider.callApiStream).toHaveBeenCalledTimes(1);
  });

  it('transient error BEFORE any content (uncommitted) → 503 status (retryable)', async () => {
    const provider = queueProvider({
      stream: [() => makeStreamResponse(bufferStream([buildExceptionFrame(RETRYABLE_CODE)]))],
    });
    app = await buildApp(provider, 2);
    const res = await inject(app, STREAM_BODY);
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: { type: string } }).error.type).toBe('overloaded_error');
    expect(provider.callApiStream).toHaveBeenCalledTimes(1);
  });
});
