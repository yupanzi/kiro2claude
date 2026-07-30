import { describe, expect, it } from 'vitest';

import {
  classifyErrorBody,
  isBearerTokenInvalidBody,
  isMonthlyRequestLimitBody,
  matchModelCapacityReason,
  ProviderError,
  type ProviderErrorKind,
} from '../../src/kiro/provider-error.js';

describe('ProviderError', () => {
  it('is an Error subclass with a descriptive name', () => {
    const err = new ProviderError({ kind: 'bad_request', status: 400 }, 'some body');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ProviderError');
  });

  it('preserves kind and body fields', () => {
    const err = new ProviderError({ kind: 'quota_exhausted', status: 402 }, 'quota body');
    expect(err.kind.kind).toBe('quota_exhausted');
    expect(err.body).toBe('quota body');
  });

  it('generates default messages for each kind', () => {
    const cases: Array<[ProviderErrorKind, RegExp]> = [
      [{ kind: 'quota_exhausted', status: 402 }, /quota exhausted/],
      [{ kind: 'bad_request', status: 400 }, /bad request/],
      [{ kind: 'context_window_full', status: 400 }, /context window full/],
      [{ kind: 'input_too_long', status: 400 }, /input too long/],
      [{ kind: 'unauthorized', status: 401, bearerInvalid: true }, /unauthorized/],
      [{ kind: 'rate_limited', status: 429, retryAfterSeconds: 5 }, /rate limited/],
      [{ kind: 'rate_limited', status: 429 }, /retryAfter=n\/a/],
      [
        { kind: 'overloaded', status: 500, reason: 'MODEL_TEMPORARILY_UNAVAILABLE' },
        /model capacity unavailable.*reason=MODEL_TEMPORARILY_UNAVAILABLE/,
      ],
      [{ kind: 'transient', status: 503, retryAfterSeconds: 12 }, /transient.*retryAfter=12s/],
      [{ kind: 'transient', status: 500 }, /transient.*retryAfter=n\/a/],
      [{ kind: 'network', cause: new Error('ECONNREFUSED') }, /network error/],
    ];
    for (const [kind, expected] of cases) {
      const err = new ProviderError(kind, 'body');
      expect(err.message, `kind=${kind.kind}`).toMatch(expected);
    }
  });

  it('truncates very long bodies in the default message', () => {
    const body = 'x'.repeat(10_000);
    const err = new ProviderError({ kind: 'bad_request', status: 400 }, body);
    expect(err.message.length).toBeLessThan(1000);
    expect(err.message).toMatch(/more chars/);
  });

  it('respects an explicit message override', () => {
    const err = new ProviderError({ kind: 'bad_request', status: 400 }, 'body', 'custom message');
    expect(err.message).toBe('custom message');
  });
});

describe('classifyErrorBody', () => {
  it('detects quota exhausted from 402 body with flat reason', () => {
    const body = '{"reason":"MONTHLY_REQUEST_COUNT"}';
    const kind = classifyErrorBody(402, body);
    expect(kind?.kind).toBe('quota_exhausted');
  });

  it('detects quota exhausted from nested error.reason', () => {
    const body = '{"error":{"reason":"MONTHLY_REQUEST_COUNT"}}';
    const kind = classifyErrorBody(402, body);
    expect(kind?.kind).toBe('quota_exhausted');
  });

  it('does not classify quota exhausted for non-402 status', () => {
    const body = '{"reason":"MONTHLY_REQUEST_COUNT"}';
    // 402 with the wrong body or 400 with quota body — neither matches
    const kind = classifyErrorBody(400, body);
    expect(kind).toBeUndefined();
  });

  it('detects context window full', () => {
    const body = '{"message":"CONTENT_LENGTH_EXCEEDS_THRESHOLD"}';
    const kind = classifyErrorBody(400, body);
    expect(kind?.kind).toBe('context_window_full');
  });

  it('detects input too long', () => {
    const body = 'Input is too long for this model';
    const kind = classifyErrorBody(400, body);
    expect(kind?.kind).toBe('input_too_long');
  });

  it('returns undefined for unknown 4xx bodies', () => {
    const body = '{"message":"some other error"}';
    expect(classifyErrorBody(400, body)).toBeUndefined();
  });
});

describe('isMonthlyRequestLimitBody', () => {
  it('detects raw string match', () => {
    expect(isMonthlyRequestLimitBody('any body with MONTHLY_REQUEST_COUNT in it')).toBe(true);
  });

  it('detects JSON with top-level reason', () => {
    expect(isMonthlyRequestLimitBody('{"reason":"MONTHLY_REQUEST_COUNT"}')).toBe(true);
  });

  it('detects JSON with nested error.reason', () => {
    expect(isMonthlyRequestLimitBody('{"error":{"reason":"MONTHLY_REQUEST_COUNT"}}')).toBe(true);
  });

  it('returns false for unrelated bodies', () => {
    expect(isMonthlyRequestLimitBody('{"reason":"DAILY_REQUEST_COUNT"}')).toBe(false);
    expect(isMonthlyRequestLimitBody('{"error":"something"}')).toBe(false);
    expect(isMonthlyRequestLimitBody('')).toBe(false);
  });

  it('tolerates invalid JSON', () => {
    expect(isMonthlyRequestLimitBody('not json at all')).toBe(false);
  });

  it('matches superset tokens and prose mentions (deliberately permissive)', () => {
    // ★ Reverse guard against "unifying" this with `matchModelCapacityReason`'s
    // declared-reason-first precedence. The cost asymmetry runs the opposite way
    // here: a miss sends an out-of-quota user to `bad_request` → 400 "check your
    // request payload", which is wrong *and* non-retryable in the client SDKs,
    // whereas an over-match only says "quota exhausted" about a 402 that already
    // failed. Only one real 402 body has ever been observed, so the scan must
    // keep covering shapes we have not seen.
    expect(isMonthlyRequestLimitBody('{"reason":"MONTHLY_REQUEST_COUNT_LIMIT_EXCEEDED"}')).toBe(
      true,
    );
    expect(
      isMonthlyRequestLimitBody(
        '{"reason":"FREE_TIER_LIMIT","message":"MONTHLY_REQUEST_COUNT reached"}',
      ),
    ).toBe(true);
  });
});

describe('matchModelCapacityReason', () => {
  // Bodies below are verbatim shapes observed from upstream during a real
  // model-capacity event.
  it('detects MODEL_TEMPORARILY_UNAVAILABLE in the real 500 body', () => {
    const body =
      '{"message":"Encountered unexpectedly high load when processing the request, please try again.","reason":"MODEL_TEMPORARILY_UNAVAILABLE"}';
    expect(matchModelCapacityReason(body)).toBe('MODEL_TEMPORARILY_UNAVAILABLE');
  });

  it('detects INSUFFICIENT_MODEL_CAPACITY in the real 429 body', () => {
    const body =
      '{"message":"I am experiencing high traffic, please try again shortly.","reason":"INSUFFICIENT_MODEL_CAPACITY"}';
    expect(matchModelCapacityReason(body)).toBe('INSUFFICIENT_MODEL_CAPACITY');
  });

  it('detects a nested error.reason', () => {
    expect(matchModelCapacityReason('{"error":{"reason":"MODEL_TEMPORARILY_UNAVAILABLE"}}')).toBe(
      'MODEL_TEMPORARILY_UNAVAILABLE',
    );
  });

  it('reads the nested reason even when an unrelated top-level reason is present', () => {
    // The two levels are collected independently: an unrecognised top-level
    // `reason` must not mask the nested one.
    expect(
      matchModelCapacityReason(
        '{"reason":"SOMETHING_ELSE","error":{"reason":"INSUFFICIENT_MODEL_CAPACITY"}}',
      ),
    ).toBe('INSUFFICIENT_MODEL_CAPACITY');
  });

  it('trusts the declared reason over a token mentioned in prose', () => {
    // ★ Precedence guard. The body *names* a different reason and merely quotes
    // the capacity token inside `message` (upstreams echo diagnostics, and
    // client content can contain anything). A body-wide substring scan would
    // relabel this generic failure as a capacity shortage and stamp the wrong
    // token into the `capacity_reason` log field — the exact text-matching
    // failure mode 踩坑「跨模型对照」 exists to end.
    const body =
      '{"message":"Internal failure; not MODEL_TEMPORARILY_UNAVAILABLE","reason":"INTERNAL_ERROR"}';
    expect(matchModelCapacityReason(body)).toBeUndefined();
  });

  it('falls back to a body scan only when no reason is declared', () => {
    // Shapes we do not know (no `reason` field at all) still get the scan —
    // that is what keeps a wire-format change from silently disabling this.
    expect(
      matchModelCapacityReason('{"__type":"X","detail":"MODEL_TEMPORARILY_UNAVAILABLE"}'),
    ).toBe('MODEL_TEMPORARILY_UNAVAILABLE');
    expect(matchModelCapacityReason('raw text: INSUFFICIENT_MODEL_CAPACITY')).toBe(
      'INSUFFICIENT_MODEL_CAPACITY',
    );
  });

  it('treats an empty declared reason as "nothing declared" and still scans', () => {
    // ★ `{"reason":""}` names nothing. If the empty string counted as a
    // declaration it would suppress the fallback scan below it, dropping the
    // body back to `transient` → 502 — precisely the outcome the 503
    // relabelling exists to remove. Same evidence class as the `reason:null`
    // case below, which upstream really does send.
    expect(matchModelCapacityReason('{"reason":"","detail":"MODEL_TEMPORARILY_UNAVAILABLE"}')).toBe(
      'MODEL_TEMPORARILY_UNAVAILABLE',
    );
    expect(
      matchModelCapacityReason(
        '{"reason":"","message":"Encountered unexpectedly high load: INSUFFICIENT_MODEL_CAPACITY"}',
      ),
    ).toBe('INSUFFICIENT_MODEL_CAPACITY');
  });

  it('returns undefined for the generic 500 body (reason:null)', () => {
    // ★ This is the discriminator that matters: a sizeable share of the
    // failures in a real capacity event carried this body instead. It says
    // "please try again" but names no reason, so the upstream state really is
    // unknown → must stay `transient`, not `overloaded`.
    const body =
      '{"message":"Encountered an unexpected error when processing the request, please try again.","reason":null}';
    expect(matchModelCapacityReason(body)).toBeUndefined();
  });

  it('returns undefined for unrelated and malformed bodies', () => {
    expect(matchModelCapacityReason('{"reason":"MONTHLY_REQUEST_COUNT"}')).toBeUndefined();
    expect(matchModelCapacityReason('service unavailable')).toBeUndefined();
    expect(matchModelCapacityReason('not json at all')).toBeUndefined();
    expect(matchModelCapacityReason('')).toBeUndefined();
  });
});

describe('isBearerTokenInvalidBody', () => {
  it('matches the exact AWS error signature', () => {
    expect(isBearerTokenInvalidBody('The bearer token included in the request is invalid')).toBe(
      true,
    );
  });

  it('matches when embedded in a larger body', () => {
    expect(
      isBearerTokenInvalidBody(
        '{"message":"The bearer token included in the request is invalid."}',
      ),
    ).toBe(true);
  });

  it('does not match generic auth errors', () => {
    expect(isBearerTokenInvalidBody('Unauthorized')).toBe(false);
    expect(isBearerTokenInvalidBody('')).toBe(false);
  });
});
