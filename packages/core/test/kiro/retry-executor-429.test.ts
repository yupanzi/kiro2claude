/**
 * Pin: 429 from upstream MUST throw immediately and pass through without
 * being absorbed by any gateway-side retry loop. The downstream client SDK
 * is the right place to apply HTTP-standard back-off; retrying on the
 * gateway only consumes more quota and delays the rate-limit signal.
 *
 * Adjacent contract: 408 and 5xx are also single-attempt — kiro2claude is a
 * zero-backoff forwarding gateway. The only retry the gateway performs is
 * the 401-bearer-invalid force-refresh path (covered in
 * retry-executor.test.ts).
 */

import type { AxiosInstance, AxiosResponse } from 'axios';
import { describe, expect, it, vi } from 'vitest';

import { ProviderError } from '../../src/kiro/provider-error.js';
import { RetryExecutor } from '../../src/kiro/retry-executor.js';
import type { SingleTokenManager } from '../../src/kiro/token-manager.js';

function makeStubTokenManager(): SingleTokenManager {
  return {
    acquireContext: vi.fn(async () => ({
      credentials: { accessToken: 'stub-token' },
      token: 'stub-token',
    })),
    forceRefreshToken: vi.fn(async () => {}),
  } as unknown as SingleTokenManager;
}

function makeStubAxios(response: Partial<AxiosResponse>): {
  client: AxiosInstance;
  post: ReturnType<typeof vi.fn>;
} {
  const post = vi.fn(async () => ({
    status: 200,
    data: '',
    headers: {},
    statusText: 'OK',
    config: {},
    ...response,
  }));
  return { client: { post } as unknown as AxiosInstance, post };
}

const baseRequest = {
  label: 'Test',
  body: 'request-body',
  buildUrl: () => 'https://upstream.invalid/api',
  buildHeaders: () => ({}),
  transformBody: (b: string) => b,
  axiosConfig: {},
  readErrorBody: async (r: AxiosResponse) => String(r.data),
  buildHost: () => 'upstream.invalid',
};

describe('RetryExecutor — 429 fast-path', () => {
  it('throws immediately on 429 without retrying', async () => {
    const { client, post } = makeStubAxios({
      status: 429,
      data: '{"RequestId":"abc","message":"rate limited"}',
      headers: { 'retry-after': '30' },
    });
    const executor = new RetryExecutor(makeStubTokenManager(), client);

    await expect(executor.execute(baseRequest)).rejects.toThrow(ProviderError);

    // The whole point: 429 short-circuits the (zero-backoff) loop entirely.
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('thrown ProviderError carries rate_limited kind + retryAfterSeconds parsed from header', async () => {
    const { client } = makeStubAxios({
      status: 429,
      data: '{"RequestId":"trace-xyz"}',
      headers: { 'retry-after': '60' },
    });
    const executor = new RetryExecutor(makeStubTokenManager(), client);

    try {
      await executor.execute(baseRequest);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError);
      const err = e as ProviderError;
      expect(err.kind).toEqual({
        kind: 'rate_limited',
        status: 429,
        retryAfterSeconds: 60,
      });
      // body is preserved on ProviderError for logger consumption only —
      // mapper must NOT echo it into wire-format response.
      expect(err.body).toBe('{"RequestId":"trace-xyz"}');
    }
  });

  it('does NOT retry on 408 or 5xx (zero-backoff gateway philosophy)', async () => {
    const { client, post } = makeStubAxios({
      status: 503,
      data: 'service unavailable',
      headers: { 'retry-after': '5' },
    });
    const executor = new RetryExecutor(makeStubTokenManager(), client);

    await expect(executor.execute(baseRequest)).rejects.toThrow(ProviderError);

    // Single attempt — transient failures are forwarded verbatim with
    // Retry-After so the downstream client SDK applies its own back-off.
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('thrown transient ProviderError carries upstream status verbatim', async () => {
    const { client } = makeStubAxios({
      status: 503,
      data: 'overloaded',
      headers: { 'retry-after': '15' },
    });
    const executor = new RetryExecutor(makeStubTokenManager(), client);

    try {
      await executor.execute(baseRequest);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError);
      const err = e as ProviderError;
      expect(err.kind).toEqual({
        kind: 'transient',
        status: 503,
        retryAfterSeconds: 15,
      });
    }
  });

  it('omits retryAfterSeconds when upstream did not send Retry-After', async () => {
    const { client } = makeStubAxios({
      status: 429,
      data: 'no retry-after',
      headers: {},
    });
    const executor = new RetryExecutor(makeStubTokenManager(), client);

    try {
      await executor.execute(baseRequest);
      throw new Error('should have thrown');
    } catch (e) {
      const err = e as ProviderError;
      // discriminated union — narrow by checking kind first
      expect(err.kind.kind).toBe('rate_limited');
      if (err.kind.kind === 'rate_limited') {
        expect(err.kind.retryAfterSeconds).toBeUndefined();
      }
    }
  });
});
