#!/usr/bin/env node
/**
 * Live multi-image CLI probe: real Claude Code and Codex run in Docker, read N distinct
 * six-digit images from a mounted workspace through the gateway with their own image
 * tools (Claude Code `Read`, Codex `view_image` via code-mode `exec`), and write
 * result.json. Real upstream calls incur usage; no retries.
 *
 *   K2C_KEY=... node this-file                       both CLIs, 4 images
 *   K2C_CLI=claude|codex   K2C_IMAGE_COUNT=6         subset / more images
 *   K2C_BASE=http://127.0.0.1:8080                   gateway (containers reach it via host.docker.internal)
 *   K2C_CLAUDE_IMAGE=kiro2claude-cc:validation-latest  K2C_CODEX_IMAGE=kiro2claude-codex:validation-latest
 *   K2C_REPORT_DIR=/tmp/k2c-cli-images               report + workspaces are kept there
 *
 * Verdict per CLI: exit 0, protocol success (Claude `is_error=false`; Codex `turn.completed`),
 * result.json exists, and no value is *attributed* to the wrong file. Each value is classified:
 *   ok         exactly the digits drawn into that file
 *   swap       equals (or is within one digit of) another file's digits → attribution failure,
 *              the multi-image defect this probe exists for (踩坑「多图归属只靠顺序」)
 *   ocr        anything else → the model misread a glyph; reported, not a gateway failure
 * A missing file means the tool loop itself broke.
 *   K2C_PARALLEL_HINT=1   ask the CLI to view all images in one turn (Claude Code otherwise
 *                         reads them one per turn, so multi-image tool results never occur)
 */
import { spawn } from 'node:child_process';
import { randomInt, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BASE, CLAUDE_MODEL, GPT_MODEL, KEY, baseHostPort } from './_harness.mjs';
import { markerPng } from './_marker-png.mjs';

if (!KEY) throw new Error('K2C_KEY is required');
const DIR = process.env.K2C_REPORT_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'k2c-cli-images-'));
fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
const CLIS = (process.env.K2C_CLI ?? 'claude,codex').split(',');
const COUNT = Number(process.env.K2C_IMAGE_COUNT ?? 4);
const TIMEOUT_MS = Number(process.env.K2C_CLI_TIMEOUT_MS ?? 420_000);
const CLAUDE_IMAGE = process.env.K2C_CLAUDE_IMAGE ?? 'kiro2claude-cc:validation-latest';
const CODEX_IMAGE = process.env.K2C_CODEX_IMAGE ?? 'kiro2claude-codex:validation-latest';
const PARALLEL_HINT = process.env.K2C_PARALLEL_HINT === '1';
const { port } = baseHostPort();
const DOCKER_HOST_BASE = `http://host.docker.internal:${port}`;

function makeWorkspace(cli) {
  const ws = fs.mkdtempSync(path.join(DIR, `ws-${cli}-`));
  fs.chmodSync(ws, 0o777); // Codex runs as a non-root user inside the container
  const expected = {};
  const used = new Set();
  for (let i = 1; i <= COUNT; i++) {
    let digits;
    do digits = String(randomInt(100000, 1000000));
    while (used.has(digits));
    used.add(digits);
    const name = `img-${i}.png`;
    fs.writeFileSync(path.join(ws, name), markerPng(digits));
    expected[name] = digits;
  }
  return { ws, expected };
}

const files = Array.from({ length: COUNT }, (_, i) => `img-${i + 1}.png`);
const PROMPT =
  `There are ${COUNT} PNG files in the current directory: ${files.join(', ')}. Each shows one six-digit number. ` +
  'Look at every image with your image-viewing tool so that you actually see each one, then write a file named result.json ' +
  'in the current directory containing a JSON object that maps each filename to its six digits as a string, ' +
  'for example {"img-1.png":"123456"}. Do not guess: every value must come from viewing that exact file. ' +
  'When result.json is written, reply with exactly DONE.' +
  (PARALLEL_HINT ? ' View all the images in a single turn (issue every image read at once, in parallel) before writing the file.' : '');

function docker(args, containerName) {
  return new Promise((resolve) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => {
      spawn('docker', ['rm', '-f', containerName], { stdio: 'ignore' });
    }, TIMEOUT_MS);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

function claudeArgs(ws, containerName) {
  return [
    'run', '--rm', '--name', containerName, '--add-host=host.docker.internal:host-gateway',
    '-v', `${ws}:/workspace`, '-w', '/workspace',
    '-e', `ANTHROPIC_AUTH_TOKEN=${KEY}`, '-e', `ANTHROPIC_BASE_URL=${DOCKER_HOST_BASE}/claude`,
    '-e', 'DISABLE_NONESSENTIAL_TRAFFIC=1', '-e', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY=1',
    CLAUDE_IMAGE, '-p', PROMPT, '--allowedTools', 'Read,Write', '--output-format', 'json',
    '--model', CLAUDE_MODEL, '--max-turns', '40',
  ];
}

function codexArgs(ws, containerName) {
  return [
    'run', '--rm', '--name', containerName, '--add-host=host.docker.internal:host-gateway',
    '-v', `${ws}:/workspace`, '-w', '/workspace',
    '-e', `KIRO2CLAUDE_API_KEY=${KEY}`, '-e', `KIRO2CLAUDE_BASE_URL=${DOCKER_HOST_BASE}/openai/v1`,
    '-e', `CODEX_MODEL=${GPT_MODEL}`,
    CODEX_IMAGE, 'exec', '--json', '--skip-git-repo-check', PROMPT,
  ];
}

function parseClaude(stdout) {
  let json;
  try { json = JSON.parse(stdout); } catch { return { ok: false, reason: 'stdout is not JSON' }; }
  return {
    ok: json.is_error === false && json.subtype === 'success',
    reason: json.is_error ? `is_error (${json.subtype})` : undefined,
    result: json.result, num_turns: json.num_turns, cost_usd: json.total_cost_usd, usage: json.usage,
  };
}

function parseCodex(stdout) {
  const events = stdout.split('\n').filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  const completed = events.filter((e) => e.type === 'turn.completed');
  const failed = events.filter((e) => e.type === 'turn.failed' || e.type === 'error');
  const messages = events.filter((e) => e.type === 'item.completed' && e.item?.type === 'agent_message').map((e) => e.item.text);
  const commands = events.filter((e) => e.type === 'item.completed' && e.item?.type === 'command_execution').length;
  return {
    ok: completed.length > 0 && failed.length === 0,
    reason: failed.length ? JSON.stringify(failed[0]).slice(0, 300) : completed.length ? undefined : 'no turn.completed',
    result: messages.at(-1), num_turns: events.filter((e) => e.type === 'turn.started').length, commands,
    usage: completed.at(-1)?.usage,
  };
}

const hamming = (a, b) => (a.length === b.length ? [...a].filter((ch, i) => ch !== b[i]).length : Number.POSITIVE_INFINITY);

function verify(ws, expected) {
  const file = path.join(ws, 'result.json');
  if (!fs.existsSync(file)) return { ok: false, reason: 'result.json missing' };
  let actual;
  try { actual = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { ok: false, reason: 'result.json is not JSON' }; }
  const classes = {};
  const details = [];
  for (const [name, digits] of Object.entries(expected)) {
    const got = String(actual?.[name] ?? '');
    let cls = 'ok';
    if (got !== digits) {
      const other = Object.entries(expected).find(([n, d]) => n !== name && hamming(got, d) <= 1);
      cls = other ? 'swap' : 'ocr';
      details.push(`${name}: expected ${digits}, got ${got || '<missing>'}${other ? ` (= ${other[0]})` : ''}`);
    }
    classes[cls] = (classes[cls] ?? 0) + 1;
  }
  return { ok: !classes.swap, actual, classes, mismatches: details, reason: classes.swap ? `${classes.swap} value(s) attributed to the wrong file` : undefined };
}

const report = [];
let failures = 0;
for (const cli of CLIS) {
  const { ws, expected } = makeWorkspace(cli);
  const containerName = `k2c-images-${cli}-${randomUUID().slice(0, 8)}`;
  const args = cli === 'claude' ? claudeArgs(ws, containerName) : codexArgs(ws, containerName);
  const t0 = Date.now();
  const run = await docker(args, containerName);
  const ms = Date.now() - t0;
  const parsed = cli === 'claude' ? parseClaude(run.stdout) : parseCodex(run.stdout);
  const check = verify(ws, expected);
  const pass = run.code === 0 && parsed.ok && check.ok;
  if (!pass) failures++;
  fs.writeFileSync(path.join(ws, 'cli-stdout.txt'), run.stdout);
  fs.writeFileSync(path.join(ws, 'cli-stderr.txt'), run.stderr);
  const entry = { cli, image: cli === 'claude' ? CLAUDE_IMAGE : CODEX_IMAGE, model: cli === 'claude' ? CLAUDE_MODEL : GPT_MODEL, images: COUNT, pass, ms, exit_code: run.code, protocol: parsed, expected, verification: check, workspace: ws };
  report.push(entry);
  console.log(`${cli.padEnd(7)} ${pass ? 'PASS' : 'FAIL'} exit=${run.code} ${Math.round(ms / 1000)}s turns=${parsed.num_turns ?? '?'} values=${JSON.stringify(check.classes ?? {})} ${parsed.reason ?? ''} ${check.reason ?? ''}`);
  console.log(`        expected ${JSON.stringify(expected)}`);
  console.log(`        actual   ${JSON.stringify(check.actual ?? null)}${check.mismatches?.length ? `\n        mismatches: ${check.mismatches.join('; ')}` : ''}`);
  console.log(`        reply    ${JSON.stringify(parsed.result ?? '').slice(0, 200)}`);
}
const file = path.join(DIR, 'multi-image-cli.json');
fs.writeFileSync(file, JSON.stringify({ base: BASE, report }, null, 2));
console.log(`report: ${file}`);
process.exit(failures ? 1 : 0);
