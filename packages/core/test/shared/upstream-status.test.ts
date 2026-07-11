import { describe, expect, it } from 'vitest';

import {
  extractRetryAfter,
  shouldPassThroughRetryAfter,
  translateUpstreamStatus,
} from '../../src/shared/upstream-status.js';

describe('translateUpstreamStatus', () => {
  describe('exceptions — must NOT be plain pass-through', () => {
    it('401 → 502 api_error (credential semantics hidden from client)', () => {
      const t = translateUpstreamStatus(401);
      expect(t.httpStatus).toBe(502);
      expect(t.claudeType).toBe('api_error');
      expect(t.safeMessage).toBe('Upstream service error');
    });

    it('403 → 502 api_error (credential semantics hidden from client)', () => {
      const t = translateUpstreamStatus(403);
      expect(t.httpStatus).toBe(502);
      expect(t.claudeType).toBe('api_error');
      expect(t.safeMessage).toBe('Upstream service error');
    });

    it('429 → 429 rate_limit_error (Claude-native type)', () => {
      const t = translateUpstreamStatus(429);
      expect(t.httpStatus).toBe(429);
      expect(t.claudeType).toBe('rate_limit_error');
      expect(t.safeMessage).toBe('Upstream rate limit exceeded');
    });

    it('503 → 503 overloaded_error (Claude-native type)', () => {
      const t = translateUpstreamStatus(503);
      expect(t.httpStatus).toBe(503);
      expect(t.claudeType).toBe('overloaded_error');
      expect(t.safeMessage).toBe('Upstream service overloaded');
    });
  });

  describe('simple pass-through — other 4xx', () => {
    it.each([
      400, 404, 408, 418, 422, 451, 499,
    ])('%i → original status + invalid_request_error', (status) => {
      const t = translateUpstreamStatus(status);
      expect(t.httpStatus).toBe(status);
      expect(t.claudeType).toBe('invalid_request_error');
      expect(t.safeMessage).toBe('Upstream rejected the request');
    });
  });

  describe('simple pass-through — other 5xx', () => {
    it.each([500, 501, 502, 504, 505, 507, 599])('%i → original status + api_error', (status) => {
      const t = translateUpstreamStatus(status);
      expect(t.httpStatus).toBe(status);
      expect(t.claudeType).toBe('api_error');
      expect(t.safeMessage).toBe('Upstream service error');
    });
  });

  describe('fallback — out-of-range or unexpected values', () => {
    it.each([
      0,
      100,
      200,
      301,
      399,
      600,
      700,
      999,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ])('maps unusual value %s to 502 api_error', (status) => {
      const t = translateUpstreamStatus(status);
      expect(t.httpStatus).toBe(502);
      expect(t.claudeType).toBe('api_error');
      expect(t.safeMessage).toBe('Upstream service error');
    });
  });

  describe('safeMessage never contains upstream content', () => {
    // Sanity: regardless of input, the returned message is from a small
    // fixed dictionary. We verify by checking the message belongs to the
    // known set.
    const KNOWN_MESSAGES = new Set([
      'Upstream service error',
      'Upstream rate limit exceeded',
      'Upstream service overloaded',
      'Upstream rejected the request',
    ]);

    it('every status across [0, 700] returns a message from the fixed dictionary', () => {
      for (let s = 0; s <= 700; s++) {
        const t = translateUpstreamStatus(s);
        expect(KNOWN_MESSAGES.has(t.safeMessage), `status=${s} msg=${t.safeMessage}`).toBe(true);
      }
    });
  });
});

describe('shouldPassThroughRetryAfter', () => {
  it('allows Retry-After for 429 and 503 only (RFC 9110 §10.2.3)', () => {
    expect(shouldPassThroughRetryAfter(429)).toBe(true);
    expect(shouldPassThroughRetryAfter(503)).toBe(true);
  });

  it('rejects Retry-After for every other status', () => {
    for (const status of [200, 400, 401, 403, 404, 408, 500, 502, 504]) {
      expect(shouldPassThroughRetryAfter(status), `status=${status}`).toBe(false);
    }
  });
});

describe('extractRetryAfter', () => {
  it('returns undefined when headers is missing or empty', () => {
    expect(extractRetryAfter(null)).toBeUndefined();
    expect(extractRetryAfter(undefined)).toBeUndefined();
    expect(extractRetryAfter({})).toBeUndefined();
  });

  it('reads from lower-cased axios-style header object', () => {
    expect(extractRetryAfter({ 'retry-after': '30' })).toBe('30');
  });

  it('tolerates capitalisation variants', () => {
    expect(extractRetryAfter({ 'Retry-After': '60' })).toBe('60');
    expect(extractRetryAfter({ 'RETRY-AFTER': '5' })).toBe('5');
  });

  it('coerces numeric values to strings (verbatim)', () => {
    expect(extractRetryAfter({ 'retry-after': 42 })).toBe('42');
  });

  it('reads from fetch-style Headers interface (.get)', () => {
    const headers = {
      get(name: string): string | null {
        return name === 'retry-after' ? '120' : null;
      },
    };
    expect(extractRetryAfter(headers)).toBe('120');
  });

  it('returns undefined for empty string values', () => {
    expect(extractRetryAfter({ 'retry-after': '' })).toBeUndefined();
  });

  it('ignores non-finite numbers', () => {
    expect(extractRetryAfter({ 'retry-after': Number.NaN })).toBeUndefined();
    expect(extractRetryAfter({ 'retry-after': Number.POSITIVE_INFINITY })).toBeUndefined();
  });

  it('returns undefined for arbitrary non-object inputs', () => {
    expect(extractRetryAfter('not an object')).toBeUndefined();
    expect(extractRetryAfter(42)).toBeUndefined();
  });
});
