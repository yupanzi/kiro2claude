import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const tempDirs: string[] = [];

// Run the real shell scripts in an isolated project with a fake Docker executable.
// No local .env files, credentials, images, volumes, or containers are touched.
function runDockerScript({
  args = [],
  env = {},
  defaults = '',
}: {
  args?: string[];
  env?: Record<string, string>;
  defaults?: string;
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'k2c-docker-run-'));
  tempDirs.push(root);
  for (const dir of ['scripts', 'fixtures', 'docker', 'bin']) {
    fs.mkdirSync(path.join(root, dir));
  }
  for (const file of [
    'scripts/docker-run.sh',
    'scripts/docker-build.sh',
    'fixtures/kiro-cli-profile.json',
    'docker/Dockerfile',
  ]) {
    fs.copyFileSync(path.join(REPO_ROOT, file), path.join(root, file));
  }
  fs.chmodSync(path.join(root, 'scripts/docker-build.sh'), 0o755);
  fs.writeFileSync(path.join(root, '.env.docker'), defaults);
  const callsPath = path.join(root, 'docker-calls.jsonl');
  fs.writeFileSync(
    path.join(root, 'bin/docker'),
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.DOCKER_CALLS_PATH, JSON.stringify(args) + '\\n');
if (args[0] === 'build') {
  const context = args.at(-1);
  const file = args.includes('-f') ? args[args.indexOf('-f') + 1] : 'Dockerfile';
  if (!fs.existsSync(path.resolve(context, file))) {
    console.error('Dockerfile not found');
    process.exit(1);
  }
  if (!args.some(arg => arg.startsWith('KIRO2CLAUDE_CLI_VERSION='))) {
    console.error('Required CLI version build argument missing');
    process.exit(1);
  }
  process.exit(Number(process.env.DOCKER_BUILD_EXIT || 0));
}
if (args[0] === 'run') process.stdout.write('test-container-id\\n');
`,
    { mode: 0o755 },
  );
  const cleanEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.startsWith('KIRO2CLAUDE_') &&
        !['API_KEY', 'START_URL', 'REGION', 'PORT', 'NAME', 'IMAGE', 'VOLUME'].includes(key),
    ),
  );
  const result = spawnSync('bash', [path.join(root, 'scripts/docker-run.sh'), ...args], {
    cwd: os.tmpdir(),
    env: {
      ...cleanEnv,
      PATH: `${path.join(root, 'bin')}${path.delimiter}${process.env.PATH}`,
      DOCKER_CALLS_PATH: callsPath,
      ...env,
    },
    encoding: 'utf8',
    timeout: 20_000,
  });
  const calls: string[][] = fs.existsSync(callsPath)
    ? fs
        .readFileSync(callsPath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    : [];
  return { result, calls, root };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('docker-run shell integration', { timeout: 30_000 }, () => {
  it('rebuilds using the project Dockerfile and fixture version before starting', () => {
    const { result, calls, root } = runDockerScript({
      args: ['--api-key', 'test-key', '--rebuild', '--image', 'test-gateway:dev'],
    });
    expect(result.status, result.stderr).toBe(0);
    const version = JSON.parse(
      fs.readFileSync(path.join(root, 'fixtures/kiro-cli-profile.json'), 'utf8'),
    ).kiroCliVersion;
    expect(calls[0]).toEqual([
      'build',
      '-f',
      'docker/Dockerfile',
      '--build-arg',
      `KIRO2CLAUDE_CLI_VERSION=${version}`,
      '-t',
      'test-gateway:dev',
      '-t',
      `test-gateway:${version}`,
      '.',
    ]);
    expect(calls.at(-1)?.[0]).toBe('run');
  });

  it('lets prefixed environment variables override every .env.docker default', () => {
    const { result, calls } = runDockerScript({
      defaults:
        'API_KEY=file-key\nSTART_URL=https://file.example/start\nREGION=file-region\n' +
        'PORT=18080\nNAME=file-name\nIMAGE=file-image\nVOLUME=file-volume\n',
      env: {
        KIRO2CLAUDE_API_KEY: 'env-key',
        KIRO2CLAUDE_LOGIN_START_URL: 'https://env.example/start',
        KIRO2CLAUDE_LOGIN_REGION: 'env-region',
        KIRO2CLAUDE_PORT_HOST: '28080',
        KIRO2CLAUDE_CONTAINER_NAME: 'env-name',
        KIRO2CLAUDE_IMAGE: 'env-image',
        KIRO2CLAUDE_VOLUME: 'env-volume',
      },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(calls.at(-1)).toEqual([
      'run',
      '-d',
      '--name',
      'env-name',
      '-e',
      'KIRO2CLAUDE_API_KEY=env-key',
      '-e',
      'KIRO2CLAUDE_HOST=0.0.0.0',
      '-e',
      'KIRO2CLAUDE_LOGIN_REGION=env-region',
      '-e',
      'KIRO2CLAUDE_LOGIN_START_URL=https://env.example/start',
      '-p',
      '28080:8080',
      '-v',
      'env-volume:/home/kiro/.local/share/kiro-cli',
      'env-image',
    ]);
  });

  it('uses .env.docker defaults when no prefixed environment value is supplied', () => {
    const { result, calls } = runDockerScript({
      defaults: 'API_KEY=file-key\nPORT=18080\nIMAGE=file-image\n',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(calls.at(-1)).toEqual(
      expect.arrayContaining(['KIRO2CLAUDE_API_KEY=file-key', '18080:8080', 'file-image']),
    );
  });

  it('lets command-line flags override both environment and file values', () => {
    const { result, calls } = runDockerScript({
      args: ['--api-key', 'cli-key', '--port', '38080'],
      env: { KIRO2CLAUDE_API_KEY: 'env-key', KIRO2CLAUDE_PORT_HOST: '28080' },
      defaults: 'API_KEY=file-key\nPORT=18080\n',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(calls.at(-1)).toEqual(
      expect.arrayContaining(['KIRO2CLAUDE_API_KEY=cli-key', '38080:8080']),
    );
  });

  it('lets an explicitly empty environment start URL disable file-configured bootstrap', () => {
    const { result, calls } = runDockerScript({
      env: { KIRO2CLAUDE_LOGIN_START_URL: '' },
      defaults: 'API_KEY=file-key\nSTART_URL=https://file.example/start\n',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(calls.at(-1)?.some((arg) => arg.startsWith('KIRO2CLAUDE_LOGIN_START_URL='))).toBe(false);
  });

  it('does not remove an existing container or start one when the rebuild fails', () => {
    const { result, calls } = runDockerScript({
      args: ['--api-key', 'test-key', '--rebuild', '--recreate'],
      env: { DOCKER_BUILD_EXIT: '17' },
    });
    expect(result.status).toBe(17);
    expect(calls.map((call) => call[0])).toEqual(['build']);
  });
});
