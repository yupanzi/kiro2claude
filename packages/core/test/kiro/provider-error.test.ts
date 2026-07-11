import { describe, expect, it } from 'vitest';

import {
  classifyErrorBody,
  isBearerTokenInvalidBody,
  isMonthlyRequestLimitBody,
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
