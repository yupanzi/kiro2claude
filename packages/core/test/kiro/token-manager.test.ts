import { describe, expect, it } from 'vitest';
import type { KiroCredentials } from '../../src/kiro/model/credentials.js';
import {
  isTokenExpired,
  isTokenExpiringSoon,
  SingleTokenManager,
  validateRefreshToken,
} from '../../src/kiro/token-manager.js';
import type { Config } from '../../src/model/config.js';

function buildConfig(overrides: Partial<Config> = {}): Config {
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
    ...overrides,
  };
}

/**
 * 构造一个最小合法的 SqliteCredentialSource。测试里只关心结构体存在，
 * 不会真的写 SQLite 文件——SingleTokenManager 只在 persist 路径下访问
 * dbPath，那条路径在下面的测试里不会被触发。
 */
function stubSource(): import('../../src/kiro/sqlite-credentials.js').SqliteCredentialSource {
  return {
    dbPath: '/tmp/__unit_test_never_opened__.sqlite3',
    extraFields: {},
    ssoRegion: 'us-east-1',
  };
}

describe('Token expiry helpers', () => {
  it('is expired with past expiresAt', () => {
    const credentials: KiroCredentials = { expiresAt: '2020-01-01T00:00:00Z' };
    expect(isTokenExpired(credentials)).toBe(true);
  });

  it('is not expired with future expiresAt', () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const credentials: KiroCredentials = { expiresAt: future };
    expect(isTokenExpired(credentials)).toBe(false);
  });

  it('is expired within 5-minute buffer', () => {
    const expires = new Date(Date.now() + 3 * 60 * 1000).toISOString();
    const credentials: KiroCredentials = { expiresAt: expires };
    expect(isTokenExpired(credentials)).toBe(true);
  });

  it('is expired when expiresAt is missing', () => {
    const credentials: KiroCredentials = {};
    expect(isTokenExpired(credentials)).toBe(true);
  });

  it('is expiring soon within 10 minutes', () => {
    const expires = new Date(Date.now() + 8 * 60 * 1000).toISOString();
    const credentials: KiroCredentials = { expiresAt: expires };
    expect(isTokenExpiringSoon(credentials)).toBe(true);
  });

  it('is not expiring soon beyond 10 minutes', () => {
    const expires = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    const credentials: KiroCredentials = { expiresAt: expires };
    expect(isTokenExpiringSoon(credentials)).toBe(false);
  });
});

describe('validateRefreshToken', () => {
  it('throws when refreshToken is missing', () => {
    const credentials: KiroCredentials = {};
    expect(() => validateRefreshToken(credentials)).toThrow(/Missing refreshToken/);
  });

  it('throws when refreshToken is empty', () => {
    const credentials: KiroCredentials = { refreshToken: '' };
    expect(() => validateRefreshToken(credentials)).toThrow(/Missing refreshToken/);
  });

  it('passes for any non-empty refreshToken', () => {
    const credentials: KiroCredentials = { refreshToken: 'abc' };
    expect(() => validateRefreshToken(credentials)).not.toThrow();
  });
});

describe('SingleTokenManager', () => {
  it('exposes config via config()', () => {
    const config = buildConfig({ region: 'eu-west-1' });
    const credentials: KiroCredentials = {
      refreshToken: 'a'.repeat(150),
      accessToken: 'token',
      // Set expiresAt in the future so acquireContext does not trigger a refresh
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      clientId: 'cid',
      clientSecret: 'csec',
    };
    const manager = new SingleTokenManager(config, credentials, stubSource());
    expect(manager.config().region).toBe('eu-west-1');
  });

  it('returns a call context without refresh when token is fresh', async () => {
    const config = buildConfig();
    const credentials: KiroCredentials = {
      refreshToken: 'a'.repeat(150),
      accessToken: 'cached-token',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      clientId: 'cid',
      clientSecret: 'csec',
    };
    const manager = new SingleTokenManager(config, credentials, stubSource());
    const ctx = await manager.acquireContext();
    expect(ctx.token).toBe('cached-token');
    expect(ctx.credentials.refreshToken).toBe('a'.repeat(150));
  });
});
