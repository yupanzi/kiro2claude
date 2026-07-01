/**
 * Empty-stream bounded-retry tests (`KIRO2CLAUDE_EMPTY_STREAM_RETRIES`).
 *
 * Pins the reliability fix for upstream "200 OK + zero content frames" silent
 * failures: the gateway re-issues the SAME upstream request, pre-commit, up to
 * N times to transparently absorb *transient* empty streams. Asserts:
 *
 * - stream: empty → content within budget delivers content (no 529 to client),
 *   re-calls callApiStream, runs the usage-finish hook exactly once
 * - stream: budget exhausted → real 503 `overloaded_error`
 * - stream: retries=0 keeps the historical single-attempt behavior
 * - stream: a committed-then-empty attempt is NEVER retried (headers on wire)
 * - non-stream: empty → content within budget; exhausted → 503
 * - non-stream: a legitimate `max_tokens` empty terminal is NOT treated as a
 *   silent failure (must not be retried / 529'd)
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AxiosResponse } from 'axios';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleNonStreamRequest } from '../../src/claude/non-stream-handler.js';
import { handleStreamRequest } from '../../src/claude/stream-handler.js';
import type { KiroProvider } from '../../src/kiro/provider.js';
import { ProviderError } from '../../src/kiro/provider-error.js';
import { HookBus } from '../../src/plugin-host/index.js';
import { registerClaudeRoutes } from '../../src/routes/claude.js';
import {
  buildAssistantResponseFrame,
  buildContextUsageFrame,
  buildMeteringFrame,
  encodeEventStreamFrame,
  framesWithMetering,
} from '../helpers/event-stream.js';

const API_KEY = 'sk-test-empty-retry';
const MODEL = 'claude-sonnet-4-5-20250929';

async function* emptyStream(): AsyncIterable<Buffer> {
  // yields nothing → silent failure
}
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

/**
 * Provider whose stream/non-stream calls walk a queue of response factories.
 * Each factory is invoked fresh per call (generators are single-use). Once the
 * queue is exhausted the last factory repeats.
 */
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

async function buildApp(
  provider: KiroProvider,
  emptyStreamRetries: number,
  captureEmptyDir?: string,
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
        captureEmptyDir,
        hookBus: new HookBus(),
      });
    },
    { prefix: '/claude/v1' },
  );
  await app.ready();
  return app;
}

/** A HookBus that records how many times the usage-finish hook ran + last credits. */
function makeCountingBus() {
  const bus = new HookBus();
  const state = { runs: 0, credits: undefined as number | undefined };
  bus.registerUsageFinish('t', (e) => {
    state.runs += 1;
    state.credits = e.getMeta<number>('kiro.creditsUsed');
  });
  return { bus, state };
}

/**
 * Minimal FastifyReply stub for direct non-stream handler calls. Captures the
 * `reply.raw` 'close' handler (so a test can simulate a client disconnect) and
 * the status/body of the single `reply.status().send()` / `reply.send()`.
 */
function nonStreamReplyStub() {
  const state = {
    closeCb: undefined as (() => void) | undefined,
    statusCode: 200,
    body: undefined as unknown,
  };
  const reply = {
    raw: {
      on: vi.fn((ev: string, cb: () => void) => {
        if (ev === 'close') state.closeCb = cb;
      }),
    },
    status: vi.fn((c: number) => {
      state.statusCode = c;
      return reply;
    }),
    send: vi.fn((b: unknown) => {
      state.body = b;
    }),
  };
  return { reply: reply as never, state };
}

const STREAM_BODY = {
  model: MODEL,
  max_tokens: 1024,
  stream: true,
  messages: [{ role: 'user', content: 'hello' }],
};
const NON_STREAM_BODY = { ...STREAM_BODY, stream: false };

describe('empty-stream retry: streaming path (app.inject)', () => {
  let app: FastifyInstance | undefined;
  beforeEach(() => {
    app = undefined;
  });
  afterEach(async () => {
    if (app) await app.close();
  });

  it('empty then content within budget: client gets content, callApiStream re-called', async () => {
    const provider = queueProvider({
      stream: [
        () => makeStreamResponse(emptyStream()),
        () => makeStreamResponse(bufferStream([buildAssistantResponseFrame('hello world')])),
      ],
    });
    app = await buildApp(provider, 2);
    const res = await app.inject({
      method: 'POST',
      url: '/claude/v1/messages',
      headers: { 'x-api-key': API_KEY },
      payload: STREAM_BODY,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('hello world');
    expect(res.body).toMatch(/event: message_stop/);
    expect(provider.callApiStream).toHaveBeenCalledTimes(2);
  });

  it('two empties then content: re-calls up to the budget', async () => {
    const provider = queueProvider({
      stream: [
        () => makeStreamResponse(emptyStream()),
        () => makeStreamResponse(emptyStream()),
        () => makeStreamResponse(bufferStream([buildAssistantResponseFrame('third time')])),
      ],
    });
    app = await buildApp(provider, 2);
    const res = await app.inject({
      method: 'POST',
      url: '/claude/v1/messages',
      headers: { 'x-api-key': API_KEY },
      payload: STREAM_BODY,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('third time');
    expect(provider.callApiStream).toHaveBeenCalledTimes(3);
  });

  it('all empty (budget exhausted): real 503 overloaded_error, exactly maxAttempts calls', async () => {
    const provider = queueProvider({ stream: [() => makeStreamResponse(emptyStream())] });
    app = await buildApp(provider, 2);
    const res = await app.inject({
      method: 'POST',
      url: '/claude/v1/messages',
      headers: { 'x-api-key': API_KEY },
      payload: STREAM_BODY,
    });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: { type: string } }).error.type).toBe('overloaded_error');
    expect(provider.callApiStream).toHaveBeenCalledTimes(3); // 1 + 2 retries
  });

  it('retries=0 keeps single-attempt behavior (immediate 503, one call)', async () => {
    const provider = queueProvider({ stream: [() => makeStreamResponse(emptyStream())] });
    app = await buildApp(provider, 0);
    const res = await app.inject({
      method: 'POST',
      url: '/claude/v1/messages',
      headers: { 'x-api-key': API_KEY },
      payload: STREAM_BODY,
    });
    expect(res.statusCode).toBe(503);
    expect(provider.callApiStream).toHaveBeenCalledTimes(1);
  });
});

describe('empty-stream retry: streaming path (direct call, hook accounting)', () => {
  function countingBus() {
    const bus = new HookBus();
    const state = { runs: 0, credits: undefined as number | undefined };
    bus.registerUsageFinish('t', (e) => {
      state.runs += 1;
      state.credits = e.getMeta<number>('kiro.creditsUsed');
    });
    return { bus, state };
  }

  function replyStub() {
    const writes: string[] = [];
    const raw = {
      writeHead: vi.fn(),
      write: vi.fn((c: string) => {
        writes.push(c);
        return true;
      }),
      end: vi.fn(),
      on: vi.fn(),
    };
    return { reply: { raw } as never, writes };
  }

  it('empty then content: hook runs exactly once, only the final attempt metering counts', async () => {
    const metering = { unit: 'credit', unitPlural: 'credits', usage: 0.0048 };
    const provider = queueProvider({
      stream: [
        // first attempt empty but still bills a (discarded) metering frame
        () => makeStreamResponse(bufferStream([buildMeteringFrame({ ...metering, usage: 9.9 })])),
        () => makeStreamResponse(bufferStream(framesWithMetering(metering))),
      ],
    });
    const { bus, state } = countingBus();
    const { reply } = replyStub();

    const result = await handleStreamRequest(
      provider,
      '{}',
      MODEL,
      10,
      false,
      new Map(),
      bus,
      reply,
      2,
    );

    expect(result.emptyResponse).toBe(false);
    expect(result.emptyAttempts).toBe(1);
    expect(provider.callApiStream).toHaveBeenCalledTimes(2);
    expect(state.runs).toBe(1); // hook once, despite the discarded empty attempt
    expect(state.credits).toBe(0.0048); // final attempt's metering, not the 9.9
  });
});

describe('empty-stream retry: committed-then-empty is never retried', () => {
  it('keepalive-timeout commit then empty falls back to in-band error, no retry', async () => {
    vi.useFakeTimers();
    try {
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      let reached!: () => void;
      const reachedPromise = new Promise<void>((r) => {
        reached = r;
      });
      async function* slowEmpty(): AsyncIterable<Buffer> {
        reached();
        await gate;
        yield* [];
      }
      const provider = queueProvider({ stream: [() => makeStreamResponse(slowEmpty())] });
      const writes: string[] = [];
      const reply = {
        raw: {
          writeHead: vi.fn(),
          write: vi.fn((c: string) => {
            writes.push(c);
            return true;
          }),
          end: vi.fn(),
          on: vi.fn(),
        },
      } as never;

      const done = handleStreamRequest(
        provider,
        '{}',
        MODEL,
        10,
        false,
        new Map(),
        new HookBus(),
        reply,
        3, // retries allowed, but commit must veto them
      );
      await reachedPromise;
      await vi.advanceTimersByTimeAsync(15_000); // commit via keepalive
      release();
      await done;

      const out = writes.join('');
      expect(out).toMatch(/event: message_start/); // committed
      expect(out).toMatch(/overloaded_error/); // in-band error
      // committed → no retry despite budget of 3
      expect(provider.callApiStream).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('empty-stream retry: non-streaming path', () => {
  let app: FastifyInstance | undefined;
  beforeEach(() => {
    app = undefined;
  });
  afterEach(async () => {
    if (app) await app.close();
  });

  it('empty then content within budget: 200 with content, callApi re-called', async () => {
    const provider = queueProvider({
      buffer: [
        () => makeBufferResponse([]),
        () =>
          makeBufferResponse(
            framesWithMetering({ unit: 'credit', unitPlural: 'credits', usage: 0.01 }),
          ),
      ],
    });
    app = await buildApp(provider, 2);
    const res = await app.inject({
      method: 'POST',
      url: '/claude/v1/messages',
      headers: { 'x-api-key': API_KEY },
      payload: NON_STREAM_BODY,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { content: Array<{ type: string; text?: string }> };
    expect(body.content.some((b) => b.type === 'text' && b.text === 'hi')).toBe(true);
    expect(provider.callApi).toHaveBeenCalledTimes(2);
  });

  it('all empty (exhausted): 503 overloaded_error, maxAttempts calls', async () => {
    const provider = queueProvider({ buffer: [() => makeBufferResponse([])] });
    app = await buildApp(provider, 2);
    const res = await app.inject({
      method: 'POST',
      url: '/claude/v1/messages',
      headers: { 'x-api-key': API_KEY },
      payload: NON_STREAM_BODY,
    });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: { type: string } }).error.type).toBe('overloaded_error');
    expect(provider.callApi).toHaveBeenCalledTimes(3);
  });

  it('max_tokens empty terminal is NOT a silent failure (no retry, not 503)', async () => {
    // ContentLengthExceededException → stop_reason max_tokens with empty content
    // is a legitimate terminal signal, must surface to the client verbatim.
    const exceptionFrame = encodeEventStreamFrame(
      { ':message-type': 'exception', ':exception-type': 'ContentLengthExceededException' },
      Buffer.from('input too long', 'utf-8'),
    );
    const provider = queueProvider({ buffer: [() => makeBufferResponse([exceptionFrame])] });
    app = await buildApp(provider, 2);
    const res = await app.inject({
      method: 'POST',
      url: '/claude/v1/messages',
      headers: { 'x-api-key': API_KEY },
      payload: NON_STREAM_BODY,
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { stop_reason: string }).stop_reason).toBe('max_tokens');
    expect(provider.callApi).toHaveBeenCalledTimes(1); // not retried
  });
});

describe('empty-stream retry: thrown upstream errors are forwarded, never retried', () => {
  let app: FastifyInstance | undefined;
  beforeEach(() => {
    app = undefined;
  });
  afterEach(async () => {
    if (app) await app.close();
  });

  it('stream: a thrown rate_limited (429) is mapped once, NOT retried, even with budget', async () => {
    // Regression: the empty-stream retry must apply ONLY to 200 streams that
    // decode to zero content — never to thrown upstream errors (which would
    // ignore Retry-After and burn quota).
    const provider = {
      callApiStream: vi.fn(async () => {
        throw new ProviderError(
          { kind: 'rate_limited', status: 429, retryAfterSeconds: 5 },
          'throttled',
        );
      }),
      callApi: vi.fn(),
      callMcp: vi.fn(),
    } as unknown as KiroProvider;
    app = await buildApp(provider, 2);
    const res = await app.inject({
      method: 'POST',
      url: '/claude/v1/messages',
      headers: { 'x-api-key': API_KEY },
      payload: STREAM_BODY,
    });
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('5');
    expect(provider.callApiStream).toHaveBeenCalledTimes(1);
  });

  it('non-stream: a thrown bad_request (400) is mapped once, NOT retried, even with budget', async () => {
    const provider = {
      callApiStream: vi.fn(),
      callApi: vi.fn(async () => {
        throw new ProviderError({ kind: 'bad_request', status: 400 }, 'bad');
      }),
      callMcp: vi.fn(),
    } as unknown as KiroProvider;
    app = await buildApp(provider, 2);
    const res = await app.inject({
      method: 'POST',
      url: '/claude/v1/messages',
      headers: { 'x-api-key': API_KEY },
      payload: NON_STREAM_BODY,
    });
    expect(res.statusCode).toBe(400);
    expect(provider.callApi).toHaveBeenCalledTimes(1);
  });

  it('stream: a deterministic max_tokens empty terminal is NOT retried (budget unused)', async () => {
    const exceptionFrame = encodeEventStreamFrame(
      { ':message-type': 'exception', ':exception-type': 'ContentLengthExceededException' },
      Buffer.from('input too long', 'utf-8'),
    );
    const provider = queueProvider({
      stream: [() => makeStreamResponse(bufferStream([exceptionFrame]))],
    });
    app = await buildApp(provider, 2);
    await app.inject({
      method: 'POST',
      url: '/claude/v1/messages',
      headers: { 'x-api-key': API_KEY },
      payload: STREAM_BODY,
    });
    // Retry budget is NOT spent on a deterministic terminal (the 503-vs-200
    // terminal shape itself is a separate pre-existing stream concern).
    expect(provider.callApiStream).toHaveBeenCalledTimes(1);
  });
});

describe('empty-stream retry: client disconnect aborts the retry loop', () => {
  // The abort-gating is the load-bearing guard that stops the gateway burning
  // real upstream credit for a client that has left. Each retry is a fresh
  // upstream call, so a disconnect mid-window MUST veto the remaining budget.

  it('stream: a disconnect during the pre-commit window stops further upstream calls', async () => {
    let closeCb: (() => void) | undefined;
    const reply = {
      raw: {
        writeHead: vi.fn(),
        write: vi.fn(() => true),
        end: vi.fn(),
        on: vi.fn((ev: string, cb: () => void) => {
          if (ev === 'close') closeCb = cb;
        }),
      },
    } as never;
    // First attempt is empty AND fires the client 'close' before yielding, so
    // the loop must break instead of consuming attempt 2's content.
    async function* emptyThenDisconnect(): AsyncIterable<Buffer> {
      closeCb?.();
      yield* []; // fires the disconnect, then yields nothing → empty
    }
    const provider = queueProvider({
      stream: [
        () => makeStreamResponse(emptyThenDisconnect()),
        () => makeStreamResponse(bufferStream([buildAssistantResponseFrame('must not reach')])),
      ],
    });

    const result = await handleStreamRequest(
      provider,
      '{}',
      MODEL,
      10,
      false,
      new Map(),
      new HookBus(),
      reply,
      2, // budget of 2, but the disconnect must veto it
    );

    expect(provider.callApiStream).toHaveBeenCalledTimes(1);
    expect(result.emptyResponse).toBe(false); // client gone → not a 503-worthy empty
    expect(result.emptyAttempts).toBe(1);
  });

  it('non-stream: a disconnect during the retry window stops further upstream calls', async () => {
    const { reply, state } = nonStreamReplyStub();
    const provider = {
      // The first call fires the captured 'close' handler, then returns empty.
      callApi: vi.fn(async () => {
        state.closeCb?.();
        return makeBufferResponse([]);
      }),
      callApiStream: vi.fn(),
      callMcp: vi.fn(),
    } as unknown as KiroProvider;

    const result = await handleNonStreamRequest(
      provider,
      '{}',
      MODEL,
      10,
      false,
      new Map(),
      new HookBus(),
      reply,
      2, // budget of 2, but the disconnect must veto it
    );

    expect(provider.callApi).toHaveBeenCalledTimes(1);
    expect(state.statusCode).toBe(503);
    expect(result.emptyResponse).toBe(true);
    expect(result.emptyAttempts).toBe(1);
  });
});

describe('empty-stream retry: deterministic context-window terminal is excluded', () => {
  let app: FastifyInstance | undefined;
  beforeEach(() => {
    app = undefined;
  });
  afterEach(async () => {
    if (app) await app.close();
  });

  it('non-stream: model_context_window_exceeded empty is NOT retried, returns 200 with that stop_reason', async () => {
    const provider = queueProvider({
      buffer: [() => makeBufferResponse([buildContextUsageFrame(100)])],
    });
    app = await buildApp(provider, 2);
    const res = await app.inject({
      method: 'POST',
      url: '/claude/v1/messages',
      headers: { 'x-api-key': API_KEY },
      payload: NON_STREAM_BODY,
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { stop_reason: string }).stop_reason).toBe(
      'model_context_window_exceeded',
    );
    expect(provider.callApi).toHaveBeenCalledTimes(1); // deterministic terminal → no retry
  });

  it('stream: model_context_window_exceeded empty is NOT retried (budget unused)', async () => {
    const provider = queueProvider({
      stream: [() => makeStreamResponse(bufferStream([buildContextUsageFrame(100)]))],
    });
    app = await buildApp(provider, 2);
    await app.inject({
      method: 'POST',
      url: '/claude/v1/messages',
      headers: { 'x-api-key': API_KEY },
      payload: STREAM_BODY,
    });
    expect(provider.callApiStream).toHaveBeenCalledTimes(1);
  });
});

describe('empty-stream retry: non-stream hook accounting', () => {
  it('empty then content: hook runs exactly once, only the final attempt metering counts', async () => {
    const { reply } = nonStreamReplyStub();
    const { bus, state } = makeCountingBus();
    const provider = queueProvider({
      buffer: [
        // first attempt empty but still bills a (discarded) metering frame
        () =>
          makeBufferResponse([
            buildMeteringFrame({ unit: 'credit', unitPlural: 'credits', usage: 9.9 }),
          ]),
        () =>
          makeBufferResponse(
            framesWithMetering({ unit: 'credit', unitPlural: 'credits', usage: 0.0048 }),
          ),
      ],
    });

    const result = await handleNonStreamRequest(
      provider,
      '{}',
      MODEL,
      10,
      false,
      new Map(),
      bus,
      reply,
      2,
    );

    expect(result.emptyResponse).toBe(false);
    expect(result.emptyAttempts).toBe(1);
    expect(provider.callApi).toHaveBeenCalledTimes(2);
    expect(state.runs).toBe(1); // hook once, despite the discarded empty attempt
    expect(state.credits).toBe(0.0048); // final attempt's metering, not the 9.9
  });
});

describe('empty-stream retry: diagnostic capture', () => {
  let app: FastifyInstance | undefined;
  let dir: string | undefined;
  beforeEach(() => {
    app = undefined;
    dir = undefined;
  });
  afterEach(async () => {
    if (app) await app.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('exhausted empty + captureEmptyDir set: writes one JSONL line with the raw Claude body', async () => {
    dir = mkdtempSync(join(tmpdir(), 'k2c-empty-'));
    const provider = queueProvider({ stream: [() => makeStreamResponse(emptyStream())] });
    app = await buildApp(provider, 1, dir); // 1 retry → 2 attempts, both empty
    const res = await app.inject({
      method: 'POST',
      url: '/claude/v1/messages',
      headers: { 'x-api-key': API_KEY },
      payload: STREAM_BODY,
    });
    expect(res.statusCode).toBe(503);

    const lines = readFileSync(join(dir, 'empty-requests.jsonl'), 'utf-8')
      .trim()
      .split('\n')
      .filter(Boolean);
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]) as {
      model: string;
      emptyAttempts: number;
      rawRequest: { model: string; stream: boolean };
    };
    expect(entry.model).toBe(MODEL);
    expect(entry.emptyAttempts).toBe(2); // 1 initial + 1 retry, both empty
    expect(entry.rawRequest).toMatchObject({ model: MODEL, stream: true });
  });

  it('content within budget: nothing is captured', async () => {
    dir = mkdtempSync(join(tmpdir(), 'k2c-empty-'));
    const provider = queueProvider({
      stream: [
        () => makeStreamResponse(emptyStream()),
        () => makeStreamResponse(bufferStream([buildAssistantResponseFrame('recovered')])),
      ],
    });
    app = await buildApp(provider, 2, dir);
    const res = await app.inject({
      method: 'POST',
      url: '/claude/v1/messages',
      headers: { 'x-api-key': API_KEY },
      payload: STREAM_BODY,
    });
    expect(res.statusCode).toBe(200);
    // A recovered request is not a deterministic empty → no capture file written.
    expect(() => readFileSync(join(dir as string, 'empty-requests.jsonl'), 'utf-8')).toThrow();
  });
});
