/**
 * 启动期 auto-capture 钩子
 *
 * 设置了 `KIRO2CLAUDE_AUTO_CAPTURE_PROFILE=true` 时，服务启动阶段调用
 * `scripts/capture-kiro-cli.sh` 从本机真实 kiro-cli 二进制抓一次最新
 * 的 client profile，写到 `$TMPDIR` 的固定文件，然后把
 * `KIRO2CLAUDE_CLIENT_PROFILE_PATH` 指向它并刷新 client-profile 缓存。
 *
 * 设计要点：
 * - 失败只 warn，不挂服务 —— 抓取失败时仍然能用仓库里的 fixture 或内置 fallback。
 * - 用 child_process.spawnSync 同步跑，与项目其它启动期加载（config / credentials）
 *   的同步风格一致，让「启动完成」这一时点确定。
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { logger } from '../shared/logger.js';
import { reloadKiroClientProfile } from './client-profile.js';
import { cleanKiroCliEnv } from './subprocess-env.js';

/** 查找 `scripts/capture-kiro-cli.sh`，相对本文件位置（src/ 或 dist/） */
function findCaptureScript(): string | undefined {
  try {
    const here = fileURLToPath(import.meta.url);
    const root = path.resolve(path.dirname(here), '..', '..');
    const candidate = path.join(root, 'scripts', 'capture-kiro-cli.sh');
    if (fs.existsSync(candidate)) return candidate;
  } catch {
    // import.meta.url 在某些测试环境下不可用
  }
  return undefined;
}

export interface AutoCaptureOptions {
  /** 是否启用 auto-capture（`KIRO2CLAUDE_AUTO_CAPTURE_PROFILE=true`） */
  enabled: boolean;
  /** kiro-cli 可执行文件路径（`KIRO2CLAUDE_CLI_BIN`），默认 `kiro-cli` */
  kiroCliBin?: string;
  /** 覆盖捕获超时（毫秒），默认 30s */
  timeoutMs?: number;
}

/**
 * 执行启动期 auto-capture。无论成功与否都返回一个可读的结果，调用方
 * （`src/index.ts`）据此打 info/warn，从不抛异常阻塞启动。
 */
export function runStartupAutoCapture(options: AutoCaptureOptions): {
  status: 'disabled' | 'success' | 'failed';
  message: string;
  profilePath?: string;
} {
  if (!options.enabled) {
    return { status: 'disabled', message: 'KIRO2CLAUDE_AUTO_CAPTURE_PROFILE 未启用' };
  }

  const bin = options.kiroCliBin ?? 'kiro-cli';
  const script = findCaptureScript();
  if (!script) {
    return {
      status: 'failed',
      message: '未找到 scripts/capture-kiro-cli.sh（项目布局被改动？）',
    };
  }

  // 文件名不带 pid：每次启动覆盖同一个位置，避免 /tmp 里累积
  const outPath = path.join(os.tmpdir(), 'kiro2claude-profile.json');
  const timeoutMs = options.timeoutMs ?? 30_000;

  logger.info(`运行 auto-capture: ${script} --out ${outPath} --bin ${bin}`);

  const result = spawnSync('bash', [script, '--out', outPath, '--bin', bin], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
    env: cleanKiroCliEnv(),
  });

  if (result.error) {
    return {
      status: 'failed',
      message: `无法启动 capture 脚本: ${result.error.message}`,
    };
  }
  if (result.status !== 0) {
    const stderr = result.stderr?.toString('utf-8') ?? '';
    return {
      status: 'failed',
      message: `capture 脚本退出码 ${result.status}: ${stderr.trim() || '(无 stderr)'}`,
    };
  }
  let outSize: number;
  try {
    outSize = fs.statSync(outPath).size;
  } catch {
    return {
      status: 'failed',
      message: `capture 脚本返回 0 但未产出 profile 文件: ${outPath}`,
    };
  }
  if (outSize === 0) {
    return {
      status: 'failed',
      message: `capture 脚本返回 0 但产出 profile 文件为空: ${outPath}`,
    };
  }

  // 指向新生成的 profile，然后刷新 client-profile 缓存
  process.env.KIRO2CLAUDE_CLIENT_PROFILE_PATH = outPath;
  try {
    const profile = reloadKiroClientProfile();
    return {
      status: 'success',
      message: `auto-capture 完成，kiro-cli ${profile.kiroCliVersion}`,
      profilePath: outPath,
    };
  } catch (e) {
    return {
      status: 'failed',
      message: `auto-capture 产物无法解析: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
