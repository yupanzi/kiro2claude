import {
  BasePlugin,
  type PluginContext,
  parseEnvBool,
  type UsageLimitsProvider,
} from '@kiro2claude/plugin-api';
import { initMeteringCounter, type MeteringResult, recordMeteringUsage } from './counter.js';

/**
 * @kiro2claude/plugin-metering — in-memory cumulative credit meter (free tier).
 *
 * Reads the upstream quota snapshot once at register time via the
 * `'usage-limits'` capability, then accumulates per-request credit usage
 * via the usage-finish hook bus.
 *
 * Wire injection: adds a `kiro_metering` extension to the response's `usage`
 * object on every finalization. The field name matches the plugin name and is
 * the contract downstream consumers read (`usage.kiro_metering`). It reports
 * credit *measurement* only — USD pricing is a separate pricing plugin's
 * job (`usage.kiro_derived`).
 *
 * Enabled by default (the plugin activates simply by being discovered). Set
 * `KIRO2CLAUDE_METERING_DISABLE=true` to opt out.
 *
 * Single-instance only — accumulated state lives in process memory.
 */
class MeteringPlugin extends BasePlugin {
  readonly name = 'metering';
  readonly version = '1.0.0';

  async register(ctx: PluginContext): Promise<void> {
    if (parseEnvBool(ctx.env.KIRO2CLAUDE_METERING_DISABLE)) {
      ctx.logger.info({}, 'plugin-metering: KIRO2CLAUDE_METERING_DISABLE set, plugin idle');
      return;
    }

    const provider = ctx.getCapability<UsageLimitsProvider>('usage-limits');
    if (!provider) {
      ctx.logger.warn(
        {},
        'plugin-metering: capability "usage-limits" not registered by host, plugin idle',
      );
      return;
    }

    try {
      const snapshot = await provider.getUsageLimits();
      if (!snapshot.limit) {
        ctx.logger.warn(
          { snapshot },
          'plugin-metering: usage-limits returned zero limit, plugin idle',
        );
        return;
      }
      initMeteringCounter(snapshot.limit, snapshot.current);
      ctx.logger.info(
        { usage_limit: snapshot.limit, current_usage: snapshot.current },
        'plugin-metering: counter initialized',
      );
    } catch (err) {
      ctx.logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'plugin-metering: failed to bootstrap counter from upstream — plugin idle',
      );
      return;
    }

    ctx.registerHook.onUsageFinish((event) => {
      const credits = event.getMeta<number>('kiro.creditsUsed');
      if (credits == null) return;
      const result: MeteringResult | undefined = recordMeteringUsage(credits);
      if (!result) return;
      // `usage.kiro_metering` is the per-request credit readout:
      //   {unit, usage}        — THIS request's credit count (the core contract)
      //   {accumulated, limit} — running total vs plan quota
      // Explicit fields come AFTER `...result` so the per-request `usage`
      // (≠ the cumulative `accumulated`) invariant survives future result
      // shape changes.
      event.addExtension('kiro_metering', {
        ...result,
        unit: 'credit',
        unitPlural: 'credits',
        usage: credits,
      });
    });

    ctx.logger.info({}, 'plugin-metering: registered usage-finish hook');
  }
}

export default new MeteringPlugin();
