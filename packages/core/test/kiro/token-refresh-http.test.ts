/**
 * End-to-end HTTP contract tests for `refreshToken` (AWS SSO OIDC).
 *
 * ## Why this file exists (vs. the pure-type contract tests in
 * `test/kiro/model/token-refresh.test.ts`)
 *
 * The pure-type tests only validate that the TS `TokenRefreshRequest` /
 * `TokenRefreshResponse` type definitions and their default JSON.stringify /
 * JSON.parse behavior match the camelCase wire format. They cannot catch bugs
 * where production code **bypasses the type** — e.g., hand-writing a body
 * literal without a type annotation, or hand-writing a snake_case field
 * mapping in the response parser (both of which shipped and caused the
 * "invalid_client" + "Refreshed token is still invalid or expired" outage).
 *
 * This file closes that gap by mocking `axios.create`, invoking the real
 * `refreshToken` entrypoint, and:
 *
 * 1. Capturing the request body that would have gone to AWS SSO OIDC, and
 *    asserting its key set matches what Smithy expects.
 * 2. Feeding a realistic camelCase response back through the parser and
 *    asserting the returned `KiroCredentials` has a valid `accessToken` and
 *    an updated `expiresAt` — i.e. `isTokenExpired` would return false.
 *
 * ## Why this is worth the mock setup
 *
 * The IdC refresh path is the most fragile surface in the project: both
 * the request body and the response body must use camelCase field names
 * (AWS SSO OIDC is Smithy-based), and both have shipped broken at
 * different times. Each failure mode was silent — the request went out
 * and AWS rejected it, or the response came back and fields were silently
 * undefined. Running these tests in CI guarantees neither direction can
 * regress into snake_case without breaking the build.
 */

import type { AxiosInstance, AxiosResponse } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// NOTE: `vi.mock` must be declared BEFORE importing the module under test.
// vitest hoists these to the top of the file at transform time, so imports
// below will receive the mocked version. We mock `axios.create` directly so
// the real `refreshToken` code path runs, but the HTTP call is intercepted
// and captured in-memory.
vi.mock('axios', () => ({
  default: {
    create: vi.fn(),
  },
}));

import axios from 'axios';
import type { KiroCredentials } from '../../src/kiro/model/credentials.js';
import { getUsageLimits, refreshToken } from '../../src/kiro/token-manager.js';
import type { Config } from '../../src/model/config.js';

type CapturedCall = {
  url: string;
  body: unknown;
  headers: Record<string, string>;
};

/** Build a fake AxiosInstance that records the call and returns a canned response. */
function makeFakeAxios(response: Partial<AxiosResponse>, captured: CapturedCall[]): AxiosInstance {
  const post = vi.fn(async (url: string, body: unknown, config: Record<string, unknown>) => {
    captured.push({
      url,
      body,
      headers: (config?.headers ?? {}) as Record<string, string>,
    });
    return {
      status: 200,
      statusText: 'OK',
      headers: {},
      config: {} as never,
      data: undefined,
      ...response,
    } as AxiosResponse;
  });
  // Minimal surface — refreshToken only calls `.post`.
  return { post } as unknown as AxiosInstance;
}

function kiroCred(overrides: Partial<KiroCredentials> = {}): KiroCredentials {
  return {
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    refreshToken: 'fake-refresh-token',
    region: 'us-east-1',
    ...overrides,
  };
}

function cfg(): Config {
  return {
    host: '127.0.0.1',
    port: 8080,
    region: 'us-east-1',
    apiKey: 'test',
    countTokensAuthType: 'x-api-key',
    extractThinking: true,
    autoCaptureProfile: false,
    loginLicense: 'pro',
    loginTimeoutMs: 300_000,
    meteringCounter: false,
  };
}

describe('refreshToken end-to-end wire format', () => {
  beforeEach(() => {
    vi.mocked(axios.create).mockReset();
  });

  // Captures the request body that would go to AWS SSO OIDC and asserts its
  // key set matches Smithy expectations (clientId / clientSecret / refreshToken /
  // grantType). This is the test that would have caught the original
  // `invalid_client` outage — it fires the real production code path.
  it('test_refresh_sends_camel_case_request_body', async () => {
    const captured: CapturedCall[] = [];
    const fakeAxios = makeFakeAxios(
      {
        status: 200,
        data: {
          accessToken: 'new-access-token',
          refreshToken: 'rotated-refresh-token',
          expiresIn: 7200,
          profileArn: 'arn:aws:profile/test',
        },
      },
      captured,
    );
    vi.mocked(axios.create).mockReturnValue(fakeAxios);

    await refreshToken(kiroCred(), cfg());

    expect(captured).toHaveLength(1);
    const call = captured[0];

    // URL target is the AWS OIDC endpoint for the credential's region.
    expect(call.url).toBe('https://oidc.us-east-1.amazonaws.com/token');

    // Body shape must match Smithy camelCase — exactly four keys, no snake_case.
    expect(call.body).toEqual({
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
      refreshToken: 'fake-refresh-token',
      grantType: 'refresh_token',
    });
    const bodyKeys = Object.keys(call.body as Record<string, unknown>).sort();
    expect(bodyKeys).toEqual(['clientId', 'clientSecret', 'grantType', 'refreshToken']);
    // Explicit negative: snake_case keys must never appear.
    expect(bodyKeys).not.toContain('client_id');
    expect(bodyKeys).not.toContain('client_secret');
    expect(bodyKeys).not.toContain('refresh_token');
    expect(bodyKeys).not.toContain('grant_type');
  });

  // Feeds a realistic camelCase AWS response back through refreshToken and
  // asserts the returned KiroCredentials has a usable accessToken and an
  // updated expiresAt. This is the test that would have caught the "response
  // parser shipped snake_case mapping" bug — where the request was fixed but
  // the response parser silently produced undefined fields, causing the
  // downstream `isTokenExpired` check to throw "Refreshed token is still
  // invalid or expired".
  it('test_refresh_parses_camel_case_response', async () => {
    const before = Date.now();
    const captured: CapturedCall[] = [];
    const fakeAxios = makeFakeAxios(
      {
        status: 200,
        data: {
          accessToken: 'brand-new-access-token',
          refreshToken: 'brand-new-refresh-token',
          expiresIn: 7200,
          profileArn: 'arn:aws:codewhisperer:us-east-1:123:profile/xyz',
        },
      },
      captured,
    );
    vi.mocked(axios.create).mockReturnValue(fakeAxios);

    const refreshed = await refreshToken(kiroCred(), cfg());

    expect(refreshed.accessToken).toBe('brand-new-access-token');
    expect(refreshed.refreshToken).toBe('brand-new-refresh-token');
    expect(refreshed.profileArn).toBe('arn:aws:codewhisperer:us-east-1:123:profile/xyz');

    // expiresAt must be set to roughly `now + 7200s` (allow ±5s for test jitter).
    expect(refreshed.expiresAt).toBeDefined();
    const expiresAtMs = new Date(refreshed.expiresAt!).getTime();
    const expectedMs = before + 7200 * 1000;
    expect(Math.abs(expiresAtMs - expectedMs)).toBeLessThan(5_000);
  });

  // Negative-path test: if AWS returned a snake_case payload (which it never
  // does — this simulates a future regression in the response parser), the
  // refresh would return a credentials object with `accessToken = undefined`.
  // This guards the response parser's type-strict behavior.
  it('test_refresh_snake_case_response_yields_undefined_fields', async () => {
    const captured: CapturedCall[] = [];
    const fakeAxios = makeFakeAxios(
      {
        status: 200,
        data: {
          access_token: 'should-never-be-read',
          refresh_token: 'should-never-be-read',
          expires_in: 7200,
          profile_arn: 'should-never-be-read',
        },
      },
      captured,
    );
    vi.mocked(axios.create).mockReturnValue(fakeAxios);

    const refreshed = await refreshToken(kiroCred(), cfg());

    // Because the response parser reads camelCase, a snake_case payload
    // leaves every field blank. The downstream `isTokenExpired` check in
    // `SingleTokenManager.doRefresh` would then correctly throw
    // "Refreshed token is still invalid or expired" rather than silently
    // succeed with a broken credential.
    expect(refreshed.accessToken).toBeUndefined();
    // `expiresAt` stays at the original (undefined) value — NOT updated
    // from the snake_case `expires_in`.
    expect(refreshed.expiresAt).toBeUndefined();
  });
});

/**
 * 合同测试：getUsageLimits 走 Smithy awsJson1_0 协议（POST / + x-amz-target）。
 *
 * kiro-cli 2.0 把所有 AmazonCodeWhispererService 操作统一成 POST / + target header。
 * 必须把 `isEmailRequired: true` 放进 body——不带此字段时上游恒返回 `userInfo.email: null`
 * （上游的 PII 最小化默认）。kiro-cli whoami 靠同一个接口 + 同一个 flag 拿邮箱，
 * 我们的 /kiro/usage 端点要和它对齐，否则 `userInfo.email` 永远是 null 且没有任何错误提示。
 */
describe('getUsageLimits Smithy wire format', () => {
  beforeEach(() => {
    vi.mocked(axios.create).mockReset();
  });

  it('sends POST /?isEmailRequired=true with aws-sdk-rust UA (no profileArn)', async () => {
    const captured: CapturedCall[] = [];
    vi.mocked(axios.create).mockReturnValue(
      makeFakeAxios({ status: 200, data: { usageBreakdownList: [] } }, captured),
    );

    await getUsageLimits(
      {
        clientId: 'cid',
        clientSecret: 'csec',
        refreshToken: 'fake-refresh-token',
        region: 'us-east-1',
      },
      cfg(),
      'access-token-stub',
    );

    expect(captured).toHaveLength(1);
    const { url, body, headers } = captured[0];

    // Smithy: POST to root path with query params (kiro-cli 双写模式)
    const parsed = new URL(url);
    expect(parsed.host).toBe('codewhisperer.us-east-1.amazonaws.com');
    expect(parsed.pathname).toBe('/');
    expect(parsed.searchParams.get('isEmailRequired')).toBe('true');
    // 无 profileArn 时 query string 里也不应出现
    expect(parsed.searchParams.has('profileArn')).toBe(false);

    // Body 和 query string 双写 isEmailRequired
    expect(body).toEqual({ isEmailRequired: true });

    // kiro-cli 仿真路径的 UA 必须以 aws-sdk-rust 开头，而且 `{os}` 占位符已被替换
    expect(headers['user-agent']).toMatch(/^aws-sdk-rust\//);
    expect(headers['user-agent']).toMatch(/\bos\/(macos|linux|windows)\b/);
    expect(headers['user-agent']).not.toContain('{os}');
    // x-amz-target 是 Smithy 协议关键头
    expect(headers['x-amz-target']).toBe('AmazonCodeWhispererService.GetUsageLimits');
    // content-type 是 Smithy awsJson1_0
    expect(headers['content-type']).toBe('application/x-amz-json-1.0');
  });

  it('includes profileArn in both query string and body when credentials carry one', async () => {
    const captured: CapturedCall[] = [];
    vi.mocked(axios.create).mockReturnValue(
      makeFakeAxios({ status: 200, data: { usageBreakdownList: [] } }, captured),
    );

    await getUsageLimits(
      {
        clientId: 'cid',
        clientSecret: 'csec',
        refreshToken: 'fake-refresh-token',
        profileArn: 'arn:aws:codewhisperer:us-east-1:123:profile/ABC',
        region: 'us-east-1',
      },
      cfg(),
      'access-token-stub',
    );

    expect(captured).toHaveLength(1);
    const { url, body } = captured[0];

    // 双写：query string 和 body 里都有 profileArn + isEmailRequired
    const parsed = new URL(url);
    expect(parsed.searchParams.get('profileArn')).toBe(
      'arn:aws:codewhisperer:us-east-1:123:profile/ABC',
    );
    expect(parsed.searchParams.get('isEmailRequired')).toBe('true');

    expect(body).toEqual({
      isEmailRequired: true,
      profileArn: 'arn:aws:codewhisperer:us-east-1:123:profile/ABC',
    });
  });
});
