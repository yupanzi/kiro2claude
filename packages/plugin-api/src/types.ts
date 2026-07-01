/**
 * @kiro2claude/plugin-api — Plugin contract types.
 *
 * Zero-runtime. Only types + an abstract base class. Plugin authors depend on
 * this package; the host (@kiro2claude/core) ships the implementation.
 *
 * Stability: BREAKING changes to exported types are major bumps. Add new
 * optional fields freely (minor bump). Renaming or removing exported names
 * cascades to every third-party plugin — gate hard.
 */

import type { FastifyInstance } from 'fastify';

// ─────────────────────────────────────────────────────────────────────────────
// Plugin manifest
// ─────────────────────────────────────────────────────────────────────────────

export interface KiroPlugin {
  /** Stable identifier; used in dependsOn graph and logs. Lowercase-kebab. */
  readonly name: string;
  /** SemVer of this plugin. */
  readonly version: string;
  /** Contract version this plugin targets. Loader refuses incompatible majors. */
  readonly apiVersion: '1.x';
  /** Names of other plugins that must register first. Loader topo-sorts. */
  readonly dependsOn?: readonly string[];
  /** Called once during host startup after capabilities are ready. */
  register(ctx: PluginContext): Promise<void> | void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Host-provided context (read-only from the plugin's view)
// ─────────────────────────────────────────────────────────────────────────────

export interface PluginContext {
  /** Fastify instance. Plugins may register routes/hooks against it. */
  readonly app: FastifyInstance;
  /** Minimal logger surface (does not leak pino types). */
  readonly logger: PluginLogger;
  /** Environment variables. Plugins read their own KIRO2CLAUDE_* keys. */
  readonly env: NodeJS.ProcessEnv;
  /** Auth API key the host expects on incoming requests. */
  readonly apiKey: string;
  /** Register usage-finish / lifecycle hooks. */
  readonly registerHook: HookRegistrar;
  /**
   * Look up host-provided capabilities by name. Returns undefined if the
   * capability is not registered. Use this instead of importing concrete
   * host types — keeps the contract upstream-agnostic.
   *
   * Well-known names registered by @kiro2claude/core:
   *   'usage-limits' → UsageLimitsProvider
   */
  getCapability<T = unknown>(name: string): T | undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Logger contract (minimal subset of pino)
// ─────────────────────────────────────────────────────────────────────────────

export interface PluginLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
  debug?(obj: object, msg?: string): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hook registry
// ─────────────────────────────────────────────────────────────────────────────

export interface HookRegistrar {
  /**
   * Called once per upstream response finalization, before the host writes
   * the SSE / non-stream payload. Plugins may read upstream meta and inject
   * additional usage fields or override standard ones.
   */
  onUsageFinish(handler: UsageFinishHook): void;
}

export type UsageFinishHook = (event: UsageFinishEvent) => void | Promise<void>;

// ─────────────────────────────────────────────────────────────────────────────
// Upstream capabilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Capability name 'usage-limits' — exposes upstream quota snapshot.
 * Host's SingleTokenManager implements this internally; plugins consume it
 * via ctx.getCapability<UsageLimitsProvider>('usage-limits').
 */
export interface UsageLimitsProvider {
  getUsageLimits(): Promise<UsageSnapshot>;
}

export interface UsageSnapshot {
  /** Total quota for the current billing window (credits). */
  readonly limit: number;
  /** Credits already consumed within the window. */
  readonly current: number;
  /** Window reset timestamp (ms since epoch). undefined if unknown. */
  readonly resetAt?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Usage finish event
// ─────────────────────────────────────────────────────────────────────────────

/** Standard Anthropic-protocol usage fields a plugin may override. */
export type StandardUsageField =
  | 'input_tokens'
  | 'output_tokens'
  | 'cache_creation_input_tokens'
  | 'cache_read_input_tokens';

/**
 * Gateway path that produced this finalization. Deliberately a single-member
 * union today ('http-direct' is the only path) — kept as a reserved extension
 * seam so a future alternate transport can be added as a non-breaking minor
 * bump. Do not delete just because it currently has one member.
 */
export type UsageFinishSource = 'http-direct';

/**
 * Indicates how reliable inputTokens is for downstream computation.
 *
 * - 'client-estimate':   tokenizer estimate on the client request body.
 * - 'upstream-reported': upstream returned an authoritative count.
 */
export type InputTokensSource = 'client-estimate' | 'upstream-reported';

export interface UsageFinishEvent {
  /** Model identifier as advertised to the downstream SDK. */
  readonly model: string;
  /** Gateway path that produced this finalization (currently always 'http-direct'). */
  readonly source: UsageFinishSource;
  /** Reliability label for the inputTokens reading. */
  readonly inputTokensSource: InputTokensSource;

  /**
   * Read host-provided upstream metadata. Keys follow the 'kiro.*' namespace
   * for kiro-specific data. Plugins should treat all values as untrusted
   * and validate types.
   *
   * Well-known keys:
   *   'kiro.inputTokens'        number
   *   'kiro.outputTokens'       number
   *   'kiro.cacheReadTokens'    number
   *   'kiro.cacheCreationTokens' number
   *   'kiro.creditsUsed'        number
   *   'kiro.pricedModel'        string
   */
  getMeta<T = unknown>(key: string): T | undefined;
  /** All meta keys currently populated. For debugging / compatibility checks. */
  listMetaKeys(): readonly string[];

  /**
   * Add a namespaced extension field to the wire payload's `usage` object.
   * Multiple calls to the same namespace overwrite (last writer wins),
   * so plugins should claim their own namespace (e.g. `kiro_usage`,
   * `kiro_derived`, or vendor-prefixed for third parties).
   */
  addExtension(namespace: string, value: unknown): void;

  /**
   * Override one of Anthropic's standard usage fields. Reason is logged
   * for traceability. If two plugins override the same field within a
   * single finalization, the host emits a `warn` log identifying both.
   */
  overrideStandardField(name: StandardUsageField, value: number, reason: string): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Convenience base class
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimal base class for plugins that prefer not to spell out the readonly
 * fields. Subclasses still need to implement `register`.
 */
export abstract class BasePlugin implements KiroPlugin {
  abstract readonly name: string;
  abstract readonly version: string;
  readonly apiVersion = '1.x' as const;
  readonly dependsOn?: readonly string[];
  abstract register(ctx: PluginContext): Promise<void> | void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Runtime guards (used by host's loader, exported so plugin tests can reuse)
// ─────────────────────────────────────────────────────────────────────────────

export function isValidPlugin(value: unknown): value is KiroPlugin {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Partial<KiroPlugin>;
  return (
    typeof v.name === 'string' &&
    v.name.length > 0 &&
    typeof v.version === 'string' &&
    typeof v.apiVersion === 'string' &&
    typeof v.register === 'function' &&
    // dependsOn (optional) must be a string[]; a malformed non-array (e.g. a
    // hand-written manifest with dependsOn: 'foo') would otherwise be iterated
    // character-by-character by the loader's topoSort, silently mis-ordering
    // load instead of being rejected here at discovery time.
    (v.dependsOn === undefined ||
      (Array.isArray(v.dependsOn) && v.dependsOn.every((d) => typeof d === 'string')))
  );
}

/**
 * Throws if the plugin's apiVersion is not '1.x'. Host's loader calls this
 * before invoking register().
 */
export function assertApiVersion(plugin: KiroPlugin): void {
  if (plugin.apiVersion !== '1.x') {
    throw new Error(
      `plugin "${plugin.name}" declares apiVersion "${String(plugin.apiVersion)}" ` +
        `which is incompatible with host's '1.x'`,
    );
  }
}
