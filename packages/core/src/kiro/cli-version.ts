/**
 * kiro-cli 版本校验
 *
 * 期望版本的 single source of truth 是 `fixtures/kiro-cli-profile.json` 的
 * `kiroCliVersion` 字段——通过 `getKiroClientProfile()` 读出来。
 *
 * 这个模块只负责"读期望 + 比对本机"。三处版本字符串（fixture / Dockerfile ARG /
 * FALLBACK_PROFILE）的一致性由 `test/static/kiro-cli-version-lock.test.ts` 静态守卫；
 * 启动期是否阻断由 `src/index.ts` 根据 `KIRO2CLAUDE_REQUIRE_CLI_VERSION` 决定。
 *
 * 设计要点：
 * - `spawnSync` 同步风格，与 `auto-capture.ts` / `bootstrap-login.ts` 保持一致——
 *   启动期"加载完成"时点确定。
 * - 用 `cleanKiroCliEnv()` 剥掉 `KIRO2CLAUDE_API_KEY` / `KIRO2CLAUDE_LOGIN_*`——
 *   kiro-cli 会把前者误判为"已 API key 认证"，影响 `--version` 之外的命令但
 *   这里统一处理，行为可预测。
 * - 不抛异常——所有失败路径都收敛到 `{ status: 'missing' }`，调用方决定 warn/fail。
 *   细分 spawn 超时 / 非零退出 / stdout 解析失败对启动期决策没意义。
 */

import { spawnSync } from 'node:child_process';

import { getKiroClientProfile } from './client-profile.js';
import { cleanKiroCliEnv } from './subprocess-env.js';

export type CliVersionCheckResult =
  | { status: 'ok'; expected: string; actual: string }
  | { status: 'missing'; expected: string; bin: string }
  | { status: 'mismatch'; expected: string; actual: string }
  | { status: 'expected-unknown'; bin: string };

/** 从当前 client profile 读期望版本（fixture / FALLBACK_PROFILE） */
export function getExpectedKiroCliVersion(): string {
  return getKiroClientProfile().kiroCliVersion;
}

/**
 * 解析 `kiro-cli --version` 的 stdout，取最后一个 token。
 * 典型格式：`kiro-cli 2.5.0\n` → `2.5.0`。
 *
 * 容忍：trailing whitespace / 多个空格 / 多余尾部 token（取最后一个非空）。
 * 失败时返回 `undefined`，调用方应当回到 missing 状态。
 */
export function parseKiroCliVersionOutput(stdout: string): string | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  const tokens = trimmed.split(/\s+/);
  const last = tokens[tokens.length - 1];
  return last && last.length > 0 ? last : undefined;
}

export interface VerifyInstalledKiroCliVersionOptions {
  /** 可执行文件路径，默认 `kiro-cli`（在 PATH 中查找） */
  bin?: string;
  /** 期望版本；省略时从 client profile 取 */
  expected?: string;
  /** `kiro-cli --version` 超时，默认 5s */
  timeoutMs?: number;
}

/**
 * spawn `<bin> --version` 与期望版本比对。
 *
 * 返回值是 discriminated union：
 * - `ok`               —— 本机版本与期望一致
 * - `missing`          —— spawn 失败（不在 PATH / 超时 / 非零退出 / stdout 解析失败）
 * - `mismatch`         —— spawn 成功但版本号与期望不符
 * - `expected-unknown` —— 期望版本不可用（fixture 缺失，FALLBACK 返回 'unknown'）
 *
 * 调用方根据是否需要 kiro-cli（auto-capture / bootstrap-login 是否开启）以及
 * `KIRO2CLAUDE_REQUIRE_CLI_VERSION` 决定 warn / error+exit。
 */
export function verifyInstalledKiroCliVersion(
  opts?: VerifyInstalledKiroCliVersionOptions,
): CliVersionCheckResult {
  const bin = opts?.bin?.trim() || 'kiro-cli';
  const expected = opts?.expected?.trim() || getExpectedKiroCliVersion();
  const timeoutMs = opts?.timeoutMs ?? 5000;

  // 期望版本是 sentinel —— fixture 没加载到（FALLBACK_PROFILE.kiroCliVersion = 'unknown'）。
  // 这是配置问题（fixture 缺失），不是版本不一致问题，单独走 expected-unknown 路径。
  if (expected === 'unknown' || expected === '') {
    return { status: 'expected-unknown', bin };
  }

  const result = spawnSync(bin, ['--version'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
    env: cleanKiroCliEnv(),
  });

  // spawn 失败：可执行文件不存在 / 不可执行 / 超时 / 非零退出
  if (result.error || result.status !== 0) {
    return { status: 'missing', expected, bin };
  }

  const stdout = result.stdout?.toString('utf-8') ?? '';
  const actual = parseKiroCliVersionOutput(stdout);
  if (!actual) {
    return { status: 'missing', expected, bin };
  }

  if (actual === expected) {
    return { status: 'ok', expected, actual };
  }
  return { status: 'mismatch', expected, actual };
}
