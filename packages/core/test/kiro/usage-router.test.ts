import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UsageLimitsResponse } from '../../src/kiro/model/usage-limits.js';
import { KiroHttpError, type SingleTokenManager } from '../../src/kiro/token-manager.js';
import { registerKiroRoutes } from '../../src/routes/kiro.js';

/**
 * A stub SingleTokenManager that only needs the `getUsageLimits` method.
 * We cast through `unknown` because the real class has private internals
 * we don't want to mock.
 */
function makeStubTokenManager(
  getUsageLimitsImpl: () => Promise<UsageLimitsResponse>,
): SingleTokenManager {
  return {
    getUsageLimits: vi.fn(getUsageLimitsImpl),
  } as unknown as SingleTokenManager;
}

const API_KEY = 'sk-test-router';
const SAMPLE_RESPONSE: UsageLimitsResponse = {
  nextDateReset: 1777593600,
  subscriptionInfo: { subscriptionTitle: 'KIRO POWER' },
  usageBreakdownList: [
    {
      currentUsage: 42,
      currentUsageWithPrecision: 42,
      bonuses: [],
      usageLimit: 10000,
      usageLimitWithPrecision: 10000,
    },
  ],
};

async function buildApp(tokenManager: SingleTokenManager): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(
    async (instance) => {
      await registerKiroRoutes(instance, { apiKey: API_KEY, tokenManager });
    },
    { prefix: '/kiro' },
  );
  await app.ready();
  return app;
}

describe('GET /kiro/usage', () => {
  let app: FastifyInstance | undefined;

  beforeEach(() => {
    app = undefined;
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  it('passes through the upstream response on success', async () => {
    const tokenManager = makeStubTokenManager(async () => SAMPLE_RESPONSE);
    app = await buildApp(tokenManager);

    const response = await app.inject({
      method: 'GET',
      url: '/kiro/usage',
      headers: { 'x-api-key': API_KEY },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(SAMPLE_RESPONSE);
    expect(tokenManager.getUsageLimits).toHaveBeenCalledTimes(1);
  });

  it('accepts Authorization: Bearer header', async () => {
    const tokenManager = makeStubTokenManager(async () => SAMPLE_RESPONSE);
    app = await buildApp(tokenManager);

    const response = await app.inject({
      method: 'GET',
      url: '/kiro/usage',
      headers: { authorization: `Bearer ${API_KEY}` },
    });

    expect(response.statusCode).toBe(200);
  });

  it('returns 401 when API key is missing', async () => {
    const tokenManager = makeStubTokenManager(async () => SAMPLE_RESPONSE);
    app = await buildApp(tokenManager);

    const response = await app.inject({
      method: 'GET',
      url: '/kiro/usage',
    });

    expect(response.statusCode).toBe(401);
    expect(tokenManager.getUsageLimits).not.toHaveBeenCalled();
  });

  it('returns 401 when API key is wrong', async () => {
    const tokenManager = makeStubTokenManager(async () => SAMPLE_RESPONSE);
    app = await buildApp(tokenManager);

    const response = await app.inject({
      method: 'GET',
      url: '/kiro/usage',
      headers: { 'x-api-key': 'wrong-key' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('masks upstream 401 as 502 to avoid misleading the client about its API key', async () => {
    const tokenManager = makeStubTokenManager(async () => {
      throw new KiroHttpError(401, 'Authentication failed, token invalid or expired: 401 ...');
    });
    app = await buildApp(tokenManager);

    const response = await app.inject({
      method: 'GET',
      url: '/kiro/usage',
      headers: { 'x-api-key': API_KEY },
    });

    expect(response.statusCode).toBe(502);
    const body = response.json() as { error: { type: string; message: string } };
    expect(body.error.type).toBe('api_error');
    expect(body.error.message).toMatch(/not your API key/i);
    expect(body.error.message).not.toMatch(/kiro|aws|upstream|bearer/i);
  });

  it('masks upstream 403 as 502', async () => {
    const tokenManager = makeStubTokenManager(async () => {
      throw new KiroHttpError(403, 'Insufficient permissions to fetch usage limits: 403 ...');
    });
    app = await buildApp(tokenManager);

    const response = await app.inject({
      method: 'GET',
      url: '/kiro/usage',
      headers: { 'x-api-key': API_KEY },
    });

    expect(response.statusCode).toBe(502);
    const body = response.json() as { error: { message: string } };
    expect(body.error.message).toMatch(/not your API key/i);
  });

  it('forwards upstream 429 with neutral rate-limit message', async () => {
    const tokenManager = makeStubTokenManager(async () => {
      throw new KiroHttpError(429, 'Rate limited: 429 ...');
    });
    app = await buildApp(tokenManager);

    const response = await app.inject({
      method: 'GET',
      url: '/kiro/usage',
      headers: { 'x-api-key': API_KEY },
    });

    expect(response.statusCode).toBe(429);
    const body = response.json() as { error: { message: string } };
    expect(body.error.message).toMatch(/rate limit/i);
    expect(body.error.message).not.toMatch(/kiro|aws|upstream/i);
  });

  it('forwards upstream 503 verbatim with neutral message', async () => {
    const tokenManager = makeStubTokenManager(async () => {
      throw new KiroHttpError(503, 'Server error, AWS service temporarily unavailable: 503 ...');
    });
    app = await buildApp(tokenManager);

    const response = await app.inject({
      method: 'GET',
      url: '/kiro/usage',
      headers: { 'x-api-key': API_KEY },
    });

    expect(response.statusCode).toBe(503);
    const body = response.json() as { error: { message: string } };
    expect(body.error.message).not.toMatch(/aws|kiro|upstream/i);
  });

  it('collapses upstream 500 to 502', async () => {
    const tokenManager = makeStubTokenManager(async () => {
      throw new KiroHttpError(500, 'Internal server error: 500 ...');
    });
    app = await buildApp(tokenManager);

    const response = await app.inject({
      method: 'GET',
      url: '/kiro/usage',
      headers: { 'x-api-key': API_KEY },
    });

    expect(response.statusCode).toBe(502);
  });

  it('classifies unknown errors as 500 with neutral message', async () => {
    const tokenManager = makeStubTokenManager(async () => {
      throw new Error('RefreshTokenInvalidError: AWS SSO OIDC said invalid_client');
    });
    app = await buildApp(tokenManager);

    const response = await app.inject({
      method: 'GET',
      url: '/kiro/usage',
      headers: { 'x-api-key': API_KEY },
    });

    expect(response.statusCode).toBe(500);
    const body = response.json() as { error: { message: string } };
    expect(body.error.message).not.toMatch(/aws|sso|refresh.*token/i);
  });
});
