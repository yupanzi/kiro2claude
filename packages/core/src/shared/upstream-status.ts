/**
 * Upstream HTTP status → downstream Claude error response translator.
 *
 * Lives in `shared/` so both `claude/error-mapper.ts` and `routes/kiro.ts`
 * can call into the same translation without violating the project's
 * dependency direction (`shared → kiro → claude → routes`).
 *
 * ## Design: simple pass-through + 4 exceptions + fallback
 *
 * The default behaviour is **pass the upstream status through verbatim**.
 * Only four statuses receive special handling:
 *
 * 1. **401 / 403** — credential semantics must not bleed downstream
 *    (a 401 here would mis-tell the Claude client its API key is bad
 *    when in fact our service has stale Kiro credentials).
 * 2. **429** — pass through with Claude's native `rate_limit_error` type
 *    so the downstream SDK applies its rate-limit back-off strategy.
 * 3. **503** — pass through with Claude's native `overloaded_error` type.
 *
 * Every other 4xx and 5xx is passed through with a generic Claude type
 * and a fixed safe message. Anything outside `[400, 600)` (status 0,
 * non-HTTP error) is funnelled to 502.
 *
 * ## Safe messages are a fixed dictionary
 *
 * `safeMessage` is **never** interpolated from upstream content. The full
 * upstream body belongs in structured logger fields, not in the wire
 * response. This is the "source-doesn't-pollute" pattern — we don't
 * regex-scrub at the boundary; we never let the data in.
 */

export interface TranslatedUpstream {
  /** HTTP status to send downstream. */
  httpStatus: number;
  /** Claude API `error.type` string (`rate_limit_error`, `api_error`, ...). */
  claudeType: string;
  /** Fixed user-facing message. Never derived from upstream content. */
  safeMessage: string;
}

/**
 * Translate an upstream HTTP status into a downstream response shape.
 *
 * @param status — upstream HTTP status code (may be `0`, `NaN`, or out-of-range)
 */
export function translateUpstreamStatus(status: number): TranslatedUpstream {
  // Exceptions 1-2: credential semantics — must NOT pass through to client.
  if (status === 401 || status === 403) {
    return {
      httpStatus: 502,
      claudeType: 'api_error',
      safeMessage: 'Upstream service error',
    };
  }

  // Exception 3: 429 — pass through with Claude's native rate_limit_error type.
  if (status === 429) {
    return {
      httpStatus: 429,
      claudeType: 'rate_limit_error',
      safeMessage: 'Upstream rate limit exceeded',
    };
  }

  // Exception 4: 503 — pass through with Claude's native overloaded_error type.
  if (status === 503) {
    return {
      httpStatus: 503,
      claudeType: 'overloaded_error',
      safeMessage: 'Upstream service overloaded',
    };
  }

  // Simple pass-through: other 4xx → original status + generic invalid_request_error.
  if (status >= 400 && status < 500) {
    return {
      httpStatus: status,
      claudeType: 'invalid_request_error',
      safeMessage: 'Upstream rejected the request',
    };
  }

  // Simple pass-through: other 5xx → original status + generic api_error.
  if (status >= 500 && status < 600) {
    return {
      httpStatus: status,
      claudeType: 'api_error',
      safeMessage: 'Upstream service error',
    };
  }

  // Fallback: anything outside [400, 600) (e.g. 0 / 200 / 999 / NaN) → 502.
  return {
    httpStatus: 502,
    claudeType: 'api_error',
    safeMessage: 'Upstream service error',
  };
}

/**
 * Should this final downstream status carry an upstream `Retry-After` header?
 *
 * Per RFC 9110 §10.2.3, `Retry-After` is defined for 429 and 503 (and 3xx
 * redirects, which we never produce). Other statuses must not carry it.
 */
export function shouldPassThroughRetryAfter(downstreamHttpStatus: number): boolean {
  return downstreamHttpStatus === 429 || downstreamHttpStatus === 503;
}

/**
 * Extract the `Retry-After` header value from a response headers map.
 *
 * Tolerates the few shapes we encounter in practice: axios's lower-cased
 * header object, fetch's `Headers` interface, and plain `Record<string, _>`.
 * The value is returned **verbatim** as a string (RFC 9110 allows either
 * `delta-seconds` or `HTTP-date`); we do not parse or validate it. Callers
 * pass it through to the downstream `Retry-After` header unchanged.
 *
 * Returns `undefined` when the header is missing or empty.
 */
export function extractRetryAfter(headers: unknown): string | undefined {
  if (!headers) return undefined;

  // fetch-style Headers interface
  if (typeof (headers as { get?: unknown }).get === 'function') {
    const v = (headers as { get(name: string): string | null }).get('retry-after');
    return v && v.length > 0 ? v : undefined;
  }

  // Plain object — try a few capitalisations.
  if (typeof headers === 'object') {
    const h = headers as Record<string, unknown>;
    for (const key of ['retry-after', 'Retry-After', 'RETRY-AFTER']) {
      const v = h[key];
      if (typeof v === 'string' && v.length > 0) return v;
      if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    }
  }

  return undefined;
}
