/** Fake credentials only: real temporary SQLite + loopback HTTP OIDC, never AWS. */
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import axios from 'axios';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFromSqlite } from '../../src/kiro/sqlite-credentials.js';
import { RefreshTokenInvalidError, SingleTokenManager } from '../../src/kiro/token-manager.js';
import type { Config } from '../../src/model/config.js';

const TOKEN_KEY = 'kirocli:odic:token';
const REGISTRATION_KEY = 'kirocli:odic:device-registration';
const config: Config = {
  host: '127.0.0.1',
  port: 8080,
  region: 'us-east-1',
  apiKey: 'fake-test-key',
  countTokensAuthType: 'x-api-key',
  extractThinking: false,
  autoCaptureProfile: false,
  loginLicense: 'pro',
  loginTimeoutMs: 300_000,
};
const realCreateAxios = axios.create.bind(axios);
const httpAdapter = axios.getAdapter('http');

describe('SingleTokenManager external login: SQLite + local OIDC', () => {
  let directory: string;
  let dbPath: string;
  let database: Database.Database;
  let server: Server;
  let received: Array<Record<string, unknown>>;

  function writeLogin(generation: 'old' | 'new', expiresAt: string) {
    const token = {
      access_token: `fake-${generation}-access`,
      refresh_token: `fake-${generation}-refresh`,
      expires_at: expiresAt,
      region: 'us-east-1',
      scopes: [`${generation}-scope`],
      oauth_flow: 'device_code',
      start_url: `${generation}-login`,
      preserved_marker: `${generation}-metadata`,
    };
    const upsert = database.prepare('INSERT OR REPLACE INTO auth_kv (key, value) VALUES (?, ?)');
    upsert.run(TOKEN_KEY, JSON.stringify(token));
    upsert.run(
      REGISTRATION_KEY,
      JSON.stringify({ client_id: `fake-${generation}-client`, client_secret: 'fake-secret' }),
    );
    return token;
  }

  function readToken() {
    const row = database.prepare('SELECT value FROM auth_kv WHERE key = ?').get(TOKEN_KEY) as {
      value: string;
    };
    return JSON.parse(row.value);
  }

  function startManager() {
    const initial = loadFromSqlite(dbPath);
    if (!initial) throw new Error('Missing fake test credentials');
    return new SingleTokenManager(config, initial.credentials, initial.source);
  }

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'k2c-auth-integration-'));
    dbPath = join(directory, 'fake-kiro.sqlite3');
    database = new Database(dbPath);
    database.exec('CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    writeLogin('old', '2000-01-01T00:00:00Z');
    received = [];
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        received.push(body);
        response.setHeader('content-type', 'application/json');
        if (body.refreshToken === 'fake-new-refresh' && body.clientId === 'fake-new-client') {
          response.end(
            JSON.stringify({
              accessToken: 'fake-http-refreshed',
              refreshToken: 'fake-http-rotated',
              expiresIn: 7200,
            }),
          );
        } else {
          response.statusCode = 400;
          response.end(
            JSON.stringify({
              error: 'invalid_grant',
              error_description: 'Invalid refresh token provided',
            }),
          );
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing loopback address');
    const loopbackUrl = `http://127.0.0.1:${address.port}/token`;

    // Exercise real Axios HTTP serialization and responses. Every request is redirected
    // before the network adapter runs; unexpected endpoints fail locally, never reach AWS.
    vi.spyOn(axios, 'create').mockImplementation((options) =>
      realCreateAxios({
        ...options,
        proxy: false,
        adapter: (request) => {
          expect(request.url).toBe('https://oidc.us-east-1.amazonaws.com/token');
          request.url = loopbackUrl;
          request.headers.delete('host');
          return httpAdapter(request);
        },
      }),
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('uses a login written after startup without restarting, preserving the new source metadata', async () => {
    const manager = startManager();
    const newLogin = writeLogin('new', new Date(Date.now() + 7_200_000).toISOString());

    const outcomes = await Promise.allSettled(
      Array.from({ length: 10 }, () => manager.acquireContext()),
    );
    expect(outcomes.every((outcome) => outcome.status === 'fulfilled')).toBe(true);
    const contexts = outcomes.flatMap((outcome) =>
      outcome.status === 'fulfilled' ? [outcome.value] : [],
    );

    expect(contexts.every((context) => context.token === 'fake-new-access')).toBe(true);
    expect(contexts[0].credentials.clientId).toBe('fake-new-client');
    expect(received).toEqual([
      {
        clientId: 'fake-old-client',
        clientSecret: 'fake-secret',
        refreshToken: 'fake-old-refresh',
        grantType: 'refresh_token',
      },
    ]);
    expect(readToken()).toEqual(newLogin);
    expect(database.prepare('SELECT COUNT(*) AS count FROM auth_kv').get()).toEqual({ count: 2 });
    expect(loadFromSqlite(dbPath)?.source).toMatchObject({
      dbPath,
      scopes: ['new-scope'],
      extraFields: { start_url: 'new-login', preserved_marker: 'new-metadata' },
    });
  });

  it('refreshes an expired replacement over HTTP and writes rotated tokens to the original token key', async () => {
    const manager = startManager();
    writeLogin('new', '2000-01-01T00:00:00Z');

    expect((await manager.acquireContext()).token).toBe('fake-http-refreshed');
    expect(received.map((body) => body.refreshToken)).toEqual([
      'fake-old-refresh',
      'fake-new-refresh',
    ]);
    expect(received[1].clientId).toBe('fake-new-client');
    expect(readToken()).toMatchObject({
      access_token: 'fake-http-refreshed',
      refresh_token: 'fake-http-rotated',
      preserved_marker: 'new-metadata',
      start_url: 'new-login',
      scopes: ['new-scope'],
    });
    expect(Date.parse(readToken().expires_at)).toBeGreaterThan(Date.now() + 3_600_000);
    expect(readToken()).not.toHaveProperty('accessToken');
    expect(loadFromSqlite(dbPath)?.credentials.accessToken).toBe('fake-http-refreshed');
    expect((await manager.acquireContext()).token).toBe('fake-http-refreshed');
    expect(received).toHaveLength(2);
  });

  it('preserves a real SQLite row and fails once when no new login exists', async () => {
    const manager = startManager();
    const before = readToken();

    await expect(manager.acquireContext()).rejects.toBeInstanceOf(RefreshTokenInvalidError);

    expect(received).toHaveLength(1);
    expect(readToken()).toEqual(before);
  });
});
