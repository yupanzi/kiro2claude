/**
 * In-memory credit meter.
 *
 * Tracks cumulative Kiro credit usage across requests. The counter is
 * initialized by `index.ts` at register time (default-on; skipped when
 * `KIRO2CLAUDE_METERING_DISABLE=true` or no upstream quota). Until then the
 * module is inert and all public functions return `undefined`.
 *
 * This plugin only *measures* credits — it does not price them. USD cost
 * derivation is a separate pricing plugin's job (it reads the same
 * `kiro.creditsUsed` host meta independently); keeping the two decoupled means
 * pricing changes never touch this counter.
 *
 * ## Single-instance only
 *
 * The accumulated counter lives in process memory. Multiple replicas
 * or a process restart will lose state and re-sync from the upstream
 * `getUsageLimits()` snapshot at next startup. Do **not** deploy with
 * multiple pods if you rely on accurate cumulative tracking.
 *
 * ## Concurrency safety
 *
 * `recordUsage()` is fully synchronous (no `await`). In Node.js's
 * single-threaded event loop, a synchronous function runs to completion
 * without interleaving — so the read-add-write cycle on `_accumulated`
 * is atomic with respect to concurrent requests.
 */

import { Decimal } from 'decimal.js';

// ============================================================================
// Types
// ============================================================================

/** Per-request meter readout; rides inside the `usage.kiro_metering` object. */
export interface MeteringResult {
  /** Cumulative usage after this request (credits). */
  accumulated: number;
  /** Plan usage limit (credits). */
  limit: number;
}

// ============================================================================
// MeteringCounter class
// ============================================================================

/**
 * Stateful credit counter with Decimal.js precision.
 *
 * Exported for direct instantiation in unit tests. Production code
 * should use the module-level singleton via `initMeteringCounter` /
 * `recordMeteringUsage`.
 */
export class MeteringCounter {
  private _accumulated: Decimal;
  private readonly _limit: number;

  constructor(usageLimit: number, initialUsage: number) {
    this._limit = usageLimit;
    this._accumulated = new Decimal(initialUsage);
  }

  /**
   * Record a usage event and return the running meter readout.
   *
   * Fully synchronous — safe under concurrent requests. `_accumulated` uses
   * Decimal arithmetic so summing many fractional credits stays exact.
   */
  recordUsage(usage: number): MeteringResult {
    this._accumulated = this._accumulated.plus(new Decimal(usage));

    return {
      accumulated: this._accumulated.toNumber(),
      limit: this._limit,
    };
  }

  /** Current accumulated usage (for logging / diagnostics). */
  get accumulated(): number {
    return this._accumulated.toNumber();
  }

  /** Plan usage limit (for logging / diagnostics). */
  get limit(): number {
    return this._limit;
  }
}

// ============================================================================
// Module-level singleton
// ============================================================================

let counter: MeteringCounter | undefined;

/**
 * Initialize the global metering counter. Called once at startup from
 * `index.ts` (default-on, unless `KIRO2CLAUDE_METERING_DISABLE=true`).
 */
export function initMeteringCounter(usageLimit: number, initialUsage: number): void {
  counter = new MeteringCounter(usageLimit, initialUsage);
}

/**
 * Record a metering event and return the running meter readout.
 *
 * Returns `undefined` when the counter is not initialized (feature
 * disabled), so callers can use a simple truthy check to decide
 * whether to attach `kiro_metering`.
 */
export function recordMeteringUsage(usage: number): MeteringResult | undefined {
  return counter?.recordUsage(usage);
}

/**
 * Reset the singleton. **Test-only** — allows test isolation without
 * leaking state between test cases.
 */
export function resetMeteringCounter(): void {
  counter = undefined;
}
