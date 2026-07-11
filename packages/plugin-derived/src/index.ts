import { BasePlugin, type PluginContext, parseEnvBool } from '@kiro2claude/plugin-api';
import {
  type DerivedUsageBreakdown,
  deriveKiroUsage,
  initCacheReadRatio,
  initCreditDerive,
} from './derive.js';

/**
 * Parse an env var as a number, treating unset / empty / whitespace-only as
 * "not set" (returns `undefined`). A non-numeric value yields `NaN` so the
 * caller's range gate (`initCreditDerive` / `initCacheReadRatio`) rejects it.
 * Guards the classic `Number("  ") === 0` coercion that would otherwise turn a
 * stray-space env (e.g. `docker -e KIRO2CLAUDE_...=" "`) into a silent 0 —
 * a free-tier multiplier or a ratio-0 (divisor 1) that over-bills.
 */
function parseEnvNumber(raw: string | undefined): number | undefined {
  if (raw == null) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : Number(trimmed);
}

/**
 * @kiro2claude/plugin-derived — derive standard Anthropic usage shape
 * from Kiro credit metering. Plugin name (`derived`) matches the wire field it
 * injects (`usage.kiro_derived`).
 *
 * Wire injection modes (controlled by KIRO2CLAUDE_DERIVED_INCLUDE_FIELD):
 *   - default (or 'false'): override input_tokens / cache_creation_input_tokens /
 *     cache_read_input_tokens with derived values so downstream SDKs can
 *     compute cost via Anthropic standard pricing.
 *   - 'true': leave standard fields alone, add `kiro_derived` extension
 *     containing the full breakdown for diagnostic / markup deployments.
 *
 * Independent of the `metering` plugin: derivation reads the host's
 * `kiro.creditsUsed` meta key (always present), not metering's wire output, so
 * load order relative to metering does not matter and no dependsOn is declared.
 */
class DerivedPlugin extends BasePlugin {
  readonly name = 'derived';
  readonly version = '1.2.0';

  async register(ctx: PluginContext): Promise<void> {
    // Both knobs delegate their range gate to the derive.ts setters (which
    // return whether the value was applied); index owns only env parsing +
    // logging. parseEnvNumber treats unset/blank/whitespace as "not set", so a
    // stray space can't coerce to 0. `multiplier` tracks the EFFECTIVE value so
    // the registration log below never reports a rejected input.
    const requestedMultiplier = parseEnvNumber(ctx.env.KIRO2CLAUDE_COST_MULTIPLIER) ?? 1;
    let multiplier = requestedMultiplier;
    if (!initCreditDerive(requestedMultiplier)) {
      ctx.logger.warn(
        { multiplier: ctx.env.KIRO2CLAUDE_COST_MULTIPLIER },
        'plugin-derived: KIRO2CLAUDE_COST_MULTIPLIER out of range [0,1000], falling back to 1.0',
      );
      initCreditDerive(1);
      multiplier = 1;
    }

    // Optional cache-read ratio override (display/policy knob). Unset/blank =
    // keep the measured default (faithful inversion). initCacheReadRatio owns
    // the [0, 1) gate (≥1 would zero/negate the inversion divisor).
    const ratio = parseEnvNumber(ctx.env.KIRO2CLAUDE_CACHE_READ_RATIO);
    if (ratio !== undefined) {
      if (initCacheReadRatio(ratio)) {
        ctx.logger.info(
          { cacheReadRatio: ratio },
          'plugin-derived: cache-read ratio overridden — wire cache_read split diverges from measured inversion',
        );
      } else {
        ctx.logger.warn(
          { cacheReadRatio: ctx.env.KIRO2CLAUDE_CACHE_READ_RATIO },
          'plugin-derived: KIRO2CLAUDE_CACHE_READ_RATIO out of range [0,1), keeping measured default',
        );
      }
    }

    const includeField = parseEnvBool(ctx.env.KIRO2CLAUDE_DERIVED_INCLUDE_FIELD);

    ctx.registerHook.onUsageFinish((event) => {
      const credits = event.getMeta<number>('kiro.creditsUsed');
      // 用 == null 而非 !credits:credits===0 是合法值(早断不计费 / 全缓存命中),
      // 应被推导成零成本形态(deriveKiroUsage 对 0 会把输入归为 cache_read),而非
      // 被当"无数据"跳过、把标准字段留在 raw client-estimate 上导致下游过计。
      // 与 metering 插件对同一 meta key 的 == null 判断保持一致。
      if (credits == null) return;
      const inputTokens = event.getMeta<number>('kiro.inputTokens') ?? 0;
      const outputTokens = event.getMeta<number>('kiro.outputTokens') ?? 0;
      // Raw wire model; deriveKiroUsage → normalizeModelId owns all model-id
      // canonicalization (dot→dash, -thinking, -YYYYMMDD) to the price-table key.
      const model = event.getMeta<string>('kiro.pricedModel') ?? event.model;

      let breakdown: DerivedUsageBreakdown;
      try {
        breakdown = deriveKiroUsage(model, inputTokens, outputTokens, credits);
      } catch (err) {
        ctx.logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'plugin-derived: derive failed, leaving standard fields untouched',
        );
        return;
      }

      if (includeField) {
        // Diagnostic mode: leave standard fields, expose breakdown as extension.
        event.addExtension('kiro_derived', breakdown.derived);
      } else {
        // Production mode: override standard Anthropic fields so downstream
        // SDKs see derived cache shape.
        event.overrideStandardField(
          'input_tokens',
          breakdown.inputTokens,
          'credit-derive: reverse-engineered from kiro credits',
        );
        event.overrideStandardField(
          'cache_creation_input_tokens',
          breakdown.cacheCreationInputTokens,
          'credit-derive: reverse-engineered from kiro credits',
        );
        event.overrideStandardField(
          'cache_read_input_tokens',
          breakdown.cacheReadInputTokens,
          'credit-derive: reverse-engineered from kiro credits',
        );
      }
    });

    ctx.logger.info({ multiplier, includeField }, 'plugin-derived: registered usage-finish hook');
  }
}

export default new DerivedPlugin();
