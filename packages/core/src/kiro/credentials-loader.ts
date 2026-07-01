/**
 * 凭据加载器：从 kiro-cli 的本地 SQLite 数据库读取 device code flow 凭据
 *
 * kiro2claude 的唯一凭据入口：通过 `KIRO2CLAUDE_SQLITE_DB_PATH` 指向 kiro-cli 登录
 * 后产生的 SQLite 数据库。登录方式是 device code flow（Builder ID 或
 * IAM Identity Center），由 `kiro-cli login --use-device-flow` 或本项目
 * 的 bootstrap-login 模块触发。
 *
 * 详见 <https://kiro.dev/docs/cli/authentication/>。
 */

import { logger } from '../shared/logger.js';
import { expandTilde } from '../shared/paths.js';
import type { KiroCredentials } from './model/credentials.js';
import { loadFromSqlite, type SqliteCredentialSource } from './sqlite-credentials.js';

export interface LoadedCredentials {
  credentials: KiroCredentials;
  source: SqliteCredentialSource;
}

/**
 * 从环境变量加载 kiro-cli SQLite 凭据。
 *
 * - 必须设置 `KIRO2CLAUDE_SQLITE_DB_PATH`
 * - 路径里的 `~/` 会被展开为 `$HOME`
 * - SQLite 库里找不到有效 token 时抛错
 */
export function loadCredentialsFromEnv(): LoadedCredentials {
  const sqlitePathRaw = process.env.KIRO2CLAUDE_SQLITE_DB_PATH?.trim();
  if (!sqlitePathRaw) {
    throw new Error(
      'KIRO2CLAUDE_SQLITE_DB_PATH is required. Run `kiro-cli login --use-device-flow` ' +
        'and set KIRO2CLAUDE_SQLITE_DB_PATH to the resulting SQLite database path. ' +
        'See https://kiro.dev/docs/cli/authentication/',
    );
  }

  const expanded = expandTilde(sqlitePathRaw);
  const result = loadFromSqlite(expanded);
  if (!result) {
    throw new Error(
      `KIRO2CLAUDE_SQLITE_DB_PATH (${expanded}) does not contain a valid kiro-cli credential. ` +
        "Run 'kiro-cli login --use-device-flow' to (re-)authenticate.",
    );
  }

  logger.info(`Loaded credentials from kiro-cli SQLite: ${expanded}`);
  return { credentials: result.credentials, source: result.source };
}
