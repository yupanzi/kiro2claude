/**
 * Upstream HTTP executor for Kiro-family API calls.
 *
 * kiro2claude is a **forwarding gateway**: upstream errors are translated
 * (status code + body classification) and propagated to the downstream
 * client as-is. The gateway does NOT absorb transient failures with
 * exponential backoff — that's the downstream client's job, using the
 * HTTP-standard signals we faithfully forward (429 status, Retry-After
 * header, 503 Service Unavailable, etc.).
 *
 * ## The one retry the gateway DOES perform
 *
 * Bearer token recovery. When upstream returns 401 with a body containing
 * "The bearer token included in the request is invalid", the gateway calls
 * `tokenManager.forceRefreshToken()` and retries the request exactly once.
 * This is the gateway's essential responsibility — the downstream client
 * does not have the refresh token and cannot do this itself.
 *
 * All other error paths are single-attempt:
 *
 * - 2xx → return the response
 * - 400 → classify body, throw `bad_request` / `context_window_full` / `input_too_long`
 * - 401/403 → optional one-shot force-refresh (above), then throw `unauthorized`
 * - 402 + MONTHLY → throw `quota_exhausted`
 * - 429 → throw `rate_limited` with parsed Retry-After
 * - 408/5xx → throw `transient` with parsed Retry-After (mapper passes status through)
 * - Network error (axios throws) → throw `network` (mapper returns 502)
 *
 * ## What's different across the three call paths
 *
 * Five hook-shaped fields on `RetryableRequest`:
 *
 * - `label`         — free-form string for log correlation
 * - `buildUrl`      — per-credential URL (different endpoints)
 * - `buildHeaders`  — per-profile headers (MCP adds x-amzn-kiro-profile-arn)
 * - `transformBody` — request body shaping (main API injects profileArn)
 * - `axiosConfig`   — response type (json / arraybuffer / stream) and extras
 * - `readErrorBody` — how to drain the response body into a string for
 *                     classification (streams need chunk concatenation,
 *                     buffers need `.toString()`, JSON needs `JSON.stringify`)
 *
 * ## Contract with token-manager
 *
 * Errors from `tokenManager.acquireContext()` (RefreshTokenInvalidError,
 * KiroHttpError, etc.) are propagated as-is without being wrapped in
 * `ProviderError`. The outer handler distinguishes them via
 * `instanceof ProviderError` and falls through to a generic 502.
 */

import type { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';

import { getLogger } from '../shared/logger.js';
import type { KiroCredentials } from './model/credentials.js';
import { classifyErrorBody, isBearerTokenInvalidBody, ProviderError } from './provider-error.js';
import type { SingleTokenManager } from './token-manager.js';

/**
 * Per-request description. Three callers (main API, stream, MCP) each
 * build one of these and hand it to `RetryExecutor.execute()`.
 */
export interface RetryableRequest {
  /** Free-form label for logs, e.g. "Stream" / "Non-stream" / "MCP". */
  label: string;
  /** Pre-transformed request body (same shape across all attempts). */
  body: string;
  /** Build the full URL for this request given the current credentials. */
  buildUrl(credentials: KiroCredentials): string;
  /** Build the request headers given credentials, bearer token, and host. */
  buildHeaders(credentials: KiroCredentials, token: string, host: string): Record<string, string>;
  /** Transform the body just before sending (e.g. inject profileArn). */
  transformBody(body: string, credentials: KiroCredentials): string;
  /** Extra axios config merged onto the base config (timeout, responseType, etc.). */
  axiosConfig: Partial<AxiosRequestConfig>;
  /** Drain the response body into a string for error classification. */
  readErrorBody(response: AxiosResponse): Promise<string>;
  /** Derive the `host` header value from credentials (region-dependent). */
  buildHost(credentials: KiroCredentials): string;
}

export class RetryExecutor {
  private tokenManager: SingleTokenManager;
  private client: AxiosInstance;

  constructor(tokenManager: SingleTokenManager, client: AxiosInstance) {
    this.tokenManager = tokenManager;
    this.client = client;
  }

  /**
   * Execute an upstream request. Returns the successful `AxiosResponse`
   * or throws — either a `ProviderError` (HTTP-level classification) or
   * whatever the token manager threw (credentials-level failure).
   *
   * Single attempt by default. If upstream returns 401 with a body that
   * matches `isBearerTokenInvalidBody`, the executor calls
   * `tokenManager.forceRefreshToken()` and tries exactly once more. No
   * other retry logic exists — transient upstream failures (408/429/5xx)
   * are forwarded verbatim so the downstream client can apply its own
   * HTTP-standard backoff.
   */
  async execute(req: RetryableRequest): Promise<AxiosResponse> {
    const log = getLogger();
    let forceRefreshed = false;

    while (true) {
      const ctx = await this.tokenManager.acquireContext();

      const url = req.buildUrl(ctx.credentials);
      const host = req.buildHost(ctx.credentials);
      const headers = req.buildHeaders(ctx.credentials, ctx.token, host);
      const body = req.transformBody(req.body, ctx.credentials);

      log.debug({ msg: 'calling Kiro API', url, type: req.label });
      const attemptStart = Date.now();

      let response: AxiosResponse;
      try {
        response = await this.client.post(url, body, {
          headers,
          validateStatus: () => true,
          transformRequest: [(data: unknown) => data],
          ...req.axiosConfig,
        });
      } catch (e: unknown) {
        log.warn({
          msg: 'API request send failed',
          type: req.label,
          duration_ms: Date.now() - attemptStart,
          error: String(e),
        });
        throw new ProviderError({ kind: 'network', cause: e }, '');
      }

      const status = response.status;

      if (status >= 200 && status < 300) {
        log.info({
          msg: 'Kiro API call succeeded',
          type: req.label,
          status,
          duration_ms: Date.now() - attemptStart,
        });
        return response;
      }

      // Drain body once for classification. This is the slowest path
      // but happens only on non-2xx, which is rare in steady state.
      const responseBody = await req.readErrorBody(response);

      // Body-shape classification (context_window_full / input_too_long /
      // quota_exhausted).
      const classified = classifyErrorBody(status, responseBody);
      if (classified) {
        throw new ProviderError(classified, responseBody);
      }

      // 400 Bad Request (doesn't match a more specific kind)
      if (status === 400) {
        throw new ProviderError({ kind: 'bad_request', status: 400 }, responseBody);
      }

      // 401/403 — the gateway's one essential retry: force-refresh the bearer
      // token if upstream signals it was invalidated. Downstream cannot do
      // this itself (no access to refresh token), so the gateway must.
      if (status === 401 || status === 403) {
        log.warn({
          msg: 'API request failed (credential error)',
          type: req.label,
          status,
          duration_ms: Date.now() - attemptStart,
        });

        const bearerInvalid = isBearerTokenInvalidBody(responseBody);
        if (bearerInvalid && !forceRefreshed) {
          forceRefreshed = true;
          log.info('Token may be invalidated upstream, attempting force-refresh');
          try {
            await this.tokenManager.forceRefreshToken();
            log.info('Token force-refreshed, retrying API request');
            continue;
          } catch (e) {
            log.warn({ msg: 'token force-refresh failed', error: String(e) });
          }
        }

        throw new ProviderError({ kind: 'unauthorized', status, bearerInvalid }, responseBody);
      }

      // 429 — rate limited. Forward verbatim with Retry-After so the
      // downstream client can apply HTTP-standard backoff.
      if (status === 429) {
        const retryAfterSeconds = parseRetryAfter(response.headers['retry-after']);
        log.warn({
          msg: 'API request failed (rate limited)',
          type: req.label,
          status,
          retry_after_seconds: retryAfterSeconds,
          duration_ms: Date.now() - attemptStart,
        });
        throw new ProviderError(
          { kind: 'rate_limited', status: 429, retryAfterSeconds },
          responseBody,
        );
      }

      // 408 / 5xx — transient. Forward verbatim with Retry-After (503 often
      // ships one). The mapper decides which downstream status to use:
      // 408/503/504 pass through, the rest become 502.
      if (status === 408 || (status >= 500 && status < 600)) {
        const retryAfterSeconds = parseRetryAfter(response.headers['retry-after']);
        log.warn({
          msg: 'API request failed (transient)',
          type: req.label,
          status,
          retry_after_seconds: retryAfterSeconds,
          duration_ms: Date.now() - attemptStart,
        });
        throw new ProviderError({ kind: 'transient', status, retryAfterSeconds }, responseBody);
      }

      // Other 4xx — request/config problem
      if (status >= 400 && status < 500) {
        throw new ProviderError({ kind: 'bad_request', status }, responseBody);
      }

      // Unknown status (1xx/3xx leaking through). Treat as transient with
      // no Retry-After. Should be unreachable given axios's default range.
      log.warn({
        msg: 'API request failed (unknown)',
        type: req.label,
        status,
        duration_ms: Date.now() - attemptStart,
      });
      throw new ProviderError({ kind: 'transient', status }, responseBody);
    }
  }
}

// ============================================================================
// Response body drain helpers
// ============================================================================

/**
 * Read an axios response whose body is an AsyncIterable (stream mode)
 * into a UTF-8 string. Used only on error paths where the stream failed
 * before any SSE frames arrived.
 */
export async function drainStreamBody(response: AxiosResponse): Promise<string> {
  const data = response.data as AsyncIterable<Buffer> & { read?: () => unknown };
  if (data && typeof data.read === 'function') {
    const chunks: Buffer[] = [];
    try {
      for await (const chunk of data) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return Buffer.concat(chunks).toString('utf-8');
    } catch {
      return '';
    }
  }
  return drainBufferBody(response);
}

/** Read a Buffer or string response body into a UTF-8 string. */
export async function drainBufferBody(response: AxiosResponse): Promise<string> {
  const data = response.data;
  if (Buffer.isBuffer(data)) return data.toString('utf-8');
  if (typeof data === 'string') return data;
  return JSON.stringify(data ?? '');
}

/**
 * Parse the upstream Retry-After header. RFC 7231 allows two formats:
 * delta-seconds (e.g. "5") or HTTP-date (e.g. "Wed, 21 Oct 2026 07:28:00 GMT").
 * Returns undefined on missing/malformed input — callers must not invent a
 * value when the upstream did not provide one (synthesizing a delay risks
 * making the client wait when the upstream had already recovered).
 */
export function parseRetryAfter(raw: string | string[] | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return undefined;
  const asNum = Number(value);
  if (Number.isFinite(asNum)) {
    // Numeric input is unambiguous delta-seconds. Negative is malformed —
    // do not fall through to Date.parse (which would interpret "-3" as
    // an ancient calendar year and silently clamp it to 0).
    return asNum >= 0 ? Math.ceil(asNum) : undefined;
  }
  const asDate = Date.parse(value);
  if (Number.isFinite(asDate)) {
    const deltaMs = asDate - Date.now();
    return deltaMs > 0 ? Math.ceil(deltaMs / 1000) : 0;
  }
  return undefined;
}
