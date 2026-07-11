/**
 * SQLite 凭据加载器测试
 *
 * 核心关注点：`profile_arn` 的回退加载路径。
 *
 * kiro-cli 并不把当前选中的 CodeWhisperer Profile 写进 `auth_kv` 的 token JSON
 * 里，而是写在另一张 `state` 表的 `api.codewhisperer.profile` 键下。若 loader
 * 只从 token JSON 取 `profile_arn`，IdC 流程下 `credentials.profileArn` 会恒为
 * undefined——provider 发请求时的 `x-amzn-kiro-profile-arn` header 和
 * `getUsageLimits` URL 的 `profileArn` 查询参数都会被静默跳过。因此 loader
 * 必须同时从 state 表回退读取 ARN。
 *
 * 这些测试在内存里 ad-hoc 构造一个和 kiro-cli 结构一致的 SQLite 库，然后
 * 调用真实的 `loadFromSqlite`，验证 loader 同时能读出 token 和 state 表的
 * profile ARN。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadFromSqlite } from '../../src/kiro/sqlite-credentials.js';

const tmpDirs: string[] = [];

/** 创建一个符合 kiro-cli 结构的空 SQLite 库，返回文件路径。 */
function createEmptyKiroDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-sqlite-test-'));
  tmpDirs.push(dir);
  const dbPath = path.join(dir, 'data.sqlite3');
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE state   (key TEXT PRIMARY KEY, value BLOB);
    `);
  } finally {
    db.close();
  }
  return dbPath;
}

/** 往 auth_kv 写一条 JSON 记录。 */
function writeAuthKv(dbPath: string, key: string, json: object): void {
  const db = new Database(dbPath, { readonly: false });
  try {
    db.prepare('INSERT OR REPLACE INTO auth_kv (key, value) VALUES (?, ?)').run(
      key,
      JSON.stringify(json),
    );
  } finally {
    db.close();
  }
}

/** 往 state 写一条 JSON 记录。 */
function writeState(dbPath: string, key: string, json: object): void {
  const db = new Database(dbPath, { readonly: false });
  try {
    db.prepare('INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)').run(
      key,
      JSON.stringify(json),
    );
  } finally {
    db.close();
  }
}

describe('loadFromSqlite — profile_arn resolution', () => {
  beforeEach(() => {
    // Nothing to do — each test creates its own temp db.
  });

  afterEach(() => {
    for (const dir of tmpDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    tmpDirs.length = 0;
  });

  it('returns undefined when the database file is missing', () => {
    const result = loadFromSqlite('/tmp/__definitely_not_a_real_kiro_db__.sqlite3');
    expect(result).toBeUndefined();
  });

  it('returns undefined when no known token key exists', () => {
    const dbPath = createEmptyKiroDb();
    const result = loadFromSqlite(dbPath);
    expect(result).toBeUndefined();
  });

  it('loads an IdC token and pulls profile ARN from the state table', () => {
    const dbPath = createEmptyKiroDb();

    // Shape mirrors what kiro-cli actually stores for an IdC login: the token
    // JSON has NO `profile_arn` field, only access/refresh tokens + metadata.
    writeAuthKv(dbPath, 'kirocli:odic:token', {
      access_token: 'aoaAAAA-fake-access-token',
      refresh_token: 'aorAAAA-fake-refresh-token',
      region: 'us-east-1',
      scopes: [
        'codewhisperer:completions',
        'codewhisperer:analysis',
        'codewhisperer:conversations',
      ],
      expires_at: '2099-01-01T00:00:00Z',
      start_url: 'https://d-1234567890.awsapps.com/start',
      oauth_flow: 'DeviceCode',
    });
    writeAuthKv(dbPath, 'kirocli:odic:device-registration', {
      client_id: 'test-client-id',
      client_secret: 'test-client-secret',
      region: 'us-east-1',
    });
    // THIS is where the profile ARN actually lives in kiro-cli.
    writeState(dbPath, 'api.codewhisperer.profile', {
      arn: 'arn:aws:codewhisperer:us-east-1:123456789012:profile/EXAMPLETEST01',
      profile_name: 'KiroProfile-us-east-1',
    });

    const result = loadFromSqlite(dbPath);
    expect(result).toBeDefined();
    const { credentials } = result!;

    // clientId/clientSecret 由设备注册路径填充——OIDC token refresh 必需
    expect(credentials.clientId).toBe('test-client-id');
    expect(credentials.clientSecret).toBe('test-client-secret');
    expect(credentials.accessToken).toBe('aoaAAAA-fake-access-token');
    expect(credentials.refreshToken).toBe('aorAAAA-fake-refresh-token');
    expect(credentials.region).toBe('us-east-1');

    // The main assertion: profileArn was lifted out of the `state` table,
    // NOT the token JSON.
    expect(credentials.profileArn).toBe(
      'arn:aws:codewhisperer:us-east-1:123456789012:profile/EXAMPLETEST01',
    );
  });

  it('prefers profile_arn from token JSON over state table when both exist', () => {
    const dbPath = createEmptyKiroDb();

    writeAuthKv(dbPath, 'kirocli:odic:token', {
      access_token: 'aoaAAAA',
      refresh_token: 'aorAAAA',
      profile_arn: 'arn:aws:codewhisperer:us-east-1:1:profile/FROM_TOKEN',
      region: 'us-east-1',
      scopes: ['codewhisperer:completions'],
      expires_at: '2099-01-01T00:00:00Z',
    });
    writeState(dbPath, 'api.codewhisperer.profile', {
      arn: 'arn:aws:codewhisperer:us-east-1:2:profile/FROM_STATE',
      profile_name: 'KiroProfile',
    });

    const result = loadFromSqlite(dbPath);
    expect(result?.credentials.profileArn).toBe(
      'arn:aws:codewhisperer:us-east-1:1:profile/FROM_TOKEN',
    );
  });

  it('leaves profileArn undefined when neither token nor state carry one', () => {
    const dbPath = createEmptyKiroDb();

    writeAuthKv(dbPath, 'kirocli:odic:token', {
      access_token: 'aoaAAAA',
      refresh_token: 'aorAAAA',
      region: 'us-east-1',
      scopes: ['codewhisperer:completions'],
      expires_at: '2099-01-01T00:00:00Z',
    });

    const result = loadFromSqlite(dbPath);
    expect(result?.credentials.profileArn).toBeUndefined();
  });

  it('ignores malformed JSON in the state row without failing the load', () => {
    const dbPath = createEmptyKiroDb();

    writeAuthKv(dbPath, 'kirocli:odic:token', {
      access_token: 'aoaAAAA',
      refresh_token: 'aorAAAA',
      region: 'us-east-1',
      scopes: ['codewhisperer:completions'],
      expires_at: '2099-01-01T00:00:00Z',
    });
    // Intentionally not JSON.
    const db = new Database(dbPath, { readonly: false });
    try {
      db.prepare('INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)').run(
        'api.codewhisperer.profile',
        'not-json-at-all',
      );
    } finally {
      db.close();
    }

    const result = loadFromSqlite(dbPath);
    // Loader should still succeed; profileArn is just undefined.
    expect(result).toBeDefined();
    expect(result?.credentials.profileArn).toBeUndefined();
  });
});
