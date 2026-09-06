/**
 * kiro-cli 重试三件套的守卫。
 *
 * 真实 kiro-cli 2.21.1 在重试时会:同一逻辑调用复用一个 `amz-sdk-invocation-id`、
 * `attempt` 递增、第 2 次起 `amz-sdk-request` 多出 `ttl=`,并带 Kiro 自己的
 * `x-kiro-attempt: N;max=3`(2.21.1 新增)。网关此前把 attempt 写死成 1、且每次
 * 重试都换新 invocation-id——上游看到的每一次重试都是「全新的第一次请求」,
 * 重试语义整个丢失。
 *
 * 抓包依据见 `applyRetryHeaders` 头注释(`kiro/retry-executor.ts`)。
 */

import type { AxiosInstance } from 'axios';
import { validate as isUuid, version as uuidVersion } from 'uuid';
import { describe, expect, it, vi } from 'vitest';
import type { KiroCredentials } from '../../src/kiro/model/credentials.js';
import { type RetryableRequest, RetryExecutor } from '../../src/kiro/retry-executor.js';
import type { SingleTokenManager } from '../../src/kiro/token-manager.js';

const CREDENTIALS = { accessToken: 'tok', region: 'us-east-1' } as unknown as KiroCredentials;

function makeRequest(): RetryableRequest {
  return {
    label: 'Test',
    body: '{}',
    buildUrl: () => 'https://example.invalid/generateAssistantResponse',
    buildHost: () => 'example.invalid',
    // 刻意不产出任何重试头 —— executor 是它们的唯一 owner
    buildHeaders: () => ({ 'x-amz-target': 'T', Authorization: 'Bearer tok' }),
    transformBody: (b) => b,
    axiosConfig: {},
    readErrorBody: async (res) => String(res.data ?? ''),
  };
}

/** 收集每次 POST 的 headers;`statuses` 逐次决定返回码。 */
function makeExecutor(statuses: number[], bodies: string[] = []) {
  const sent: Record<string, string>[] = [];
  let i = 0;
  const client = {
    post: vi.fn(async (_url: string, _body: unknown, cfg: { headers: Record<string, string> }) => {
      sent.push({ ...cfg.headers });
      const status = statuses[i] ?? 200;
      const data = bodies[i] ?? '';
      i++;
      return { status, headers: {}, data };
    }),
  } as unknown as AxiosInstance;

  const tokenManager = {
    acquireContext: async () => ({ credentials: CREDENTIALS, token: 'tok' }),
    forceRefreshToken: async () => 'tok2',
  } as unknown as SingleTokenManager;

  return { executor: new RetryExecutor(tokenManager, client), sent };
}

describe('kiro-cli 重试头', () => {
  it('首次请求:attempt=1、无 ttl、带 x-kiro-attempt', async () => {
    const { executor, sent } = makeExecutor([200]);
    await executor.execute(makeRequest());

    expect(sent).toHaveLength(1);
    expect(sent[0]['amz-sdk-request']).toBe('attempt=1; max=3');
    expect(sent[0]['x-kiro-attempt']).toBe('1;max=3');
    const id = sent[0]['amz-sdk-invocation-id'];
    expect(isUuid(id) && uuidVersion(id) === 4).toBe(true);
  });

  it('401 force-refresh 重试:同一 invocation-id、attempt 递增、第 2 次带 ttl', async () => {
    const { executor, sent } = makeExecutor(
      [401, 200],
      ['The bearer token included in the request is invalid', ''],
    );
    await executor.execute(makeRequest());

    expect(sent).toHaveLength(2);
    // 同一逻辑调用 —— invocation-id 必须复用,否则上游无从知道这是同一次调用的重试
    expect(sent[1]['amz-sdk-invocation-id']).toBe(sent[0]['amz-sdk-invocation-id']);
    expect(sent[1]['x-kiro-attempt']).toBe('2;max=3');
    expect(sent[1]['amz-sdk-request']).toMatch(/^ttl=\d{8}T\d{6}Z; attempt=2; max=3$/);
  });

  it('两次独立调用用不同的 invocation-id（对应 kiro-cli 的外层重试）', async () => {
    const { executor, sent } = makeExecutor([200, 200]);
    await executor.execute(makeRequest());
    await executor.execute(makeRequest());

    expect(sent[1]['amz-sdk-invocation-id']).not.toBe(sent[0]['amz-sdk-invocation-id']);
    // 新的逻辑调用,attempt 归 1
    expect(sent[1]['x-kiro-attempt']).toBe('1;max=3');
  });

  it('重试头由 executor 注入，buildHeaders 不必也不该产出它们', async () => {
    const { executor, sent } = makeExecutor([200]);
    const req = makeRequest();
    expect(req.buildHeaders(CREDENTIALS, 'tok', 'h')['amz-sdk-request']).toBeUndefined();

    await executor.execute(req);
    expect(sent[0]['amz-sdk-request']).toBeDefined();
  });
});
