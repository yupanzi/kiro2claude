#!/usr/bin/env node
/**
 * Run the real Codex CLI against empty-cli-server.ts (stub upstream, no account).
 * K2C_PROBE_PORT=18931 node packages/core/test/manual/codex-empty-probe.mjs
 * Optional K2C_PROBE_CASES=empty-recover,empty-always and
 * K2C_PROBE_RETRY_MODE=default|bounded restrict a rerun.
 * Reports include untouched CLI output and the gateway's captured HTTP bodies.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const port = Number(process.env.K2C_PROBE_PORT ?? 18931);
const reportDir = resolve(process.env.K2C_PROBE_REPORT_DIR ?? 'test-results/empty-response-2026-09-07');
const image = process.env.K2C_PROBE_CODEX_IMAGE ?? 'kiro2claude-codex:validation-latest';
const hostBase = `http://127.0.0.1:${port}`;
const successText = 'EMPTY_PROBE_RECOVERED';
const scenarios = process.env.K2C_PROBE_CASES?.split(',') ?? [
  'empty-recover',
  'exhausted-recover',
  'slow-empty-recover',
  'truncated-only-recover',
  'redacted-only-recover',
  'shell-recover',
  'empty-always',
  'slow-empty-always',
  'truncated-only-always',
];
await mkdir(reportDir, { recursive: true });

function command(args, timeoutMs = 150_000, containerName) {
  return new Promise((resolveResult, reject) => {
    const started = Date.now();
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      timedOut = true;
      // Killing docker run alone can leave the container alive.
      if (containerName) spawn('docker', ['rm', '-f', containerName], { stdio: 'ignore' });
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolveResult({ exitCode, signal, timedOut, durationMs: Date.now() - started, stdout, stderr });
    });
  });
}

async function getStats(scenario) {
  const response = await fetch(`${hostBase}/probe/stats`);
  if (!response.ok) throw new Error(`Probe stats HTTP ${response.status}`);
  const stats = await response.json();
  return stats[`${scenario}/codex`];
}

const version = await command(['run', '--rm', image, '--version']);
if (version.exitCode !== 0) throw new Error(`Cannot run Codex: ${version.stderr}`);
const results = [];
const runStarted = new Date().toISOString();

async function runCase(scenario) {
  const retryMode = process.env.K2C_PROBE_RETRY_MODE ?? (scenario.endsWith('always') ? 'bounded' : 'default');
  if (!['default', 'bounded'].includes(retryMode)) throw new Error(`Unknown retry mode: ${retryMode}`);
  const id = `${scenario}-${retryMode}`;
  const reset = await fetch(`${hostBase}/probe/reset`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scenario, protocol: 'codex' }),
  });
  if (!reset.ok) throw new Error(`Cannot reset ${id}: HTTP ${reset.status}`);
  const containerName = `k2c-codex-empty-${randomUUID()}`;
  const args = [
    'run', '--rm', '--name', containerName,
    '-e', 'KIRO2CLAUDE_API_KEY=empty-probe-key',
    '-e', `KIRO2CLAUDE_BASE_URL=http://host.docker.internal:${port}/case/${scenario}/openai/v1`,
    '-e', 'CODEX_MODEL=gpt-5.6-sol',
    image, 'exec', '--json', '--skip-git-repo-check', '--ephemeral', '--color', 'never',
  ];
  if (retryMode === 'bounded') args.push(
    '-c', 'model_providers.kiro2claude.request_max_retries=1',
    '-c', 'model_providers.kiro2claude.stream_max_retries=1',
  );
  args.push('Reply with exactly EMPTY_PROBE_RECOVERED. Do not use tools.');
  console.log(JSON.stringify({ event: 'case.started', id }));
  const raw = await command(args, Number(process.env.K2C_PROBE_TIMEOUT_MS ?? 150_000), containerName);
  await Promise.all([
    writeFile(resolve(reportDir, `codex-${id}.stdout.jsonl`), raw.stdout),
    writeFile(resolve(reportDir, `codex-${id}.stderr.txt`), raw.stderr),
  ]);
  const parsed = raw.stdout.split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return { type: 'unparsed', text: line }; }
  });
  const completed = parsed.filter((event) => event.type === 'turn.completed');
  const failed = parsed.filter((event) => event.type === 'turn.failed');
  const agentMessages = parsed.filter((event) => event.type === 'item.completed' && event.item?.type === 'agent_message')
    .map((event) => event.item.text);
  const toolItems = parsed.filter((event) => event.type?.startsWith('item.') && event.item
    && !['agent_message', 'reasoning'].includes(event.item.type));
  const recovered = agentMessages.some((message) => message === successText);
  const emptySuccess = (raw.exitCode === 0 || completed.length > 0)
    && !agentMessages.some((message) => message?.trim()) && toolItems.length === 0;
  const gateway = await getStats(scenario);
  const shouldRecover = scenario.endsWith('recover');
  const first = gateway?.requests[0];
  const leakedTool = gateway?.requests.some((request) => /toolu_incomplete|DO_NOT_EXECUTE/.test(request.body));
  const correctFault = scenario.startsWith('slow')
    ? first?.status === 200 && first.durationMs >= 15_000 && first.body.includes('overloaded_error') && !first.body.includes('response.completed')
    : scenario.startsWith('truncated')
      ? first?.status === 200 && first.body.includes('"type":"response.incomplete"')
      : first?.status === 503 && first.body.includes('overloaded_error');
  const correctAttempts = shouldRecover
    ? gateway?.requests.length >= 2 && gateway?.attempts.length === (scenario === 'exhausted-recover' ? 4 : 2)
    : gateway?.attempts.length >= 2;
  const passed = !raw.timedOut && toolItems.length === 0 && !emptySuccess && !leakedTool && correctFault && correctAttempts
    && (shouldRecover
      ? raw.exitCode === 0 && completed.length === 1 && failed.length === 0 && recovered
      : raw.exitCode !== 0 && failed.length > 0 && completed.length === 0 && !recovered);
  const result = {
    id, scenario, retryMode, expected: shouldRecover ? 'recover' : 'fail',
    exitCode: raw.exitCode, signal: raw.signal, timedOut: raw.timedOut, durationMs: raw.durationMs,
    passed, recovered, emptySuccess, leakedTool, correctFault, correctAttempts,
    turnCompleted: completed.length, turnFailed: failed.length,
    agentMessages, toolItems,
    errors: parsed.filter((event) => ['error', 'turn.failed'].includes(event.type)),
    reconnectMessages: parsed.filter((event) => /reconnect/i.test(event.message ?? '')),
    gateway, command: ['docker', ...args],
  };
  await writeFile(resolve(reportDir, `codex-${id}.json`), `${JSON.stringify(result, null, 2)}\n`);
  results.push(result);
  console.log(JSON.stringify({ event: 'case.finished', id, passed,
    exitCode: result.exitCode, durationMs: result.durationMs, recovered, emptySuccess,
    providerAttempts: gateway?.attempts.length, httpStatuses: gateway?.requests.map((request) => request.status),
    turnCompleted: result.turnCompleted, turnFailed: result.turnFailed }));
}

// Cases have independent counters; two concurrent clients keep slow fault probes bounded in wall time.
const queue = [...scenarios];
await Promise.all(Array.from({ length: 2 }, async () => {
  while (queue.length) await runCase(queue.shift());
}));
results.sort((left, right) => scenarios.indexOf(left.scenario) - scenarios.indexOf(right.scenario));
await writeFile(resolve(reportDir, 'codex-summary.json'), `${JSON.stringify({
  runStarted, version: version.stdout.trim(), image,
  fakeUpstream: true, retryDocs: 'https://learn.chatgpt.com/docs/config-file/config-reference',
  results,
}, null, 2)}\n`);
if (results.some((result) => !result.passed)) process.exitCode = 1;
