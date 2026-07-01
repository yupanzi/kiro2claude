import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isValidPlugin, type KiroPlugin, type PluginLogger } from '@kiro2claude/plugin-api';

const PLUGIN_KEYWORD = 'kiro2claude-plugin';

interface DiscoveredPlugin {
  plugin: KiroPlugin;
  source: string; // human-readable source path / package name
}

/**
 * Discover plugins from two sources:
 *   1. Local enterprise/plugin-*\/ dist (workspace-local closed-source plugins)
 *   2. node_modules packages whose package.json has keyword 'kiro2claude-plugin'
 *      (third-party / npm-distributed plugins)
 *
 * Duplicates (same name from both sources) default to ERROR. Override via
 * env KIRO2CLAUDE_PLUGINS_LOCAL=name1,name2 to prefer local for those names.
 *
 * Loader failures are isolated per-plugin: a broken plugin is skipped with
 * a warn log, the host still boots with the remaining plugins.
 */
export async function discoverPlugins(args: {
  repoRoot: string;
  nodeModulesRoot: string;
  logger: PluginLogger;
  env: NodeJS.ProcessEnv;
}): Promise<DiscoveredPlugin[]> {
  const { repoRoot, nodeModulesRoot, logger, env } = args;

  const localPlugins = await discoverLocal(repoRoot, logger);
  const npmPlugins = await discoverFromNodeModules(nodeModulesRoot, logger);

  const localOverride = new Set(
    (env.KIRO2CLAUDE_PLUGINS_LOCAL ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

  const byName = new Map<string, DiscoveredPlugin>();
  for (const p of localPlugins) byName.set(p.plugin.name, p);
  for (const p of npmPlugins) {
    const existing = byName.get(p.plugin.name);
    if (existing) {
      if (localOverride.has(p.plugin.name)) {
        logger.info(
          { plugin: p.plugin.name, kept: existing.source, skipped: p.source },
          'plugin discovered from both sources — local kept per KIRO2CLAUDE_PLUGINS_LOCAL',
        );
        continue;
      }
      throw new Error(
        `plugin "${p.plugin.name}" discovered from two sources:\n` +
          `  - ${existing.source}\n` +
          `  - ${p.source}\n` +
          `Set KIRO2CLAUDE_PLUGINS_LOCAL=${p.plugin.name} to prefer the local copy.`,
      );
    }
    byName.set(p.plugin.name, p);
  }

  return topoSort(Array.from(byName.values()), logger);
}

// ───────────────────────────────────────────────────────────────────────────
// Discovery sources
// ───────────────────────────────────────────────────────────────────────────

async function discoverLocal(repoRoot: string, logger: PluginLogger): Promise<DiscoveredPlugin[]> {
  const out: DiscoveredPlugin[] = [];
  const enterpriseDir = path.join(repoRoot, 'enterprise');
  if (!fs.existsSync(enterpriseDir)) return out;

  for (const entry of fs.readdirSync(enterpriseDir)) {
    if (!entry.startsWith('plugin-')) continue;
    const distEntry = path.join(enterpriseDir, entry, 'dist', 'index.js');
    if (!fs.existsSync(distEntry)) {
      logger.debug?.(
        { entry, distEntry },
        'enterprise plugin directory has no dist/index.js — skipping',
      );
      continue;
    }
    try {
      const mod = await import(pathToFileURL(distEntry).href);
      const plugin = mod.default ?? mod.plugin;
      if (isValidPlugin(plugin)) {
        out.push({ plugin, source: `enterprise/${entry}` });
      } else {
        logger.warn({ entry }, 'enterprise dir present but exports no valid KiroPlugin');
      }
    } catch (err) {
      logger.warn(
        { entry, err: err instanceof Error ? err.message : String(err) },
        'failed to import enterprise plugin',
      );
    }
  }
  return out;
}

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
