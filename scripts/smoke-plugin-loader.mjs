#!/usr/bin/env node
// Smoke test: boot the actual plugin-host machinery (loader + HookBus +
// UsageFinishEvent) and verify plugin discovery + the usage-finish hook bus.
//
// Layout-adaptive — runs in BOTH:
//   - dev repo:  <repo>/scripts, core at <repo>/packages/core/dist, echo-plugin present
//   - container: /app/scripts,   core at /app/dist, no packages/ tree, echo-plugin absent
//
// Usage:
//   node scripts/smoke-plugin-loader.mjs                     # dev: loader + echo hook
//   node /app/scripts/smoke-plugin-loader.mjs --expect-plugin=metering   # container gate

import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// `scripts/` sits directly under the app/repo root in both layouts:
//   container: /app/scripts → /app ;  dev: <repo>/scripts → <repo>
const repoRoot = path.resolve(here, '..');

// --expect-plugin=<name> (or `--expect-plugin <name>`): assert a plugin with
// this name was discovered. Absent → no assertion.
let expectPlugin;
const expectArg = process.argv.find((a) => a.startsWith('--expect-plugin'));
if (expectArg) {
  expectPlugin = expectArg.includes('=')
    ? expectArg.split('=')[1]
    : process.argv[process.argv.indexOf(expectArg) + 1];
}

// Detect layout: container flattens core to <root>/dist; dev keeps it under
// packages/core/dist. `fastify` (a core runtime dep) must be resolved from the
// matching node_modules scope, so anchor createRequire to the same layout.
const containerCore = path.join(repoRoot, 'dist', 'plugin-host', 'index.js');
const devCore = path.join(repoRoot, 'packages', 'core', 'dist', 'plugin-host', 'index.js');
let corePath;
let requireFrom;
if (fs.existsSync(containerCore)) {
  corePath = containerCore;
  requireFrom = path.join(repoRoot, 'package.json'); // /app/package.json → /app/node_modules
} else if (fs.existsSync(devCore)) {
  corePath = devCore;
  requireFrom = path.join(repoRoot, 'packages', 'core', 'package.json'); // → packages/core/node_modules
} else {
  console.error('[FAIL] core plugin-host dist not found. Build core first. Looked in:');
  console.error('  - ' + containerCore);
  console.error('  - ' + devCore);
  process.exit(1);
}
const require = createRequire(requireFrom);
const Fastify = require('fastify').default ?? require('fastify');

const { CapabilityRegistry, HookBus, UsageFinishEventImpl, discoverPlugins } = await import(
  pathToFileURL(corePath).href
);

const fakeLogger = {
  info(o, m) { console.log('[info]', m ?? '', JSON.stringify(o)); },
  warn(o, m) { console.warn('[warn]', m ?? '', JSON.stringify(o)); },
  error(o, m) { console.error('[error]', m ?? '', JSON.stringify(o)); },
};

const hookBus = new HookBus();
const caps = new CapabilityRegistry();

// Loader smoke: must run without throwing. Discovers whatever plugins are
// installed under repoRoot (enterprise/plugin-*/dist + node_modules keyword).
const discovered = await discoverPlugins({
  repoRoot,
  nodeModulesRoot: path.join(repoRoot, 'node_modules'),
  logger: fakeLogger,
  env: process.env,
});
console.log(`\n=== Loader ran: discovered ${discovered.length} plugin(s) ===`);
for (const { plugin, source } of discovered) {
  console.log(`  - ${plugin.name}@${plugin.version} (${source})`);
}

// Container gate: assert the expected plugin is present.
if (expectPlugin) {
  const found = discovered.some(({ plugin }) => plugin.name === expectPlugin);
  if (!found) {
    console.error(`\n[FAIL] expected plugin "${expectPlugin}" was NOT discovered`);
    process.exit(1);
  }
  console.log(`\n[PASS] plugin "${expectPlugin}" discovered`);
}

// Hook-bus end-to-end check using the public echo-plugin — dev-only (the example
// is not shipped in deployment images). Skipped cleanly when absent.
const echoPath = path.join(repoRoot, 'packages', 'examples', 'echo-plugin', 'dist', 'index.js');
if (fs.existsSync(echoPath)) {
  const echoPlugin = (await import(pathToFileURL(echoPath).href)).default;
  const app = Fastify({ logger: false });
  const ctx = {
    app,
    logger: fakeLogger,
    env: { ...process.env },
    apiKey: 'test',
    registerHook: {
      onUsageFinish: (h) => hookBus.registerUsageFinish(echoPlugin.name, h),
    },
    getCapability: (name) => caps.get(name),
  };
  await echoPlugin.register(ctx);

  const event = new UsageFinishEventImpl({
    model: 'claude-opus-4.6',
    source: 'http-direct',
    inputTokensSource: 'client-estimate',
    meta: { 'kiro.inputTokens': 5000, 'kiro.outputTokens': 200 },
    logger: fakeLogger,
  });
  await hookBus.runUsageFinish(event);

  if (!event.getExtensions().has('echo')) {
    console.error('\n[FAIL] expected echo-plugin to inject the "echo" extension');
    process.exit(1);
  }
  console.log('\n[PASS] plugin loader + hook bus end-to-end works');
} else if (!expectPlugin) {
  console.log('\n[skip] echo-plugin dist absent and no --expect-plugin given (nothing asserted)');
}

process.exit(0);
