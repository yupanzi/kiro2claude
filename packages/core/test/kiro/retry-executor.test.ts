import { describe, expect, it, vi } from 'vitest';

import { parseRetryAfter } from '../../src/kiro/retry-executor.js';

describe('parseRetryAfter', () => {
  it('parses integer delta-seconds', () => {
    expect(parseRetryAfter('5')).toBe(5);
    expect(parseRetryAfter('0')).toBe(0);
    expect(parseRetryAfter('120')).toBe(120);
  });

  it('rounds up fractional seconds to next whole second', () => {
    expect(parseRetryAfter('1.4')).toBe(2);
    expect(parseRetryAfter('0.1')).toBe(1);
  });

  it('parses an HTTP-date in the future as a positive delta', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-05-12T00:00:00Z'));
      const future = new Date('2026-05-12T00:00:10Z').toUTCString();
      expect(parseRetryAfter(future)).toBe(10);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clamps an HTTP-date in the past to 0 instead of returning a negative', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-05-12T00:00:00Z'));
      const past = new Date('2026-05-11T23:59:50Z').toUTCString();
      expect(parseRetryAfter(past)).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns undefined on missing, empty, or unparseable input', () => {
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter('')).toBeUndefined();
    expect(parseRetryAfter('not a number or date')).toBeUndefined();
  });

  it('takes the first value when given an array (axios edge case)', () => {
    expect(parseRetryAfter(['7', '99'])).toBe(7);
    expect(parseRetryAfter([])).toBeUndefined();
  });

  it('rejects negative delta-seconds', () => {
    expect(parseRetryAfter('-3')).toBeUndefined();
  });
});
