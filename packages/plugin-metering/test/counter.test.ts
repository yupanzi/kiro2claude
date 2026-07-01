import { afterEach, describe, expect, it } from 'vitest';
import {
  initMeteringCounter,
  MeteringCounter,
  recordMeteringUsage,
  resetMeteringCounter,
} from '../src/counter.js';

afterEach(() => {
  resetMeteringCounter();
});

// ============================================================================
// MeteringCounter class — direct instantiation
// ============================================================================

describe('MeteringCounter', () => {
  it('accumulates a single request and reports the plan limit', () => {
    const counter = new MeteringCounter(10000, 0);
    const result = counter.recordUsage(5);

    expect(result.accumulated).toBe(5);
    expect(result.limit).toBe(10000);
  });

  it('keeps accumulating from a non-zero initial usage', () => {
    const counter = new MeteringCounter(10000, 9998);
    const result = counter.recordUsage(5);

    expect(result.accumulated).toBe(10003);
    expect(result.limit).toBe(10000);
  });

  it('accumulates past the plan limit without clamping', () => {
    const counter = new MeteringCounter(100, 150);
    const result = counter.recordUsage(5);

    // limit is reported as-is; the counter never caps the running total.
    expect(result.accumulated).toBe(155);
    expect(result.limit).toBe(100);
  });

  it('handles zero usage', () => {
    const counter = new MeteringCounter(10000, 5000);
    const result = counter.recordUsage(0);

    expect(result.accumulated).toBe(5000);
    expect(result.limit).toBe(10000);
  });

  it('handles fractional usage with precision', () => {
    const counter = new MeteringCounter(10000, 0);
    const result = counter.recordUsage(0.0048);

    expect(result.accumulated).toBe(0.0048);
  });

  it('accumulates across sequential requests', () => {
    const counter = new MeteringCounter(100, 95);

    expect(counter.recordUsage(3).accumulated).toBe(98);
    expect(counter.recordUsage(4).accumulated).toBe(102);
    expect(counter.recordUsage(1).accumulated).toBe(103);
  });

  it('avoids floating-point drift over many small requests', () => {
    const counter = new MeteringCounter(10000, 0);

    // Simulate 1000 requests of 0.001 each
    for (let i = 0; i < 1000; i++) {
      counter.recordUsage(0.001);
    }

    // Pure JS: 0.001 added 1000 times ≠ 1.0 due to IEEE 754
    // Decimal.js should give us exactly 1.0
    expect(counter.accumulated).toBe(1);
  });

  it('exposes accumulated and limit getters', () => {
    const counter = new MeteringCounter(10000, 5469.38);
    expect(counter.accumulated).toBe(5469.38);
    expect(counter.limit).toBe(10000);
  });
});

// ============================================================================
// Module-level singleton functions
// ============================================================================

describe('singleton functions', () => {
  it('recordMeteringUsage returns undefined when counter is not initialized', () => {
    expect(recordMeteringUsage(5)).toBeUndefined();
  });

  it('initMeteringCounter + recordMeteringUsage works end-to-end', () => {
    initMeteringCounter(10000, 9999);
    const result = recordMeteringUsage(2);

    expect(result).toBeDefined();
    expect(result!.accumulated).toBe(10001);
    expect(result!.limit).toBe(10000);
  });

  it('resetMeteringCounter clears the singleton', () => {
    initMeteringCounter(100, 0);
    expect(recordMeteringUsage(1)).toBeDefined();

    resetMeteringCounter();
    expect(recordMeteringUsage(1)).toBeUndefined();
  });
});
