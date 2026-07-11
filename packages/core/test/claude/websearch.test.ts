/**
 * Regression tests for `formatPageAgeUTC` — the UTC-aware date formatter
 * used by the WebSearch tool result renderer.
 *
 * ## Background
 *
 * The WebSearch tool result renderer must format `publishedDate` (a
 * millisecond timestamp) as a human-readable string of shape
 * `"<Full Month> <day-no-leading-zero>, <year>"`, e.g. `"January 6, 2024"`.
 * This string is part of the wire format sent back to Claude clients,
 * so it must be deterministic across hosts: a request served from
 * Frankfurt and a request served from Los Angeles must produce the same
 * output for the same input timestamp.
 *
 * JavaScript's `Date.prototype.toLocaleDateString` defaults to the host
 * timezone. A naïve implementation like:
 *
 * ```ts
 * new Date(ms).toLocaleDateString('en-US', { month: 'long', ... })
 * ```
 *
 * would render the *same* timestamp differently depending on where the
 * server runs — a midnight-UTC date shows up as the previous day on any
 * US-region host. This is a silent cross-region wire-format divergence.
 *
 * `formatPageAgeUTC` fixes the bug by pinning `timeZone: 'UTC'`. These
 * tests lock that behavior by:
 *
 * 1. Asserting the output shape matches the expected `"Month D, YYYY"` form.
 * 2. Verifying the output is invariant to `process.env.TZ`. This is the
 *    most important assertion — a developer whose local clock happens to
 *    be UTC (or happens to fall on the same side of the date boundary)
 *    wouldn't catch the bug otherwise.
 */

import { describe, expect, it } from 'vitest';
import { formatPageAgeUTC } from '../../src/claude/websearch.js';

/**
 * Swap out `process.env.TZ` and return a restorer. Note: changing `TZ`
 * only affects new `Date.prototype.toLocaleString` calls on platforms where
 * ICU respects the env var — this works on macOS, Linux, and node built
 * with full-icu (the default for Node ≥13). If your CI uses small-icu, add
 * a `full-icu` dependency.
 */
function withTZ<T>(tz: string, body: () => T): T {
  const prev = process.env.TZ;
  process.env.TZ = tz;
  try {
    return body();
  } finally {
    if (prev === undefined) delete process.env.TZ;
    else process.env.TZ = prev;
  }
}

describe('formatPageAgeUTC', () => {
  // Use a timestamp chosen so that the UTC rendering and the US-West
  // local rendering land on *different* days. Date.UTC(2024, 0, 6) is
  // 2024-01-06 00:00:00 UTC, which is 2024-01-05 16:00 in America/Los_Angeles.
  // A local-time formatter would print "January 5, 2024" on a US-West
  // host; the UTC-pinned formatter must always print "January 6, 2024".
  const CROSS_DAY_UTC_MS = Date.UTC(2024, 0, 6);

  it('test_format_page_age_matches_expected_shape', () => {
    // Expected format: full month name, day without leading zero, year
    //   → "January 6, 2024"
    expect(formatPageAgeUTC(CROSS_DAY_UTC_MS)).toBe('January 6, 2024');
  });

  it('test_format_page_age_strips_leading_zero_from_day', () => {
    // Day 1 and day 31 both render without padding.
    expect(formatPageAgeUTC(Date.UTC(2024, 2, 1))).toBe('March 1, 2024');
    expect(formatPageAgeUTC(Date.UTC(2024, 11, 31))).toBe('December 31, 2024');
  });

  it('test_format_page_age_uses_full_month_name', () => {
    // Sanity check: all twelve months render with the full English name.
    const months = [
      'January',
      'February',
      'March',
      'April',
      'May',
      'June',
      'July',
      'August',
      'September',
      'October',
      'November',
      'December',
    ];
    for (let m = 0; m < 12; m++) {
      const out = formatPageAgeUTC(Date.UTC(2024, m, 15));
      expect(out).toBe(`${months[m]} 15, 2024`);
    }
  });

  it('test_format_page_age_returns_null_for_invalid_input', () => {
    // Non-finite timestamps cannot be formatted — the helper returns `null`,
    // which `page_age` downstream serializes as JSON null on the wire.
    expect(formatPageAgeUTC(Number.NaN)).toBeNull();
    expect(formatPageAgeUTC(Number.POSITIVE_INFINITY)).toBeNull();
    expect(formatPageAgeUTC(Number.NEGATIVE_INFINITY)).toBeNull();
  });

  // ==========================================================================
  // The regression-critical assertions: output must NOT depend on host TZ.
  // ==========================================================================
  //
  // These tests are what would have caught the original bug. Before the
  // fix, the expected output was "January 6, 2024" only on developer
  // machines in Asia/Hong_Kong (UTC+8 — the date boundary is crossed the
  // other direction, so the UTC day still happens to match). On
  // America/Los_Angeles (UTC-8), the unfixed code returned "January 5,
  // 2024", a 1-day offset from the expected wire format.
  //
  // The `withTZ` helper uses `process.env.TZ` which takes effect on the
  // next `Date.toLocaleDateString` call in Node (ICU re-reads `TZ`
  // lazily). On any platform with full-icu (default for Node 13+) this
  // works without additional setup.

  describe('regression: output must be timezone-invariant', () => {
    const EXPECTED = 'January 6, 2024';

    it('test_format_page_age_is_invariant_under_us_west_tz', () => {
      withTZ('America/Los_Angeles', () => {
        expect(formatPageAgeUTC(CROSS_DAY_UTC_MS)).toBe(EXPECTED);
      });
    });

    it('test_format_page_age_is_invariant_under_us_east_tz', () => {
      withTZ('America/New_York', () => {
        expect(formatPageAgeUTC(CROSS_DAY_UTC_MS)).toBe(EXPECTED);
      });
    });

    it('test_format_page_age_is_invariant_under_asia_hk_tz', () => {
      withTZ('Asia/Hong_Kong', () => {
        expect(formatPageAgeUTC(CROSS_DAY_UTC_MS)).toBe(EXPECTED);
      });
    });

    it('test_format_page_age_is_invariant_under_pacific_auckland_tz', () => {
      // Auckland is UTC+12/+13; the date boundary is crossed the same
      // direction as Hong Kong but by a much larger amount. Covers the
      // far-east edge case.
      withTZ('Pacific/Auckland', () => {
        expect(formatPageAgeUTC(CROSS_DAY_UTC_MS)).toBe(EXPECTED);
      });
    });

    it('test_format_page_age_is_invariant_under_utc_tz', () => {
      withTZ('UTC', () => {
        expect(formatPageAgeUTC(CROSS_DAY_UTC_MS)).toBe(EXPECTED);
      });
    });

    // Exhaustive cross-product: multiple timestamps × multiple timezones,
    // all must produce the same output. This is the strongest regression
    // assertion — any pairwise mismatch means the helper is leaking the
    // host timezone into the output.
    it('test_format_page_age_output_is_constant_across_tz_matrix', () => {
      const timestamps = [
        Date.UTC(2024, 0, 1), // Jan 1, 2024 00:00 UTC
        Date.UTC(2024, 5, 15, 23, 59, 59, 999), // Jun 15, 2024 23:59:59 UTC
        Date.UTC(2024, 11, 31, 12, 0, 0), // Dec 31, 2024 noon UTC
      ];
      const tzs = [
        'UTC',
        'America/Los_Angeles',
        'America/New_York',
        'Europe/London',
        'Europe/Berlin',
        'Asia/Hong_Kong',
        'Asia/Tokyo',
        'Pacific/Auckland',
      ];

      for (const ts of timestamps) {
        const outputs = tzs.map((tz) => withTZ(tz, () => formatPageAgeUTC(ts) ?? ''));
        // All outputs for the same timestamp must be identical, regardless
        // of which TZ was active when the call was made.
        const unique = new Set(outputs);
        expect(
          unique.size,
          `formatPageAgeUTC(${ts}) produced different outputs across timezones: ${JSON.stringify(outputs)}`,
        ).toBe(1);
      }
    });
  });
});
