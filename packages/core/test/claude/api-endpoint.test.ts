/**
 * `/api/claude/v1` 「去泄漏」镜像端点的集成测试。
 *
 * 忠实镜像 index.ts 的装配（onRequest 建 AsyncLocalStorage 上下文 + `/claude/v1`
 * 与 `/api/claude/v1` 两组独立 scope，后者作用域 preHandler 打 `stripPluginUsage` 标记），
 * 用 stub KiroProvider 回一段「带 Metering 帧的非空响应」+ 一个模拟 metering 插件的
 * usage-finish hook（读 `kiro.creditsUsed` → addExtension('kiro_metering')）。
 *
 * 单测（stream.test.ts）已覆盖组装点的过滤逻辑；这里钉死的是**运行时链路**：
 * 请求级标记确实从 `/api` 作用域 preHandler 经 ALS 传到了 `buildClaudeUsagePayload`。
 * 流式（SSE message_delta.usage）与非流式（JSON usage）都验。
 */

import type { UsageFinishEvent } from '@kiro2claude/plugin-api';
import type { AxiosResponse } from 'axios';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { KiroProvider } from '../../src/kiro/provider.js';
import { HookBus } from '../../src/plugin-host/index.js';
import { registerClaudeRoutes } from '../../src/routes/claude.js';
import { getRequestContext, requestContextStorage } from '../../src/shared/request-context.js';
import { framesWithMetering, parseSseEvents } from '../helpers/event-stream.js';

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

/** Stub provider：非流式回 Buffer、流式回 AsyncIterable，两者都带 Metering 帧。 */
function makeProvider(): KiroProvider {
  const frames = framesWithMetering(METERING);
  return {
    callApi: async () => bufferResponse(Buffer.concat(frames)),
    callApiStream: async () => streamResponse(bufferStream(frames)),
    callMcp: async () => streamResponse(bufferStream(frames)),
  } as unknown as KiroProvider;
}

/** 模拟 metering 插件：读上游 credits，注入 usage.kiro_metering 扩展。 */
function meteringMutator(event: UsageFinishEvent): void {
  const credits = event.getMeta<number>('kiro.creditsUsed');
  if (credits == null) return;
  event.addExtension('kiro_metering', {
    accumulated: 100,
    limit: 10000,
    unit: 'credit',
    unitPlural: 'credits',
    usage: credits,
  });
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const hookBus = new HookBus();
  hookBus.registerUsageFinish('metering', meteringMutator);

  // 镜像 index.ts 的 onRequest hook：建立请求级 ALS 上下文。没有它，
  // preHandler 里 getRequestContext() 就是 undefined，/api 的过滤永远不会触发。
  app.addHook('onRequest', (request, _reply, done) => {
    const reqId = (request.headers['x-request-id'] as string) || 'test-req';
    requestContextStorage.run({ reqId, startTime: Date.now() }, done);
  });

  const deps = {
    apiKey: API_KEY,
    kiroProvider: makeProvider(),
    extractThinking: false,
    identityOverride: false,
    rejectUnsupportedDocuments: false,
    emptyStreamRetries: 0,
    toolCallTextRescue: false,
    hookBus,
  };

  // 完整 wire 端点
  await app.register(async (instance) => registerClaudeRoutes(instance, deps), {
    prefix: '/claude/v1',
  });

  // 去泄漏镜像端点：作用域 preHandler 打标记
  await app.register(
    async (instance) => {
      instance.addHook('preHandler', (_req, _reply, done) => {
        const ctx = getRequestContext();
        if (ctx) ctx.stripPluginUsage = true;
        done();
      });
      await registerClaudeRoutes(instance, deps);
    },
    { prefix: '/api/claude/v1' },
  );

  await app.ready();
  return app;
}

function reqBody(stream: boolean) {
  return {
    model: 'claude-sonnet-4-6',
    max_tokens: 64,
    stream,
    messages: [{ role: 'user', content: 'hi' }],
  };
}

async function post(app: FastifyInstance, path: string, stream: boolean) {
  return app.inject({
    method: 'POST',
    url: path,
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
    payload: reqBody(stream),
  });
}

/** 从流式响应体里挖出 message_delta 的 usage。 */
function streamUsage(payload: string): Record<string, unknown> {
  const events = parseSseEvents(payload);
  const delta = events.find((e) => e.event === 'message_delta');
  if (!delta) throw new Error(`no message_delta in SSE:\n${payload.slice(0, 500)}`);
  return (delta.data as { usage: Record<string, unknown> }).usage;
}

describe('/api/claude/v1 leak-stripped mirror endpoint', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('non-stream: /claude keeps kiro_metering, /api strips it', async () => {
    app = await buildApp();

    const claude = await post(app, '/claude/v1/messages', false);
    expect(claude.statusCode).toBe(200);
    const claudeUsage = claude.json().usage;
    expect(claudeUsage.kiro_metering).toBeDefined();
    expect(claudeUsage.kiro_metering.usage).toBe(0.005);

    const api = await post(app, '/api/claude/v1/messages', false);
    expect(api.statusCode).toBe(200);
    const apiUsage = api.json().usage;
    expect('kiro_metering' in apiUsage).toBe(false);
    // 标准 Anthropic 字段仍在
    expect(typeof apiUsage.input_tokens).toBe('number');
    expect(typeof apiUsage.output_tokens).toBe('number');
  });

  it('stream: /claude keeps kiro_metering, /api strips it', async () => {
    app = await buildApp();

    const claude = await post(app, '/claude/v1/messages', true);
    expect(claude.statusCode).toBe(200);
    const claudeUsage = streamUsage(claude.payload);
    expect(claudeUsage.kiro_metering).toBeDefined();

    const api = await post(app, '/api/claude/v1/messages', true);
    expect(api.statusCode).toBe(200);
    const apiUsage = streamUsage(api.payload);
    expect('kiro_metering' in apiUsage).toBe(false);
    expect(typeof apiUsage.input_tokens).toBe('number');
    expect(typeof apiUsage.output_tokens).toBe('number');
  });
});
