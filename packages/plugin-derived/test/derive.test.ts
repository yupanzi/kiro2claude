import type { PluginContext } from '@kiro2claude/plugin-api';
import { afterEach, describe, expect, it } from 'vitest';
import {
  deriveKiroUsage,
  initCacheReadRatio,
  initCreditDerive,
  KIRO_CACHE_READ_RATIO,
  KIRO_K_IN,
  KIRO_K_OUT,
  KIRO_OVERAGE_RATE,
  resetCreditDerive,
} from '../src/derive.js';
import plugin from '../src/index.js';

afterEach(() => {
  resetCreditDerive();
});

// ============================================================================
// Golden data: 8 points from round3/round4 calibration runs
// ============================================================================
// Each row: { source label, model, T_in, T_out, credits, expected ... }
// Expected values recomputed under the KIRO_CACHE_READ_RATIO inversion
// divisor (value + provenance: see src/derive.ts). Sonnet/Haiku rounds had
// cache pollution, so several of them now saturate at 100% hit — that is
// the expected inversion output for under-priced rows, not an error.
// Tolerances: cache_read / cache_creation / input_tokens ±10 tokens
//             claudeEquivUsd ±1.5%
//
// Notes:
// - Opus 4.5/4.6 P_in=5e-6, P_out=25e-6, P_cr=0.5e-6, P_cw=6.25e-6
// - Sonnet 4.5/4.6 P_in=3e-6, P_out=15e-6, P_cr=0.3e-6, P_cw=3.75e-6
// - Haiku 4.5 P_in=1e-6, P_out=5e-6, P_cr=0.1e-6, P_cw=1.25e-6
// - Split: input=min(nonRead,10) fixed tail, rest → cache_creation (real Claude Code)

const TOL_TOKENS = 10;
const TOL_USD_PCT = 0.015;

describe('deriveKiroUsage — 8 golden data points (round3/round4)', () => {
  const cases = [
    {
      name: 'Opus 4.5 xs_in_xs_out (round3)',
      model: 'claude-opus-4-5-20251101',
      tIn: 4177,
      tOut: 1,
      credits: 0.029191,
      expected: {
        inputTokens: 10,
        cacheCreation: 4088,
        cacheRead: 79,
        status: 'ok_derived',
        claudeUsd: 0.025677,
      },
    },
    {
      name: 'Opus 4.5 lg_in_md_out (round3)',
      model: 'claude-opus-4-5-20251101',
      tIn: 31593,
      tOut: 109,
      credits: 0.2667,
      expected: {
        inputTokens: 10,
        cacheCreation: 31583,
        cacheRead: 0,
        status: 'ok_derived',
        claudeUsd: 0.200181,
      },
    },
    {
      name: 'Opus 4.5 mid_in_md_out (round4)',
      model: 'claude-opus-4-5-20251101',
      tIn: 6133,
      tOut: 159,
      credits: 0.113595,
      expected: {
        inputTokens: 10,
        cacheCreation: 6123,
        cacheRead: 0,
        status: 'ok_derived',
        claudeUsd: 0.042306,
      },
    },
    {
      name: 'Sonnet 4.5 xs_in_xs_out (round3) — cache_write, non-read → creation',
      model: 'claude-sonnet-4-5-20250929',
      tIn: 4173,
      tOut: 1,
      credits: 0.011136,
      expected: {
        // non-read 865: 10 → input tail (Claude Code structural), 855 → cache_creation.
        inputTokens: 10,
        cacheCreation: 855,
        cacheRead: 3308,
        status: 'ok_derived',
        claudeUsd: 0.004251,
      },
    },
    {
      name: 'Sonnet 4.5 mid_in_md_out (round4) — cache_write, saturated at 100% hit',
      model: 'claude-sonnet-4-5-20250929',
      tIn: 5907,
      tOut: 108,
      credits: 0.033963,
      expected: {
        inputTokens: 0,
        cacheCreation: 0,
        cacheRead: 5907,
        status: 'ok_derived',
        claudeUsd: 0.003392,
      },
    },
    {
      name: 'Sonnet 4.6 mid_in_md_out (round4)',
      model: 'claude-sonnet-4-6',
      tIn: 6143,
      tOut: 159,
      credits: 0.06744,
      expected: {
        inputTokens: 10,
        cacheCreation: 6133,
        cacheRead: 0,
        status: 'ok_derived',
        claudeUsd: 0.025421,
      },
    },
    {
      name: 'Haiku 4.5 xs_in_xs_out (round3)',
      model: 'claude-haiku-4-5-20251001',
      tIn: 4174,
      tOut: 1,
      credits: 0.005305,
      expected: {
        inputTokens: 10,
        cacheCreation: 3280,
        cacheRead: 884,
        status: 'ok_derived',
        claudeUsd: 0.004206,
      },
    },
    {
      name: 'Haiku 4.5 mid_in_md_out (round4) — cache_write, saturated at 100% hit',
      model: 'claude-haiku-4-5-20251001',
      tIn: 5896,
      tOut: 104,
      credits: 0.010094,
      expected: {
        inputTokens: 0,
        cacheCreation: 0,
        cacheRead: 5896,
        status: 'ok_derived',
        claudeUsd: 0.00111,
      },
    },
  ] as const;

  for (const c of cases) {
    it(c.name, () => {
      const out = deriveKiroUsage(c.model, c.tIn, c.tOut, c.credits);

      // Token attributions within tolerance
      expect(out.inputTokens).toBeGreaterThanOrEqual(c.expected.inputTokens - TOL_TOKENS);
      expect(out.inputTokens).toBeLessThanOrEqual(c.expected.inputTokens + TOL_TOKENS);
      expect(out.cacheCreationInputTokens).toBeGreaterThanOrEqual(
        c.expected.cacheCreation - TOL_TOKENS,
      );
      expect(out.cacheCreationInputTokens).toBeLessThanOrEqual(
        c.expected.cacheCreation + TOL_TOKENS,
      );
      expect(out.cacheReadInputTokens).toBeGreaterThanOrEqual(c.expected.cacheRead - TOL_TOKENS);
      expect(out.cacheReadInputTokens).toBeLessThanOrEqual(c.expected.cacheRead + TOL_TOKENS);

      // Status
      expect(out.derived.derivedStatus).toBe(c.expected.status);

      // Protocol identity
      expect(out.inputTokens + out.cacheCreationInputTokens + out.cacheReadInputTokens).toBe(c.tIn);

      // claudeEquivalentCostUsd within ±0.5%
      const expectedUsd = c.expected.claudeUsd;
      const lo = expectedUsd * (1 - TOL_USD_PCT);
      const hi = expectedUsd * (1 + TOL_USD_PCT);
      expect(out.derived.claudeEquivalentCostUsd).toBeGreaterThanOrEqual(lo);
      expect(out.derived.claudeEquivalentCostUsd).toBeLessThanOrEqual(hi);

      // inputTokensTotal and finalCostUsd defaults
      expect(out.derived.inputTokensTotal).toBe(c.tIn);
      expect(out.derived.costMultiplier).toBe(1.0);
      expect(out.derived.finalCostUsd).toBeCloseTo(out.derived.claudeEquivalentCostUsd, 10);
    });
  }
});

// ============================================================================
// Cache-hit regression: round2/round5 same-prompt resend probes
// ============================================================================
// The probe pair that exposed the original bug: resending an identical prompt
// within the cache TTL is a physically ~100% cache hit, which the old
// Anthropic-0.1× divisor could never derive (the derivable hit ratio was
// hard-capped — see the KIRO_CACHE_READ_RATIO jsdoc in src/derive.ts);
// under the Kiro ratio it must derive as a full hit.

describe('deriveKiroUsage — resend probe derives full cache hit (round2/round5)', () => {
  const model = 'claude-sonnet-4-5-20250929';
  const tIn = 17727;
  const tOut = 1;
  // Measured probe billing data (round2/round5) — do not regenerate.
  const FIRST_SEND_CREDITS = 0.07275670913764512;
  const RESEND_CREDITS = 0.03841924645107795;

  it('resend (true ~100% hit) → cacheRead=T_in, ratio=1, cache_write', () => {
    const out = deriveKiroUsage(model, tIn, tOut, RESEND_CREDITS);
    expect(out.cacheReadInputTokens).toBe(tIn);
    expect(out.inputTokens).toBe(0);
    expect(out.cacheCreationInputTokens).toBe(0);
    expect(out.derived.estimatedCacheHitRatio).toBe(1);
    expect(out.derived.derivedStatus).toBe('ok_derived');
  });

  it('first send (cache miss) → near-zero hit ratio, cache_write', () => {
    const out = deriveKiroUsage(model, tIn, tOut, FIRST_SEND_CREDITS);
    expect(out.derived.estimatedCacheHitRatio).toBeLessThan(0.1);
    expect(out.derived.derivedStatus).toBe('ok_derived');
    expect(out.inputTokens + out.cacheCreationInputTokens + out.cacheReadInputTokens).toBe(tIn);
  });

  it('synthetic Opus 100% hit at exact fitted price → ratio=1 without clamping', () => {
    // credits = (k_in·P_in·(r·T_in) + k_out·P_out·T_out) / overage_rate for a
    // pure full-hit request (Opus public P_in=5e-6, P_out=25e-6); the
    // inversion must round-trip to cacheRead=T_in.
    const credits =
      (KIRO_K_IN * 5e-6 * KIRO_CACHE_READ_RATIO * 20000 + KIRO_K_OUT * 25e-6 * 1) /
      KIRO_OVERAGE_RATE;
    const out = deriveKiroUsage('claude-opus-4-6', 20000, 1, credits);
    expect(out.cacheReadInputTokens).toBe(20000);
    expect(out.derived.estimatedCacheHitRatio).toBe(1);
    expect(out.derived.derivedStatus).toBe('ok_derived');
  });
});

// ============================================================================
// Threshold gating
// ============================================================================

describe('deriveKiroUsage — cache threshold gating', () => {
  it('Opus 4.5 + T_in=4095 → below_threshold', () => {
    const out = deriveKiroUsage('claude-opus-4-5-20251101', 4095, 1, 0.05);
    expect(out.derived.derivedStatus).toBe('below_threshold');
    expect(out.inputTokens).toBe(4095);
    expect(out.cacheCreationInputTokens).toBe(0);
    expect(out.cacheReadInputTokens).toBe(0);
  });

  it('Opus 4.5 + T_in=4096 → enters reverse-engineering', () => {
    // 4096 == threshold, should pass through
    const out = deriveKiroUsage('claude-opus-4-5-20251101', 4096, 1, 0.001);
    expect(out.derived.derivedStatus).toMatch(/^ok_/);
  });

  it('Sonnet 4.6 + T_in=2047 → below_threshold', () => {
    const out = deriveKiroUsage('claude-sonnet-4-6', 2047, 1, 0.01);
    expect(out.derived.derivedStatus).toBe('below_threshold');
  });

  it('Sonnet 4.6 + T_in=2048 → enters reverse-engineering', () => {
    const out = deriveKiroUsage('claude-sonnet-4-6', 2048, 1, 0.005);
    expect(out.derived.derivedStatus).toMatch(/^ok_/);
  });

  it('Sonnet 4.5 + T_in=1023 → below_threshold (1024 minimum)', () => {
    const out = deriveKiroUsage('claude-sonnet-4-5-20250929', 1023, 1, 0.005);
    expect(out.derived.derivedStatus).toBe('below_threshold');
  });

  it('Opus 4.7 + T_in=4095 → below_threshold (same as 4.5/4.6)', () => {
    const out = deriveKiroUsage('claude-opus-4-7', 4095, 1, 0.05);
    expect(out.derived.derivedStatus).toBe('below_threshold');
    expect(out.inputTokens).toBe(4095);
  });

  it('Opus 4.7 + T_in=4096 → enters reverse-engineering', () => {
    const out = deriveKiroUsage('claude-opus-4-7', 4096, 1, 0.001);
    expect(out.derived.derivedStatus).toMatch(/^ok_/);
  });
});

// ============================================================================
// Unknown model + thinking variants
// ============================================================================

describe('deriveKiroUsage — unknown / thinking variants', () => {
  it('unknown model → status="unknown_model", input_tokens preserved', () => {
    const out = deriveKiroUsage('gpt-4', 5000, 100, 0.01);
    expect(out.derived.derivedStatus).toBe('unknown_model');
    expect(out.inputTokens).toBe(5000);
    expect(out.cacheCreationInputTokens).toBe(0);
    expect(out.cacheReadInputTokens).toBe(0);
    expect(out.derived.claudeEquivalentCostUsd).toBe(0);
  });

  it('thinking variant uses base model price table', () => {
    const baseOut = deriveKiroUsage('claude-opus-4-5-20251101', 5000, 100, 0.05);
    const thinkingOut = deriveKiroUsage('claude-opus-4-5-20251101-thinking', 5000, 100, 0.05);
    expect(thinkingOut.inputTokens).toBe(baseOut.inputTokens);
    expect(thinkingOut.cacheCreationInputTokens).toBe(baseOut.cacheCreationInputTokens);
    expect(thinkingOut.cacheReadInputTokens).toBe(baseOut.cacheReadInputTokens);
    expect(thinkingOut.derived.derivedStatus).toBe(baseOut.derived.derivedStatus);
  });

  it('Opus 4.7 produces identical breakdown as Opus 4.6 (same prices/threshold)', () => {
    // 4.5/4.6/4.7 share the Anthropic public price table; the breakdown
    // and derived USD must match exactly for any input.
    const args = [10000, 200, 0.08] as const;
    const opus46 = deriveKiroUsage('claude-opus-4-6', ...args);
    const opus47 = deriveKiroUsage('claude-opus-4-7', ...args);
    expect(opus47.inputTokens).toBe(opus46.inputTokens);
    expect(opus47.cacheCreationInputTokens).toBe(opus46.cacheCreationInputTokens);
    expect(opus47.cacheReadInputTokens).toBe(opus46.cacheReadInputTokens);
    expect(opus47.derived.derivedStatus).toBe(opus46.derived.derivedStatus);
    expect(opus47.derived.claudeEquivalentCostUsd).toBe(opus46.derived.claudeEquivalentCostUsd);
  });
});

// ============================================================================
// Model-id normalization: alias vs dated snapshot both hit the price table
// ============================================================================
// Regression for the production bug (found via live kiro-cli test): the priced
// model is the raw wire model; undated aliases (`claude-haiku-4-5`) — what Claude
// Code and most clients actually send — missed the dated price-table keys and
// fell to unknown_model (all input, no cache derivation). normalizeModelId now
// owns all model-id canonicalization to the price-table key: dot-form → dash,
// `-thinking` strip, and `-YYYYMMDD` snapshot-date strip, so every variant
// (alias / dated / dot-form / thinking) shares one key via the direct API too.

describe('deriveKiroUsage — model-id normalization to price-table key', () => {
  const ARGS = [10000, 1, 0.05] as const;

  it.each([
    ['haiku alias', 'claude-haiku-4-5'],
    ['haiku dated snapshot', 'claude-haiku-4-5-20251001'],
    ['opus-4-5 alias', 'claude-opus-4-5'],
    ['opus-4-5 dated snapshot', 'claude-opus-4-5-20251101'],
    ['sonnet-4-5 alias', 'claude-sonnet-4-5'],
    ['sonnet-4-5 dated snapshot', 'claude-sonnet-4-5-20250929'],
    ['opus-4-6 dot-form', 'claude-opus-4.6'],
    ['opus-4-6 dot-form + thinking', 'claude-opus-4.6-thinking'],
  ])('%s prices (ok_derived, not unknown_model)', (_label, model) => {
    const out = deriveKiroUsage(model, ...ARGS);
    expect(out.derived.derivedStatus).toBe('ok_derived');
    expect(out.derived.claudeEquivalentCostUsd).toBeGreaterThan(0);
  });

  it('alias and dated snapshot produce identical breakdown', () => {
    const alias = deriveKiroUsage('claude-haiku-4-5', ...ARGS);
    const dated = deriveKiroUsage('claude-haiku-4-5-20251001', ...ARGS);
    expect(alias.inputTokens).toBe(dated.inputTokens);
    expect(alias.cacheCreationInputTokens).toBe(dated.cacheCreationInputTokens);
    expect(alias.cacheReadInputTokens).toBe(dated.cacheReadInputTokens);
    expect(alias.derived.claudeEquivalentCostUsd).toBe(dated.derived.claudeEquivalentCostUsd);
  });

  it('dot-form and dash-form map to the same price-table key', () => {
    const dot = deriveKiroUsage('claude-opus-4.6', ...ARGS);
    const dash = deriveKiroUsage('claude-opus-4-6', ...ARGS);
    expect(dot.derived.claudeEquivalentCostUsd).toBe(dash.derived.claudeEquivalentCostUsd);
    expect(dot.cacheReadInputTokens).toBe(dash.cacheReadInputTokens);
  });
});

// ============================================================================
// Extreme boundaries
// ============================================================================

describe('deriveKiroUsage — extreme boundaries', () => {
  it('T_in_total=0 → returns 0 across the board', () => {
    const out = deriveKiroUsage('claude-opus-4-5-20251101', 0, 100, 0.01);
    expect(out.inputTokens).toBe(0);
    expect(out.cacheCreationInputTokens).toBe(0);
    expect(out.cacheReadInputTokens).toBe(0);
  });

  it('credits=0 → cache_read clamped to T_in, hit_ratio=1, cache_write', () => {
    const tIn = 10000;
    const out = deriveKiroUsage('claude-opus-4-5-20251101', tIn, 1, 0);
    expect(out.cacheReadInputTokens).toBe(tIn);
    expect(out.cacheCreationInputTokens).toBe(0);
    expect(out.inputTokens).toBe(0);
    expect(out.derived.derivedStatus).toBe('ok_derived');
    expect(out.derived.estimatedCacheHitRatio).toBe(1);
  });

  it('credits much greater than baseline → cache_read=0, cache_write', () => {
    const out = deriveKiroUsage('claude-opus-4-5-20251101', 5000, 1, 1.0);
    expect(out.cacheReadInputTokens).toBe(0);
    expect(out.cacheCreationInputTokens).toBe(4990);
    expect(out.inputTokens).toBe(10);
    expect(out.derived.derivedStatus).toBe('ok_derived');
  });
});

// ============================================================================
// Multiplier
// ============================================================================

describe('deriveKiroUsage — cost multiplier', () => {
  it('initCreditDerive(2.5) → finalCostUsd × 2.5', () => {
    initCreditDerive(2.5);
    const out = deriveKiroUsage('claude-opus-4-5-20251101', 4177, 1, 0.029191);
    expect(out.derived.costMultiplier).toBe(2.5);
    expect(out.derived.finalCostUsd).toBeCloseTo(out.derived.claudeEquivalentCostUsd * 2.5, 10);
  });

  it('initCreditDerive(0) is allowed (free tier)', () => {
    initCreditDerive(0);
    const out = deriveKiroUsage('claude-opus-4-5-20251101', 4177, 1, 0.029191);
    expect(out.derived.costMultiplier).toBe(0);
    expect(out.derived.finalCostUsd).toBe(0);
  });

  it('initCreditDerive(-1) is rejected, multiplier stays 1.0', () => {
    initCreditDerive(-1);
    const out = deriveKiroUsage('claude-opus-4-5-20251101', 4177, 1, 0.029191);
    expect(out.derived.costMultiplier).toBe(1.0);
  });

  it('initCreditDerive(NaN) is rejected, multiplier stays 1.0', () => {
    initCreditDerive(Number.NaN);
    const out = deriveKiroUsage('claude-opus-4-5-20251101', 4177, 1, 0.029191);
    expect(out.derived.costMultiplier).toBe(1.0);
  });

  it('initCreditDerive(2000) is rejected (>1000 gate now lives in derive), stays 1.0', () => {
    initCreditDerive(2000);
    const out = deriveKiroUsage('claude-opus-4-5-20251101', 4177, 1, 0.029191);
    expect(out.derived.costMultiplier).toBe(1.0);
  });

  it('initCreditDerive returns whether the value was applied', () => {
    expect(initCreditDerive(2.5)).toBe(true);
    expect(initCreditDerive(0)).toBe(true);
    expect(initCreditDerive(2000)).toBe(false);
    expect(initCreditDerive(-1)).toBe(false);
    expect(initCreditDerive(Number.NaN)).toBe(false);
  });

  it('resetCreditDerive() returns multiplier to 1.0', () => {
    initCreditDerive(3.0);
    resetCreditDerive();
    const out = deriveKiroUsage('claude-opus-4-5-20251101', 4177, 1, 0.029191);
    expect(out.derived.costMultiplier).toBe(1.0);
  });
});

// ============================================================================
// Upstream cost floor: finalCostUsd >= credits × KIRO_OVERAGE_RATE (0.04)
// ============================================================================

describe('deriveKiroUsage — upstream cost floor', () => {
  it('floor activates when claudeUsd × multiplier < credits × 0.04', () => {
    // tiny multiplier: 0.0259 × 0.01 = 0.000259, floor = 0.029191 × 0.04 = 0.001168
    initCreditDerive(0.01);
    const out = deriveKiroUsage('claude-opus-4-5-20251101', 4177, 1, 0.029191);
    expect(out.derived.floorApplied).toBe(true);
    expect(out.derived.finalCostUsd).toBeCloseTo(0.029191 * KIRO_OVERAGE_RATE, 10);
  });

  it('floorApplied=false when algorithm value exceeds floor', () => {
    // default multiplier=1.0: claudeUsd ≈ 0.0259 > floor 0.001168
    const out = deriveKiroUsage('claude-opus-4-5-20251101', 4177, 1, 0.029191);
    expect(out.derived.floorApplied).toBe(false);
    expect(out.derived.finalCostUsd).toBeCloseTo(out.derived.claudeEquivalentCostUsd, 10);
  });

  it('multiplier=0 bypasses floor (explicit free tier)', () => {
    initCreditDerive(0);
    const out = deriveKiroUsage('claude-opus-4-5-20251101', 4177, 1, 0.029191);
    expect(out.derived.floorApplied).toBe(false);
    expect(out.derived.finalCostUsd).toBe(0);
  });

  it('unknown_model + multiplier=1 still hits floor (claudeUsd=0)', () => {
    // unknown model → claudeUsd=0, even with multiplier=1 the algo USD is 0,
    // so floor `credits × 0.04` always wins
    const out = deriveKiroUsage('gpt-4', 5000, 100, 0.01);
    expect(out.derived.claudeEquivalentCostUsd).toBe(0);
    expect(out.derived.floorApplied).toBe(true);
    expect(out.derived.finalCostUsd).toBeCloseTo(0.01 * KIRO_OVERAGE_RATE, 10);
  });

  it('floor protects below_threshold path too', () => {
    // tiny request, multiplier=0.001 → claudeUsd × m is microscopic
    initCreditDerive(0.001);
    const out = deriveKiroUsage('claude-opus-4-5-20251101', 100, 5, 0.001);
    expect(out.derived.derivedStatus).toBe('below_threshold');
    expect(out.derived.floorApplied).toBe(true);
    expect(out.derived.finalCostUsd).toBeCloseTo(0.001 * KIRO_OVERAGE_RATE, 10);
  });
});

// ============================================================================
// Protocol identity invariant
// ============================================================================

describe('deriveKiroUsage — Anthropic protocol identity', () => {
  // Cover all derivedStatus paths to ensure identity holds everywhere.
  const fixtures: Array<[string, string, number, number, number]> = [
    ['ok_derived Opus', 'claude-opus-4-5-20251101', 5000, 100, 0.05],
    ['ok_derived Sonnet', 'claude-sonnet-4-5-20250929', 5907, 108, 0.033963],
    ['below_threshold', 'claude-opus-4-5-20251101', 100, 5, 0.001],
    ['unknown_model', 'gpt-4', 5000, 100, 0.05],
  ];

  for (const [label, model, tIn, tOut, credits] of fixtures) {
    it(`${label}: input + creation + read === inputTokensTotal`, () => {
      const out = deriveKiroUsage(model, tIn, tOut, credits);
      expect(out.inputTokens + out.cacheCreationInputTokens + out.cacheReadInputTokens).toBe(tIn);
      expect(out.derived.inputTokensTotal).toBe(tIn);
    });
  }
});

// ============================================================================
// Cache-read ratio knob (KIRO2CLAUDE_CACHE_READ_RATIO override)
// ============================================================================
// The measured default is KIRO_CACHE_READ_RATIO; initCacheReadRatio overrides
// the inversion divisor as an explicit display/policy knob. afterEach's
// resetCreditDerive restores the measured default between tests.

describe('initCacheReadRatio — cache-read ratio knob', () => {
  // A partial-hit request under the measured default: opus xs derives ~1.9% hit
  // (cacheRead≈79). Used to show the knob amplifies the reported split.
  const ARGS = ['claude-opus-4-5-20251101', 4177, 1, 0.029191] as const;

  it('measured default leaves the faithful inversion unchanged', () => {
    const out = deriveKiroUsage(...ARGS);
    // Matches the golden "Opus 4.5 xs_in_xs_out" point (cacheRead≈79).
    expect(out.cacheReadInputTokens).toBeGreaterThanOrEqual(69);
    expect(out.cacheReadInputTokens).toBeLessThanOrEqual(89);
    expect(out.derived.derivedStatus).toBe('ok_derived');
  });

  it('raising the ratio to 0.99 inflates the reported cache_read split', () => {
    const base = deriveKiroUsage(...ARGS);
    initCacheReadRatio(0.99);
    const hi = deriveKiroUsage(...ARGS);
    expect(hi.cacheReadInputTokens).toBeGreaterThan(base.cacheReadInputTokens);
    expect(hi.derived.estimatedCacheHitRatio).toBeGreaterThan(base.derived.estimatedCacheHitRatio);
    // Protocol identity still holds under the override.
    expect(hi.inputTokens + hi.cacheCreationInputTokens + hi.cacheReadInputTokens).toBe(4177);
  });

  it('a partial-hit request saturates to 100% under 0.99', () => {
    // Sonnet steady golden (cacheRead≈3308 / ~79% at default) → clamps to full.
    initCacheReadRatio(0.99);
    const out = deriveKiroUsage('claude-sonnet-4-5-20250929', 4173, 1, 0.011136);
    expect(out.cacheReadInputTokens).toBe(4173);
    expect(out.derived.estimatedCacheHitRatio).toBe(1);
    expect(out.derived.derivedStatus).toBe('ok_derived');
  });

  it('a genuine full-price miss stays 0% even at 0.99 (cold-start ceiling)', () => {
    // credits high enough that tEffIn >= inputTokensTotal → cacheRead=0 branch,
    // which the ratio knob never touches.
    initCacheReadRatio(0.99);
    const out = deriveKiroUsage('claude-opus-4-5-20251101', 5000, 1, 1.0);
    expect(out.cacheReadInputTokens).toBe(0);
    expect(out.derived.derivedStatus).toBe('ok_derived');
  });

  it.each([
    ['ratio == 1 (divisor zero)', 1],
    ['ratio > 1 (divisor negative)', 1.5],
    ['negative ratio', -0.1],
    ['NaN', Number.NaN],
  ])('rejects invalid %s, keeping measured default', (_label, bad) => {
    const base = deriveKiroUsage(...ARGS);
    initCacheReadRatio(bad);
    const after = deriveKiroUsage(...ARGS);
    expect(after.cacheReadInputTokens).toBe(base.cacheReadInputTokens);
    expect(after.derived.estimatedCacheHitRatio).toBe(base.derived.estimatedCacheHitRatio);
  });

  it('resetCreditDerive restores the measured default after an override', () => {
    const base = deriveKiroUsage(...ARGS);
    initCacheReadRatio(0.99);
    resetCreditDerive();
    const restored = deriveKiroUsage(...ARGS);
    expect(restored.cacheReadInputTokens).toBe(base.cacheReadInputTokens);
    expect(restored.derived.estimatedCacheHitRatio).toBe(base.derived.estimatedCacheHitRatio);
  });

  it('boundary: ratio 0 is accepted (conservative attribution)', () => {
    // ratio 0 → divisor 1 → cacheRead = (Tin - tEffIn), the most conservative
    // non-degenerate attribution. Must be accepted (not rejected like <0).
    const base = deriveKiroUsage(...ARGS);
    initCacheReadRatio(0);
    const out = deriveKiroUsage(...ARGS);
    expect(out.cacheReadInputTokens).toBeLessThanOrEqual(base.cacheReadInputTokens);
  });
});

// ============================================================================
// Plugin register — env parsing edge cases (whitespace coercion + effective log)
// ============================================================================
// Regression: Number("  ") === 0, so a whitespace-only env value used to
// silently become multiplier 0 (free-tier, revenue zeroed) or ratio 0 (divisor
// 1 → over-billing). parseEnvNumber now treats blank/whitespace as "unset".
// afterEach's resetCreditDerive clears the module state register() mutates.

describe('DerivedPlugin.register — env parsing', () => {
  const PARTIAL = ['claude-opus-4-5-20251101', 4177, 1, 0.029191] as const;

  // Minimal PluginContext: register() only touches env / logger / registerHook.
  function makeCtx(env: NodeJS.ProcessEnv) {
    const logs: { info: object[]; warn: object[] } = { info: [], warn: [] };
    const ctx = {
      app: undefined,
      apiKey: 'test-key',
      env,
      logger: {
        info: (obj: object) => logs.info.push(obj),
        warn: (obj: object) => logs.warn.push(obj),
        error: () => {},
      },
      registerHook: { onUsageFinish: () => {} },
      getCapability: () => undefined,
    } as unknown as PluginContext;
    return { ctx, logs };
  }

  it('whitespace-only CACHE_READ_RATIO is treated as unset, not ratio 0', async () => {
    await plugin.register(makeCtx({ KIRO2CLAUDE_CACHE_READ_RATIO: '   ' }).ctx);
    const ws = deriveKiroUsage(...PARTIAL);
    resetCreditDerive();
    await plugin.register(makeCtx({}).ctx);
    const unset = deriveKiroUsage(...PARTIAL);
    // Whitespace must behave identically to unset (measured default), NOT ratio 0.
    expect(ws.cacheReadInputTokens).toBe(unset.cacheReadInputTokens);
  });

  it('explicit "0" CACHE_READ_RATIO is honored and differs from the default', async () => {
    await plugin.register(makeCtx({}).ctx);
    const def = deriveKiroUsage(...PARTIAL);
    resetCreditDerive();
    await plugin.register(makeCtx({ KIRO2CLAUDE_CACHE_READ_RATIO: '0' }).ctx);
    const zero = deriveKiroUsage(...PARTIAL);
    // ratio 0 → divisor 1 → fewer cacheRead tokens than the measured default.
    expect(zero.cacheReadInputTokens).toBeLessThan(def.cacheReadInputTokens);
  });

  it('whitespace-only COST_MULTIPLIER falls back to 1.0, not free-tier 0', async () => {
    await plugin.register(makeCtx({ KIRO2CLAUDE_COST_MULTIPLIER: '  ' }).ctx);
    const out = deriveKiroUsage(...PARTIAL);
    expect(out.derived.costMultiplier).toBe(1);
    expect(out.derived.finalCostUsd).toBeGreaterThan(0);
  });

  it('out-of-range COST_MULTIPLIER logs the EFFECTIVE 1.0, not the rejected value', async () => {
    const { ctx, logs } = makeCtx({ KIRO2CLAUDE_COST_MULTIPLIER: '5000' });
    await plugin.register(ctx);
    const registered = logs.info.find((o) => 'multiplier' in o) as
      | { multiplier: number }
      | undefined;
    expect(registered?.multiplier).toBe(1);
  });
});
