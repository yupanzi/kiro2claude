/**
 * Kiro CLI 客户端画像（client profile）
 *
 * 集中管理 kiro2claude 向上游伪装成 kiro-cli 时使用的请求形态：
 * - User-Agent / x-amz-user-agent 模板（带 `{service}` / `{os}` 占位符）
 * - x-amz-target / Content-Type 等静态头部
 * - body 内的语义字段（origin / agentTaskType / envState.operatingSystem 等）
 *
 * 这个模块是 kiro2claude 唯一的客户端伪装路径——`provider.ts`、
 * `token-manager.ts`、`converter.ts` 都会从这里取 UA / target / body
 * 字段，确保三端使用同一套 kiro-cli 画像，不会偷偷漂移。
 *
 * 值的加载优先级（高→低）：
 *   1. 环境变量 `KIRO2CLAUDE_CLIENT_PROFILE_PATH` 指向的 JSON 文件
 *   2. 启动期 auto-capture 临时写到 `$TMPDIR/kiro2claude-profile.json` 的文件
 *      （由 `KIRO2CLAUDE_AUTO_CAPTURE_PROFILE=true` 开启；见 `src/index.ts`）
 *   3. 仓库根目录下的 `fixtures/kiro-cli-profile.json`（由
 *      `scripts/capture-kiro-cli.sh` 从本机真实 kiro-cli 捕获生成）
 *   4. 下面写死的 `FALLBACK_PROFILE`（一次性抓包快照，kiroCliVersion 字段固定 'unknown'）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { logger } from '../shared/logger.js';
import { expandTilde } from '../shared/paths.js';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** kiro-cli 调用的上游服务标识（用于 UA 里的 `api/{service}/...`） */
export type KiroServiceId = 'codewhispererstreaming' | 'codewhispererruntime';

/** x-amz-target 所映射的操作类型 */
export type KiroTargetKey =
  | 'generateAssistantResponse'
  | 'invokeMcp'
  | 'sendTelemetryEvent'
  | 'listAvailableModels'
  | 'getProfile'
  | 'getUsageLimits';

export interface KiroClientProfile {
  /** 固定为 'kiro-cli'——这个模块只承载 kiro-cli 仿真画像 */
  readonly mode: 'kiro-cli';
  /** 捕获时的 kiro-cli 版本，仅用于日志 */
  kiroCliVersion: string;
  /** 静态头部（逐次请求都一样） */
  staticHeaders: Record<string, string>;
  /**
   * UA 模板，`{service}` 会被替换成具体的服务标识，`{os}` 会被替换成
   * 运行时平台的 kiro-cli 风格字符串（`macos` / `linux` / `windows`）。
   * 例如：`aws-sdk-rust/1.3.15 ua/2.1 api/{service}/0.1.16551 os/{os} …`
   */
  userAgent: string;
  /** 同上，对应 `x-amz-user-agent` 头 */
  xAmzUserAgent: string;
  /** x-amz-target 映射：按 target key 取实际发送的字符串 */
  amzTargets: Partial<Record<KiroTargetKey, string>>;
  /** body 里需要塞的语义字段 */
  body: {
    origin: string;
    agentTaskType: string;
    chatTriggerType: string;
    envState: {
      /** 同样支持 `{os}` 占位符，render 时按 process.platform 替换 */
      operatingSystem: string;
    };
  };
}

// ---------------------------------------------------------------------------
// Fallback —— fixture 缺失时的兜底快照
// ---------------------------------------------------------------------------

/**
 * 兜底 profile。当 fixture 文件不存在或加载失败时使用。
 * 数值来源：2026-06 kiro-cli 2.7.0 实测抓包（一次性快照，不维护同步）。
 * 例外：`x-amzn-codewhisperer-optout` 固定 `'true'`（项目隐私硬约束，绝不参与
 * 上游训练 / 遥测），不取抓包值——与 fixture 的归一化立场一致。
 *
 * **kiroCliVersion 字段固定为 'unknown'**——版本号的唯一真相源是
 * `fixtures/kiro-cli-profile.json` 的 `kiroCliVersion`。FALLBACK 触发
 * 时说明 fixture 不可用，此时显示具体版本号反而误导，'unknown' 是
 * 诚实的状态报告。
 *
 * 其它字段（userAgent / xAmzUserAgent 等）保留快照时点的具体值——它们
 * 是 kiro-cli 真实 UA 的 token，runtime 用这些值伪装时必须保持完整形态，
 * 不能 'unknown'。可以 stale，但必须 wire-format 合法。
 *
 * `{os}` 占位符意味着：这个 profile 可以同时在 macOS 和 Linux
 * 运行时使用，runtime 决定 os token。
 */
const FALLBACK_PROFILE: KiroClientProfile = {
  mode: 'kiro-cli',
  kiroCliVersion: 'unknown',
  staticHeaders: {
    'content-type': 'application/x-amz-json-1.0',
    // 隐私硬约束：始终 opt-out，绝不让对话数据被上游用于训练。与 fixture 同立场。
    'x-amzn-codewhisperer-optout': 'true',
    accept: '*/*',
    'accept-encoding': 'gzip',
  },
  userAgent:
    'aws-sdk-rust/1.3.15 ua/2.1 api/{service}/0.1.16551 os/{os} lang/rust/1.92.0 md/appVersion-2.7.0 app/AmazonQ-For-CLI',
  xAmzUserAgent:
    'aws-sdk-rust/1.3.15 ua/2.1 api/{service}/0.1.16551 os/{os} lang/rust/1.92.0 m/F app/AmazonQ-For-CLI',
  amzTargets: {
    generateAssistantResponse: 'AmazonCodeWhispererStreamingService.GenerateAssistantResponse',
    invokeMcp: 'AmazonCodeWhispererStreamingService.InvokeMCP',
    sendTelemetryEvent: 'AmazonCodeWhispererService.SendTelemetryEvent',
    listAvailableModels: 'AmazonCodeWhispererService.ListAvailableModels',
    getProfile: 'AmazonCodeWhispererService.GetProfile',
    getUsageLimits: 'AmazonCodeWhispererService.GetUsageLimits',
  },
  body: {
    origin: 'KIRO_CLI',
    agentTaskType: 'vibe',
    chatTriggerType: 'MANUAL',
    envState: {
      operatingSystem: '{os}',
    },
  },
};

// ---------------------------------------------------------------------------
// os 归一化
// ---------------------------------------------------------------------------

/**
 * 把任意 kiro-cli 风格的 os token（`macos` / `linux` / `windows`）替换成 `{os}` 占位符。
 *
 * `scripts/capture-kiro-cli.sh` 已经在写 fixture 时做了同样的替换，但手工编辑的 fixture
 * 或 FALLBACK_PROFILE 仍然可能留下具体 os——这里做兜底归一化，保证 macOS 抓的画像部署
 * 到 Linux 容器也能工作。
 */
function normalizeProfileOs(profile: KiroClientProfile): KiroClientProfile {
  const replaceOs = (s: string) => s.replace(/\bos\/(macos|linux|windows)\b/g, 'os/{os}');
  return {
    ...profile,
    userAgent: replaceOs(profile.userAgent),
    xAmzUserAgent: replaceOs(profile.xAmzUserAgent),
    body: {
      ...profile.body,
      envState: {
        ...profile.body.envState,
        operatingSystem: /^(macos|linux|windows)$/.test(profile.body.envState.operatingSystem)
          ? '{os}'
          : profile.body.envState.operatingSystem,
      },
    },
  };
}

/** 根据 Node 的 process.platform 返回 kiro-cli 风格的 os 字符串 */
function currentOsToken(): string {
  switch (process.platform) {
    case 'linux':
      return 'linux';
    case 'darwin':
      return 'macos';
    case 'win32':
      return 'windows';
    default:
      // freebsd / android 等冷门平台按 kiro-cli 默认落回 linux 最接近
      return 'linux';
  }
}

// ---------------------------------------------------------------------------
// 加载
// ---------------------------------------------------------------------------

/** 把 capture 脚本产出的原始 JSON 规范化为 `KiroClientProfile` */
function parseCaptured(raw: unknown): KiroClientProfile {
  if (!raw || typeof raw !== 'object') {
    throw new Error('profile JSON root is not an object');
  }
  const obj = raw as Record<string, unknown>;

  const kiroCliVersion = typeof obj.kiroCliVersion === 'string' ? obj.kiroCliVersion : 'unknown';
  const staticHeaders =
    obj.staticHeaders && typeof obj.staticHeaders === 'object'
      ? (obj.staticHeaders as Record<string, string>)
      : FALLBACK_PROFILE.staticHeaders;
  const userAgent = typeof obj.userAgent === 'string' ? obj.userAgent : FALLBACK_PROFILE.userAgent;
  const xAmzUserAgent =
    typeof obj.xAmzUserAgent === 'string' ? obj.xAmzUserAgent : FALLBACK_PROFILE.xAmzUserAgent;

  const amzTargets: KiroClientProfile['amzTargets'] = { ...FALLBACK_PROFILE.amzTargets };
  if (obj.amzTargets && typeof obj.amzTargets === 'object') {
    for (const [k, v] of Object.entries(obj.amzTargets as Record<string, unknown>)) {
      if (typeof v === 'string') {
        (amzTargets as Record<string, string>)[k] = v;
      }
    }
  }

  const body = { ...FALLBACK_PROFILE.body };
  if (obj.body && typeof obj.body === 'object') {
    const b = obj.body as Record<string, unknown>;
    if (typeof b.origin === 'string') body.origin = b.origin;
    if (typeof b.agentTaskType === 'string') body.agentTaskType = b.agentTaskType;
    if (typeof b.chatTriggerType === 'string') body.chatTriggerType = b.chatTriggerType;
    if (b.envState && typeof b.envState === 'object') {
      const es = b.envState as Record<string, unknown>;
      if (typeof es.operatingSystem === 'string') {
        body.envState = { ...body.envState, operatingSystem: es.operatingSystem };
      }
    }
  }

  const profile: KiroClientProfile = {
    mode: 'kiro-cli',
    kiroCliVersion,
    staticHeaders,
    userAgent,
    xAmzUserAgent,
    amzTargets,
    body,
  };

  // 不管来源是 fixture 还是 fallback，统一把 os 归一化成 `{os}` 占位符，
  // 这样 macOS 抓包出来的 fixture 部署到 Linux 也能工作。
  return normalizeProfileOs(profile);
}

function resolveDefaultFixturePath(): string | undefined {
  // 单 repo 时代 fixtures/ 在 `../../fixtures`；workspace 化后 fixtures/ 仍在
  // 仓库根（`packages/` 的上层），需要沿父目录向上找。生产态
  // (`dist/kiro/client-profile.js`) 同样适用——容器里 fixtures/ 紧挨 dist/ 一层。
  try {
    const here = fileURLToPath(import.meta.url);
    let dir = path.dirname(here);
    for (let i = 0; i < 8; i++) {
      const candidate = path.join(dir, 'fixtures', 'kiro-cli-profile.json');
      if (fs.existsSync(candidate)) return candidate;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // import.meta.url 在某些测试环境下不可用
  }
  return undefined;
}

let cached: KiroClientProfile | undefined;

/**
 * 获取当前进程生效的 client profile。首次调用会加载并缓存；
 * 后续调用直接返回缓存值。
 */
export function getKiroClientProfile(): KiroClientProfile {
  if (cached) return cached;

  const explicitPath = process.env.KIRO2CLAUDE_CLIENT_PROFILE_PATH?.trim();
  const fixturePath =
    explicitPath && explicitPath.length > 0
      ? expandTilde(explicitPath)
      : resolveDefaultFixturePath();

  if (fixturePath) {
    try {
      const text = fs.readFileSync(fixturePath, 'utf-8');
      const profile = parseCaptured(JSON.parse(text));
      logger.info(
        `Loaded kiro-cli client profile from ${fixturePath} (kiro-cli ${profile.kiroCliVersion})`,
      );
      cached = profile;
      return profile;
    } catch (e) {
      logger.warn(
        `Failed to load kiro-cli client profile from ${fixturePath}, falling back to built-in: ${e}`,
      );
    }
  } else {
    logger.info('No kiro-cli client profile fixture found, using built-in defaults');
  }

  // Fallback 也要归一化 os —— 保持与 fixture 路径同构
  cached = normalizeProfileOs(FALLBACK_PROFILE);
  return cached;
}

/** 仅用于测试：重置内部缓存，让下次 `getKiroClientProfile()` 重新加载 */
export function _resetKiroClientProfileCacheForTesting(): void {
  cached = undefined;
}

/**
 * 启动期 auto-capture 完成后调用：用新写入的 fixture 替换掉缓存，
 * 避免应用已经缓存了旧值导致新抓结果失效。
 */
export function reloadKiroClientProfile(): KiroClientProfile {
  cached = undefined;
  return getKiroClientProfile();
}

// ---------------------------------------------------------------------------
// 便捷方法：按服务填 UA
// ---------------------------------------------------------------------------

/** 把 `{service}` 和 `{os}` 占位替换成实际的 service id / 运行时平台 */
export function renderUserAgent(profile: KiroClientProfile, service: KiroServiceId): string {
  return renderPlaceholders(profile.userAgent, service);
}

export function renderXAmzUserAgent(profile: KiroClientProfile, service: KiroServiceId): string {
  return renderPlaceholders(profile.xAmzUserAgent, service);
}

/** 把 body.envState.operatingSystem 里的 `{os}` 占位符也渲染成当前平台值 */
export function renderOperatingSystem(profile: KiroClientProfile): string {
  return profile.body.envState.operatingSystem.replace('{os}', currentOsToken());
}

function renderPlaceholders(template: string, service: KiroServiceId): string {
  return template.replace('{service}', service).replace('{os}', currentOsToken());
}

/** 按 target key 取出 x-amz-target 头值；未定义时抛错 */
export function requireAmzTarget(profile: KiroClientProfile, key: KiroTargetKey): string {
  const v = profile.amzTargets[key];
  if (!v) throw new Error(`kiro-cli client profile missing amzTargets.${key}`);
  return v;
}
