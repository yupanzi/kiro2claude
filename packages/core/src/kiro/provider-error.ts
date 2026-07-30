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
 * - `overloaded`       — 5xx whose body *names* model-capacity shortage. Split
 *                        out of `transient` because the upstream failure state
 *                        is **known**, not unknown. Token set and rationale:
 *                        {@link MODEL_CAPACITY_REASONS}.
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
  | {
      kind: 'overloaded';
      status: number;
      /** Narrowed to the token set so a typo at a throw site is a tsc error. */
      reason: ModelCapacityReason;
      retryAfterSeconds?: number;
    }
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
    case 'overloaded':
      return `Kiro API model capacity unavailable (HTTP ${kind.status}, reason=${kind.reason}, retryAfter=${kind.retryAfterSeconds ?? 'n/a'}s): ${truncate(body)}`;
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
// Body inspection helpers — string-based classification of upstream error
// bodies. `classifyErrorBody` handles the status-agnostic body rules; capacity
// classification is deliberately NOT here — it is status-gated to 5xx and needs
// the response headers (Retry-After), so it lives in the executor's 5xx branch
// via `matchModelCapacityReason` (see its doc). Add new body rules with that
// split in mind, not by widening `classifyErrorBody`.
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
 *
 * ★ Deliberately a permissive whole-body scan, **unlike**
 * {@link matchModelCapacityReason}, which trusts the declared `reason` first.
 * The cost asymmetry runs the other way, so do NOT unify them: a miss here sends
 * an out-of-quota user to `bad_request` → 400 "check your payload" — wrong *and*
 * non-retryable in the client SDKs — while an over-match only says "quota
 * exhausted" about a 402 that already failed. So superset tokens
 * (`MONTHLY_REQUEST_COUNT_LIMIT_EXCEEDED`) and prose mentions must still match.
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

/**
 * Upstream `reason` tokens that mean **"this model has no capacity right now"**.
 *
 * The upstream reports the *same* condition under three different wire shapes:
 *
 *   1. `429` + `INSUFFICIENT_MODEL_CAPACITY`  ("I am experiencing high traffic…")
 *   2. `500` + `MODEL_TEMPORARILY_UNAVAILABLE` ("Encountered unexpectedly high load…")
 *   3. a mid-stream `ThrottlingException` / `InternalServerException` frame
 *
 * (1) reaches the client as a 429, and (3) as 503/`overloaded_error` — but (3)
 * only when the frame carries one of the *named* exception types in
 * `claude/stream.ts` RETRYABLE_UPSTREAM_ERROR_CODES; a mid-stream frame with the
 * generic `code:"error"` is not in that set and still surfaces as 502 (踩坑「空流有界重试」).
 * Only (2) used to fall into the generic 5xx bucket and get compressed to
 * 502/`api_error`, which reads as "the gateway broke" rather than "retry later".
 * This set is what lets the executor tell (2) apart from a genuinely unknown 5xx.
 */
const MODEL_CAPACITY_REASONS = [
  'MODEL_TEMPORARILY_UNAVAILABLE',
  'INSUFFICIENT_MODEL_CAPACITY',
] as const;

/** One of the {@link MODEL_CAPACITY_REASONS} tokens, verbatim as upstream spells it. */
type ModelCapacityReason = (typeof MODEL_CAPACITY_REASONS)[number];

/**
 * Every **non-empty** `reason` the body *declares*, from `reason` and
 * `error.reason`. Empty = "upstream told us nothing", which is distinct from
 * "upstream told us something we don't recognise".
 *
 * Both levels are collected (not `a ?? b`) so an unrecognised top-level `reason`
 * can't mask the nested one. Empty strings are dropped: `{"reason":""}` declares
 * nothing, and counting it would suppress {@link matchModelCapacityReason}'s
 * fallback scan for a body that named no reason at all.
 */
function declaredReasons(body: string): string[] {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return []; // non-JSON body — nothing declared.
  }
  if (typeof value !== 'object' || value === null) return [];
  const record = value as { reason?: unknown; error?: { reason?: unknown } };
  return [record.reason, record.error?.reason].filter(
    (r): r is string => typeof r === 'string' && r.length > 0,
  );
}

/**
 * Return the model-capacity reason token named by this response body, or
 * `undefined` if the body doesn't name one.
 *
 * Returns the **token**, not a boolean, so the caller can put it straight into a
 * structured log field — triage otherwise has to substring-match formatted
 * `error` prose to tell "high load" apart from a generic 500 (踩坑「跨模型对照」).
 *
 * ★ **Precedence is load-bearing: the declared `reason` first, whole-body scan
 * only as fallback.** A body-wide `includes` matches the token *anywhere* — in
 * `message` prose, in a nested diagnostic, in request content the upstream echoed
 * back — so scanning first would relabel a generic 500 as a capacity event and
 * stamp a token upstream never declared into the very dimension this exists to
 * make trustworthy. The scan is kept for non-JSON bodies and shapes we don't
 * know, so a wire-format change can't silently disable the relabelling.
 */
export function matchModelCapacityReason(body: string): ModelCapacityReason | undefined {
  const declared = declaredReasons(body);
  if (declared.length > 0) return MODEL_CAPACITY_REASONS.find((t) => declared.includes(t));
  return MODEL_CAPACITY_REASONS.find((t) => body.includes(t));
}
