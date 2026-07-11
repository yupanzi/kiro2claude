/**
 * cli-version 模块单测
 *
 * 三个被测函数：
 *   - parseKiroCliVersionOutput —— 纯函数，输入鲁棒性
 *   - verifyInstalledKiroCliVersion —— mock spawnSync，覆盖三种 status
 *   - getExpectedKiroCliVersion —— 从 client profile 取值
 *
 * 为什么 mock spawnSync：CI / 开发机不一定装 kiro-cli，跑真的二进制会失败。
 * 项目其它测试（client-profile.test.ts）也用真 fs；spawnSync 是少数必须 mock
 * 的系统接口之一。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    spawnSync: vi.fn(),
  };
});

import { spawnSync } from 'node:child_process';
import {
  getExpectedKiroCliVersion,
  parseKiroCliVersionOutput,
  verifyInstalledKiroCliVersion,
} from '../../src/kiro/cli-version.js';
import { _resetKiroClientProfileCacheForTesting } from '../../src/kiro/client-profile.js';

const mockSpawnSync = vi.mocked(spawnSync);

/** 构造 spawnSync 成功返回值，stdout 是给定字符串 */
function spawnOk(stdout: string) {
  return {
    pid: 12345,
    status: 0,
    signal: null,
    output: ['', stdout, ''],
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(''),
    error: undefined as Error | undefined,
  } as unknown as ReturnType<typeof spawnSync>;
}

/** 构造 spawnSync ENOENT 返回值（bin 不存在） */
function spawnEnoent() {
  const err = new Error('spawn kiro-cli ENOENT') as NodeJS.ErrnoException;
  err.code = 'ENOENT';
  return {
    pid: 0,
    status: null,
    signal: null,
    output: ['', '', ''],
    stdout: Buffer.from(''),
    stderr: Buffer.from(''),
    error: err,
  } as unknown as ReturnType<typeof spawnSync>;
}

/** 构造 spawnSync 非零退出（bin 存在但 --version 失败） */
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

describe('parseKiroCliVersionOutput', () => {
  it('parses the typical `kiro-cli 2.5.0` format', () => {
    expect(parseKiroCliVersionOutput('kiro-cli 2.5.0')).toBe('2.5.0');
    expect(parseKiroCliVersionOutput('kiro-cli 2.5.0\n')).toBe('2.5.0');
  });

  it('handles trailing whitespace / extra newlines', () => {
    expect(parseKiroCliVersionOutput('  kiro-cli 2.5.0  \n\n')).toBe('2.5.0');
    expect(parseKiroCliVersionOutput('kiro-cli   2.5.0')).toBe('2.5.0');
  });

  it('takes the last whitespace-separated token when there are extras', () => {
    // 防御性测试：上游某天加 build hash / SHA 尾缀也不会 silently 误判
    // 当前实现取末 token，这里钉住该行为以便未来变更时显式选择
    expect(parseKiroCliVersionOutput('kiro-cli 2.5.0 build-abcdef')).toBe('build-abcdef');
  });

  it('returns undefined on empty input', () => {
    expect(parseKiroCliVersionOutput('')).toBeUndefined();
    expect(parseKiroCliVersionOutput('   \n\n  ')).toBeUndefined();
  });
});

describe('verifyInstalledKiroCliVersion', () => {
  beforeEach(() => {
    mockSpawnSync.mockReset();
  });

  it('status=ok when installed version matches expected', () => {
    mockSpawnSync.mockReturnValueOnce(spawnOk('kiro-cli 2.5.0\n'));
    const result = verifyInstalledKiroCliVersion({ expected: '2.5.0' });
    expect(result).toEqual({ status: 'ok', expected: '2.5.0', actual: '2.5.0' });
  });

  it('status=mismatch when installed version differs', () => {
    mockSpawnSync.mockReturnValueOnce(spawnOk('kiro-cli 2.4.0\n'));
    const result = verifyInstalledKiroCliVersion({ expected: '2.5.0' });
    expect(result).toEqual({ status: 'mismatch', expected: '2.5.0', actual: '2.4.0' });
  });

  it('status=missing when bin does not exist (ENOENT)', () => {
    mockSpawnSync.mockReturnValueOnce(spawnEnoent());
    const result = verifyInstalledKiroCliVersion({ expected: '2.5.0', bin: 'nope-cli' });
    expect(result).toEqual({ status: 'missing', expected: '2.5.0', bin: 'nope-cli' });
  });

  it('status=missing when --version exits non-zero', () => {
    mockSpawnSync.mockReturnValueOnce(spawnFailed('unknown flag\n'));
    const result = verifyInstalledKiroCliVersion({ expected: '2.5.0' });
    expect(result.status).toBe('missing');
  });

  it('status=missing when stdout is empty', () => {
    mockSpawnSync.mockReturnValueOnce(spawnOk(''));
    const result = verifyInstalledKiroCliVersion({ expected: '2.5.0' });
    expect(result.status).toBe('missing');
  });

  it("status=expected-unknown when expected is 'unknown' (fixture absent)", () => {
    // FALLBACK_PROFILE.kiroCliVersion 是 'unknown'；当 fixture 加载失败时
    // getExpectedKiroCliVersion() 会返回 'unknown'。verifyInstalledKiroCliVersion
    // 必须直接走 expected-unknown 路径，不能误判成 mismatch。
    const result = verifyInstalledKiroCliVersion({ expected: 'unknown' });
    expect(result.status).toBe('expected-unknown');
    // 校验不应当 spawn kiro-cli ——白校验 spawn 是浪费
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it('empty string expected falls back to getExpectedKiroCliVersion() (does not short-circuit to expected-unknown)', () => {
    // 实现细节：`opts?.expected?.trim() || getExpectedKiroCliVersion()` 把空字符串
    // 当作 falsy，会回落到 fixture/FALLBACK 的实际版本。所以空字符串不应当
    // 直接走 expected-unknown 短路，而应当尝试与 fixture 实际版本比对。
    // 这里 mock spawn 返回 fixture 版本，断言 status=ok（链路接通）
    mockSpawnSync.mockReturnValueOnce(spawnOk('kiro-cli 2.5.0'));
    const result = verifyInstalledKiroCliVersion({ expected: '' });
    expect(['ok', 'mismatch']).toContain(result.status);
    // 确认 spawn 真的被调（即没走 expected-unknown 短路）
    expect(mockSpawnSync).toHaveBeenCalled();
  });

  it('uses default bin `kiro-cli` when none provided', () => {
    mockSpawnSync.mockReturnValueOnce(spawnOk('kiro-cli 2.5.0'));
    verifyInstalledKiroCliVersion({ expected: '2.5.0' });
    expect(mockSpawnSync).toHaveBeenCalledWith(
      'kiro-cli',
      ['--version'],
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] }),
    );
  });

  it('passes the provided bin verbatim', () => {
    mockSpawnSync.mockReturnValueOnce(spawnOk('kiro-cli 2.5.0'));
    verifyInstalledKiroCliVersion({ expected: '2.5.0', bin: '/opt/kiro/bin/kiro-cli' });
    expect(mockSpawnSync).toHaveBeenCalledWith(
      '/opt/kiro/bin/kiro-cli',
      ['--version'],
      expect.any(Object),
    );
  });

  it('strips KIRO2CLAUDE_API_KEY from the child env (cleanKiroCliEnv used)', () => {
    // 防回归：cleanKiroCliEnv 必须被调用，否则 kiro-cli 把 API_KEY 误判为
    // "已 API key 认证"。这里通过断言 env 不含该变量 + KIRO2CLAUDE_LOGIN_*
    // 来 pin 这条契约
    process.env.KIRO2CLAUDE_API_KEY = 'sk-leak-canary';
    process.env.KIRO2CLAUDE_LOGIN_START_URL = 'https://leak.example.com';
    mockSpawnSync.mockReturnValueOnce(spawnOk('kiro-cli 2.5.0'));
    try {
      verifyInstalledKiroCliVersion({ expected: '2.5.0' });
      const call = mockSpawnSync.mock.calls[0];
      const env = call[2]?.env as NodeJS.ProcessEnv;
      expect(env.KIRO2CLAUDE_API_KEY).toBeUndefined();
      expect(env.KIRO2CLAUDE_LOGIN_START_URL).toBeUndefined();
    } finally {
      delete process.env.KIRO2CLAUDE_API_KEY;
      delete process.env.KIRO2CLAUDE_LOGIN_START_URL;
    }
  });
});

describe('getExpectedKiroCliVersion', () => {
  // 不 mock client-profile —— 用真实 fixture / FALLBACK 路径，
  // 这条测试和 static guard 互补：guard 测三方一致性，这条测取值链路

  beforeEach(() => {
    _resetKiroClientProfileCacheForTesting();
  });

  afterEach(() => {
    _resetKiroClientProfileCacheForTesting();
  });

  it('returns a semver-shaped string from the loaded profile', () => {
    const v = getExpectedKiroCliVersion();
    expect(typeof v).toBe('string');
    expect(v).toMatch(/^\d+\.\d+(\.\d+)?/);
  });
});
