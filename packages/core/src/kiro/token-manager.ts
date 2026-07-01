/**
 * Token 管理模块
 *
 * 负责 kiro-cli device code flow 凭据的 token 过期检测和刷新。暴露
 * `SingleTokenManager` 管理单个凭据的生命周期：lazy refresh、并发互斥、
 * 刷新后写回同一个 SQLite 库。Token refresh 唯一路径是 AWS SSO OIDC
 * `CreateToken` API（camelCase Smithy wire format）。
 */

import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import type { Config } from '../model/config.js';
import { getLogger, logger } from '../shared/logger.js';
import { extractRetryAfter } from '../shared/upstream-status.js';
import {
  getKiroClientProfile,
  renderUserAgent,
  renderXAmzUserAgent,
  requireAmzTarget,
} from './client-profile.js';
import type { KiroCredentials } from './model/credentials.js';
import {
  credentialEffectiveApiRegion,
  credentialEffectiveAuthRegion,
} from './model/credentials.js';
import type { TokenRefreshRequest, TokenRefreshResponse } from './model/token-refresh.js';
import type { UsageLimitsResponse } from './model/usage-limits.js';
import {
  reloadFromSqlite,
  type SqliteCredentialSource,
  saveToSqlite,
} from './sqlite-credentials.js';

// ---------------------------------------------------------------------------
// Token 过期判定辅助函数
// ---------------------------------------------------------------------------

/** 判断 token 是否会在 N 分钟内过期；无 expiresAt 返回 undefined */
export function isTokenExpiringWithin(
  credentials: KiroCredentials,
  minutes: number,
): boolean | undefined {
  if (!credentials.expiresAt) return undefined;
  const expiresMs = Date.parse(credentials.expiresAt);
  if (Number.isNaN(expiresMs)) return undefined;
  return expiresMs <= Date.now() + minutes * 60_000;
}

/** 判断 token 是否已过期（带 5 分钟安全边界） */
export function isTokenExpired(credentials: KiroCredentials): boolean {
  return isTokenExpiringWithin(credentials, 5) ?? true;
}

/** 判断 token 是否即将过期（10 分钟内） */
export function isTokenExpiringSoon(credentials: KiroCredentials): boolean {
  return isTokenExpiringWithin(credentials, 10) ?? false;
}

/** 校验 refreshToken 存在且非空；通过后调用点可以安全地把 refreshToken 当作 `string` 用 */
export function validateRefreshToken(
  credentials: KiroCredentials,
): asserts credentials is KiroCredentials & { refreshToken: string } {
  if (!credentials.refreshToken || credentials.refreshToken.length === 0) {
    throw new Error('Missing refreshToken in kiro-cli SQLite credentials');
  }
}

// ---------------------------------------------------------------------------
// RefreshTokenInvalidError / KiroHttpError
// ---------------------------------------------------------------------------

/** refreshToken 被上游永久作废（400 + invalid_grant） */
export class RefreshTokenInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RefreshTokenInvalidError';
  }
}

/**
 * 从 Kiro/AWS 上游收到的非 2xx HTTP 错误。
 *
 * 把 status 作为结构化字段暴露给调用方，避免"反解自己打印的错误消息"那条
 * 脆弱路径。目前由两处抛出：`refreshToken`（AWS SSO OIDC `CreateToken`，不含
 * invalid_grant 永久失败）和 `getUsageLimits`（`codewhisperer.<region>.amazonaws.com`）。
 *
 * ## 源头不污染（source-doesn't-pollute）
 *
 * `.message` 是预定义的固定字符串（如 "Rate limited"），**不**拼接上游 body。
 * 上游原始内容走结构化字段 `upstreamBody`（仅给 logger 用，绝不进 wire-format
 * response），`Retry-After` 响应头走 `retryAfter`（原样字符串透传）。这避免了
 * 在 error mapper 端用 regex 反清洗 RequestId 等敏感字段——数据从一开始就没
 * 进入暴露路径。
 */
export class KiroHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /** 上游响应体原文，仅供 logger 使用；永远不进 wire-format response */
    public readonly upstreamBody?: string,
    /** 上游 `Retry-After` 响应头原文（delta-seconds 或 HTTP-date，原样透传） */
    public readonly retryAfter?: string,
  ) {
    super(message);
    this.name = 'KiroHttpError';
  }
}

// ---------------------------------------------------------------------------
// codewhispererruntime 非流式服务 host 解析
// ---------------------------------------------------------------------------

/**
 * 按 region 解析 codewhispererruntime 非流式服务 host。
 *
 * kiro-cli 2.2.0 二进制里的 endpoint 表（`fig_api_client::endpoints`）：
 *   - us-east-1      → `codewhisperer.us-east-1.amazonaws.com`
 *   - us-gov-east-1  → `q.us-gov-east-1.amazonaws.com`
 *   - us-gov-west-1  → `q.us-gov-west-1.amazonaws.com`
 *   - eu-central-1   → `q.eu-central-1.amazonaws.com`
 *
 * 非 us-east-1 商业 region 暂未实测，按最保守的 `q.{region}` 兜底。
 *
 * 注意：streaming service（GenerateAssistantResponse / InvokeMCP）走
 * `runtime.{region}.kiro.dev`，和这里的 host 不同。
 */
function runtimeServiceHost(region: string): string {
  if (region === 'us-east-1') return `codewhisperer.${region}.amazonaws.com`;
  return `q.${region}.amazonaws.com`;
}

// ---------------------------------------------------------------------------
// Token 刷新（AWS SSO OIDC CreateToken）
// ---------------------------------------------------------------------------

/**
 * 刷新 Token（AWS SSO OIDC `CreateToken`）。
 *
 * 请求和响应体都必须是 **camelCase**（Smithy wire format）；snake_case 会
 * 让 AWS 返回 `401 invalid_client`，而且错误提示非常误导。详见
 * `test/kiro/model/token-refresh.test.ts` 的契约测试。
 */
export async function refreshToken(
  credentials: KiroCredentials,
  config: Config,
): Promise<KiroCredentials> {
  validateRefreshToken(credentials);

  const log = getLogger();
  const refreshStart = Date.now();

  const clientId = credentials.clientId;
  if (!clientId) throw new Error('Missing clientId in kiro-cli device registration');
  const clientSecret = credentials.clientSecret;
  if (!clientSecret) throw new Error('Missing clientSecret in kiro-cli device registration');

  const region = credentialEffectiveAuthRegion(credentials, config);
  log.info({ msg: 'refreshing token (AWS SSO OIDC)', region });
  const refreshUrl = `https://oidc.${region}.amazonaws.com/token`;

  const client = axios.create({ timeout: 60_000 });

  const body: TokenRefreshRequest = {
    clientId,
    clientSecret,
    refreshToken: credentials.refreshToken,
    grantType: 'refresh_token',
  };

  const response = await client.post(refreshUrl, body, {
    headers: {
      'content-type': 'application/json',
      host: `oidc.${region}.amazonaws.com`,
      'amz-sdk-invocation-id': uuidv4(),
      'amz-sdk-request': 'attempt=1; max=4',
      Connection: 'close',
    },
    validateStatus: () => true,
  });

  const status = response.status;
  if (status < 200 || status >= 300) {
    const bodyText =
      typeof response.data === 'string' ? response.data : JSON.stringify(response.data ?? '');

    // 400 + invalid_grant → 永久失败
    if (
      status === 400 &&
      bodyText.includes('"invalid_grant"') &&
      bodyText.includes('Invalid refresh token provided')
    ) {
      throw new RefreshTokenInvalidError(
        `kiro-cli refreshToken invalidated (invalid_grant): ${bodyText}. ` +
          "Re-run 'kiro-cli login --use-device-flow' to obtain a new credential.",
      );
    }

    const errorMsg =
      status === 401
        ? 'Credentials expired or invalid, re-authentication required'
        : status === 403
          ? 'Insufficient permissions to refresh token'
          : status === 429
            ? 'Rate limited'
            : status >= 500 && status < 600
              ? 'Server error, AWS OIDC service temporarily unavailable'
              : 'Token refresh failed';
    const retryAfter = extractRetryAfter(response.headers);
    log.error({
      msg: 'upstream http error',
      endpoint: 'oidc-token',
      upstream_status: status,
      upstream_body: bodyText,
      upstream_retry_after: retryAfter,
    });
    throw new KiroHttpError(status, errorMsg, bodyText, retryAfter);
  }

  const data = response.data as TokenRefreshResponse;

  log.info({
    msg: 'token refreshed',
    duration_ms: Date.now() - refreshStart,
    status: response.status,
  });

  const newCredentials: KiroCredentials = { ...credentials };
  newCredentials.accessToken = data.accessToken;

  if (data.refreshToken) {
    newCredentials.refreshToken = data.refreshToken;
  }
  if (data.expiresIn != null) {
    newCredentials.expiresAt = new Date(Date.now() + data.expiresIn * 1000).toISOString();
  }
  if (data.profileArn) {
    newCredentials.profileArn = data.profileArn;
  }

  return newCredentials;
}

/**
 * 拉取使用额度（纯透传上游）。
 *
 * 使用 kiro-cli client profile 构造请求头，走 Smithy awsJson1_0 协议
 * （POST / + x-amz-target）。注意：GetUsageLimits 属于 codewhispererruntime
 * 非流式服务，endpoint 和 streaming 不同：
 *   - streaming → `runtime.{region}.kiro.dev`
 *   - runtime   → `codewhisperer.{region}.amazonaws.com`（us-east-1）
 *                  `q.{region}.amazonaws.com`（gov / eu 等）
 *
 * `isEmailRequired=true` 让上游在 userInfo 里返回真实邮箱——不设
 * 此参数时上游一律把 userInfo.email 置为 null（最小化 PII 默认）。
 */
export async function getUsageLimits(
  credentials: KiroCredentials,
  config: Config,
  token: string,
): Promise<UsageLimitsResponse> {
  getLogger().debug('Fetching usage limits...');

  const region = credentialEffectiveApiRegion(credentials, config);
  const host = runtimeServiceHost(region);

  const profile = getKiroClientProfile();
  const headers: Record<string, string> = {
    ...profile.staticHeaders,
    'x-amz-target': requireAmzTarget(profile, 'getUsageLimits'),
    'user-agent': renderUserAgent(profile, 'codewhispererruntime'),
    'x-amz-user-agent': renderXAmzUserAgent(profile, 'codewhispererruntime'),
    host,
    'amz-sdk-invocation-id': uuidv4(),
    'amz-sdk-request': 'attempt=1; max=1',
    Authorization: `Bearer ${token}`,
  };

  // kiro-cli 把 profileArn / isEmailRequired 同时放在 query string 和 body 里
  // （双写模式，和 ListAvailableModels 一致）。body 里不需要 origin / resourceType。
  const body: Record<string, unknown> = { isEmailRequired: true };
  const query = new URLSearchParams({ isEmailRequired: 'true' });
  if (credentials.profileArn) {
    body.profileArn = credentials.profileArn;
    query.set('profileArn', credentials.profileArn);
  }

  const url = `https://${host}/?${query.toString()}`;
  const client = axios.create({ timeout: 60_000 });

  const response = await client.post(url, body, {
    headers,
    validateStatus: () => true,
  });

  const status = response.status;
  if (status < 200 || status >= 300) {
    const bodyText =
      typeof response.data === 'string' ? response.data : JSON.stringify(response.data ?? '');
    const errorMsg =
      status === 401
        ? 'Authentication failed, token invalid or expired'
        : status === 403
          ? 'Insufficient permissions to fetch usage limits'
          : status === 429
            ? 'Rate limited'
            : status >= 500 && status < 600
              ? 'Server error, AWS service temporarily unavailable'
              : 'Failed to fetch usage limits';
    const retryAfter = extractRetryAfter(response.headers);
    getLogger().error({
      msg: 'upstream http error',
      endpoint: 'getUsageLimits',
      upstream_status: status,
      upstream_body: bodyText,
      upstream_retry_after: retryAfter,
    });
    throw new KiroHttpError(status, errorMsg, bodyText, retryAfter);
  }

  getLogger().debug({ msg: 'raw getUsageLimits response', usage_limits_raw: response.data });
  return response.data as UsageLimitsResponse;
}

// ============================================================================
// AsyncMutex —— 基于 Promise 的互斥锁，给刷新流程用
// ============================================================================

class AsyncMutex {
  private _locked = false;
  private _waiters: Array<() => void> = [];

  async acquire(): Promise<() => void> {
    while (this._locked) {
      await new Promise<void>((resolve) => this._waiters.push(resolve));
    }
    this._locked = true;
    return () => {
      this._locked = false;
      const next = this._waiters.shift();
      if (next) next();
    };
  }
}

// ============================================================================
// SingleTokenManager
// ============================================================================

/** 一次 API 调用的上下文，绑定一对 credential + access token */
export interface CallContext {
  /** 凭据信息（用于构造请求头） */
  credentials: KiroCredentials;
  /** access token */
  token: string;
}

/**
 * 单凭据 Token 管理器。
 *
 * 职责被刻意收窄到「一个 kiro-cli 凭据的生命周期」：过期时 lazy refresh、
 * 通过 `AsyncMutex` 双检锁避免并发刷新、刷新成功后把新凭据写回原 SQLite
 * 库（保持和 kiro-cli 的字段完全兼容，kiro-cli 下次启动能直接用）。
 */
export class SingleTokenManager {
  private _config: Config;
  private _credentials: KiroCredentials;
  private _source: SqliteCredentialSource;
  private _refreshLock: AsyncMutex;

  constructor(config: Config, credentials: KiroCredentials, source: SqliteCredentialSource) {
    this._config = config;
    this._credentials = { ...credentials };
    this._source = source;
    this._refreshLock = new AsyncMutex();
  }

  /** 拿到 Config 引用 */
  config(): Config {
    return this._config;
  }

  /**
   * 获取一次 API 调用的上下文。
   *
   * 如果 token 已过期或即将过期，会触发一次 lazy refresh；通过
   * AsyncMutex 双检锁避免并发场景下的重复刷新。
   */
  async acquireContext(): Promise<CallContext> {
    const log = getLogger();
    const needsRefresh =
      isTokenExpired(this._credentials) || isTokenExpiringSoon(this._credentials);

    if (needsRefresh) {
      const refreshStart = Date.now();
      const release = await this._refreshLock.acquire();
      try {
        // 拿到锁之后再检查一次，避免与其他协程重复刷新
        if (isTokenExpired(this._credentials) || isTokenExpiringSoon(this._credentials)) {
          await this.doRefresh();
          log.info({
            msg: 'token refreshed via acquireContext',
            expires_at: this._credentials.expiresAt,
            duration_ms: Date.now() - refreshStart,
          });
        } else {
          log.debug('Token already refreshed by another request, skipping');
        }
      } finally {
        release();
      }
    }

    const token = this._credentials.accessToken;
    if (!token) throw new Error('No access_token available after refresh');

    return { credentials: { ...this._credentials }, token };
  }

  /**
   * 无条件强制刷新 Token（provider 在 401 路径下调用）。
   */
  async forceRefreshToken(): Promise<void> {
    const log = getLogger();
    const start = Date.now();
    // Snapshot the bearer we're about to invalidate BEFORE queuing on the lock.
    const staleToken = this._credentials.accessToken;
    const release = await this._refreshLock.acquire();
    try {
      // De-dup the thundering herd: when N concurrent requests all hit 401 on the
      // same stale bearer, the first one through the lock rotates the token; the
      // rest find it already changed and skip. Otherwise each would run a full
      // OIDC CreateToken + SQLite writeback, which wastes latency and can itself
      // trip OIDC rate limits / invalidate a token another holder is mid-using.
      if (this._credentials.accessToken !== staleToken) {
        log.debug('Token already force-refreshed by another request, skipping');
        return;
      }
      await this.doRefresh();
    } finally {
      release();
    }
    log.info({ msg: 'token force-refreshed', duration_ms: Date.now() - start });
  }

  /**
   * 拉取当前凭据的使用额度。
   *
   * 内部会先确保 token 新鲜，再调用顶层 `getUsageLimits`。上游响应
   * 原样返回，不做业务加工。
   */
  async getUsageLimits(): Promise<UsageLimitsResponse> {
    const ctx = await this.acquireContext();
    return await getUsageLimits(ctx.credentials, this._config, ctx.token);
  }

  // ========================================================================
  // 内部辅助
  // ========================================================================

  /**
   * 执行一次 token 刷新；刷新失败时带一次 stale-token 重试。
   *
   * 第一次刷新若返回 400/401，通常意味着 kiro-cli 通过再次登录旋转了
   * refresh_token。此时从 SQLite 重读一次最新凭据再试。必须在持有
   * `_refreshLock` 时调用。
   */
  private async doRefresh(): Promise<void> {
    let newCreds: KiroCredentials;
    try {
      newCreds = await refreshToken(this._credentials, this._config);
    } catch (e: unknown) {
      if (this.shouldRetryFromSqlite(e)) {
        getLogger().warn({ msg: 'token refresh failed, reloading from SQLite', error: String(e) });
        newCreds = await this.reloadAndRetryRefresh();
      } else {
        throw e;
      }
    }

    if (isTokenExpired(newCreds)) {
      throw new Error('Refreshed token is still invalid or expired');
    }

    this._credentials = { ...newCreds };
    this.persistRefreshedCredentials();
  }

  /**
   * 判断一次刷新失败是否该触发 SQLite 重读重试。
   *
   * 400/401 通常意味着 refresh token 在 OIDC 端已经被作废——常见于另一
   * 台机器或本机的 kiro-cli 在此期间重新走了一次 device flow 刷新出了
   * 新的 refresh token。400 + invalid_grant 会先被 `RefreshTokenInvalidError`
   * 截获，永远不会走到这里，所以此处只剩下"用 SQLite 里的最新值再试一次"
   * 这条恢复路径。
   */
  private shouldRetryFromSqlite(error: unknown): boolean {
    return error instanceof KiroHttpError && (error.status === 400 || error.status === 401);
  }

  /** 从 SQLite 重读凭据并再试一次刷新 */
  private async reloadAndRetryRefresh(): Promise<KiroCredentials> {
    const result = reloadFromSqlite(this._source);
    if (!result) throw new Error('SQLite reload found no credentials');

    // 更新内存中的凭据和持久化源
    this._credentials = { ...result.credentials };
    this._source = result.source;

    // 用重读出来的新凭据再试一次刷新
    return await refreshToken(this._credentials, this._config);
  }

  /**
   * 把刷新后的凭据写回 SQLite。
   *
   * 写回失败只打 warn，不向上抛——刷新本身已经在内存里成功，下一次
   * 请求仍然能用到新 token；持久化失败只影响进程重启后的状态。
   */
  private persistRefreshedCredentials(): void {
    try {
      saveToSqlite(this._source, this._credentials);
      logger.debug('Credentials written back to SQLite');
    } catch (e) {
      logger.warn({ msg: 'credential write-back failed', error: String(e) });
    }
  }
}
