import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KiroCredentials } from '../../src/kiro/model/credentials.js';
import type { SqliteCredentialSource } from '../../src/kiro/sqlite-credentials.js';
import type { Config } from '../../src/model/config.js';

const mocks = vi.hoisted(() => ({ post: vi.fn(), reload: vi.fn(), save: vi.fn() }));
vi.mock('axios', () => ({ default: { create: () => ({ post: mocks.post }) } }));
vi.mock('../../src/kiro/sqlite-credentials.js', () => ({
  reloadFromSqlite: mocks.reload,
  saveToSqlite: mocks.save,
}));

import {
  KiroHttpError,
  RefreshTokenInvalidError,
  SingleTokenManager,
} from '../../src/kiro/token-manager.js';

const config: Config = {
  host: '127.0.0.1',
  port: 8080,
  region: 'us-east-1',
  apiKey: 'test',
  countTokensAuthType: 'x-api-key',
  extractThinking: false,
  autoCaptureProfile: false,
  loginLicense: 'pro',
  loginTimeoutMs: 300_000,
};
const stale: KiroCredentials = {
  accessToken: 'fake-old-access',
  refreshToken: 'fake-old-refresh',
  clientId: 'fake-client',
  clientSecret: 'fake-secret',
  region: 'us-east-1',
  expiresAt: '2000-01-01T00:00:00Z',
};
const source: SqliteCredentialSource = {
  dbPath: '/never-opened/fake-auth.sqlite3',
  extraFields: { start_url: 'old-login' },
  ssoRegion: 'us-east-1',
};
const invalidGrant = {
  status: 400,
  data: { error: 'invalid_grant', error_description: 'Invalid refresh token provided' },
  headers: {},
};
const refreshed = {
  status: 200,
  data: { accessToken: 'fake-refreshed-access', refreshToken: 'fake-rotated', expiresIn: 7200 },
  headers: {},
};

function latest(overrides: Partial<KiroCredentials> = {}) {
  const credentials: KiroCredentials = {
    ...stale,
    accessToken: 'fake-login-access',
    refreshToken: 'fake-login-refresh',
    expiresAt: new Date(Date.now() + 7_200_000).toISOString(),
    ...overrides,
  };
  const result = {
    credentials,
    source: {
      ...source,
      extraFields: { start_url: 'new-login' },
      scopes: ['new-scope'],
      ssoRegion: credentials.region,
    },
  };
  mocks.reload.mockReturnValue(result);
  return result;
}

describe('SingleTokenManager recovers an external kiro-cli login', () => {
  beforeEach(() => {
    mocks.post.mockReset();
    mocks.reload.mockReset();
    mocks.save.mockReset();
  });

  it.each([
    'acquire',
    'force',
  ] as const)('%s: concurrent requests adopt the new login after one invalid_grant', async (mode) => {
    const replacement = latest();
    const manager = new SingleTokenManager(config, stale, source);
    mocks.post.mockResolvedValue(invalidGrant);

    const outcomes = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        mode === 'acquire' ? manager.acquireContext() : manager.forceRefreshToken(),
      ),
    );

    expect(outcomes.every((outcome) => outcome.status === 'fulfilled')).toBe(true);
    expect((await manager.acquireContext()).token).toBe('fake-login-access');
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.reload).toHaveBeenCalledExactlyOnceWith(source);
    expect(mocks.save).toHaveBeenCalledExactlyOnceWith(replacement.source, replacement.credentials);
  });

  it('refreshes an expired replacement once using its updated OIDC registration', async () => {
    const replacement = latest({
      expiresAt: stale.expiresAt,
      clientId: 'fake-new-client',
      clientSecret: 'fake-new-secret',
      region: 'eu-west-1',
    });
    const manager = new SingleTokenManager(config, stale, source);
    mocks.post.mockResolvedValueOnce(invalidGrant).mockResolvedValueOnce(refreshed);

    expect((await manager.acquireContext()).token).toBe('fake-refreshed-access');
    expect(mocks.post).toHaveBeenCalledTimes(2);
    expect(mocks.post).toHaveBeenNthCalledWith(
      2,
      'https://oidc.eu-west-1.amazonaws.com/token',
      expect.objectContaining({
        clientId: 'fake-new-client',
        clientSecret: 'fake-new-secret',
        refreshToken: 'fake-login-refresh',
      }),
      expect.any(Object),
    );
    expect(mocks.save).toHaveBeenCalledExactlyOnceWith(
      replacement.source,
      expect.objectContaining({ accessToken: 'fake-refreshed-access' }),
    );
  });

  it.each([
    'unchanged',
    'only-expiry',
    'missing',
  ])('%s SQLite credentials preserve the permanent failure without another HTTP request', async (variant) => {
    if (variant === 'unchanged') mocks.reload.mockReturnValue({ credentials: stale, source });
    if (variant === 'only-expiry') {
      latest({ accessToken: stale.accessToken, refreshToken: stale.refreshToken });
    }
    const manager = new SingleTokenManager(config, stale, source);
    mocks.post.mockResolvedValue(invalidGrant);

    await expect(manager.acquireContext()).rejects.toBeInstanceOf(RefreshTokenInvalidError);
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.reload).toHaveBeenCalledTimes(1);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('does not commit a replacement rejected by OIDC or retry it indefinitely', async () => {
    latest({ expiresAt: stale.expiresAt });
    const manager = new SingleTokenManager(config, stale, source);
    mocks.post.mockResolvedValue(invalidGrant);

    await expect(manager.acquireContext()).rejects.toBeInstanceOf(RefreshTokenInvalidError);
    expect(mocks.post).toHaveBeenCalledTimes(2);
    expect(mocks.reload).toHaveBeenCalledTimes(1);
    expect(mocks.save).not.toHaveBeenCalled();

    // A later successful login can recover; the failed candidate never replaced memory.
    latest({ accessToken: 'fake-successful-relogin' });
    expect((await manager.acquireContext()).token).toBe('fake-successful-relogin');
    expect(mocks.post).toHaveBeenCalledTimes(3);
    expect(mocks.post.mock.calls[2][1]).toMatchObject({ refreshToken: 'fake-old-refresh' });
  });

  it('never reuses the rejected bearer merely because its refresh token changed', async () => {
    latest({ accessToken: stale.accessToken });
    const manager = new SingleTokenManager(config, stale, source);
    mocks.post.mockResolvedValueOnce(invalidGrant).mockResolvedValueOnce(refreshed);

    await manager.forceRefreshToken();
    expect((await manager.acquireContext()).token).toBe('fake-refreshed-access');
    expect(mocks.post).toHaveBeenCalledTimes(2);
  });

  it('rejects a successful HTTP response without an access token before persisting', async () => {
    latest({ expiresAt: stale.expiresAt });
    const manager = new SingleTokenManager(config, stale, source);
    mocks.post
      .mockResolvedValueOnce(invalidGrant)
      .mockResolvedValueOnce({ status: 200, data: { expiresIn: 7200 }, headers: {} });

    await expect(manager.acquireContext()).rejects.toThrow('Refreshed token is still invalid');
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it.each([400, 401])('preserves the existing recovery path for HTTP %s', async (status) => {
    latest({ expiresAt: stale.expiresAt });
    const manager = new SingleTokenManager(config, stale, source);
    mocks.post
      .mockResolvedValueOnce({ status, data: { error: 'invalid_client' }, headers: {} })
      .mockResolvedValueOnce(refreshed);

    expect((await manager.acquireContext()).token).toBe('fake-refreshed-access');
    expect(mocks.post).toHaveBeenCalledTimes(2);
    expect(mocks.reload).toHaveBeenCalledTimes(1);
  });

  it('does not reload credentials for upstream service failures', async () => {
    latest();
    const manager = new SingleTokenManager(config, stale, source);
    mocks.post.mockResolvedValue({ status: 503, data: {}, headers: {} });

    await expect(manager.acquireContext()).rejects.toBeInstanceOf(KiroHttpError);
    expect(mocks.reload).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });
});
