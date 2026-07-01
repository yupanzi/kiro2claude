import type {
  PluginContext,
  UsageFinishEvent,
  UsageFinishHook,
  UsageLimitsProvider,
} from '@kiro2claude/plugin-api';
import { afterEach, describe, expect, it } from 'vitest';
import { resetMeteringCounter } from '../src/counter.js';
import meteringPlugin from '../src/index.js';

afterEach(() => {
  resetMeteringCounter();
});

// ────────────────────────────────────────────────────────────────────────────
// Test harness — minimal fakes for PluginContext + UsageFinishEvent
// ────────────────────────────────────────────────────────────────────────────

const noopLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

function makeCtx(opts: {
  env?: NodeJS.ProcessEnv;
  snapshot?: { limit: number; current: number };
}): { ctx: PluginContext; getHook: () => UsageFinishHook | undefined } {
  let hook: UsageFinishHook | undefined;
  const usageLimits: UsageLimitsProvider = {
    getUsageLimits: async () => opts.snapshot ?? { limit: 10000, current: 0 },
  };
  const ctx = {
    app: {} as unknown,
    logger: noopLogger,
    env: opts.env ?? {},
    apiKey: 'test',
    registerHook: {
      onUsageFinish: (h: UsageFinishHook) => {
        hook = h;
      },
    },
    getCapability: <T>(name: string): T | undefined =>
      name === 'usage-limits' ? (usageLimits as unknown as T) : undefined,
  } as unknown as PluginContext;
  return { ctx, getHook: () => hook };
}

/** Fake usage-finish event: credits in via meta, extensions captured out. */
function makeEvent(credits: number): {
  event: UsageFinishEvent;
  extensions: Map<string, unknown>;
} {
  const extensions = new Map<string, unknown>();
  const event = {
    model: 'claude-opus-4-8',
    source: 'http-direct',
    inputTokensSource: 'upstream-reported',
    getMeta: <T>(key: string): T | undefined =>
      key === 'kiro.creditsUsed' ? (credits as unknown as T) : undefined,
    addExtension: (namespace: string, value: unknown) => {
      extensions.set(namespace, value);
    },
    overrideStandardField: () => {},
  } as unknown as UsageFinishEvent;
  return { event, extensions };
}

// ────────────────────────────────────────────────────────────────────────────
// Wire contract: usage.kiro_metering superset
// ────────────────────────────────────────────────────────────────────────────

describe('plugin-metering wire injection', () => {
  it('injects usage.kiro_metering with unit + per-request usage + accumulated/limit (no USD)', async () => {
    const { ctx, getHook } = makeCtx({ snapshot: { limit: 10000, current: 0 } });
    await meteringPlugin.register(ctx);
    const hook = getHook();
    expect(hook).toBeDefined();

    const { event, extensions } = makeEvent(3.5);
    await hook!(event);

    const m = extensions.get('kiro_metering') as Record<string, unknown>;
    expect(m).toBeDefined();
    expect(m.unit).toBe('credit');
    expect(m.unitPlural).toBe('credits');
    // CRITICAL invariant: usage is THIS request's credits, never accumulated.
    expect(m.usage).toBe(3.5);
    expect(m.accumulated).toBe(3.5);
    expect(m.limit).toBe(10000);
    // Exactly the 5-field credit readout — pricing lives in a separate plugin.
    expect(Object.keys(m).sort()).toEqual(
      ['accumulated', 'limit', 'unit', 'unitPlural', 'usage'].sort(),
    );
    for (const gone of [
      'cost',
      'inPlanCost',
      'overageCost',
      'inPlanRate',
      'overageRate',
      'inPlan',
    ]) {
      expect(gone in m).toBe(false);
    }
    // No legacy field name.
    expect(extensions.has('kiro_cost')).toBe(false);
  });

  it('keeps usage per-request across calls while accumulated grows', async () => {
    const { ctx, getHook } = makeCtx({ snapshot: { limit: 10000, current: 0 } });
    await meteringPlugin.register(ctx);
    const hook = getHook()!;

    const first = makeEvent(3.5);
    await hook(first.event);
    const second = makeEvent(2);
    await hook(second.event);

    const m1 = first.extensions.get('kiro_metering') as Record<string, unknown>;
    const m2 = second.extensions.get('kiro_metering') as Record<string, unknown>;
    // Per-request usage stays the input credits, NOT the cumulative.
    expect(m1.usage).toBe(3.5);
    expect(m2.usage).toBe(2);
    // Accumulated reflects the running total.
    expect(m1.accumulated).toBe(3.5);
    expect(m2.accumulated).toBe(5.5);
  });

  it('does not inject when credits meta is absent', async () => {
    const { ctx, getHook } = makeCtx({ snapshot: { limit: 10000, current: 0 } });
    await meteringPlugin.register(ctx);
    const hook = getHook()!;

    const extensions = new Map<string, unknown>();
    const event = {
      model: 'claude-opus-4-8',
      source: 'http-direct',
      inputTokensSource: 'upstream-reported',
      getMeta: () => undefined,
      addExtension: (ns: string, v: unknown) => extensions.set(ns, v),
      overrideStandardField: () => {},
    } as unknown as UsageFinishEvent;
    await hook(event);

    expect(extensions.has('kiro_metering')).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Default-enable + opt-out
// ────────────────────────────────────────────────────────────────────────────

describe('plugin-metering enablement', () => {
  it('is enabled by default (no env required)', async () => {
    const { ctx, getHook } = makeCtx({ env: {} });
    await meteringPlugin.register(ctx);
    expect(getHook()).toBeDefined();
  });

  it('goes idle when KIRO2CLAUDE_METERING_DISABLE=true', async () => {
    const { ctx, getHook } = makeCtx({ env: { KIRO2CLAUDE_METERING_DISABLE: 'true' } });
    await meteringPlugin.register(ctx);
    expect(getHook()).toBeUndefined();
  });

  it('goes idle when usage-limits capability is absent', async () => {
    let hook: UsageFinishHook | undefined;
    const ctx = {
      app: {} as unknown,
      logger: noopLogger,
      env: {},
      apiKey: 'test',
      registerHook: { onUsageFinish: (h: UsageFinishHook) => (hook = h) },
      getCapability: () => undefined,
    } as unknown as PluginContext;
    await meteringPlugin.register(ctx);
    expect(hook).toBeUndefined();
  });
});
