/**
 * Handlers streaming integration tests.
 *
 * Safety net for the SSE path. These tests verify:
 *
 * - SSE headers are set correctly (Content-Type, Cache-Control, Connection)
 * - Empty upstream streams are surfaced as a real `503 overloaded_error` status
 *   (headers are committed lazily, so an empty stream never commits and can
 *   still send a status — see stream-handler.ts), NOT as a legal
 *   `message_stop(end_turn)` which would hide upstream degradations from the
 *   downstream Claude SDK's retry logic. A stream forced to commit by the
 *   keepalive timeout instead falls back to an in-band `error` event.
 * - Non-empty streams produce the normal message_start → … → message_stop
 *   sequence with kiro_metering correctly threaded through usage
 * - ProviderError during `callApiStream` is mapped via `mapProviderError`
 *   (falls through to a JSON error response, not an SSE error event)
 *
 * Deliberately narrow scope: we don't construct real AWS Event Stream
 * frame bytes here — that coverage lives in the parser unit tests. The
 * point of this suite is to pin the Fastify-level wiring so refactors
 * cannot silently break the SSE contract.
 */

import type { AxiosResponse } from 'axios';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleStreamRequest } from '../../src/claude/stream-handler.js';
import type { KiroProvider } from '../../src/kiro/provider.js';
import { ProviderError } from '../../src/kiro/provider-error.js';
import { HookBus } from '../../src/plugin-host/index.js';
import { registerClaudeRoutes } from '../../src/routes/claude.js';
import { buildAssistantResponseFrame, framesWithMetering } from '../helpers/event-stream.js';

const API_KEY = 'sk-test-handlers-stream';

/** Async generator that yields no chunks — closes the stream immediately. */
async function* emptyStream(): AsyncIterable<Buffer> {
  // yields nothing; the for-await-of loop completes on first iteration
}

/** Async generator that yields given buffers in order. */
async function* bufferStream(buffers: Buffer[]): AsyncIterable<Buffer> {
  for (const buf of buffers) {
    yield buf;
  }
}

/**
 * Build an AxiosResponse shaped for stream consumers. `data` is an
 * AsyncIterable<Buffer> rather than a Buffer so handlers.ts's
 * `for await (const chunk of stream)` loop compiles and runs.
 */
function makeStreamResponse(body: AsyncIterable<Buffer> = emptyStream()): AxiosResponse {
  return {
    data: body as unknown as AxiosResponse['data'],
    status: 200,
    statusText: 'OK',
    headers: {},
    config: {} as AxiosResponse['config'],
  };
}

interface StubProviderBehavior {
  callApi?: (body: string) => Promise<AxiosResponse>;
  callApiStream?: (body: string) => Promise<AxiosResponse>;
  callMcp?: (body: string) => Promise<AxiosResponse>;
}

function makeStubProvider(behavior: StubProviderBehavior = {}): KiroProvider {
  return {
    callApi: vi.fn(behavior.callApi ?? (async () => makeStreamResponse())),
    callApiStream: vi.fn(behavior.callApiStream ?? (async () => makeStreamResponse())),
    callMcp: vi.fn(behavior.callMcp ?? (async () => makeStreamResponse())),
  } as unknown as KiroProvider;
}

interface BuildAppOptions {
  /**
   * Optional plugin-style mutator: registered as a hook bus handler so the
   * test can simulate first-party / third-party plugins injecting wire fields.
   */
  pluginMutator?: (event: import('@kiro2claude/plugin-api').UsageFinishEvent) => void;
}

async function buildApp(
  provider: KiroProvider,
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const hookBus = new HookBus();
  if (options.pluginMutator) {
    hookBus.registerUsageFinish('test-plugin', options.pluginMutator);
  }
  await app.register(
    async (instance) => {
      await registerClaudeRoutes(instance, {
        apiKey: API_KEY,
        kiroProvider: provider,
        extractThinking: true,
        identityOverride: false,
        hookBus,
      });
    },
    { prefix: '/claude/v1' },
  );
  await app.ready();
  return app;
}

const STREAM_BODY = {
  model: 'claude-sonnet-4-5-20250929',
  max_tokens: 1024,
  stream: true,
  messages: [{ role: 'user', content: 'hello' }],
};

/**
 * Minimal `reply.raw` stub we can drive directly (bypassing app.inject): capture
 * writes + simulate a client disconnect. Shared by the disconnect-drain suite
 * and the deferred-commit suite.
 */
function makeReplyStub() {
  const writes: string[] = [];
  const closeHandlers: Array<() => void> = [];
  let closed = false;
  const raw = {
    writeHead: vi.fn(),
    write: vi.fn((chunk: string) => {
      // After disconnect a write throws (EPIPE) so safeWrite() returns false,
      // mirroring a real torn-down socket.
      if (closed) throw new Error('EPIPE');
      writes.push(chunk);
      return true;
    }),
    end: vi.fn(),
    on: (ev: string, cb: () => void) => {
      if (ev === 'close') closeHandlers.push(cb);
    },
  };
  return {
    reply: { raw } as unknown as FastifyReply,
    writes,
    disconnect: () => {
      closed = true;
      for (const cb of closeHandlers) cb();
    },
  };
}

describe('handlers stream: SSE happy path', () => {
  let app: FastifyInstance | undefined;
  beforeEach(() => {
    app = undefined;
  });
  afterEach(async () => {
    if (app) await app.close();
  });

  it('sets SSE headers for streaming responses', async () => {
    // Headers commit on the first content frame, so the stream must emit content.
    app = await buildApp(
      makeStubProvider({
        callApiStream: async () =>
          makeStreamResponse(bufferStream([buildAssistantResponseFrame('hi')])),
      }),
    );
    const response = await app.inject({
      method: 'POST',
      url: '/claude/v1/messages',
      headers: { 'x-api-key': API_KEY },
      payload: STREAM_BODY,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/text\/event-stream/);
    expect(response.headers['cache-control']).toMatch(/no-cache/);
    expect(response.headers.connection).toMatch(/keep-alive/);
  });

  it('returns a real 503 overloaded_error when upstream stream is empty (silent failure)', async () => {
    // Upstream returns 200 OK but no content frames. Because headers commit
    // lazily (only on the first content frame), an empty stream NEVER commits —
    // so we can answer with a real 503 status, exactly like the non-stream path,
    // instead of an in-band error event that only retry-aware clients act on.
    // The Claude SDK's built-in HTTP retry then takes over.
    app = await buildApp(makeStubProvider()); // default stub = empty stream
    const response = await app.inject({
      method: 'POST',
      url: '/claude/v1/messages',
      headers: { 'x-api-key': API_KEY },
      payload: STREAM_BODY,
    });
    expect(response.statusCode).toBe(503);
    const body = response.json() as { error: { type: string; message: string } };
    expect(body.error.type).toBe('overloaded_error');
    // Nothing was committed: no SSE content-type, no message_start on the wire.
    expect(response.headers['content-type']).not.toMatch(/text\/event-stream/);
    expect(response.body).not.toMatch(/event: message_start/);
  });

  it('calls callApiStream (not callApi) for stream:true requests', async () => {
    const provider = makeStubProvider();
    app = await buildApp(provider);
    await app.inject({
      method: 'POST',
      url: '/claude/v1/messages',
      headers: { 'x-api-key': API_KEY },
      payload: STREAM_BODY,
    });
    expect(provider.callApiStream).toHaveBeenCalledTimes(1);
    expect(provider.callApi).not.toHaveBeenCalled();
  });

  it('includes the model id in the SSE message_start event', async () => {
    // message_start only reaches the wire after commit, so emit content.
    app = await buildApp(
      makeStubProvider({
        callApiStream: async () =>
          makeStreamResponse(bufferStream([buildAssistantResponseFrame('hi')])),
      }),
    );
    const response = await app.inject({
      method: 'POST',
      url: '/claude/v1/messages',
      headers: { 'x-api-key': API_KEY },
      payload: STREAM_BODY,
    });
    expect(response.body).toContain('claude-sonnet-4-5-20250929');
  });
});

/** Extract message_delta.data.usage from an SSE body. */
function extractMessageDeltaUsage(body: string): Record<string, unknown> | undefined {
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === 'event: message_delta' && lines[i + 1]?.startsWith('data: ')) {
      const parsed = JSON.parse(lines[i + 1].slice(6)) as { usage: Record<string, unknown> };
      return parsed.usage;
    }
  }
  return undefined;
}

describe('handlers stream: hook bus delivers kiro.* meta to plugin', () => {
  let app: FastifyInstance | undefined;
  beforeEach(() => {
    app = undefined;
  });
  afterEach(async () => {
    if (app) await app.close();
  });

  it('publishes upstream metering credit + raw payload as kiro.* meta keys', async () => {
    const metering = { unit: 'credit', unitPlural: 'credits', usage: 0.0048 };
    // Include an assistantResponseEvent frame so outputTokens > 0 and the
    // silent-failure detector does not fire (which would suppress message_delta
    // and skip the hook bus entirely).
    const provider = makeStubProvider({
      callApiStream: async () => makeStreamResponse(bufferStream(framesWithMetering(metering))),
    });
    let credits: number | undefined;
    let raw: unknown;
    app = await buildApp(provider, {
      pluginMutator: (event) => {
        credits = event.getMeta<number>('kiro.creditsUsed');
        raw = event.getMeta('kiro.upstreamRaw');
      },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/claude/v1/messages',
      headers: { 'x-api-key': API_KEY },
      payload: STREAM_BODY,
    });
    expect(response.statusCode).toBe(200);
    expect(credits).toBe(0.0048);
    expect(raw).toEqual(metering);
  });

  it('publishes undefined credit when upstream omits meteringEvent', async () => {
    // Content-only stream (no meteringEvent) — an assistantResponseEvent frame
    // is required so outputTokens > 0 and the silent-failure detector does not
    // fire, which would skip the hook bus and leave credits at its -1 sentinel.
    let credits: number | undefined = -1;
    const provider = makeStubProvider({
      callApiStream: async () =>
        makeStreamResponse(bufferStream([buildAssistantResponseFrame('hi')])),
    });
    app = await buildApp(provider, {
      pluginMutator: (event) => {
        credits = event.getMeta<number>('kiro.creditsUsed');
      },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/claude/v1/messages',
      headers: { 'x-api-key': API_KEY },
      payload: STREAM_BODY,
    });
    expect(response.statusCode).toBe(200);
    expect(credits).toBeUndefined();
  });
});

describe('handlers stream: client disconnect drains upstream for billing', () => {
  /** HookBus with a single handler that counts runs + captures captured credit. */
  function makeCountingHookBus() {
    const bus = new HookBus();
    const state: { runs: number; credits: number | undefined } = { runs: 0, credits: undefined };
    bus.registerUsageFinish('test-plugin', (event) => {
      state.runs += 1;
      state.credits = event.getMeta<number>('kiro.creditsUsed');
    });
    return { bus, state };
  }

  const MODEL = 'claude-sonnet-4-5-20250929';

  it('client disconnects before metering frame: drains to it, runs hook once with credit, stops writing', async () => {
    const metering = { unit: 'credit', unitPlural: 'credits', usage: 0.0048 };
    const [assistantFrame, meteringFrame] = framesWithMetering(metering);

    // `reachedGate` fires once the assistant frame has been consumed; `gate`
    // holds the tail metering frame until the test simulates a disconnect.
    let reachedGate!: () => void;
    const reachedGatePromise = new Promise<void>((r) => {
      reachedGate = r;
    });
    let releaseGate!: () => void;
    const gatePromise = new Promise<void>((r) => {
      releaseGate = r;
    });

    async function* gatedStream(): AsyncIterable<Buffer> {
      yield assistantFrame; // outputTokens > 0; forwarded while client connected
      reachedGate(); // first frame consumed → about to pause
      await gatePromise; // hold the tail until the test disconnects the client
      yield meteringFrame; // arrives AFTER disconnect → only the drain captures it
    }

    const provider = makeStubProvider({
      callApiStream: async () => makeStreamResponse(gatedStream()),
    });
    const { reply, writes, disconnect } = makeReplyStub();
    const { bus, state } = makeCountingHookBus();

    const done = handleStreamRequest(provider, '{}', MODEL, 10, false, new Map(), bus, reply);

    await reachedGatePromise;
    disconnect(); // client gone → aborted = true
    releaseGate(); // let the metering frame flow into the drain path
    await done;

    // The tail metering frame arrived after the client left, yet the hook still
    // ran exactly once and recorded the credit the upstream billed.
    expect(state.runs).toBe(1);
    expect(state.credits).toBe(0.0048);
    // Nothing is written to the dead socket after disconnect (no final events).
    expect(writes.join('')).not.toContain('event: message_stop');
  });

  it('regression: connected client still gets message_stop and exactly one hook run', async () => {
    const metering = { unit: 'credit', unitPlural: 'credits', usage: 0.0048 };
    const provider = makeStubProvider({
      callApiStream: async () => makeStreamResponse(bufferStream(framesWithMetering(metering))),
    });
    const { reply, writes } = makeReplyStub();
    const { bus, state } = makeCountingHookBus();

    await handleStreamRequest(provider, '{}', MODEL, 10, false, new Map(), bus, reply);

    expect(state.runs).toBe(1);
    expect(state.credits).toBe(0.0048);
    expect(writes.join('')).toContain('event: message_stop');
  });
});

describe('handlers stream: deferred commit', () => {
  const MODEL = 'claude-sonnet-4-5-20250929';

  it('keepalive timeout commits before content; a then-empty upstream falls back to in-band error', async () => {
    // No content arrives within STREAM_COMMIT_TIMEOUT_MS, so the keepalive net
    // forces a commit (message_start on the wire). The stream then ends empty —
    // headers are already sent, so we cannot send a 503; we fall back to the
    // in-band overloaded_error event. An empty stream runs no usage-finish hook.
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
        reached(); // handler is in the drain loop, commit timer armed
        await gate; // stays open without yielding any content
        yield* []; // yields nothing; present to satisfy the generator contract
      }
      const provider = makeStubProvider({
        callApiStream: async () => makeStreamResponse(slowEmpty()),
      });
      const { reply, writes } = makeReplyStub();
      const bus = new HookBus();
      let hookRuns = 0;
      bus.registerUsageFinish('test-plugin', () => {
        hookRuns += 1;
      });

      const done = handleStreamRequest(provider, '{}', MODEL, 10, false, new Map(), bus, reply);
      await reachedPromise;
      await vi.advanceTimersByTimeAsync(15_000); // fire the commit timeout
      release(); // stream ends, still empty
      await done;

      const out = writes.join('');
      expect(out).toMatch(/event: message_start/); // committed via timeout
      expect(out).toMatch(/overloaded_error/); // then-empty → in-band error
      expect(out).not.toMatch(/event: message_stop/); // no success terminal
      expect(hookRuns).toBe(0); // empty → no hook
    } finally {
      vi.useRealTimers();
    }
  });

  it('client disconnects during the pre-commit window: never commits, no hook, nothing written', async () => {
    // The client leaves before any content frame. We never committed, so there
    // are no headers to write and no 503 to attach to a live socket — we just
    // drain and stop. The empty stream runs no hook; callApiStream runs once.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let reached!: () => void;
    const reachedPromise = new Promise<void>((r) => {
      reached = r;
    });
    async function* gatedEmpty(): AsyncIterable<Buffer> {
      reached(); // handler is now inside the drain loop, pre-commit
      await gate; // no content
      yield* []; // yields nothing; present to satisfy the generator contract
    }
    const provider = makeStubProvider({
      callApiStream: async () => makeStreamResponse(gatedEmpty()),
    });
    const { reply, writes, disconnect } = makeReplyStub();
    const bus = new HookBus();
    let hookRuns = 0;
    bus.registerUsageFinish('test-plugin', () => {
      hookRuns += 1;
    });

    const done = handleStreamRequest(provider, '{}', MODEL, 10, false, new Map(), bus, reply);
    await reachedPromise;
    disconnect(); // client gone before any content
    release();
    await done;

    expect(provider.callApiStream).toHaveBeenCalledTimes(1);
    // Never committed → nothing flushed (commit would have written message_start).
    expect(writes.join('')).toBe('');
    expect(hookRuns).toBe(0);
  });
});

describe('handlers stream: plugin wire mutation API', () => {
  let app: FastifyInstance | undefined;
  beforeEach(() => {
    app = undefined;
  });
  afterEach(async () => {
    if (app) await app.close();
  });

  it('plugin addExtension injects namespaced field into SSE usage', async () => {
    const metering = { unit: 'credit', unitPlural: 'credits', usage: 0.0048 };
    const provider = makeStubProvider({
      callApiStream: async () => makeStreamResponse(bufferStream(framesWithMetering(metering))),
    });
    app = await buildApp(provider, {
      pluginMutator: (event) => {
        const credits = event.getMeta<number>('kiro.creditsUsed');
        event.addExtension('kiro_metering', { credits });
      },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/claude/v1/messages',
      headers: { 'x-api-key': API_KEY },
      payload: STREAM_BODY,
    });
    expect(response.statusCode).toBe(200);
    const usage = extractMessageDeltaUsage(response.body);
    expect(usage!.kiro_metering).toEqual({ credits: 0.0048 });
    // Standard fields still defaults
    expect(usage!.cache_creation_input_tokens).toBe(0);
    expect(usage!.cache_read_input_tokens).toBe(0);
  });

  it('plugin overrideStandardField rewrites Anthropic standard usage', async () => {
    const metering = { unit: 'credit', unitPlural: 'credits', usage: 0.0048 };
    const provider = makeStubProvider({
      callApiStream: async () => makeStreamResponse(bufferStream(framesWithMetering(metering))),
    });
    app = await buildApp(provider, {
      pluginMutator: (event) => {
        event.overrideStandardField('input_tokens', 7777, 'test');
        event.overrideStandardField('cache_read_input_tokens', 2048, 'test');
      },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/claude/v1/messages',
      headers: { 'x-api-key': API_KEY },
      payload: STREAM_BODY,
    });
    expect(response.statusCode).toBe(200);
    const usage = extractMessageDeltaUsage(response.body);
    expect(usage!.input_tokens).toBe(7777);
    expect(usage!.cache_read_input_tokens).toBe(2048);
  });

  it('default: no plugin → wire payload is bare Anthropic shape (no kiro_*)', async () => {
    const metering = { unit: 'credit', unitPlural: 'credits', usage: 0.0048 };
    const provider = makeStubProvider({
      callApiStream: async () => makeStreamResponse(bufferStream(framesWithMetering(metering))),
    });
    app = await buildApp(provider); // no plugin mutator
    const response = await app.inject({
      method: 'POST',
      url: '/claude/v1/messages',
      headers: { 'x-api-key': API_KEY },
      payload: STREAM_BODY,
    });
    expect(response.statusCode).toBe(200);
    const usage = extractMessageDeltaUsage(response.body);
    expect('kiro_metering' in usage!).toBe(false);
    expect('kiro_derived' in usage!).toBe(false);
    expect('kiro_cost' in usage!).toBe(false);
  });
});

describe('handlers stream: error mapping', () => {
  let app: FastifyInstance | undefined;
  beforeEach(() => {
    app = undefined;
  });
  afterEach(async () => {
    if (app) await app.close();
  });

  it('maps quota_exhausted at callApiStream to 402 JSON error', async () => {
    const provider = makeStubProvider({
      callApiStream: async () => {
        throw new ProviderError({ kind: 'quota_exhausted', status: 402 }, 'body');
      },
    });
    app = await buildApp(provider);
    const response = await app.inject({
      method: 'POST',
      url: '/claude/v1/messages',
      headers: { 'x-api-key': API_KEY },
      payload: STREAM_BODY,
    });
    expect(response.statusCode).toBe(402);
    const body = response.json() as { error: { type: string } };
    expect(body.error.type).toBe('api_error');
  });

  it('maps context_window_full to 400 JSON error for stream requests', async () => {
    const provider = makeStubProvider({
      callApiStream: async () => {
        throw new ProviderError({ kind: 'context_window_full', status: 400 }, 'body');
      },
    });
    app = await buildApp(provider);
    const response = await app.inject({
      method: 'POST',
      url: '/claude/v1/messages',
      headers: { 'x-api-key': API_KEY },
      payload: STREAM_BODY,
    });
    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: { message: string } };
    expect(body.error.message).toMatch(/Context window is full/);
  });

  it('forwards transient 503 at callApiStream verbatim with Retry-After and neutral message', async () => {
    const provider = makeStubProvider({
      callApiStream: async () => {
        throw new ProviderError(
          { kind: 'transient', status: 503, retryAfterSeconds: 8 },
          'Kiro API said service unavailable',
        );
      },
    });
    app = await buildApp(provider);
    const response = await app.inject({
      method: 'POST',
      url: '/claude/v1/messages',
      headers: { 'x-api-key': API_KEY },
      payload: STREAM_BODY,
    });
    expect(response.statusCode).toBe(503);
    expect(response.headers['retry-after']).toBe('8');
    const body = response.json() as { error: { message: string } };
    expect(body.error.message).not.toMatch(/kiro|aws|upstream|bearer/i);
  });

  it('forwards transient 408 at callApiStream verbatim', async () => {
    const provider = makeStubProvider({
      callApiStream: async () => {
        throw new ProviderError({ kind: 'transient', status: 408 }, 'timeout');
      },
    });
    app = await buildApp(provider);
    const response = await app.inject({
      method: 'POST',
      url: '/claude/v1/messages',
      headers: { 'x-api-key': API_KEY },
      payload: STREAM_BODY,
    });
    expect(response.statusCode).toBe(408);
  });

  it('collapses transient 500 at callApiStream to 502', async () => {
    const provider = makeStubProvider({
      callApiStream: async () => {
        throw new ProviderError({ kind: 'transient', status: 500 }, 'internal error');
      },
    });
    app = await buildApp(provider);
    const response = await app.inject({
      method: 'POST',
      url: '/claude/v1/messages',
      headers: { 'x-api-key': API_KEY },
      payload: STREAM_BODY,
    });
    expect(response.statusCode).toBe(502);
  });

  it('maps rate_limited at callApiStream to 429 with Retry-After header', async () => {
    const provider = makeStubProvider({
      callApiStream: async () => {
        throw new ProviderError(
          { kind: 'rate_limited', status: 429, retryAfterSeconds: 12 },
          'throttled',
        );
      },
    });
    app = await buildApp(provider);
    const response = await app.inject({
      method: 'POST',
      url: '/claude/v1/messages',
      headers: { 'x-api-key': API_KEY },
      payload: STREAM_BODY,
    });
    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBe('12');
    const body = response.json() as { error: { type: string; message: string } };
    expect(body.error.type).toBe('rate_limit_error');
    expect(body.error.message).not.toMatch(/kiro|aws|upstream|bearer/i);
  });

  it('omits Retry-After at callApiStream when upstream did not provide one', async () => {
    const provider = makeStubProvider({
      callApiStream: async () => {
        throw new ProviderError({ kind: 'rate_limited', status: 429 }, 'throttled');
      },
    });
    app = await buildApp(provider);
    const response = await app.inject({
      method: 'POST',
      url: '/claude/v1/messages',
      headers: { 'x-api-key': API_KEY },
      payload: STREAM_BODY,
    });
    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBeUndefined();
  });
});
