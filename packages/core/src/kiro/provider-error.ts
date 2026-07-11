/**
 * Structured provider-side error.
 *
 * The provider decides **at the failure site** which category the error
 * belongs to and hands the consumer a tagged `ProviderError` that can be
 * dispatched via an exhaustive switch — rather than throwing a flat
 * `Error` whose message the consumer must `.includes(...)` to classify.
 *
 * ## Why discriminated union instead of subclasses
 *
 * TypeScript's structural typing makes switch-based dispatch both more
 * concise and more type-safe than `instanceof` checks. The `kind.kind`
 * field is a string literal union, so `tsc` catches missed cases at
 * compile time when a new variant is added.
 *
 * ## Variants
 *
 * - `quota_exhausted` — 402 + MONTHLY_REQUEST_COUNT signal
 * - `bad_request`      — generic 400 that doesn't match a more specific kind
 * - `context_window_full` — 400 with CONTENT_LENGTH_EXCEEDS_THRESHOLD
 * - `input_too_long`   — 400 with "Input is too long"
 * - `unauthorized`     — 401/403, optionally flagged as bearer invalidation
 * - `rate_limited`     — 429 specifically; carries optional retryAfterSeconds
 *                        from upstream Retry-After header. Distinguished from
 *                        `transient` so the downstream HTTP status is preserved.
 * - `transient`        — 408/5xx returned verbatim by the gateway (no retries);
 *                        carries optional retryAfterSeconds from the upstream
 *                        Retry-After header (503 commonly ships one)
 * - `network`          — axios send error (no HTTP response)
 */

export type ProviderErrorKind =
  | { kind: 'quota_exhausted'; status: 402 }
  | { kind: 'bad_request'; status: number }
  | { kind: 'context_window_full'; status: number }
  | { kind: 'input_too_long'; status: number }
  | { kind: 'unauthorized'; status: number; bearerInvalid: boolean }
  | { kind: 'rate_limited'; status: 429; retryAfterSeconds?: number }
  | { kind: 'transient'; status: number; retryAfterSeconds?: number }
  | { kind: 'network'; cause: unknown };

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly body: string;

  constructor(kind: ProviderErrorKind, body: string, message?: string) {
    super(message ?? defaultMessage(kind, body));
    this.name = 'ProviderError';
    this.kind = kind;
    this.body = body;
  }
}

function defaultMessage(kind: ProviderErrorKind, body: string): string {
  switch (kind.kind) {
    case 'quota_exhausted':
      return `Kiro API quota exhausted (HTTP ${kind.status}): ${truncate(body)}`;
    case 'bad_request':
      return `Kiro API bad request (HTTP ${kind.status}): ${truncate(body)}`;
    case 'context_window_full':
      return `Kiro API: context window full (HTTP ${kind.status}): ${truncate(body)}`;
    case 'input_too_long':
      return `Kiro API: input too long (HTTP ${kind.status}): ${truncate(body)}`;
    case 'unauthorized':
      return `Kiro API unauthorized (HTTP ${kind.status}, bearerInvalid=${kind.bearerInvalid}): ${truncate(body)}`;
    case 'rate_limited':
      return `Kiro API rate limited (HTTP 429, retryAfter=${kind.retryAfterSeconds ?? 'n/a'}s): ${truncate(body)}`;
    case 'transient':
      return `Kiro API transient failure (HTTP ${kind.status}, retryAfter=${kind.retryAfterSeconds ?? 'n/a'}s): ${truncate(body)}`;
    case 'network':
      return `Kiro API network error: ${stringifyCause(kind.cause)}`;
  }
}

function truncate(body: string, max = 512): string {
  if (body.length <= max) return body;
  return `${body.slice(0, max)}…(${body.length - max} more chars)`;
}

function stringifyCause(cause: unknown): string {
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  return String(cause);
}

// ============================================================================
// Body inspection helpers — single source of truth for string-based
// classification of upstream error bodies.
// ============================================================================

/**
 * Classify an upstream 4xx/5xx response body into a more specific kind
 * when possible. Returns `undefined` if the body doesn't match a known
 * pattern, letting the caller fall back to a generic `bad_request` or
 * `transient` variant.
 */
export function classifyErrorBody(
  status: number,
  body: string,
):
  | Extract<
      ProviderErrorKind,
      { kind: 'context_window_full' | 'input_too_long' | 'quota_exhausted' }
    >
  | undefined {
  if (status === 402 && isMonthlyRequestLimitBody(body)) {
    return { kind: 'quota_exhausted', status: 402 };
  }
  if (body.includes('CONTENT_LENGTH_EXCEEDS_THRESHOLD')) {
    return { kind: 'context_window_full', status };
  }
  if (body.includes('Input is too long')) {
    return { kind: 'input_too_long', status };
  }
  return undefined;
}

/**
 * Standalone body check for "monthly quota exhausted". Kept as an exported
 * function (not a class static) so callers can import it without pulling
 * in the whole provider module — and so the contract tests can
 * verify the classification logic without constructing a real provider.
 */
export function isMonthlyRequestLimitBody(body: string): boolean {
  if (body.includes('MONTHLY_REQUEST_COUNT')) return true;
  try {
    const value = JSON.parse(body);
    if (value?.reason === 'MONTHLY_REQUEST_COUNT') return true;
    if (value?.error?.reason === 'MONTHLY_REQUEST_COUNT') return true;
  } catch {
    // non-JSON body, string match above already decided
  }
  return false;
}

/** Does the response body say "bearer token invalid"? */
export function isBearerTokenInvalidBody(body: string): boolean {
  return body.includes('The bearer token included in the request is invalid');
}
