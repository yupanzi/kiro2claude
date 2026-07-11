import type {
  InputTokensSource,
  PluginLogger,
  StandardUsageField,
  UsageFinishEvent,
  UsageFinishSource,
} from '@kiro2claude/plugin-api';

/**
 * Concrete UsageFinishEvent. Mutable from inside the host's hook bus —
 * plugins only see the readonly UsageFinishEvent surface.
 */
export class UsageFinishEventImpl implements UsageFinishEvent {
  readonly model: string;
  readonly source: UsageFinishSource;
  readonly inputTokensSource: InputTokensSource;

  // Hot path: getMeta is a point lookup; storing as a plain object skips the
  // Map allocation + Object.entries tuple array we'd pay every request.
  readonly #meta: Record<string, unknown>;
  readonly #extensions = new Map<string, unknown>();
  // Value map is the hot read; origin map is only consulted on the duplicate
  // warn path so we don't rebuild a Map<field, number> view per getOverrides() call.
  readonly #overrides = new Map<StandardUsageField, number>();
  readonly #overrideOrigins = new Map<StandardUsageField, { plugin: string; reason: string }>();
  readonly #logger: PluginLogger;

  /** Track which plugin is currently registering writes (set by hook bus). */
  #activePlugin = 'unknown';

  constructor(args: {
    model: string;
    source: UsageFinishSource;
    inputTokensSource: InputTokensSource;
    meta: Record<string, unknown>;
    logger: PluginLogger;
  }) {
    this.model = args.model;
    this.source = args.source;
    this.inputTokensSource = args.inputTokensSource;
    this.#meta = args.meta;
    this.#logger = args.logger;
  }

  /** Hook bus calls this before invoking each plugin's handler. */
  _setActivePlugin(name: string): void {
    this.#activePlugin = name;
  }

  getMeta<T = unknown>(key: string): T | undefined {
    return this.#meta[key] as T | undefined;
  }

  listMetaKeys(): readonly string[] {
    return Object.keys(this.#meta);
  }

  addExtension(namespace: string, value: unknown): void {
    if (typeof namespace !== 'string' || namespace.length === 0) {
      throw new Error('addExtension: namespace must be a non-empty string');
    }
    this.#extensions.set(namespace, value);
  }

  overrideStandardField(name: StandardUsageField, value: number, reason: string): void {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`overrideStandardField: value for ${name} must be a finite number`);
    }
    const priorOrigin = this.#overrideOrigins.get(name);
    if (priorOrigin) {
      this.#logger.warn(
        {
          field: name,
          firstPlugin: priorOrigin.plugin,
          firstReason: priorOrigin.reason,
          firstValue: this.#overrides.get(name),
          secondPlugin: this.#activePlugin,
          secondReason: reason,
          secondValue: value,
        },
        'multiple plugins overrode the same standard usage field',
      );
    }
    this.#overrides.set(name, value);
    this.#overrideOrigins.set(name, { plugin: this.#activePlugin, reason });
  }

  // ───────────────────────────────────────────────────────────────────────
  // Host-side readout (not part of contract — used by stream/non-stream)
  // ───────────────────────────────────────────────────────────────────────

  /** Returns the namespaced extensions added by plugins. */
  getExtensions(): ReadonlyMap<string, unknown> {
    return this.#extensions;
  }

  /** Returns plugin overrides for standard Anthropic fields. */
  getOverrides(): ReadonlyMap<StandardUsageField, number> {
    return this.#overrides;
  }
}
