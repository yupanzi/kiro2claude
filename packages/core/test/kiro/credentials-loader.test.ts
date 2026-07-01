/**
 * credentials-loader 的职责很窄：
 * - 只支持 `KIRO2CLAUDE_SQLITE_DB_PATH`（kiro-cli device code flow 产生的 SQLite 库）
 * - 展开路径里的 `~/`
 * - 找不到有效凭据时抛错
 *
 * SQLite loader 的成功路径由 `test/kiro/sqlite-credentials.test.ts` 覆盖；
 * 这里只专注于 env 层的分派和错误信息。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadCredentialsFromEnv } from '../../src/kiro/credentials-loader.js';

describe('loadCredentialsFromEnv', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    delete process.env.KIRO2CLAUDE_SQLITE_DB_PATH;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('throws when KIRO2CLAUDE_SQLITE_DB_PATH is not set', () => {
    expect(() => loadCredentialsFromEnv()).toThrow(/KIRO2CLAUDE_SQLITE_DB_PATH is required/);
  });

  it('throws when KIRO2CLAUDE_SQLITE_DB_PATH points to a missing file', () => {
    // loadFromSqlite 会返回 undefined → loader 把它翻译成带路径的错误
    process.env.KIRO2CLAUDE_SQLITE_DB_PATH = '/tmp/__definitely_not_a_real_kiro_db__.sqlite3';
    expect(() => loadCredentialsFromEnv()).toThrow(/does not contain a valid kiro-cli credential/);
  });

  it('expands ~ in KIRO2CLAUDE_SQLITE_DB_PATH before hitting the filesystem', () => {
    // `~/` 必须展开为 $HOME；使用不存在的文件名确保命中"loader 认出路径但库不存在"
    // 这条分支，而不是被 `KIRO2CLAUDE_SQLITE_DB_PATH is required` 拦下
    process.env.KIRO2CLAUDE_SQLITE_DB_PATH =
      '~/__kiro2claude_tilde_test_db_that_does_not_exist__.sqlite3';
    expect(() => loadCredentialsFromEnv()).toThrow(/does not contain a valid kiro-cli credential/);
  });
});
