import * as fs from 'node:fs';
import * as path from 'node:path';
import { isValidPlugin, type KiroPlugin, type PluginLogger } from '@kiro2claude/plugin-api';

const PLUGIN_KEYWORD = 'kiro2claude-plugin';

interface DiscoveredPlugin {
  plugin: KiroPlugin;
  source: string; // human-readable source path / package name
}

/**
 * Discover plugins from node_modules: any package whose package.json declares
 * the keyword 'kiro2claude-plugin'. First-party bundled plugins (metering,
 * derived) are ordinary dependencies of @kiro2claude/core, so they land in
 * node_modules and are discovered here exactly like third-party / npm plugins.
 *
 * Loader failures are isolated per-plugin: a broken plugin is skipped with
 * a warn log, the host still boots with the remaining plugins.
 */
export async function discoverPlugins(args: {
  nodeModulesRoot: string;
  logger: PluginLogger;
}): Promise<DiscoveredPlugin[]> {
  const { nodeModulesRoot, logger } = args;
  const npmPlugins = await discoverFromNodeModules(nodeModulesRoot, logger);
  return topoSort(npmPlugins, logger);
}

// ───────────────────────────────────────────────────────────────────────────
// Discovery source: node_modules keyword scan
// ───────────────────────────────────────────────────────────────────────────

async function discoverFromNodeModules(
  nodeModulesRoot: string,
  logger: PluginLogger,
): Promise<DiscoveredPlugin[]> {
  const out: DiscoveredPlugin[] = [];
  if (!fs.existsSync(nodeModulesRoot)) return out;

  const candidates: string[] = [];
  for (const entry of fs.readdirSync(nodeModulesRoot)) {
    if (entry.startsWith('.')) continue;
    if (entry.startsWith('@')) {
      const scopeDir = path.join(nodeModulesRoot, entry);
      if (!fs.statSync(scopeDir).isDirectory()) continue;
      for (const sub of fs.readdirSync(scopeDir)) {
        candidates.push(`${entry}/${sub}`);
      }
    } else {
      candidates.push(entry);
    }
  }

  for (const name of candidates) {
    const pkgJsonPath = path.join(nodeModulesRoot, name, 'package.json');
    if (!fs.existsSync(pkgJsonPath)) continue;
    let pkg: { keywords?: string[]; main?: string; module?: string };
    try {
      pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
    } catch {
      continue;
    }
    if (!Array.isArray(pkg.keywords) || !pkg.keywords.includes(PLUGIN_KEYWORD)) {
      continue;
    }
    try {
      const mod = await import(name);
      const plugin = mod.default ?? mod.plugin;
      if (isValidPlugin(plugin)) {
        out.push({ plugin, source: `npm:${name}` });
      } else {
        logger.warn({ name }, 'npm plugin keyword present but no valid KiroPlugin default export');
      }
    } catch (err) {
      logger.warn(
        { name, err: err instanceof Error ? err.message : String(err) },
        'failed to import npm plugin',
      );
    }
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// Topological sort by dependsOn
// ───────────────────────────────────────────────────────────────────────────

function topoSort(plugins: DiscoveredPlugin[], logger: PluginLogger): DiscoveredPlugin[] {
  const byName = new Map(plugins.map((p) => [p.plugin.name, p] as const));
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const out: DiscoveredPlugin[] = [];

  const visit = (name: string, chain: string[]): void => {
    if (visited.has(name)) return;
    if (inStack.has(name)) {
      throw new Error(`plugin dependency cycle: ${[...chain, name].join(' -> ')}`);
    }
    const p = byName.get(name);
    if (!p) {
      logger.warn({ dep_name: name, chain }, 'plugin dependsOn target not discovered');
      return;
    }
    inStack.add(name);
    for (const dep of p.plugin.dependsOn ?? []) {
      visit(dep, [...chain, name]);
    }
    inStack.delete(name);
    visited.add(name);
    out.push(p);
  };

  for (const p of plugins) visit(p.plugin.name, []);
  return out;
}
