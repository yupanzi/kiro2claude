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
import { findUpwards } from '../shared/paths.js';
import { reloadKiroClientProfile } from './client-profile.js';
import { cleanKiroCliEnv } from './subprocess-env.js';

interface CaptureScriptLookup {
  /** 命中的脚本绝对路径；`undefined` = 没找到 */
  script?: string;
  /** 探过的候选，找不到时进 warn；空数组 = `import.meta.url` 不可用 */
  probed: string[];
}

/**
 * 查找 `scripts/capture-kiro-cli.sh`，相对本文件位置逐级向上。走查算法与理由见
 * `shared/paths.ts` 的 `findUpwards()`；同款调用还有 `client-profile.ts` 的
 * `resolveDefaultFixturePath()` 与 `index.ts` 的 `resolvePluginRoot()`。
 */
function findCaptureScript(): CaptureScriptLookup {
  try {
    const from = path.dirname(fileURLToPath(import.meta.url));
    const { hit, probed } = findUpwards(from, path.join('scripts', 'capture-kiro-cli.sh'));
    return { script: hit?.path, probed };
  } catch {
    // import.meta.url 在某些测试环境下不可用
    return { probed: [] };
  }
}

export interface AutoCaptureOptions {
  /** 是否启用 auto-capture（`KIRO2CLAUDE_AUTO_CAPTURE_PROFILE=true`） */
  enabled: boolean;
  /** kiro-cli 可执行文件路径（`KIRO2CLAUDE_CLI_BIN`），默认 `kiro-cli` */
  kiroCliBin?: string;
  /** 覆盖捕获超时（毫秒），默认 30s */
  timeoutMs?: number;
}

export interface AutoCaptureResult {
  status: 'disabled' | 'success' | 'failed';
  message: string;
  profilePath?: string;
}

/**
 * 执行启动期 auto-capture，返回可读结果供 `index.ts` 打 info/warn。
 *
 * ★ 「从不抛异常」靠这里的 try/catch 兜实，不是靠内部每步恰好不抛：`spawnSync`
 * 参数非法时会**抛**而非落进 `result.error`，而 `index.ts` 调用处没有 try/catch，
 * 穿透一次就是整个网关启动失败——而它刷新的只是一份可选 profile，失败退回
 * fixture / FALLBACK 完全够用。反向守卫见 `test/kiro/auto-capture.test.ts`。
 */
export function runStartupAutoCapture(options: AutoCaptureOptions): AutoCaptureResult {
  if (!options.enabled) {
    return { status: 'disabled', message: 'KIRO2CLAUDE_AUTO_CAPTURE_PROFILE 未启用' };
  }
  try {
    return runCapture(options);
  } catch (e) {
    return {
      status: 'failed',
      message: `auto-capture 意外失败: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/** `runStartupAutoCapture` 的主体。允许抛——由上面那层统一兜成 `failed`。 */
function runCapture(options: AutoCaptureOptions): AutoCaptureResult {
  const bin = options.kiroCliBin ?? 'kiro-cli';
  const { script, probed } = findCaptureScript();
  if (!script) {
    return {
      status: 'failed',
      message:
        probed.length === 0
          ? '未找到 scripts/capture-kiro-cli.sh（无法定位本模块位置）'
          : `未找到 scripts/capture-kiro-cli.sh（项目布局被改动？）已逐级向上探 ${probed.length} 层: ${probed.join(' | ')}`,
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
