/**
 * 首次启动 bootstrap：如果 kiro-cli 还未登录，spawn `kiro-cli login
 * --use-device-flow` 完成 device code 认证（Builder ID 或 IAM Identity
 * Center）。device flow URL 会实时转发到 logger（`docker logs -f` 即可
 * 看到），用户在外部浏览器完成认证后 kiro-cli 会把 SQLite DB 写到挂载
 * 卷里；后续重启直接跳过。
 *
 * **登录之外还有第二步：激活 profile**。kiro-cli device flow 只写 token /
 * device-registration 到 SQLite `auth_kv` 表，**不会**写
 * `state.api.codewhisperer.profile`——这个 state 只有当用户跑 `kiro-cli profile`
 * 并在 TUI 中回车确认后才持久化。kiro2claude 自己直接调上游不经过 kiro-cli，
 * 所以纯走 bootstrap-login 的实例永远拿不到 profileArn，进而 `/kiro/usage`
 * (上游 GetUsageLimits 严格要求 profileArn) 会 `400 Invalid profileArn.`。
 * `runBootstrapLogin` 内部在 login 成功（或 already-authenticated）后会调用
 * `activateProfile` 跑一次 PTY 包裹的 `kiro-cli profile` 把 profile ARN 写入
 * SQLite state。失败仅 log warn，不破坏 bootstrap 的 success 语义。
 *
 * 这里有两个容易踩的坑值得记录：
 *
 * 1. **KIRO2CLAUDE_API_KEY 命名空间冲突**：kiro-cli 本身也读这个环境变量，把它
 *    当作"已用 API key 认证"的标志，进而拒绝 `kiro-cli login`。所以
 *    spawn 时必须从 env 里剥掉，让它走真实的 device code flow。
 *
 * 2. **必须分配 PTY**：kiro-cli 即使传了 `--identity-provider` 和 `--region`
 *    仍然会交互式弹出 prompt（那两个参数只是预填默认值）。非 TTY 环境下
 *    prompt 直接返回空字符串，region 校验就会爆 `invalid host label`。
 *    这里用 util-linux 的 `script -qec '<cmd>' /dev/null` 包一层给
 *    kiro-cli 分配 pty，再往 stdin 灌两个换行自动确认 Start URL / Region
 *    prompt，device flow 才能真正启动。`activateProfile` 同样需要 PTY，
 *    且需要往 stdin 灌一个 `\n` 接受高亮的默认 profile。
 */

import { spawn } from 'node:child_process';

import { logger } from '../shared/logger.js';
import { expandTilde } from '../shared/paths.js';
import { cleanKiroCliEnv } from './subprocess-env.js';

/**
 * SIGTERM 发出后给 kiro-cli 子进程清理 pty 的宽限时间（毫秒）。
 *
 * `script -qec` 包裹的子进程在 SIGTERM 后需要几百毫秒把 pty 主端关干净；
 * 2 秒足以让正常情况收尾，又不会让调用方等得太久才升级到 SIGKILL。
 */
const SIGKILL_GRACE_MS = 2000;

/**
 * `kiro-cli profile` 的整体超时（毫秒）。
 *
 * 实测正常网络下 kiro-cli profile 的 `ListAvailableProfiles` + 等用户回车确认
 * 总用时 5-10 秒；90 秒是 9-18x buffer，覆盖冷连接、DNS、TLS handshake、
 * AWS 上游限流重试等极端情况。失败也只 log warn 不阻塞启动，所以 timeout
 * 偏大没有副作用。
 */
const PROFILE_ACTIVATION_TIMEOUT_MS = 90_000;

export interface BootstrapLoginOptions {
  /** 期望 kiro-cli 写 SQLite 的路径（用于日志和失败诊断，不做文件级判断） */
  sqliteDbPath: string;
  /** kiro-cli 可执行文件 */
  bin: string;
  /** AWS SSO start URL：`https://xxx.awsapps.com/start` */
  startUrl: string;
  /** AWS SSO region，例如 us-east-1 */
  region: string;
  /** license 等级，一般是 `pro` */
  license: string;
  /** 整个 device flow 的超时（毫秒）；到点后 SIGTERM → SIGKILL */
  timeoutMs: number;
}

export type BootstrapLoginStatus = 'already-authenticated' | 'success' | 'failed';

export interface BootstrapLoginResult {
  status: BootstrapLoginStatus;
  message: string;
}

export async function runBootstrapLogin(
  options: BootstrapLoginOptions,
): Promise<BootstrapLoginResult> {
  const dbPath = expandTilde(options.sqliteDbPath);

  // 用 `kiro-cli whoami` 作为权威判据——它是 kiro-cli 自己的 "logged in?" 检查，
  // 比任何文件 size 启发式都靠谱（fresh schema DB 也是 28KB，完全骗不过去）。
  if (await runWhoami(options.bin)) {
    // 已登录路径也跑一次 profile 激活：device flow 不写 state.api.codewhisperer.profile，
    // 而旧 SQLite（pre-fix 时代）可能也缺这个 state。重复跑幂等（kiro-cli 覆盖相同 ARN）。
    await activateProfile(options.bin);
    return { status: 'already-authenticated', message: '已检测到 kiro-cli 登录状态' };
  }

  return new Promise((resolve) => {
    const timeoutSec = Math.floor(options.timeoutMs / 1000);
    logger.warn('════════════════════════════════════════════════════════');
    logger.warn(`首次启动：kiro-cli 未登录 (预期 DB 路径: ${dbPath})`);
    logger.warn(`启动 kiro-cli login --use-device-flow (超时 ${timeoutSec}s)`);
    logger.warn('请在下面的日志里找到 device flow URL，在浏览器打开完成认证');
    logger.warn('════════════════════════════════════════════════════════');

    // 把 kiro-cli 命令拼成单一字符串给 script -c 执行。所有字段都要 shell-quote
    // 避免 URL 里的 query / 参数被 shell 误解（虽然目前 Start URL 不包含特殊字符，
    // 但防御式编程保险一点）。
    const innerCmd = [
      shellQuote(options.bin),
      'login',
      '--license',
      shellQuote(options.license),
      '--identity-provider',
      shellQuote(options.startUrl),
      '--region',
      shellQuote(options.region),
      '--use-device-flow',
    ].join(' ');

    // `-q` 静默 script 自身的 "Script started" / "Script done" 横幅
    // `-e` 让 script 的退出码透传 kiro-cli 的退出码（不加就永远是 0）
    // `-c` 指定要在 pty 下执行的命令
    // 最后的 /dev/null 是 typescript 文件名：我们不要录播，丢到 /dev/null
    const child = spawn('script', ['-qec', innerCmd, '/dev/null'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: cleanKiroCliEnv(),
    });

    // 灌两个回车：kiro-cli 会弹 Start URL 和 Region prompt，两者都已经被
    // `--identity-provider` / `--region` 预填成我们想要的值，回车即接受默认值。
    // `--license pro` 不再弹 License prompt，所以是精确的 2 个换行。
    try {
      child.stdin?.write('\n\n');
      child.stdin?.end();
    } catch {
      // stdin 可能已经被关闭（子进程迅速退出等），忽略
    }

    const timer = setTimeout(() => {
      logger.error(`kiro-cli login 超时 (${timeoutSec}s)，发送 SIGTERM`);
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, SIGKILL_GRACE_MS).unref();
    }, options.timeoutMs);

    forwardStream(child.stdout, 'stdout');
    forwardStream(child.stderr, 'stderr');

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ status: 'failed', message: `spawn 失败: ${err.message}` });
    });

    child.on('exit', async (code, signal) => {
      clearTimeout(timer);
      if (signal === 'SIGTERM' || signal === 'SIGKILL') {
        resolve({
          status: 'failed',
          message: `登录超时被强制终止 (${timeoutSec}s)`,
        });
        return;
      }
      if (code !== 0) {
        resolve({ status: 'failed', message: `kiro-cli login 退出码 ${code}` });
        return;
      }
      // 退出码 0 不代表真的登录成功——再跑一次 whoami 确认
      if (!(await runWhoami(options.bin))) {
        resolve({
          status: 'failed',
          message: 'kiro-cli login 退出码 0，但随后 whoami 仍报未登录',
        });
        return;
      }
      // 登录确认通过：紧跟着激活 profile（写 SQLite state.api.codewhisperer.profile）
      await activateProfile(options.bin);
      resolve({ status: 'success', message: '首次登录完成，kiro-cli 已就绪' });
    });
  });
}

/** 异步版本的 `kiro-cli whoami`：exit 0 → 已登录，其它 → 未登录 */
function runWhoami(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(bin, ['whoami'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: cleanKiroCliEnv(),
    });
    // 丢弃所有输出，只关心退出码
    child.stdout?.resume();
    child.stderr?.resume();
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });
}

/** 转发子进程流到 logger，按行切分；同时剥掉 ANSI 转义让日志可读 */
function forwardStream(stream: NodeJS.ReadableStream | null, tag: 'stdout' | 'stderr'): void {
  if (!stream) return;
  let buf = '';
  stream.on('data', (chunk: Buffer | string) => {
    buf += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
    // 避免 login 中 "Logging in..." 旋转动画占位字符堆积到极端大小——
    // 旋转阶段没有换行，buf 会一直长到下一次 kiro-cli 真正打印 \n 为止
    if (buf.length > 16 * 1024) {
      buf = buf.slice(buf.length - 4 * 1024);
    }
    for (;;) {
      const idx = buf.indexOf('\n');
      if (idx < 0) break;
      const line = stripAnsi(buf.slice(0, idx)).replace(/\r$/, '').trimEnd();
      buf = buf.slice(idx + 1);
      if (line.length > 0) {
        logger.info(`[kiro-cli:${tag}] ${line}`);
      }
    }
  });
  stream.on('end', () => {
    const tail = stripAnsi(buf).trim();
    if (tail.length > 0) {
      logger.info(`[kiro-cli:${tag}] ${tail}`);
    }
  });
}

// ESC (0x1b) 和 BEL (0x07) 的 ANSI 清洗正则。Biome 不允许正则字面量里直接写
// 控制字符，所以用 String.fromCharCode 动态构造——行为完全等价。
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const ANSI_CSI_RE = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, 'g');
const ANSI_OSC_RE = new RegExp(`${ESC}\\][^${BEL}]*${BEL}`, 'g');

/** 最小化的 ANSI 转义清理：覆盖 CSI（颜色/光标）和 OSC（窗口标题）序列 */
function stripAnsi(s: string): string {
  return s.replace(ANSI_CSI_RE, '').replace(ANSI_OSC_RE, '');
}

function shellQuote(s: string): string {
  // 单引号包裹，内部单引号用 '\'' 转义
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * 跑一次 `kiro-cli profile` 让 kiro-cli 把当前 IdC profile ARN 写入 SQLite
 * `state.api.codewhisperer.profile`。device flow 不会自动写这个 state，
 * 但 `/kiro/usage` (上游 GetUsageLimits) 严格要求 profileArn。
 *
 * 与 `runBootstrapLogin` 共用同一套 PTY 机制（`script -qec`）和 env 清理
 * (`cleanKiroCliEnv`)。stdin 灌一个 `\n` 接受 kiro-cli TUI 高亮的默认 profile。
 *
 * 失败不抛错——只 log warn 并 resolve()，因为 profile 缺失只影响 `/kiro/usage`，
 * 主路径 `/claude/v1/messages` 不需要 profileArn，不应该让 `runBootstrapLogin`
 * 因为 profile 步骤失败而退化成 failed。
 */
function activateProfile(bin: string): Promise<void> {
  return new Promise((resolve) => {
    const timeoutSec = Math.floor(PROFILE_ACTIVATION_TIMEOUT_MS / 1000);
    logger.info(`activate-profile: spawn ${bin} profile (timeout ${timeoutSec}s)`);

    const innerCmd = `${shellQuote(bin)} profile`;
    const child = spawn('script', ['-qec', innerCmd, '/dev/null'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: cleanKiroCliEnv(),
    });

    // kiro-cli profile 只弹一个 selector（"Select an IAM Identity Center profile"），
    // 不像 login 有两个 prompt（Start URL / Region），所以单 \n 即可。
    try {
      child.stdin?.write('\n');
      child.stdin?.end();
    } catch {
      // 子进程已退出，忽略
    }

    const timer = setTimeout(() => {
      logger.warn(`activate-profile: 超时 (${timeoutSec}s)，发送 SIGTERM`);
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, SIGKILL_GRACE_MS).unref();
    }, PROFILE_ACTIVATION_TIMEOUT_MS);

    forwardStream(child.stdout, 'stdout');
    forwardStream(child.stderr, 'stderr');

    child.on('error', (err) => {
      clearTimeout(timer);
      logger.warn(
        `activate-profile: spawn 失败: ${err.message}（仅影响 /kiro/usage，主 API 不受影响）`,
      );
      resolve();
    });

    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (signal === 'SIGTERM' || signal === 'SIGKILL') {
        logger.warn(`activate-profile: 被超时强制终止（仅影响 /kiro/usage，主 API 不受影响）`);
      } else if (code !== 0) {
        logger.warn(
          `activate-profile: kiro-cli profile 退出码 ${code}（仅影响 /kiro/usage，主 API 不受影响）`,
        );
      } else {
        logger.info('activate-profile: kiro-cli profile 已写入 SQLite state');
      }
      resolve();
    });
  });
}
