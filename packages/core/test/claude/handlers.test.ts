/**
 * Handlers integration tests.
 *
 * These tests pin the wire-format behavior of the Claude-compatible
 * endpoints so structural refactors cannot silently change request/response
 * semantics. They use `fastify.inject()` + a stubbed KiroProvider, following
 * the pattern from `test/kiro/usage-router.test.ts`.
 *
 * Scope: non-streaming paths only. Streaming coverage lives in
 * `handlers-stream.test.ts`.
 *
 * Deliberately minimal AWS Event Stream fixtures: most success-path tests
 * feed a single `assistantResponseEvent` (or metering) frame via
 * `buildAssistantResponseFrame` so the content-extraction loop yields a
 * non-empty message. An empty buffer is now treated as a *silent failure*
 * (upstream 200 with zero content frames) and surfaced as a 503
 * `overloaded_error`, NOT an empty assistant message — see the dedicated
 * test. This is sufficient to assert the Fastify wrapping, auth, validation,
 * and error mapping layers without wrestling with frame encoding.
 */

import type { AxiosResponse } from 'axios';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDENTITY_OVERRIDE_DIRECTIVE } from '../../src/claude/converter.js';
import type { KiroProvider } from '../../src/kiro/provider.js';
import { ProviderError } from '../../src/kiro/provider-error.js';
import { HookBus } from '../../src/plugin-host/index.js';
import { registerClaudeRoutes } from '../../src/routes/claude.js';
import { buildAssistantResponseFrame, framesWithMetering } from '../helpers/event-stream.js';
import { generateMinimalPdfBytes } from '../helpers/fixtures.js';

const API_KEY = 'sk-test-handlers';

/**
 * Build a minimal AxiosResponse matching the shape handlers.ts consumes.
 * `data` defaults to an empty Buffer so the non-stream decoder loop exits
 * immediately and yields zero content frames — which the handler now treats
 * as a silent failure (503 overloaded_error). Pass an assistantResponseEvent
 * frame (via `buildAssistantResponseFrame`) for success-path tests.
 */
function makeAxiosResponse(data: Buffer = Buffer.alloc(0)): AxiosResponse {
  return {
    data,
    status: 200,
    statusText: 'OK',
    headers: {},
    config: {} as AxiosResponse['config'],
  };
}

/** Build a stub KiroProvider with configurable per-call behavior. */
interface StubProviderBehavior {
  callApi?: (body: string) => Promise<AxiosResponse>;
  callApiStream?: (body: string) => Promise<AxiosResponse>;
  callMcp?: (body: string) => Promise<AxiosResponse>;
}

function makeStubProvider(behavior: StubProviderBehavior = {}): KiroProvider {
  return {
    callApi: vi.fn(behavior.callApi ?? (async () => makeAxiosResponse())),
    callApiStream: vi.fn(behavior.callApiStream ?? (async () => makeAxiosResponse())),
    callMcp: vi.fn(behavior.callMcp ?? (async () => makeAxiosResponse())),
  } as unknown as KiroProvider;
}

interface BuildAppOptions {
  pluginMutator?: (event: import('@kiro2claude/plugin-api').UsageFinishEvent) => void;
  rejectUnsupportedDocuments?: boolean;
  identityOverride?: boolean;
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
        identityOverride: options.identityOverride ?? false,
        rejectUnsupportedDocuments: options.rejectUnsupportedDocuments ?? false,
        hookBus,
      });
    },
    { prefix: '/claude/v1' },
  );
  await app.ready();
  return app;
}

const VALID_BODY = {
  model: 'claude-sonnet-4-5-20250929',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'hello' }],
};

describe('handlers: GET /claude/v1/models', () => {
  let app: FastifyInstance | undefined;
  beforeEach(() => {
    app = undefined;
  });
  afterEach(async () => {
    if (app) await app.close();
  });

  it('returns the models catalog with valid API key', async () => {
    app = await buildApp(makeStubProvider());
    const response = await app.inject({
      method: 'GET',
      url: '/claude/v1/models',
      headers: { 'x-api-key': API_KEY },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { object: string; data: Array<{ id: string; type: string }> };
    expect(body.object).toBe('list');
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data.every((m) => m.type === 'chat')).toBe(true);
  });

  it('rejects missing API key with 401', async () => {
    app = await buildApp(makeStubProvider());
    const response = await app.inject({ method: 'GET', url: '/claude/v1/models' });
    expect(response.statusCode).toBe(401);
  });

  it('accepts Authorization: Bearer header', async () => {
    app = await buildApp(makeStubProvider());
    const response = await app.inject({
      method: 'GET',
      url: '/claude/v1/models',
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    expect(response.statusCode).toBe(200);
  });
});

describe('handlers: POST /claude/v1/messages - validation', () => {
  let app: FastifyInstance | undefined;
  beforeEach(() => {
    app = undefined;
  });
  afterEach(async () => {
    if (app) await app.close();
  });

  it('rejects missing API key with 401', async () => {
    app = await buildApp(makeStubProvider());
    const response = await app.inject({
      method: 'POST',
      url: '/claude/v1/messages',
      payload: VALID_BODY,
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects missing model with 400 invalid_request_error', async () => {
    app = await buildApp(makeStubProvider());
    const response = await app.inject({
      method: 'POST',
      url: '/claude/v1/messages',
      headers: { 'x-api-key': API_KEY },
      payload: { max_tokens: 1024, messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: { type: string; message: string } };
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.message).toMatch(/model/);
  });

  it('rejects missing max_tokens with 400', async () => {
    app = await buildApp(makeStubProvider());
    const response = await app.inject({
      method: 'POST',
      url: '/claude/v1/messages',
      headers: { 'x-api-key': API_KEY },
      payload: { model: 'claude-sonnet-4-5-20250929', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects missing messages with 400', async () => {
    app = await buildApp(makeStubProvider());
    const response = await app.inject({
      method: 'POST',
      url: '/claude/v1/messages',
      headers: { 'x-api-key': API_KEY },
      payload: { model: 'claude-sonnet-4-5-20250929', max_tokens: 1024 },
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects unsupported model with 400 "Model not supported"', async () => {
    app = await buildApp(makeStubProvider());
    const response = await app.inject({
      method: 'POST',
      url: '/claude/v1/messages',
      headers: { 'x-api-key': API_KEY },
      payload: {
        model: 'gpt-4-definitely-not-a-claude-model',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'hi' }],
      },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: { message: string } };
    expect(body.error.message).toMatch(/Model not supported/);
  });

  it('rejects empty messages array with 400 "Messages list is empty"', async () => {
    app = await buildApp(makeStubProvider());
    const response = await app.inject({
      method: 'POST',
      url: '/claude/v1/messages',
      headers: { 'x-api-key': API_KEY },
      payload: {
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 1024,
        messages: [],
      },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: { message: string } };
    expect(body.error.message).toMatch(/Messages list is empty/);
  });
});

describe('handlers: POST /claude/v1/messages - happy path', () => {
  let app: FastifyInstance | undefined;
  beforeEach(() => {
    app = undefined;
  });
  afterEach(async () => {
    if (app) await app.close();
  });

  it('returns 200 with assistant content when upstream emits assistantResponseEvent', async () => {
    const provider = makeStubProvider({
      callApi: async () => makeAxiosResponse(buildAssistantResponseFrame('hi from kiro')),
    });
    app = await buildApp(provider);
    const response = await app.inject({
      method: 'POST',
      url: '/claude/v1/messages',
      headers: { 'x-api-key': API_KEY },
      payload: VALID_BODY,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      id: string;
      type: string;
      role: string;
      model: string;
      content: Array<{ type: string; text?: string }>;
      stop_reason: string;
    };
    expect(body.type).toBe('message');
    expect(body.role).toBe('assistant');
    expect(body.model).toBe('claude-sonnet-4-5-20250929');
    expect(body.content).toEqual([{ type: 'text', text: 'hi from kiro' }]);
    expect(body.stop_reason).toBe('end_turn');
    expect(provider.callApi).toHaveBeenCalledTimes(1);
  });

  it('identityOverride=true: directive reaches the upstream request body', async () => {
    // 唯一在 CI 内、经 handler 边界覆盖 deps.identityOverride=true 的用例。此前 true 路径
    // 只在不进 CI 的 e2e —— handler 若忽略 deps.identityOverride、内部写死 false,所有 in-CI
    // 集成套件(全设 false)都不会变红。捕获上游 JSON body 断言 directive 确实被注入。
    let sentBody = '';
    const provider = makeStubProvider({
      callApi: async (body) => {
        sentBody = body;
        return makeAxiosResponse(buildAssistantResponseFrame('done'));
      },
    });
    app = await buildApp(provider, { identityOverride: true });
    const response = await app.inject({
      method: 'POST',
      url: '/claude/v1/messages',
      headers: { 'x-api-key': API_KEY },
      payload: VALID_BODY,
    });

    expect(response.statusCode).toBe(200);
    expect(sentBody).toContain(IDENTITY_OVERRIDE_DIRECTIVE);
  });

  it('identityOverride=false (default): directive absent from upstream body', async () => {
    let sentBody = '';
    const provider = makeStubProvider({
      callApi: async (body) => {
        sentBody = body;
        return makeAxiosResponse(buildAssistantResponseFrame('done'));
      },
    });
    app = await buildApp(provider);
    const response = await app.inject({
      method: 'POST',
      url: '/claude/v1/messages',
      headers: { 'x-api-key': API_KEY },
      payload: VALID_BODY,
    });

    expect(response.statusCode).toBe(200);
    expect(sentBody).not.toContain(IDENTITY_OVERRIDE_DIRECTIVE);
  });

  it('accepts a request carrying a PDF document block (dropped) and still returns 200', async () => {
    // A `document` block has no Kiro channel, so the converter drops it. The full
    // POST pipeline (validate → convert → upstream → response) must still succeed
    // rather than 400/500 — the model simply does not see the PDF, and its bytes
    // are never forwarded upstream.
    const pdfB64 = generateMinimalPdfBytes().toString('base64');
    let sentBody = '';
    const provider = makeStubProvider({
      callApi: async (body) => {
        sentBody = body;
        return makeAxiosResponse(buildAssistantResponseFrame('done'));
      },
    });
    app = await buildApp(provider);
    const response = await app.inject({
      method: 'POST',
      url: '/claude/v1/messages',
      headers: { 'x-api-key': API_KEY },
      payload: {
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'summarize this pdf' },
              {
                type: 'document',
                source: { type: 'base64', media_type: 'application/pdf', data: pdfB64 },
              },
            ],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { content: Array<{ type: string; text?: string }> };
    expect(body.content).toEqual([{ type: 'text', text: 'done' }]);
    // The dropped PDF is never forwarded to the upstream.
    expect(sentBody).not.toContain(pdfB64);
  });

  it('replaces a PDF document block with a text placeholder when rejectUnsupportedDocuments is on', async () => {
    // With the flag on the document is NOT silently dropped: a neutral text
    // placeholder reaches the upstream so the model is told a file was attached
    // that it cannot read, and the downstream agent can extract+resend the text.
    const pdfB64 = generateMinimalPdfBytes().toString('base64');
    let sentBody = '';
    const provider = makeStubProvider({
      callApi: async (body) => {
        sentBody = body;
        return makeAxiosResponse(buildAssistantResponseFrame('done'));
      },
    });
    app = await buildApp(provider, { rejectUnsupportedDocuments: true });
    const response = await app.inject({
      method: 'POST',
      url: '/claude/v1/messages',
      headers: { 'x-api-key': API_KEY },
      payload: {
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'summarize this pdf' },
              {
                type: 'document',
                source: { type: 'base64', media_type: 'application/pdf', data: pdfB64 },
              },
            ],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    // base64 still never leaks upstream...
    expect(sentBody).not.toContain(pdfB64);
    // ...but the placeholder text does reach the upstream request body.
    expect(sentBody).toContain('cannot read document/PDF');
  });

  it('returns 503 overloaded_error for empty-stream response (silent failure)', async () => {
    // Empty buffer = upstream sent no content frames. Previously surfaced as a
    // 200 with an empty content array (indistinguishable from a legitimate
    // silent turn). Now mapped to a 503 overloaded_error so the Claude SDK
    // retries via its normal upstream-503 path.
    const provider = makeStubProvider();
    app = await buildApp(provider);
    const response = await app.inject({
      method: 'POST',
      url: '/claude/v1/messages',
      headers: { 'x-api-key': API_KEY },
      payload: VALID_BODY,
    });

    expect(response.statusCode).toBe(503);
    const body = response.json() as { error: { type: string; message: string } };
    expect(body.error.type).toBe('overloaded_error');
    expect(body.error.message).toMatch(/empty/i);
    // Neutralization: must not leak the upstream backend identity.
    expect(body.error.message).not.toMatch(/kiro|aws|bearer/i);
    expect(provider.callApi).toHaveBeenCalledTimes(1);
  });
});

describe('handlers: POST /claude/v1/messages - hook bus meta delivery', () => {
  let app: FastifyInstance | undefined;
  beforeEach(() => {
    app = undefined;
  });
  afterEach(async () => {
    if (app) await app.close();
  });

  it('publishes kiro.creditsUsed + kiro.upstreamRaw when upstream returns meteringEvent', async () => {
    const metering = { unit: 'credit', unitPlural: 'credits', usage: 0.0048 };
    const provider = makeStubProvider({
      callApi: async () => makeAxiosResponse(Buffer.concat(framesWithMetering(metering))),
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
      payload: VALID_BODY,
    });
    expect(response.statusCode).toBe(200);
    expect(credits).toBe(0.0048);
    expect(raw).toEqual(metering);
  });

  it('publishes undefined creditsUsed when upstream omits meteringEvent', async () => {
    // Content-only response (no meteringEvent) — verifies creditsUsed is not
    // synthesized. An assistantResponseEvent frame is required so the response
    // is non-empty and the silent-failure detector does not short-circuit to
    // 503 (which would skip the hook bus entirely).
    let credits: number | undefined = -1;
    const provider = makeStubProvider({
      callApi: async () => makeAxiosResponse(buildAssistantResponseFrame('hi')),
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
      payload: VALID_BODY,
    });
    expect(response.statusCode).toBe(200);
    expect(credits).toBeUndefined();
  });
});

describe('handlers: POST /claude/v1/messages - plugin wire mutation', () => {
  let app: FastifyInstance | undefined;
  beforeEach(() => {
    app = undefined;
  });
  afterEach(async () => {
    if (app) await app.close();
  });

  it('default: bare Anthropic shape (no kiro_* fields)', async () => {
    const metering = { unit: 'credit', unitPlural: 'credits', usage: 0.0048 };
    const provider = makeStubProvider({
      callApi: async () => makeAxiosResponse(Buffer.concat(framesWithMetering(metering))),
    });
    app = await buildApp(provider);
    const response = await app.inject({
      method: 'POST',
      url: '/claude/v1/messages',
      headers: { 'x-api-key': API_KEY },
      payload: VALID_BODY,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { usage: Record<string, unknown> };
    expect('kiro_metering' in body.usage).toBe(false);
    expect('kiro_derived' in body.usage).toBe(false);
    expect('kiro_cost' in body.usage).toBe(false);
    expect(body.usage.cache_creation_input_tokens).toBe(0);
    expect(body.usage.cache_read_input_tokens).toBe(0);
  });

  it('plugin addExtension injects namespaced field into non-stream usage', async () => {
    const metering = { unit: 'credit', unitPlural: 'credits', usage: 0.0048 };
    const provider = makeStubProvider({
      callApi: async () => makeAxiosResponse(Buffer.concat(framesWithMetering(metering))),
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
      payload: VALID_BODY,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { usage: Record<string, unknown> };
    expect(body.usage.kiro_metering).toEqual({ credits: 0.0048 });
  });

  it('plugin overrideStandardField rewrites Anthropic standard usage', async () => {
    const metering = { unit: 'credit', unitPlural: 'credits', usage: 0.0048 };
    const provider = makeStubProvider({
      callApi: async () => makeAxiosResponse(Buffer.concat(framesWithMetering(metering))),
    });
    app = await buildApp(provider, {
      pluginMutator: (event) => {
        event.overrideStandardField('input_tokens', 5555, 'test');
        event.overrideStandardField('cache_creation_input_tokens', 999, 'test');
      },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/claude/v1/messages',
      headers: { 'x-api-key': API_KEY },
      payload: VALID_BODY,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { usage: Record<string, unknown> };
    expect(body.usage.input_tokens).toBe(5555);
    expect(body.usage.cache_creation_input_tokens).toBe(999);
  });
});

describe('handlers: POST /claude/v1/messages - ProviderError mapping', () => {
  let app: FastifyInstance | undefined;
  beforeEach(() => {
    app = undefined;
  });
  afterEach(async () => {
    if (app) await app.close();
  });

  it('maps quota_exhausted to 402 api_error', async () => {
    const provider = makeStubProvider({
      callApi: async () => {
        throw new ProviderError({ kind: 'quota_exhausted', status: 402 }, 'body');
      },
    });
    app = await buildApp(provider);
    const response = await app.inject({
      method: 'POST',
      url: '/claude/v1/messages',
      headers: { 'x-api-key': API_KEY },
      payload: VALID_BODY,
    });
    expect(response.statusCode).toBe(402);
    const body = response.json() as { error: { type: string } };
    expect(body.error.type).toBe('api_error');
  });

  it('maps context_window_full to 400 invalid_request_error', async () => {
    const provider = makeStubProvider({
      callApi: async () => {
        throw new ProviderError({ kind: 'context_window_full', status: 400 }, 'body');
      },
    });
    app = await buildApp(provider);
    const response = await app.inject({
      method: 'POST',
      url: '/claude/v1/messages',
      headers: { 'x-api-key': API_KEY },
      payload: VALID_BODY,
    });
    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: { type: string; message: string } };
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.message).toMatch(/Context window is full/);
    expect(body.error.message).not.toMatch(/kiro|aws|upstream|bearer/i);
  });

  it('maps input_too_long to 400 invalid_request_error', async () => {
    const provider = makeStubProvider({
      callApi: async () => {
        throw new ProviderError({ kind: 'input_too_long', status: 400 }, 'body');
      },
    });
    app = await buildApp(provider);
    const response = await app.inject({
      method: 'POST',
      url: '/claude/v1/messages',
      headers: { 'x-api-key': API_KEY },
      payload: VALID_BODY,
    });
    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: { message: string } };
    expect(body.error.message).toMatch(/Input is too long/);
    expect(body.error.message).not.toMatch(/kiro|aws|upstream|bearer/i);
  });

  it('maps bad_request to 400 invalid_request_error', async () => {
    const provider = makeStubProvider({
      callApi: async () => {
        throw new ProviderError({ kind: 'bad_request', status: 400 }, 'upstream rejected');
      },
    });
    app = await buildApp(provider);
    const response = await app.inject({
      method: 'POST',
      url: '/claude/v1/messages',
      headers: { 'x-api-key': API_KEY },
      payload: VALID_BODY,
    });
    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: { type: string } };
    expect(body.error.type).toBe('invalid_request_error');
  });

  it('maps unauthorized to 502 with "not your API key" disclaimer', async () => {
    const provider = makeStubProvider({
      callApi: async () => {
        throw new ProviderError(
          { kind: 'unauthorized', status: 401, bearerInvalid: true },
          'invalid',
        );
      },
    });
    app = await buildApp(provider);
    const response = await app.inject({
      method: 'POST',
      url: '/claude/v1/messages',
      headers: { 'x-api-key': API_KEY },
      payload: VALID_BODY,
    });
    expect(response.statusCode).toBe(502);
    const body = response.json() as { error: { type: string; message: string } };
    expect(body.error.type).toBe('api_error');
    expect(body.error.message).toMatch(/not your API key/i);
    expect(body.error.message).not.toMatch(/kiro|aws|upstream|bearer/i);
  });

  it('does not leak upstream backend identity in transient response message', async () => {
    const provider = makeStubProvider({
      callApi: async () => {
        throw new ProviderError({ kind: 'transient', status: 503 }, 'Kiro API failed: ...');
      },
    });
    app = await buildApp(provider);
    const response = await app.inject({
      method: 'POST',
      url: '/claude/v1/messages',
      headers: { 'x-api-key': API_KEY },
      payload: VALID_BODY,
    });
    const body = response.json() as { error: { message: string } };
    // The internal err.message contains "Kiro API ..." but we MUST NOT
    // forward that to the downstream response body.
    expect(body.error.message).not.toMatch(/kiro|aws|upstream/i);
  });

  it('does not leak upstream backend identity in quota_exhausted response', async () => {
    const provider = makeStubProvider({
      callApi: async () => {
        throw new ProviderError({ kind: 'quota_exhausted', status: 402 }, 'MONTHLY_REQUEST_COUNT');
      },
    });
    app = await buildApp(provider);
    const response = await app.inject({
      method: 'POST',
      url: '/claude/v1/messages',
      headers: { 'x-api-key': API_KEY },
      payload: VALID_BODY,
    });
    expect(response.statusCode).toBe(402);
    const body = response.json() as { error: { message: string } };
    expect(body.error.message).toMatch(/quota/i);
    expect(body.error.message).not.toMatch(/kiro|aws/i);
  });

  it('does not leak upstream body content through bad_request response', async () => {
    const provider = makeStubProvider({
      callApi: async () => {
        // Body shaped like a real AWS Smithy validation response.
        const awsBody = '{"__type":"ValidationException","message":"Field XYZ required"}';
        throw new ProviderError({ kind: 'bad_request', status: 400 }, awsBody);
      },
    });
    app = await buildApp(provider);
    const response = await app.inject({
      method: 'POST',
      url: '/claude/v1/messages',
      headers: { 'x-api-key': API_KEY },
      payload: VALID_BODY,
    });
    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: { message: string } };
    expect(body.error.message).not.toMatch(/__type|ValidationException/i);
  });

  it('forwards transient 408 verbatim to downstream', async () => {
    const provider = makeStubProvider({
      callApi: async () => {
        throw new ProviderError({ kind: 'transient', status: 408 }, 'timeout');
      },
    });
    app = await buildApp(provider);
    const response = await app.inject({
      method: 'POST',
      url: '/claude/v1/messages',
      headers: { 'x-api-key': API_KEY },
      payload: VALID_BODY,
    });
    expect(response.statusCode).toBe(408);
    const body = response.json() as { error: { type: string } };
    expect(body.error.type).toBe('api_error');
  });

  it('forwards transient 503 verbatim with Retry-After header', async () => {
    const provider = makeStubProvider({
      callApi: async () => {
        throw new ProviderError(
          { kind: 'transient', status: 503, retryAfterSeconds: 15 },
          'service unavailable',
        );
      },
    });
    app = await buildApp(provider);
    const response = await app.inject({
      method: 'POST',
      url: '/claude/v1/messages',
      headers: { 'x-api-key': API_KEY },
      payload: VALID_BODY,
    });
    expect(response.statusCode).toBe(503);
    expect(response.headers['retry-after']).toBe('15');
  });

  it('forwards transient 504 verbatim to downstream', async () => {
    const provider = makeStubProvider({
      callApi: async () => {
        throw new ProviderError({ kind: 'transient', status: 504 }, 'gateway timeout');
      },
    });
    app = await buildApp(provider);
    const response = await app.inject({
      method: 'POST',
      url: '/claude/v1/messages',
      headers: { 'x-api-key': API_KEY },
      payload: VALID_BODY,
    });
    expect(response.statusCode).toBe(504);
  });

  it('collapses transient 500 to 502 (unknown upstream failure)', async () => {
    const provider = makeStubProvider({
      callApi: async () => {
        throw new ProviderError({ kind: 'transient', status: 500 }, 'internal error');
      },
    });
    app = await buildApp(provider);
    const response = await app.inject({
      method: 'POST',
      url: '/claude/v1/messages',
      headers: { 'x-api-key': API_KEY },
      payload: VALID_BODY,
    });
    expect(response.statusCode).toBe(502);
  });

  it('collapses transient 502 to 502 (upstream truly broken)', async () => {
    const provider = makeStubProvider({
      callApi: async () => {
        throw new ProviderError({ kind: 'transient', status: 502 }, 'bad gateway');
      },
    });
    app = await buildApp(provider);
    const response = await app.inject({
      method: 'POST',
      url: '/claude/v1/messages',
      headers: { 'x-api-key': API_KEY },
      payload: VALID_BODY,
    });
    expect(response.statusCode).toBe(502);
  });

  it('maps rate_limited to 429 rate_limit_error and forwards Retry-After', async () => {
    const provider = makeStubProvider({
      callApi: async () => {
        throw new ProviderError(
          { kind: 'rate_limited', status: 429, retryAfterSeconds: 7 },
          'throttled',
        );
      },
    });
    app = await buildApp(provider);
    const response = await app.inject({
      method: 'POST',
      url: '/claude/v1/messages',
      headers: { 'x-api-key': API_KEY },
      payload: VALID_BODY,
    });
    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBe('7');
    const body = response.json() as { error: { type: string; message: string } };
    expect(body.error.type).toBe('rate_limit_error');
    expect(body.error.message).toMatch(/rate limit/i);
    expect(body.error.message).not.toMatch(/kiro|aws|upstream|bearer/i);
  });

  it('omits Retry-After header when upstream did not provide one', async () => {
    const provider = makeStubProvider({
      callApi: async () => {
        throw new ProviderError({ kind: 'rate_limited', status: 429 }, 'throttled');
      },
    });
    app = await buildApp(provider);
    const response = await app.inject({
      method: 'POST',
      url: '/claude/v1/messages',
      headers: { 'x-api-key': API_KEY },
      payload: VALID_BODY,
    });
    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBeUndefined();
    const body = response.json() as { error: { type: string } };
    expect(body.error.type).toBe('rate_limit_error');
  });

  it('maps network error to 502 api_error with neutral "unreachable" message', async () => {
    const provider = makeStubProvider({
      callApi: async () => {
        throw new ProviderError({ kind: 'network', cause: new Error('ECONNREFUSED') }, '');
      },
    });
    app = await buildApp(provider);
    const response = await app.inject({
      method: 'POST',
      url: '/claude/v1/messages',
      headers: { 'x-api-key': API_KEY },
      payload: VALID_BODY,
    });
    expect(response.statusCode).toBe(502);
    const body = response.json() as { error: { type: string; message: string } };
    expect(body.error.type).toBe('api_error');
    expect(body.error.message).toMatch(/unreachable/i);
    expect(body.error.message).not.toMatch(/kiro|aws|upstream|econnrefused/i);
  });

  it('maps generic non-provider errors to 502 with neutral message (no internal leak)', async () => {
    const provider = makeStubProvider({
      callApi: async () => {
        throw new Error('token manager RefreshTokenInvalidError');
      },
    });
    app = await buildApp(provider);
    const response = await app.inject({
      method: 'POST',
      url: '/claude/v1/messages',
      headers: { 'x-api-key': API_KEY },
      payload: VALID_BODY,
    });
    expect(response.statusCode).toBe(502);
    const body = response.json() as { error: { type: string; message: string } };
    expect(body.error.type).toBe('api_error');
    // The internal RefreshTokenInvalidError message MUST stay in the logs,
    // not leak into the downstream response body.
    expect(body.error.message).not.toMatch(/refresh.*token|kiro|aws|bearer/i);
  });
});

describe('handlers: POST /claude/v1/messages/count_tokens', () => {
  let app: FastifyInstance | undefined;
  beforeEach(() => {
    app = undefined;
  });
  afterEach(async () => {
    if (app) await app.close();
  });

  it('returns input_tokens for a valid request', async () => {
    app = await buildApp(makeStubProvider());
    const response = await app.inject({
      method: 'POST',
      url: '/claude/v1/messages/count_tokens',
      headers: { 'x-api-key': API_KEY },
      payload: {
        model: 'claude-sonnet-4-5-20250929',
        messages: [{ role: 'user', content: 'hello' }],
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { input_tokens: number };
    expect(body.input_tokens).toBeGreaterThan(0);
  });

  it('rejects missing model with 400', async () => {
    app = await buildApp(makeStubProvider());
    const response = await app.inject({
      method: 'POST',
      url: '/claude/v1/messages/count_tokens',
      headers: { 'x-api-key': API_KEY },
      payload: { messages: [{ role: 'user', content: 'hello' }] },
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects missing API key with 401', async () => {
    app = await buildApp(makeStubProvider());
    const response = await app.inject({
      method: 'POST',
      url: '/claude/v1/messages/count_tokens',
      payload: {
        model: 'claude-sonnet-4-5-20250929',
        messages: [{ role: 'user', content: 'hello' }],
      },
    });
    expect(response.statusCode).toBe(401);
  });
});
