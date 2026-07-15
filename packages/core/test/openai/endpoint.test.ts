/**
 * `/openai/v1` 与 `/api/openai/v1` 端点的集成测试。
 *
 * 用 stub KiroProvider 回「带 Metering 帧的非空响应」,走完整链路
 * (schema → convertOpenAiRequest → convertRequest → handler → OpenAI 响应)。
 * 验证:GET /models、非流式 chat.completion、流式 chunk 序列(role → content →
 * finish → usage → [DONE])、工具调用 tool_calls。
 */

import type { AxiosResponse } from 'axios';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { KiroProvider } from '../../src/kiro/provider.js';
import { HookBus } from '../../src/plugin-host/index.js';
import { registerOpenAiRoutes } from '../../src/routes/openai.js';
import { getRequestContext, requestContextStorage } from '../../src/shared/request-context.js';
import {
  buildMeteringFrame,
  buildToolUseFrame,
  framesWithMetering,
} from '../helpers/event-stream.js';

const API_KEY = 'test-key';
const METERING = { unit: 'credit', unitPlural: 'credits', usage: 0.005 };

async function* bufferStream(buffers: Buffer[]): AsyncIterable<Buffer> {
  for (const buf of buffers) yield buf;
}

function streamResponse(body: AsyncIterable<Buffer>): AxiosResponse {
  return {
    data: body as unknown as AxiosResponse['data'],
    status: 200,
    statusText: 'OK',
    headers: {},
    config: {} as AxiosResponse['config'],
  };
}

function bufferResponse(body: Buffer): AxiosResponse {
  return {
    data: body as unknown as AxiosResponse['data'],
    status: 200,
    statusText: 'OK',
    headers: {},
    config: {} as AxiosResponse['config'],
  };
}

function makeProvider(frames: Buffer[]): KiroProvider {
  return {
    callApi: async () => bufferResponse(Buffer.concat(frames)),
    callApiStream: async () => streamResponse(bufferStream(frames)),
    callMcp: async () => streamResponse(bufferStream(frames)),
  } as unknown as KiroProvider;
}

async function buildApp(frames: Buffer[]): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const hookBus = new HookBus();

  app.addHook('onRequest', (request, _reply, done) => {
    const reqId = (request.headers['x-request-id'] as string) || 'test-req';
    requestContextStorage.run({ reqId, startTime: Date.now() }, done);
  });

  const deps = {
    apiKey: API_KEY,
    kiroProvider: makeProvider(frames),
    extractThinking: false,
    identityOverride: false,
    rejectUnsupportedDocuments: false,
    emptyStreamRetries: 0,
    toolCallTextRescue: false,
    hookBus,
  };

  await app.register(async (instance) => registerOpenAiRoutes(instance, deps), {
    prefix: '/openai/v1',
  });
  await app.ready();
  return app;
}

async function postChat(app: FastifyInstance, body: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/openai/v1/chat/completions',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
    payload: { model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'hi' }], ...body },
  });
}

/** 解析 OpenAI SSE payload → chunk 对象数组(跳过 [DONE])。 */
function parseChunks(payload: string): Record<string, unknown>[] {
  return payload
    .split(/\r?\n\r?\n/)
    .map((b) => b.trim())
    .filter(Boolean)
    .map((b) => (b.startsWith('data:') ? b.slice(b.indexOf(':') + 1).trim() : b))
    .filter((s) => s && s !== '[DONE]')
    .map((s) => {
      try {
        return JSON.parse(s) as Record<string, unknown>;
      } catch {
        return undefined;
      }
    })
    .filter((x): x is Record<string, unknown> => x !== undefined);
}

interface ChunkDelta {
  role?: string;
  content?: string;
  reasoning_content?: string;
  tool_calls?: Array<{
    index: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

function delta(chunk: Record<string, unknown>): ChunkDelta | undefined {
  const choices = chunk.choices as Array<{ delta?: ChunkDelta }> | undefined;
  return choices?.[0]?.delta;
}

describe('/openai/v1 endpoint', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('GET /models 含 gpt-5.6-sol(owned_by openai)', async () => {
    app = await buildApp(framesWithMetering(METERING));
    const res = await app.inject({
      method: 'GET',
      url: '/openai/v1/models',
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.object).toBe('list');
    const gpt = body.data.find((m: { id: string }) => m.id === 'gpt-5.6-sol');
    expect(gpt).toMatchObject({ object: 'model', owned_by: 'openai' });
  });

  it('非流式 chat.completion', async () => {
    app = await buildApp(framesWithMetering(METERING, 'pong'));
    const res = await postChat(app, { stream: false });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.object).toBe('chat.completion');
    expect(body.model).toBe('gpt-5.6-sol');
    expect(body.choices[0].message).toEqual({ role: 'assistant', content: 'pong' });
    expect(body.choices[0].finish_reason).toBe('stop');
    expect(typeof body.usage.prompt_tokens).toBe('number');
    expect(typeof body.usage.completion_tokens).toBe('number');
    expect(body.usage.total_tokens).toBe(body.usage.prompt_tokens + body.usage.completion_tokens);
    // OpenAI usage 不含 kiro_* 扩展(leak-safe)
    expect('kiro_metering' in body.usage).toBe(false);
  });

  it('流式:role → content → finish → usage → [DONE]', async () => {
    app = await buildApp(framesWithMetering(METERING, 'pong'));
    const res = await postChat(app, { stream: true, stream_options: { include_usage: true } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.payload).toContain('data: [DONE]');

    const chunks = parseChunks(res.payload);
    // 首个是 role chunk
    expect(delta(chunks[0])).toEqual({ role: 'assistant', content: '' });
    // 有 content
    expect(chunks.some((c) => delta(c)?.content === 'pong')).toBe(true);
    // 有 finish chunk
    expect(
      chunks.some(
        (c) => (c.choices as { finish_reason?: string }[])?.[0]?.finish_reason === 'stop',
      ),
    ).toBe(true);
    // include_usage:末尾有 usage-only chunk(choices 空 + usage)
    const usageChunk = chunks.find((c) => (c.choices as unknown[])?.length === 0 && c.usage);
    expect(usageChunk).toBeDefined();
    expect(typeof (usageChunk?.usage as { prompt_tokens: number }).prompt_tokens).toBe('number');
  });

  it('不带 include_usage:无 usage-only chunk,但仍有 [DONE]', async () => {
    app = await buildApp(framesWithMetering(METERING, 'pong'));
    const res = await postChat(app, { stream: true });
    const chunks = parseChunks(res.payload);
    expect(res.payload).toContain('data: [DONE]');
    expect(chunks.some((c) => (c.choices as unknown[])?.length === 0 && c.usage)).toBe(false);
  });

  it('工具调用:非流式 message.tool_calls', async () => {
    const frames = [
      buildToolUseFrame('get_weather', 'call_0', '{"city":"Tokyo"}', true),
      buildMeteringFrame(METERING),
    ];
    app = await buildApp(frames);
    const res = await postChat(app, {
      stream: false,
      tools: [{ type: 'function', function: { name: 'get_weather' } }],
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.choices[0].finish_reason).toBe('tool_calls');
    expect(body.choices[0].message.content).toBeNull();
    expect(body.choices[0].message.tool_calls[0]).toMatchObject({
      id: 'call_0',
      type: 'function',
      function: { name: 'get_weather', arguments: '{"city":"Tokyo"}' },
    });
  });

  it('工具调用:流式 tool_calls 增量', async () => {
    const frames = [
      buildToolUseFrame('get_weather', 'call_0', '{"city":"Tokyo"}', true),
      buildMeteringFrame(METERING),
    ];
    app = await buildApp(frames);
    const res = await postChat(app, {
      stream: true,
      tools: [{ type: 'function', function: { name: 'get_weather' } }],
    });
    const chunks = parseChunks(res.payload);
    // tool_calls start chunk(带 id + name)
    const startTc = chunks.map((c) => delta(c)?.tool_calls?.[0]).find((tc) => tc?.id === 'call_0');
    expect(startTc).toMatchObject({ index: 0, function: { name: 'get_weather' } });
    // finish_reason=tool_calls
    expect(
      chunks.some(
        (c) => (c.choices as { finish_reason?: string }[])?.[0]?.finish_reason === 'tool_calls',
      ),
    ).toBe(true);
  });
});

describe('/openai/v1 plugin usage 扩展 + /api/openai/v1 剥离', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  // derived 默认模式是 override-only：override input_tokens、不产 kiro_derived 扩展。
  // 用一个 sentinel 值验证 OpenAI 端到端**只搬 addExtension、绝不套 override**(守 #16）：
  // 回包 kiro_metering 必须在，但 prompt_tokens 必须 ≠ sentinel。
  const OVERRIDE_SENTINEL = 424242;

  async function buildDualApp(frames: Buffer[]): Promise<FastifyInstance> {
    const instance = Fastify({ logger: false });
    const hookBus = new HookBus();
    hookBus.registerUsageFinish('metering', (event) => {
      event.addExtension('kiro_metering', METERING);
    });
    hookBus.registerUsageFinish('derived', (event) => {
      event.overrideStandardField('input_tokens', OVERRIDE_SENTINEL, 'test: default override mode');
    });

    instance.addHook('onRequest', (request, _reply, done) => {
      const reqId = (request.headers['x-request-id'] as string) || 'test-req';
      requestContextStorage.run({ reqId, startTime: Date.now() }, done);
    });

    const deps = {
      apiKey: API_KEY,
      kiroProvider: makeProvider(frames),
      extractThinking: false,
      identityOverride: false,
      rejectUnsupportedDocuments: false,
      emptyStreamRetries: 0,
      toolCallTextRescue: false,
      hookBus,
    };

    // /openai/v1 = 完整 usage；/api/openai/v1 = 去泄漏镜像（preHandler 打
    // stripPluginUsage，精确复制 index.ts:327-337）。
    await instance.register(async (i) => registerOpenAiRoutes(i, deps), { prefix: '/openai/v1' });
    await instance.register(
      async (i) => {
        i.addHook('preHandler', (_req, _reply, done) => {
          const ctx = getRequestContext();
          if (ctx) ctx.stripPluginUsage = true;
          done();
        });
        await registerOpenAiRoutes(i, deps);
      },
      { prefix: '/api/openai/v1' },
    );
    await instance.ready();
    return instance;
  }

  function post(a: FastifyInstance, prefix: string, body: Record<string, unknown>) {
    return a.inject({
      method: 'POST',
      url: `${prefix}/chat/completions`,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
      payload: { model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'hi' }], ...body },
    });
  }

  it('/openai/v1 非流式:usage 含 kiro_metering;prompt_tokens 不被 override 污染(守 #16)', async () => {
    app = await buildDualApp(framesWithMetering(METERING, 'pong'));
    const res = await post(app, '/openai/v1', { stream: false });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.usage.kiro_metering).toEqual(METERING);
    expect(body.usage.prompt_tokens).not.toBe(OVERRIDE_SENTINEL);
    expect(typeof body.usage.prompt_tokens).toBe('number');
  });

  it('/api/openai/v1 非流式:stripPluginUsage 剥离 kiro_*,只留标准三字段', async () => {
    app = await buildDualApp(framesWithMetering(METERING, 'pong'));
    const res = await post(app, '/api/openai/v1', { stream: false });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect('kiro_metering' in body.usage).toBe(false);
    expect(Object.keys(body.usage).sort()).toEqual([
      'completion_tokens',
      'prompt_tokens',
      'total_tokens',
    ]);
    expect(body.usage.prompt_tokens).not.toBe(OVERRIDE_SENTINEL);
  });

  it('/openai/v1 流式:include_usage 的 usage-only chunk 含 kiro_metering', async () => {
    app = await buildDualApp(framesWithMetering(METERING, 'pong'));
    const res = await post(app, '/openai/v1', {
      stream: true,
      stream_options: { include_usage: true },
    });
    const chunks = parseChunks(res.payload);
    const usageChunk = chunks.find((c) => (c.choices as unknown[])?.length === 0 && c.usage);
    expect(usageChunk).toBeDefined();
    expect((usageChunk?.usage as Record<string, unknown>).kiro_metering).toEqual(METERING);
  });

  it('/api/openai/v1 流式:usage-only chunk 剥离 kiro_*', async () => {
    app = await buildDualApp(framesWithMetering(METERING, 'pong'));
    const res = await post(app, '/api/openai/v1', {
      stream: true,
      stream_options: { include_usage: true },
    });
    const chunks = parseChunks(res.payload);
    const usageChunk = chunks.find((c) => (c.choices as unknown[])?.length === 0 && c.usage);
    expect(usageChunk).toBeDefined();
    expect('kiro_metering' in (usageChunk?.usage as Record<string, unknown>)).toBe(false);
  });
});
