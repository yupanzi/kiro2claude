import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('Claude Code harness gateway probe', { timeout: 30_000 }, () => {
  it.each([
    ['http://host.docker.internal:18080/claude', 'http://127.0.0.1:18080/health'],
    ['http://host.docker.internal:18080/claude/', 'http://127.0.0.1:18080/health'],
    ['https://gateway.example:8443/claude', 'https://gateway.example:8443/health'],
  ])('probes the root health endpoint for %s without changing the client base', (base, health) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'k2c-cc-harness-'));
    tempDirs.push(root);
    const harness = path.join(root, 'tools/claude-code');
    const bin = path.join(root, 'bin');
    fs.mkdirSync(harness, { recursive: true });
    fs.mkdirSync(bin);
    fs.copyFileSync(
      path.join(REPO_ROOT, 'tools/claude-code/test.sh'),
      path.join(harness, 'test.sh'),
    );
    fs.writeFileSync(path.join(harness, 'VERSION'), '1.2.3\n');
    const callsPath = path.join(root, 'calls.jsonl');
    const stub = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS_PATH, JSON.stringify({command, args}) + '\\n');
if (command === 'curl') process.exit(args.at(-1) === process.env.EXPECT_HEALTH ? 0 : 22);
if (command === 'docker' && args[0] === 'run') process.stdout.write('1.2.3 (Claude Code)\\n');
`;
    for (const command of ['docker', 'curl', 'jq']) {
      fs.writeFileSync(path.join(bin, command), stub, { mode: 0o755 });
    }
    const result = spawnSync(
      'bash',
      [
        path.join(harness, 'test.sh'),
        '-t',
        'test-key',
        '-u',
        base,
        '--case',
        '00-version',
        '--no-color',
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          CLAUDE_CODE_VERSION: '1.2.3',
          PATH: `${bin}${path.delimiter}${process.env.PATH}`,
          TMPDIR: root,
          CALLS_PATH: callsPath,
          EXPECT_HEALTH: health,
        },
        encoding: 'utf8',
        timeout: 20_000,
      },
    );
    const calls: { command: string; args: string[] }[] = fs
      .readFileSync(callsPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(calls.find((call) => call.command === 'curl')?.args.at(-1)).toBe(health);
    const dockerRun = calls.find((call) => call.command === 'docker' && call.args[0] === 'run');
    expect(dockerRun?.args).toContain(`ANTHROPIC_BASE_URL=${base}`);
    expect(result.stdout).toContain('全部通过 (1/1)');
  });
});
