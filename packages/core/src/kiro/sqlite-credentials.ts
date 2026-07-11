/**
 * kiro-cli SQLite 库的凭据读写模块
 *
 * 从 kiro-cli 的 SQLite 数据库（如 `~/.local/share/kiro-cli/data.sqlite3`）
 * 加载 device code flow 产生的 AWS SSO OIDC 凭据，并在 Token 刷新后写回
 * 同一个库。kiro-cli 的 Builder ID 和 IAM Identity Center 登录都走这条
 * 路径，底层是同一套 OIDC device code flow。
 */

import fs from 'node:fs';
import Database from 'better-sqlite3';
import { logger } from '../shared/logger.js';
import type { KiroCredentials } from './model/credentials.js';
import { SqliteCredentialCorruptedError } from './sqlite-errors.js';

/**
 * SQLite `busy_timeout` 值（毫秒）。
 *
 * kiro-cli 自身在写 SQLite 时用的也是 5 秒 busy_timeout；保持一致避免
 * 两个进程同时写入时出现意外的 `SQLITE_BUSY`。把这个值放大对我们没有
 * 收益（刷新 token 的写入本来就很快），放小会在 kiro-cli 在进程外写入
 * 时误报锁冲突。
 */
const SQLITE_BUSY_TIMEOUT_MS = 5000;

/** kiro-cli 1.29+ device code flow 写入的 token 键 */
const SQLITE_TOKEN_KEY = 'kirocli:odic:token';

/** kiro-cli 1.29+ device code flow 写入的设备注册键 */
const SQLITE_REGISTRATION_KEY = 'kirocli:odic:device-registration';

/**
 * kiro-cli 把「当前选中的 CodeWhisperer Profile」存在独立的 `state` 表里，
 * 而不是 token JSON 里。实测 device code flow 下 token JSON 的 `profile_arn`
 * 字段**通常是缺失的**（只会有 access_token / refresh_token / region / scopes
 * / expires_at / start_url / oauth_flow），所以需要额外回退读一次 state 表。
 *
 * 值形如：
 * ```json
 * { "arn": "arn:aws:codewhisperer:us-east-1:<acct>:profile/<id>",
 *   "profile_name": "KiroProfile-us-east-1" }
 * ```
 */
const SQLITE_PROFILE_STATE_KEY = 'api.codewhisperer.profile';

/** `state.api.codewhisperer.profile` JSON 结构 */
interface SqliteProfileState {
  arn?: string;
  profile_name?: string;
}

/** SQLite token JSON 数据结构（kiro-cli 用 snake_case） */
interface SqliteTokenData {
  access_token?: string;
  refresh_token?: string;
  profile_arn?: string;
  region?: string;
  scopes?: string[];
  expires_at?: string;
  /** 来自 kiro-cli 的其他字段（oauth_flow / start_url 等），写回时保留 */
  [key: string]: unknown;
}

/** SQLite 设备注册 JSON 数据结构 */
interface SqliteRegistrationData {
  client_id?: string;
  client_secret?: string;
  region?: string;
}

/** SQLite 凭据源信息，供写回和重读使用 */
export interface SqliteCredentialSource {
  /** 数据库文件路径 */
  dbPath: string;
  /** 来自 kiro-cli 的额外字段（写回时原样保留） */
  extraFields: Record<string, unknown>;
  /** scopes 字段（写回时保留） */
  scopes?: string[];
  /** SSO region，用于 OIDC endpoint；可能与 API region 不同 */
  ssoRegion?: string;
}

/**
 * 从 auth_kv 表按 key 读一条 JSON value。
 *
 * - key 不存在 → 返回 `undefined`（"尚未登录"的合法信号）
 * - key 存在但 JSON 损坏 → 抛 `SqliteCredentialCorruptedError`
 *
 * 把「存储被破坏」作为结构性错误显式抛出，而非也返回 undefined——这样调用方能
 * 区分「首次启动」与「存储被破坏」，决策是硬挂退出还是 warn 继续
 * （profile_arn 回退之类的 non-critical 读取可以 catch 掉）。
 */
function readAuthKvJson<T>(db: Database.Database, key: string): T | undefined {
  const row = db.prepare('SELECT value FROM auth_kv WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  if (!row) return undefined;
  try {
    return JSON.parse(row.value) as T;
  } catch (e) {
    logger.error({ msg: 'SQLite credential corrupted', key, error: String(e) });
    throw new SqliteCredentialCorruptedError(key, e);
  }
}

/**
 * 从 kiro-cli SQLite 数据库加载凭据。
 *
 * 以只读方式打开数据库，按 kiro-cli 的约定 key 读 token 和设备注册，
 * 组装出一个 KiroCredentials。
 */
export function loadFromSqlite(
  dbPath: string,
): { credentials: KiroCredentials; source: SqliteCredentialSource } | undefined {
  if (!fs.existsSync(dbPath)) {
    logger.warn(`SQLite database does not exist: ${dbPath}`);
    return undefined;
  }

  const db = new Database(dbPath, { readonly: true });
  try {
    const tokenData = readAuthKvJson<SqliteTokenData>(db, SQLITE_TOKEN_KEY);
    if (!tokenData) {
      logger.debug('No valid token data found in SQLite database');
      return undefined;
    }

    const registration = readAuthKvJson<SqliteRegistrationData>(db, SQLITE_REGISTRATION_KEY);

    // 决定 SSO region：优先看 token，缺失时回退到注册信息
    const ssoRegion = tokenData.region ?? registration?.region;

    // 把受管字段从 tokenData 里抽出来，剩下的作为 extraFields 写回时保留
    const { access_token, refresh_token, profile_arn, region, scopes, expires_at, ...extraFields } =
      tokenData;

    // profile_arn 回退：token JSON 里没带时，尝试从 state 表读 kiro-cli 存的
    // 当前 profile 选择（见 SQLITE_PROFILE_STATE_KEY 的说明）。
    let profileArn = profile_arn;
    if (!profileArn) {
      try {
        const row = db
          .prepare('SELECT value FROM state WHERE key = ?')
          .get(SQLITE_PROFILE_STATE_KEY) as { value: string | Buffer } | undefined;
        if (row) {
          const raw = typeof row.value === 'string' ? row.value : row.value.toString('utf-8');
          try {
            const parsed = JSON.parse(raw) as SqliteProfileState;
            if (typeof parsed.arn === 'string' && parsed.arn.length > 0) {
              profileArn = parsed.arn;
              logger.debug(
                `Loaded profileArn from SQLite state '${SQLITE_PROFILE_STATE_KEY}': ${parsed.arn}`,
              );
            }
          } catch (e) {
            logger.warn(`Failed to parse SQLite state '${SQLITE_PROFILE_STATE_KEY}' JSON: ${e}`);
          }
        }
      } catch {
        // state 表不存在（老版本 kiro-cli）或 key 未写过，忽略
      }
    }

    // 组装 KiroCredentials
    const credentials: KiroCredentials = {
      accessToken: access_token,
      refreshToken: refresh_token,
      profileArn,
      expiresAt: expires_at,
      region: ssoRegion,
      clientId: registration?.client_id,
      clientSecret: registration?.client_secret,
    };

    const source: SqliteCredentialSource = {
      dbPath,
      extraFields,
      scopes,
      ssoRegion,
    };

    return { credentials, source };
  } finally {
    db.close();
  }
}

/**
 * 把刷新后的凭据写回 SQLite 数据库。
 *
 * kiro-cli 存的额外字段（oauth_flow / start_url 等）会原样保留，
 * 只覆盖受管字段（access_token / refresh_token / expires_at 等）。
 */
export function saveToSqlite(source: SqliteCredentialSource, credentials: KiroCredentials): void {
  if (!fs.existsSync(source.dbPath)) {
    throw new Error(`SQLite database does not exist: ${source.dbPath}`);
  }

  const db = new Database(source.dbPath, { readonly: false });
  try {
    db.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);

    // 用保留下来的额外字段打底，再覆盖受管字段
    const tokenData: SqliteTokenData = {
      ...source.extraFields,
      access_token: credentials.accessToken,
      refresh_token: credentials.refreshToken,
      profile_arn: credentials.profileArn,
      region: source.ssoRegion ?? credentials.region,
      scopes: source.scopes,
      expires_at: credentials.expiresAt,
    };

    const result = db
      .prepare('UPDATE auth_kv SET value = ? WHERE key = ?')
      .run(JSON.stringify(tokenData), SQLITE_TOKEN_KEY);

    if (result.changes > 0) {
      logger.debug(`Wrote credentials back to SQLite key: ${SQLITE_TOKEN_KEY}`);
    } else {
      logger.warn(`SQLite write-back: row '${SQLITE_TOKEN_KEY}' not found in auth_kv`);
    }
  } finally {
    db.close();
  }
}

/**
 * 从 SQLite 重读最新凭据（stale-token 重试路径使用）。
 */
export function reloadFromSqlite(
  source: SqliteCredentialSource,
): { credentials: KiroCredentials; source: SqliteCredentialSource } | undefined {
  return loadFromSqlite(source.dbPath);
}
