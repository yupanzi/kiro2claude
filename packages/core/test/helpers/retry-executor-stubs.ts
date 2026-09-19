/**
 * Shared stubs for `RetryExecutor` tests: a token manager that never refreshes
 * for real, an axios client that replays a scripted response sequence (the last
 * entry repeats), and a minimal `RetryableRequest`. One copy instead of one per
 * test file, so adding a field to `RetryableRequest` is a single edit.
 */

import type { AxiosInstance, AxiosResponse } from 'axios';
import { vi } from 'vitest';
import type { RetryableRequest } from '../../src/kiro/retry-executor.js';
import type { SingleTokenManager } from '../../src/kiro/token-manager.js';

export function makeStubTokenManager(): SingleTokenManager {
  return {
    acquireContext: vi.fn(async () => ({
      credentials: { accessToken: 'stub-token' },
      token: 'stub-token',
    })),
    forceRefreshToken: vi.fn(async () => {}),
  } as unknown as SingleTokenManager;
}

/**
 * Axios stub whose `post` answers with `responses[i]` on the i-th call and keeps
 * returning the last entry afterwards. A single object is a one-element script.
 */
export function makeStubAxios(responses: Partial<AxiosResponse> | Partial<AxiosResponse>[]): {
  client: AxiosInstance;
  post: ReturnType<typeof vi.fn>;
} {
  const script = Array.isArray(responses) ? responses : [responses];
  let i = 0;
  const post = vi.fn(async () => {
    const r = script[Math.min(i++, script.length - 1)];
    return { status: 200, data: '', headers: {}, statusText: 'OK', config: {}, ...r };
  });
  return { client: { post } as unknown as AxiosInstance, post };
}

export function makeRequest(body = 'request-body'): RetryableRequest {
  return {
    label: 'Test',
    body,
    buildUrl: () => 'https://upstream.invalid/api',
    buildHost: () => 'upstream.invalid',
    buildHeaders: () => ({}),
    transformBody: (b: string) => b,
    axiosConfig: {},
    readErrorBody: async (r: AxiosResponse) => String(r.data),
  };
}

export const baseRequest: RetryableRequest = makeRequest();
