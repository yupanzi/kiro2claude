/** Real Claude Code against empty-cli-server.ts; no real upstream requests. */
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const base = process.env.K2C_PROBE_BASE ?? 'http://127.0.0.1:18931';
const dockerBase = process.env.K2C_PROBE_DOCKER_BASE ?? 'http://host.docker.internal:18931';
const image = process.env.K2C_CLAUDE_IMAGE ?? 'kiro2claude-cc:validation-latest';
const reportDir = resolve(process.env.K2C_PROBE_REPORT_DIR ?? 'test-results/empty-response-2026-09-07');
await mkdir(reportDir, { recursive: true });
const version = execFileSync('docker', ['run', '--rm', '--entrypoint', 'cat', image, '/etc/cc-version'], { encoding: 'utf8' }).trim();
const cases = [
  'empty-recover', 'exhausted-recover', 'slow-empty-recover',
  'truncated-only-recover', 'redacted-only-recover', 'shell-recover',
  'empty-always', 'slow-empty-always', 'truncated-only-always',
];
const results = [];
async function run(scenario) {
  await fetch(`${base}/probe/reset`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scenario, protocol: 'claude' }) });
  const persistent = scenario.endsWith('always');
  const name = `k2c-empty-claude-${scenario}-${process.pid}`;
  const args = ['run', '--rm', '--name', name,
    '-e', `ANTHROPIC_BASE_URL=${dockerBase}/case/${scenario}/claude`,
    '-e', 'ANTHROPIC_AUTH_TOKEN=empty-probe-key',
    '-e', 'ANTHROPIC_API_KEY=empty-probe-key',
    '-e', 'DISABLE_NONESSENTIAL_TRAFFIC=1',
    ...(persistent ? ['-e', 'CLAUDE_CODE_MAX_RETRIES=1'] : []),
    image, '-p', 'Reply with EMPTY_PROBE_RECOVERED.', '--model', 'claude-opus-5',
    '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--max-turns', '8', '--no-session-persistence', '--tools', 'Read',
  ];
  const start = Date.now();
  const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => {
    timedOut = true;
    spawn('docker', ['rm', '-f', name], { stdio: 'ignore' });
  }, 120_000);
  const exitCode = await new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('close', resolveExit);
  });
  clearTimeout(timer);
  const events = stdout.split('\n').flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  const terminal = events.findLast((event) => event.type === 'result');
  const stats = (await (await fetch(`${base}/probe/stats`)).json())[`${scenario}/claude`];
  const falseSuccess = terminal?.is_error === false && terminal?.subtype === 'success' && !terminal?.result?.includes('EMPTY_PROBE_RECOVERED');
  const leakedTool = events.some((event) =>
    event.message?.content?.some((block) => block.type === 'tool_use') ||
    (event.type === 'stream_event' && event.event?.content_block?.type === 'tool_use')) ||
    stats.requests.some((request) => /toolu_incomplete|DO_NOT_EXECUTE/.test(request.body));
  const first = stats.requests[0];
  const correctFault = scenario.startsWith('slow')
    ? first?.status === 200 && first.durationMs >= 15_000 && first.body.includes('overloaded_error') && !first.body.includes('message_stop')
    : scenario.startsWith('truncated')
      ? first?.status === 200 && first.body.includes('"stop_reason":"max_tokens"')
      : first?.status === 503 && first.body.includes('overloaded_error');
  const passed = !timedOut && !falseSuccess && !leakedTool && correctFault && (persistent
    ? exitCode !== 0 && terminal?.is_error === true
    : exitCode === 0 && terminal?.is_error === false && terminal?.result?.includes('EMPTY_PROBE_RECOVERED') && stats.requests.length >= 2 && stats.attempts.length === (scenario === 'exhausted-recover' ? 4 : 2));
  const result = {
    scenario, version, retrySetting: persistent ? 1 : 'default', exitCode,
    timedOut, durationMs: Date.now() - start, passed, falseSuccess, leakedTool, correctFault,
    terminal, upstreamAttempts: stats.attempts.length,
    httpStatuses: stats.requests.map((request) => request.status),
  };
  await Promise.all([
    writeFile(resolve(reportDir, `claude-${scenario}.jsonl`), stdout),
    writeFile(resolve(reportDir, `claude-${scenario}.stderr`), stderr),
    writeFile(resolve(reportDir, `claude-${scenario}-wire.json`), `${JSON.stringify(stats, null, 2)}\n`),
  ]);
  results.push(result);
  console.log(JSON.stringify({ ...result, terminal: { is_error: terminal?.is_error, subtype: terminal?.subtype, result: terminal?.result } }));
}

// Cases are independent; three workers keep the real 16-second timeout probes
// from delaying the immediate-error probes. Never run one case twice at once.
const pending = [...cases];
await Promise.all(Array.from({ length: 3 }, async () => {
  while (pending.length) await run(pending.shift());
}));
await writeFile(resolve(reportDir, 'claude-results.json'), `${JSON.stringify(results, null, 2)}\n`);
process.exitCode = results.every((result) => result.passed) ? 0 : 1;
