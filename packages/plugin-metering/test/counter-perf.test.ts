/**
 * Performance and concurrency correctness benchmarks for MeteringCounter.
 *
 * These tests answer two questions:
 *   1. How fast is recordUsage() — is Decimal.js overhead acceptable?
 *   2. Under simulated concurrent requests, does the counter stay accurate?
 */
import { describe, expect, it } from 'vitest';
import { MeteringCounter } from '../src/counter.js';

// ============================================================================
// Performance benchmarks
// ============================================================================

describe('performance', () => {
  it('recordUsage single call latency', () => {
    const counter = new MeteringCounter(10000, 5000);

    // Warm up JIT
    for (let i = 0; i < 1000; i++) {
      counter.recordUsage(0.0048);
    }

    // Measure
    const iterations = 100_000;
    const warmCounter = new MeteringCounter(10000, 5000);
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      warmCounter.recordUsage(0.0048);
    }
    const elapsed = performance.now() - start;

    const perCallUs = (elapsed / iterations) * 1000; // microseconds
    const opsPerSec = Math.floor(iterations / (elapsed / 1000));

    console.log(
      `recordUsage: ${perCallUs.toFixed(2)} µs/call, ${opsPerSec.toLocaleString()} ops/sec`,
    );

    // Assert: each call should be well under 100µs (typical HTTP request is ~ms)
    expect(perCallUs).toBeLessThan(100);
  });

  it('memory overhead per Decimal is acceptable', () => {
    // Decimal.js objects are lightweight — verify counter doesn't leak memory
    const before = process.memoryUsage().heapUsed;
    const counter = new MeteringCounter(10000, 0);
    for (let i = 0; i < 10_000; i++) {
      counter.recordUsage(0.0048);
    }
    // Force GC if available, otherwise just measure
    if (global.gc) global.gc();
    const after = process.memoryUsage().heapUsed;

    const deltaKB = (after - before) / 1024;
    console.log(`memory delta after 10k calls: ${deltaKB.toFixed(0)} KB`);

    // Counter itself stores only _accumulated (Decimal) + _limit (number).
    // Each recordUsage creates temporaries that get GC'd.
    // 10K calls should not accumulate >10MB of retained memory.
    expect(deltaKB).toBeLessThan(10_000);
  });
});

// ============================================================================
// Concurrency correctness (simulated with interleaved async)
// ============================================================================

describe('concurrency correctness', () => {
  it('concurrent async requests produce exact accumulated total', async () => {
    const counter = new MeteringCounter(100000, 0);
    const requestCount = 500;
    const usagePerRequest = 1.5;

    // Simulate N concurrent requests: each does some async work, then
    // calls recordUsage synchronously. The key question is whether
    // interleaving at await points corrupts the counter.
    const results = await Promise.all(
      Array.from({ length: requestCount }, async () => {
        // Simulate variable async latency (like different response times)
        await new Promise((r) => setTimeout(r, Math.random() * 10));
        return counter.recordUsage(usagePerRequest);
      }),
    );

    // Every result should have a unique accumulated value (strictly increasing)
    const accumulatedValues = results.map((r) => r.accumulated);
    const uniqueValues = new Set(accumulatedValues);
    expect(uniqueValues.size).toBe(requestCount);

    // Final accumulated should be exact: 500 × 1.5 = 750.0
    expect(counter.accumulated).toBe(requestCount * usagePerRequest);
  });
});
