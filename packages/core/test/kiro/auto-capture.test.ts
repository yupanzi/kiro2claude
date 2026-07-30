/**
 * auto-capture 模块单测
 *
 * 核心不变式：走查必须能从**本模块真实位置**解析到仓库根的
 * `scripts/capture-kiro-cli.sh`。vitest 下被测模块正跑在
 * `packages/core/src/kiro/`——固定 `'..','..'` 老实现失败的那个布局，所以真实
 * `import.meta.url` 位置是暴露 bug 的条件而非障碍，不必先抽成可注入的纯函数。
 * 第一组用例在老实现上会因 spawnSync 从未被调用而失败。
 *
 * mock spawnSync 的理由同 cli-version.test.ts（真跑脚本要求已登录的 kiro-cli 且
 * 会改本机 settings）；fs 用真的——「脚本确实在那」正是要断言的东西。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    spawnSync: vi.fn(),
  };
});

import { spawnSync } from 'node:child_process';
import { runStartupAutoCapture } from '../../src/kiro/auto-capture.js';

const mockSpawnSync = vi.mocked(spawnSync);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// test/kiro/ → packages/core/ → 仓库根
const PACKAGE_ROOT = path.resolve(__dirname, '../..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '../..');
const EXPECTED_SCRIPT = path.join(REPO_ROOT, 'scripts', 'capture-kiro-cli.sh');

/** 构造 spawnSync 非 0 退出返回值——在 statSync 之前就让流程返回，不碰文件系统产物 */
function spawnFailed(stderr: string) {
  return {
    pid: 12345,
    status: 1,
    signal: null,
    output: ['', '', stderr],
    stdout: Buffer.from(''),
    stderr: Buffer.from(stderr),
    error: undefined as Error | undefined,
  } as unknown as ReturnType<typeof spawnSync>;
}

/** 构造 spawnSync 起不来的返回值（bash 不存在等） */
function spawnErrored(message: string) {
  return {
    pid: 0,
    status: null,
    signal: null,
    output: ['', '', ''],
    stdout: Buffer.from(''),
    stderr: Buffer.from(''),
    error: new Error(message),
  } as unknown as ReturnType<typeof spawnSync>;
}

/** 取 spawnSync 实际拿到的脚本路径（argv 是 ['bash', [script, '--out', out, '--bin', bin]]） */
function capturedScriptPath(): string {
  const call = mockSpawnSync.mock.calls[0];
  expect(call).toBeDefined();
  expect(call?.[0]).toBe('bash');
  const argv = call?.[1] as string[];
  return argv[0] as string;
}

describe('runStartupAutoCapture', () => {
  // 成功分支会改写 KIRO2CLAUDE_CLIENT_PROFILE_PATH 并刷新 client-profile 缓存。
  // 下面的用例都让 spawnSync 失败，走不到那里；仍然存下来保证测试之间不串味。
  const savedProfilePath = process.env.KIRO2CLAUDE_CLIENT_PROFILE_PATH;

  beforeEach(() => {
    mockSpawnSync.mockReset();
  });

  afterEach(() => {
    if (savedProfilePath === undefined) delete process.env.KIRO2CLAUDE_CLIENT_PROFILE_PATH;
    else process.env.KIRO2CLAUDE_CLIENT_PROFILE_PATH = savedProfilePath;
  });

  describe('capture 脚本定位（逐级向上走查）', () => {
    it('从本模块真实位置解析到仓库根的 capture 脚本', () => {
      mockSpawnSync.mockReturnValue(spawnFailed('boom'));

      const result = runStartupAutoCapture({ enabled: true });

      // 这句是本文件的存在理由：老的固定 2 级实现会在这之前就返回
      // 「未找到 scripts/capture-kiro-cli.sh」，spawnSync 一次都不会被调用。
      expect(mockSpawnSync).toHaveBeenCalledTimes(1);
      expect(result.message).not.toContain('未找到');
      expect(capturedScriptPath()).toBe(EXPECTED_SCRIPT);
    });

    it('解析出的脚本在磁盘上真实存在且是文件', () => {
      mockSpawnSync.mockReturnValue(spawnFailed('boom'));
      runStartupAutoCapture({ enabled: true });

      const script = capturedScriptPath();
      expect(fs.existsSync(script)).toBe(true);
      expect(fs.statSync(script).isFile()).toBe(true);
    });

    it('传绝对路径给 bash，并带上 --out / --bin 参数', () => {
      mockSpawnSync.mockReturnValue(spawnFailed('boom'));
      runStartupAutoCapture({ enabled: true, kiroCliBin: '/opt/custom/kiro-cli' });

      const argv = mockSpawnSync.mock.calls[0]?.[1] as string[];
      expect(path.isAbsolute(argv[0] as string)).toBe(true);
      expect(argv).toContain('--out');
      expect(argv).toContain('--bin');
      expect(argv[argv.indexOf('--bin') + 1]).toBe('/opt/custom/kiro-cli');
    });

    it('未指定 kiroCliBin 时默认 kiro-cli', () => {
      mockSpawnSync.mockReturnValue(spawnFailed('boom'));
      runStartupAutoCapture({ enabled: true });

      const argv = mockSpawnSync.mock.calls[0]?.[1] as string[];
      expect(argv[argv.indexOf('--bin') + 1]).toBe('kiro-cli');
    });
  });

  describe('开关与失败降级', () => {
    it('enabled=false 时直接 disabled，不 spawn 任何东西', () => {
      const result = runStartupAutoCapture({ enabled: false });

      expect(result.status).toBe('disabled');
      expect(mockSpawnSync).not.toHaveBeenCalled();
    });

    it('脚本非 0 退出 → failed，message 带退出码与 stderr', () => {
      mockSpawnSync.mockReturnValue(spawnFailed('错误: 未找到 kiro-cli'));

      const result = runStartupAutoCapture({ enabled: true });

      expect(result.status).toBe('failed');
      expect(result.message).toContain('退出码 1');
      expect(result.message).toContain('未找到 kiro-cli');
    });

    it('脚本起不来 → failed，message 说明无法启动', () => {
      mockSpawnSync.mockReturnValue(spawnErrored('spawn bash ENOENT'));

      const result = runStartupAutoCapture({ enabled: true });

      expect(result.status).toBe('failed');
      expect(result.message).toContain('无法启动');
      expect(result.message).toContain('ENOENT');
    });

    it('脚本返回 0 但没产出 profile → failed，不静默当成功', () => {
      // outPath 落在 $TMPDIR，真跑过 auto-capture 的机器上可能有残留 —— 有残留
      // 时该用例无意义，跳过。
      if (fs.existsSync(path.join(os.tmpdir(), 'kiro2claude-profile.json'))) return;

      mockSpawnSync.mockReturnValue({
        pid: 12345,
        status: 0,
        signal: null,
        output: ['', '', ''],
        stdout: Buffer.from(''),
        stderr: Buffer.from(''),
        error: undefined as Error | undefined,
      } as unknown as ReturnType<typeof spawnSync>);

      const result = runStartupAutoCapture({ enabled: true });
      expect(result.status).toBe('failed');
      expect(result.message).toContain('未产出 profile 文件');
    });

    it('spawnSync 直接抛也不穿透——启动期不能被 auto-capture 挂掉', () => {
      // 反向守卫：index.ts 的调用处没有 try/catch，只有最外层 main().catch()，
      // 穿透一次就是整个网关启动失败。头注释承诺「从不抛异常」，这条钉住它。
      mockSpawnSync.mockImplementation(() => {
        throw new Error('boom from spawnSync');
      });

      const result = runStartupAutoCapture({ enabled: true });

      expect(result.status).toBe('failed');
      expect(result.message).toContain('boom from spawnSync');
    });
  });
});
