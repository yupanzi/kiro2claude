/**
 * Reverse-engineer Kiro `meteringEvent.usage` (credits) into the standard
 * Anthropic Claude API cache usage shape.
 *
 * Closed-form formula fitted offline from credit-calibration data:
 *
 *     credits ≈ (k_in · P_in · T_eff + k_out · P_out · T_out) / overage_rate
 *     T_eff   = T_nonread + KIRO_CACHE_READ_RATIO · T_cache_read
 *
 * with k_in = 0.0556, k_out = 0.6705 fitted on Opus 4.5/4.6 cache-miss data
 * (R²=0.9999).
 *
 * Two DISTINCT cache economics live in this file — do not conflate them:
 * the credits equation (and therefore the INVERSION divisor) uses Kiro's
 * own cache-hit price ratio (KIRO_CACHE_READ_RATIO — value, provenance and
 * refit guidance live in its jsdoc), while the Anthropic public cache
 * prices in CLAUDE_PRICE_USD_PER_TOK are used ONLY to price the derived
 * breakdown into `claudeEquivalentCostUsd`.
 *
 * Given (model, input_tokens_total, output_tokens, credits) we solve for
 * `T_eff_in` (the "uncached-equivalent" input volume), then compare with
 * the upstream-reported total to attribute the difference as cache_read.
 * cache_creation vs uncached split: measured against real Claude Code via
 * `claude -p` + raw request capture (genuine Anthropic
 * usage) — the non-read remainder is written to cache (cache_creation) except a
 * small fixed input tail (CLAUDE_CODE_INPUT_TAIL_TOKENS ~10, constant structural
 * framing, not user content). This holds for both cold start (cacheRead=0 → all
 * creation) and steady state (large cacheRead → small creation): the main path
 * attributes `input = min(nonRead, tail)` and the rest → cache_creation; only
 * `below_threshold` (whole prompt too small to cache) stays pure input.
 * Kiro shows no separate cache-WRITE premium — UUID-clean first sends sit
 * on the plain k_in line — so writes need no extra term in the inversion.
 *
 * The Anthropic protocol identity
 *     input_tokens + cache_creation_input_tokens + cache_read_input_tokens
 *       == upstream input_tokens (`inputTokensTotal`)
 * holds for every status.
 *
 * Multi-instance note: like metering-counter, the cost multiplier is a
 * module-level singleton initialized once at startup. There's no shared
 * state across requests, so concurrent calls are safe.
 */

// ============================================================================
// Tunable constants (fitted offline from credit-calibration data)
// ============================================================================

export const KIRO_K_IN = 0.0556;
export const KIRO_K_OUT = 0.6705;
export const KIRO_OVERAGE_RATE = 0.04;
/**
 * Kiro's cached-input price as a fraction of its own miss price — the
 * inversion divisor is (1 - this). Measured from same-prompt resend
 * probes: round6 2026-07-02 opus-4.8 @37k = 0.52758 (two independent
 * anchor pairs, bit-reproducible) and sonnet-4.5 @24.6k = 0.52822;
 * round2/round5 2026-04 sonnet-4.5 @17.7k = 0.5264. Constant pinned to
 * the opus anchor (0.5276) — opus dominates typical traffic and is
 * the only deterministic multi-anchor measurement. NOT the Anthropic
 * 0.1× cache-read price — using that here caps the derivable hit ratio
 * at ~52% and was the root cause of derived cache ratios plateauing
 * around 30% on real (~99% cached) traffic.
 *
 * Probe scripts + raw data live outside this repo (offline calibration
 * dataset, not shipped) — rerun those to refit if upstream changes its
 * cache discount (symptom: estimatedCacheHitRatio drifts and true
 * full-hit resends stop deriving ~1.0).
 *
 * Known residual: haiku is billed well below the global k_in line (its
 * round6 miss anchors already derive 0.66-0.89 hit ratios), so haiku
 * requests over-attribute cache. The round6 2-point per-model solve was
 * adversarially audited as ill-conditioned (anchors self-contradictory,
 * ×22.8 error amplification) — do NOT add haiku constants without a
 * dedicated byte-stable grid with a large output-tokens lever.
 *
 * This is the MEASURED default. It can be overridden at runtime via the
 * `KIRO2CLAUDE_CACHE_READ_RATIO` env (see index.ts → `initCacheReadRatio`),
 * but that is a deliberate DISPLAY/POLICY knob, NOT a recalibration:
 * raising it inflates the reported `cache_read` split (and lowers
 * `claudeEquivalentCostUsd`, since cache_read prices at 0.1×), diverging the
 * wire numbers from what upstream actually billed. It cannot exceed the real
 * aggregate ceiling (~87.7% on typical traffic — cold-start input can
 * never enter the cache_read numerator), and values ≥1 are rejected
 * (divisor `1 - ratio` would hit zero / go negative). Leave it unset to keep
 * the faithful, measurement-backed inversion.
 */
export const KIRO_CACHE_READ_RATIO = 0.5276;

// ============================================================================
// Claude API public pricing (USD per token)
// ============================================================================

interface ClaudePrice {
  in: number;
  out: number;
  cacheRead: number;
  cacheCreation: number;
}

const CLAUDE_PRICE_USD_PER_TOK: Record<string, ClaudePrice> = {
  'claude-haiku-4-5': {
    in: 1e-6,
    out: 5e-6,
    cacheRead: 0.1e-6,
    cacheCreation: 1.25e-6,
  },
  'claude-sonnet-4-5': {
    in: 3e-6,
    out: 15e-6,
    cacheRead: 0.3e-6,
    cacheCreation: 3.75e-6,
  },
  'claude-sonnet-4-6': {
    in: 3e-6,
    out: 15e-6,
    cacheRead: 0.3e-6,
    cacheCreation: 3.75e-6,
  },
  // 标准价 $3/$15;促销价 $2/$10 截至 2026-08-31,静态表按标准价避免到期后失真
  'claude-sonnet-5': {
    in: 3e-6,
    out: 15e-6,
    cacheRead: 0.3e-6,
    cacheCreation: 3.75e-6,
  },
  'claude-opus-4-5': {
    in: 5e-6,
    out: 25e-6,
    cacheRead: 0.5e-6,
    cacheCreation: 6.25e-6,
  },
  'claude-opus-4-6': {
    in: 5e-6,
    out: 25e-6,
    cacheRead: 0.5e-6,
    cacheCreation: 6.25e-6,
  },
  'claude-opus-4-7': {
    in: 5e-6,
    out: 25e-6,
    cacheRead: 0.5e-6,
    cacheCreation: 6.25e-6,
  },
  'claude-opus-4-8': {
    in: 5e-6,
    out: 25e-6,
    cacheRead: 0.5e-6,
    cacheCreation: 6.25e-6,
  },
};

const MODEL_CACHE_THRESHOLD: Record<string, number> = {
  'claude-haiku-4-5': 4096,
  'claude-sonnet-4-5': 1024,
  'claude-sonnet-4-6': 2048,
  'claude-sonnet-5': 2048,
  'claude-opus-4-5': 4096,
  'claude-opus-4-6': 4096,
  'claude-opus-4-7': 4096,
  'claude-opus-4-8': 4096,
};

/**
 * Fixed `input_tokens` tail kept on the main (cacheable) path. Captured from
 * real Claude Code (claude -p + raw request capture): Claude
 * Code puts its last `cache_control` breakpoint on the FINAL message block, so no
 * user content falls outside the cache — yet Anthropic still reports a small,
 * CONSTANT `input_tokens` (~10, independent of prompt size: a 1-token "hi" and a
 * 40k-token prompt both bill input_tokens=10). It is per-request structural/turn
 * framing, not user content. We attribute `input = min(nonRead, this)` and put
 * the rest on cache_creation, so the wire mirrors real Claude Code instead of a
 * bare 0. Model-independent (framing, not content); credits can't recover it
 * anyway (input and creation are same-priced in Kiro), so this is a display knob.
 */
const CLAUDE_CODE_INPUT_TAIL_TOKENS = 10;

// ============================================================================
// Public types
// ============================================================================

export type DerivedStatus = 'unknown_model' | 'below_threshold' | 'ok_derived';

/** Metadata sub-object attached as `usage.kiro_derived` on responses. */
export interface KiroDerivedMetadata {
  inputTokensTotal: number;
  estimatedCacheHitRatio: number;
  claudeEquivalentCostUsd: number;
  finalCostUsd: number;
  costMultiplier: number;
  derivedStatus: DerivedStatus;
  /**
   * True when the per-request upstream cost floor (`credits × KIRO_OVERAGE_RATE`)
   * exceeded `claudeEquivalentCostUsd × multiplier` and was used as `finalCostUsd`.
   * Always false when `multiplier === 0` (explicit free-tier bypass).
   */
  floorApplied: boolean;
}

/**
 * The full breakdown returned by `deriveKiroUsage`. The handler reads
 * `inputTokens` / `cacheCreationInputTokens` / `cacheReadInputTokens` to
 * fill the top-level Anthropic-protocol `usage` fields, and attaches
 * `derived` as the `kiro_derived` sub-object.
 */
export interface DerivedUsageBreakdown {
  inputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  derived: KiroDerivedMetadata;
}

// ============================================================================
// Module-level singleton: cost multiplier
// ============================================================================

let _multiplier = 1.0;

/**
 * Effective cache-read price ratio used as the inversion divisor `(1 - this)`.
 * Defaults to the MEASURED constant; overridable via `initCacheReadRatio`
 * (env `KIRO2CLAUDE_CACHE_READ_RATIO`) as an explicit display/policy knob.
 */
let _cacheReadRatio = KIRO_CACHE_READ_RATIO;

/**
 * Set the cost multiplier — the single gate for its range. Accepts `[0, 1000]`;
 * non-finite / negative / `>1000` are rejected (returns `false`), leaving the
 * current value in place. Returns whether the value was applied so the env-layer
 * caller can log the *effective* outcome without re-encoding the bound.
 * `multiplier === 0` is an explicit free-tier bypass (see `applyFloor`).
 */
export function initCreditDerive(multiplier: number): boolean {
  if (!Number.isFinite(multiplier) || multiplier < 0 || multiplier > 1000) {
    return false;
  }
  _multiplier = multiplier;
  return true;
}

/**
 * Override the cache-read price ratio (inversion divisor). This is the single
 * gate for the `[0, 1)` invariant: `≥1` (divisor `1 - ratio` → 0 / negative)
 * and negatives are rejected, leaving the measured default in place. Returns
 * whether the override was applied so the env-layer caller can log the outcome
 * (structured, through its own logger) without re-encoding the bound. A
 * deliberate display/policy knob — see the `KIRO_CACHE_READ_RATIO` jsdoc for
 * the trade-offs (inflated cache_read, lowered claudeEquivalentCostUsd, ~87.7%
 * aggregate ceiling).
 */
export function initCacheReadRatio(ratio: number): boolean {
  if (!Number.isFinite(ratio) || ratio < 0 || ratio >= 1) {
    return false;
  }
  _cacheReadRatio = ratio;
  return true;
}

export function resetCreditDerive(): void {
  _multiplier = 1.0;
  _cacheReadRatio = KIRO_CACHE_READ_RATIO;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Collapse model-id variants to one price-table key — the single place that
 * defines the key space, so the exported API and the wire path canonicalize
 * identically. The priced model is the raw wire model the client sent (handlers
 * pass `payload.model` through), so it can be an alias (`claude-haiku-4-5`), a
 * dated snapshot (`claude-haiku-4-5-20251001`, advertised in models-catalog), a
 * dot-form id (`claude-opus-4.6`, if a client sends one), or a `-thinking`
 * variant. Normalize non-leading dots to dashes, strip `-thinking`, then strip a
 * trailing `-20YYMMDD` snapshot date — anchored to a `20xx` year so an arbitrary
 * 8-digit tail (e.g. `-12345678`) is NOT mistaken for a date — so all of them map
 * to the undated dash-form key. (Alias `-4-5`/`-5` tails aren't dates → kept.)
 */
function normalizeModelId(model: string): string {
  // Dot-form → dash-form: a client may send 'claude-opus-4.6' but the table is
  // keyed dash-form. (Kiro's own dot-form mapModel output never reaches here —
  // the plugin is fed the raw client `payload.model`, so this is a defensive
  // guard, not a coupling to mapModel.)
  const dashed = model.replace(/(?<=\w)\.(?=\w)/g, '-');
  const noThinking = dashed.endsWith('-thinking') ? dashed.slice(0, -'-thinking'.length) : dashed;
  return noThinking.replace(/-20\d{6}$/, '');
}

function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

/**
 * Apply the per-request upstream cost floor: `finalUsd` never falls below
 * `credits × KIRO_OVERAGE_RATE`. Setting `multiplier === 0` is treated as an
 * explicit free-tier bypass (no floor applied).
 */
function applyFloor(
  claudeUsd: number,
  credits: number,
): {
  finalUsd: number;
  floorApplied: boolean;
} {
  if (_multiplier === 0) {
    return { finalUsd: 0, floorApplied: false };
  }
  const algoUsd = claudeUsd * _multiplier;
  const floorUsd = credits * KIRO_OVERAGE_RATE;
  if (floorUsd > algoUsd) {
    return { finalUsd: floorUsd, floorApplied: true };
  }
  return { finalUsd: algoUsd, floorApplied: false };
}

function passthroughBreakdown(
  inputTokensTotal: number,
  outputTokens: number,
  credits: number,
  cp: ClaudePrice | undefined,
  status: DerivedStatus,
): DerivedUsageBreakdown {
  const claudeUsd = cp == null ? 0 : inputTokensTotal * cp.in + outputTokens * cp.out;
  const { finalUsd, floorApplied } = applyFloor(claudeUsd, credits);
  return {
    inputTokens: inputTokensTotal,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    derived: {
      inputTokensTotal,
      estimatedCacheHitRatio: 0,
      claudeEquivalentCostUsd: claudeUsd,
      finalCostUsd: finalUsd,
      costMultiplier: _multiplier,
      derivedStatus: status,
      floorApplied,
    },
  };
}

// ============================================================================
// Main reverse-engineering function
// ============================================================================

export function deriveKiroUsage(
  model: string,
  inputTokensTotal: number,
  outputTokens: number,
  credits: number,
): DerivedUsageBreakdown {
  const normalizedModel = normalizeModelId(model);
  const cp = CLAUDE_PRICE_USD_PER_TOK[normalizedModel];

  if (cp == null) {
    return passthroughBreakdown(
      inputTokensTotal,
      outputTokens,
      credits,
      undefined,
      'unknown_model',
    );
  }

  if (inputTokensTotal <= 0) {
    return passthroughBreakdown(0, outputTokens, credits, cp, 'below_threshold');
  }

  const threshold = MODEL_CACHE_THRESHOLD[normalizedModel] ?? 1024;
  if (inputTokensTotal < threshold) {
    return passthroughBreakdown(inputTokensTotal, outputTokens, credits, cp, 'below_threshold');
  }

  // Step 2: invert credits → effective uncached input
  const kiroUsd = credits * KIRO_OVERAGE_RATE;
  const kiroInputUsd = Math.max(0, kiroUsd - KIRO_K_OUT * cp.out * outputTokens);
  const tEffIn = kiroInputUsd / (KIRO_K_IN * cp.in);

  let cacheRead: number;
  if (tEffIn >= inputTokensTotal) {
    cacheRead = 0;
  } else {
    // Divisor uses the runtime-effective ratio (measured default unless the
    // KIRO2CLAUDE_CACHE_READ_RATIO knob overrides it). _cacheReadRatio is
    // constrained to [0, 1), so (1 - _cacheReadRatio) is always > 0.
    const raw = (inputTokensTotal - tEffIn) / (1 - _cacheReadRatio);
    // Round first, then clamp: clamping before rounding could let a fractional
    // cap round up past inputTokensTotal (harmless today — token counts are
    // integers — but this keeps cacheRead ≤ total unconditionally).
    cacheRead = clamp(Math.round(raw), 0, inputTokensTotal);
  }

  // Step 3: attribute the non-read remainder. Calibrated against real Claude
  // Code (claude -p + raw request capture): the non-read part
  // is written to cache (cache_creation) except a small fixed structural input
  // tail (CLAUDE_CODE_INPUT_TAIL_TOKENS ~10, model-independent, not user content).
  // Holds for both cold start (cacheRead=0) and steady state; no cache_hit_ratio
  // branch. estimatedCacheHitRatio is still reported (diagnostic), not used here.
  const cacheHitRatio = cacheRead / inputTokensTotal;
  const nonRead = inputTokensTotal - cacheRead;
  const uncached = Math.min(nonRead, CLAUDE_CODE_INPUT_TAIL_TOKENS);
  const cacheCreation = nonRead - uncached;

  // Step 4: cost — using Anthropic public price table, then floor against
  // upstream cost so finalCostUsd never falls below `credits × KIRO_OVERAGE_RATE`.
  const claudeUsd =
    uncached * cp.in +
    cacheCreation * cp.cacheCreation +
    cacheRead * cp.cacheRead +
    outputTokens * cp.out;
  const { finalUsd, floorApplied } = applyFloor(claudeUsd, credits);

  return {
    inputTokens: uncached,
    cacheCreationInputTokens: cacheCreation,
    cacheReadInputTokens: cacheRead,
    derived: {
      inputTokensTotal,
      estimatedCacheHitRatio: cacheHitRatio,
      claudeEquivalentCostUsd: claudeUsd,
      finalCostUsd: finalUsd,
      costMultiplier: _multiplier,
      derivedStatus: 'ok_derived',
      floorApplied,
    },
  };
}
