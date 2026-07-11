import { BasePlugin, type PluginContext } from '@kiro2claude/plugin-api';

/**
 * @kiro2claude/echo-plugin — the smallest possible KiroPlugin.
 *
 * Demonstrates:
 *   1. KiroPlugin manifest (name / version / apiVersion via BasePlugin)
 *   2. Route registration on the host Fastify instance
 *   3. usage-finish hook → addExtension(...)
 *
 * Usage: drop this package into the same workspace as @kiro2claude/core —
 * the loader auto-discovers it via the 'kiro2claude-plugin' keyword in this
 * package.json. (Not published to npm.)
 */
class EchoPlugin extends BasePlugin {
  readonly name = 'echo';
  readonly version = '0.1.0';

  register(ctx: PluginContext): void {
    ctx.app.get('/echo', async () => ({
      ok: true,
      plugin: this.name,
      version: this.version,
      timestamp: Date.now(),
    }));

    ctx.registerHook.onUsageFinish((event) => {
      event.addExtension('echo', {
        model: event.model,
        source: event.source,
        inputTokensSource: event.inputTokensSource,
        availableMetaKeys: event.listMetaKeys(),
      });
    });

    ctx.logger.info({}, 'echo-plugin: registered /echo + onUsageFinish');
  }
}

export default new EchoPlugin();
