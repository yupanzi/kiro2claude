/**
 * kiro2claude 主入口
 *
 * 职责：加载配置和凭据（全部来自环境变量），启动 Fastify 服务，挂载
 * Claude 兼容路由和 Kiro 用量透传路由。
 *
 * kiro2claude 只支持 kiro-cli device code authentication
 * （Builder ID 或 IAM Identity Center，详见
 * <https://kiro.dev/docs/cli/authentication/>）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertApiVersion,
  type PluginContext,
  type UsageLimitsProvider,
} from '@kiro2claude/plugin-api';
import Fastify from 'fastify';

import { runStartupAutoCapture } from './kiro/auto-capture.js';
import { runBootstrapLogin } from './kiro/bootstrap-login.js';
import { verifyInstalledKiroCliVersion } from './kiro/cli-version.js';
import { loadCredentialsFromEnv } from './kiro/credentials-loader.js';
import { KiroProvider } from './kiro/provider.js';
import { SingleTokenManager } from './kiro/token-manager.js';
import { loadConfigFromEnv } from './model/config.js';
import { CapabilityRegistry, discoverPlugins, HookBus } from './plugin-host/index.js';
import { registerClaudeRoutes } from './routes/claude.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerKiroRoutes } from './routes/kiro.js';
import { registerOpenAiRoutes } from './routes/openai.js';
import { getLogger, logger } from './shared/logger.js';
import {
  generateReqId,
  getRequestContext,
  requestContextStorage,
} from './shared/request-context.js';
import { initCountTokensConfig } from './token.js';

/**
 * Resolve the directory whose `node_modules/` holds the plugin packages. All
 * first-party plugins (metering, derived) are ordinary dependencies of core, so
 * they resolve from node_modules exactly like third-party npm plugins.
 *
 * Must work across layouts whose nesting depth differs, so a fixed `'..','..'`
 * from cwd cannot serve all (cwd is also user-mountable, e.g. the container's
 * WORKDIR=/data):
 *   - dev:        <repo>/packages/core/{src,dist}/index → node_modules under packages/core
 *   - container:  /app/dist/index.js                    → root=/app
 *
 * Strategy: derive candidate roots from THIS module's location (stable, not the
 * mountable cwd), then pick the first that actually holds a node_modules/.
 * `KIRO2CLAUDE_PLUGIN_ROOT` overrides everything; the cwd-based legacy path is a
 * last-resort fallback for test envs where import.meta.url is unavailable.
 */
function resolvePluginRoot(env: NodeJS.ProcessEnv): string {
  if (env.KIRO2CLAUDE_PLUGIN_ROOT) {
    return path.resolve(env.KIRO2CLAUDE_PLUGIN_ROOT);
  }
  try {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    // dev needs up-1..up-3 (packages/core/{src,dist} → repo); container needs
    // up-1 (/app/dist → /app). Probe each depth for a node_modules/.
    const candidates = [
      path.resolve(dir, '..'),
      path.resolve(dir, '..', '..'),
      path.resolve(dir, '..', '..', '..'),
    ];
    for (const c of candidates) {
      if (fs.existsSync(path.join(c, 'node_modules'))) return c;
    }
  } catch {
    // import.meta.url unavailable in some test environments — fall through.
  }
  return path.resolve(process.cwd(), '..', '..');
}

async function main(): Promise<void> {
  // 1. 加载服务配置
  let config: ReturnType<typeof loadConfigFromEnv>;
  try {
    config = loadConfigFromEnv();
  } catch (e) {
    logger.error(`加载配置失败: ${(e as Error).message}`);
    process.exit(1);
  }

  // 1.5. 首次启动 bootstrap：SQLite DB 不存在且设置了 KIRO2CLAUDE_LOGIN_START_URL 时，
  // spawn `kiro-cli login --use-device-flow` 引导用户在外部浏览器完成 device
  // code 认证。认证成功后才有 SQLite DB 可以加载
  if (config.sqliteDbPath && config.loginStartUrl) {
    const bootstrap = await runBootstrapLogin({
      sqliteDbPath: config.sqliteDbPath,
      bin: config.kiroCliBin ?? 'kiro-cli',
      startUrl: config.loginStartUrl,
      region: config.loginRegion ?? config.region,
      license: config.loginLicense,
      timeoutMs: config.loginTimeoutMs,
    });
    if (bootstrap.status === 'failed') {
      logger.error(`bootstrap-login 失败，无法继续启动: ${bootstrap.message}`);
      process.exit(1);
    }
    logger.info(`bootstrap-login: ${bootstrap.message}`);
  }

  // 2. 加载 kiro-cli SQLite 凭据
  let loaded: ReturnType<typeof loadCredentialsFromEnv>;
  try {
    loaded = loadCredentialsFromEnv();
  } catch (e) {
    logger.error(`加载凭据失败: ${(e as Error).message}`);
    process.exit(1);
  }

  const apiKey = config.apiKey;

  // 3. 构建 SingleTokenManager 和 KiroProvider
  let tokenManager: SingleTokenManager;
  try {
    tokenManager = new SingleTokenManager(config, loaded.credentials, loaded.source);
  } catch (e) {
    logger.error(`创建 Token 管理器失败: ${(e as Error).message}`);
    process.exit(1);
  }

  const kiroProvider = new KiroProvider(tokenManager);

  // 3.5. 启动期 auto-capture（仅当 KIRO2CLAUDE_AUTO_CAPTURE_PROFILE=true 时生效）
  const autoCapture = runStartupAutoCapture({
    enabled: config.autoCaptureProfile,
    kiroCliBin: config.kiroCliBin,
  });
  if (autoCapture.status === 'success') {
    logger.info(`auto-capture: ${autoCapture.message} -> ${autoCapture.profilePath}`);
  } else if (autoCapture.status === 'failed') {
    logger.warn(`auto-capture 失败，继续使用仓库 fixture / 内置 fallback: ${autoCapture.message}`);
  }

  // 3.6. 本机 kiro-cli 版本校验
  //
  // 期望版本来自 fixtures/kiro-cli-profile.json 的 kiroCliVersion（版本号的
  // 唯一真相源）。本机 kiro-cli 二进制版本和期望版本不一致时：
  //   - 默认 warn 继续启动（开发者升级 kiro-cli 的中间态会落到这里）
  //   - 设置 KIRO2CLAUDE_REQUIRE_CLI_VERSION=true 升级为 error+exit（严格模式）
  //
  // missing 状态（本机找不到 kiro-cli）只在需要它的路径下才告警——纯 SQLite
  // 直读模式无需本机二进制，静默通过。
  //
  // expected-unknown 状态（fixture 未加载，FALLBACK_PROFILE 返回 'unknown'）：
  // 这是 fixture 缺失的配置问题，不是版本不一致。默认 warn，严格模式 fail——
  // 因为严格模式语义是"我要校验"，无法校验时也应当 fail。
  const versionCheck = verifyInstalledKiroCliVersion({ bin: config.kiroCliBin });
  const needsCli = Boolean(config.autoCaptureProfile || config.loginStartUrl);
  switch (versionCheck.status) {
    case 'ok':
      logger.info(`kiro-cli 版本校验通过: ${versionCheck.actual}`);
      break;
    case 'missing':
      if (needsCli) {
        const msg =
          `本机找不到 kiro-cli (bin=${versionCheck.bin})，` +
          `但 auto-capture/bootstrap-login 需要它（期望版本 ${versionCheck.expected}）`;
        if (config.requireCliVersion) {
          logger.error(`${msg}，KIRO2CLAUDE_REQUIRE_CLI_VERSION=true 阻断启动`);
          process.exit(1);
        }
        logger.warn(msg);
      }
      break;
    case 'mismatch': {
      const msg =
        `本机 kiro-cli ${versionCheck.actual} 与期望 ${versionCheck.expected} 不一致 ` +
        `(参见 fixtures/kiro-cli-profile.json)`;
      if (config.requireCliVersion) {
        logger.error(`${msg}，KIRO2CLAUDE_REQUIRE_CLI_VERSION=true 阻断启动`);
        process.exit(1);
      }
      logger.warn(msg);
      break;
    }
    case 'expected-unknown': {
      const msg =
        `kiro-cli 期望版本未知 (fixture 未加载，FALLBACK_PROFILE 返回 'unknown')，` +
        `无法做版本校验`;
      if (config.requireCliVersion) {
        logger.error(`${msg}，KIRO2CLAUDE_REQUIRE_CLI_VERSION=true 阻断启动`);
        process.exit(1);
      }
      logger.warn(msg);
      break;
    }
  }

  // 4. 启动自检：主动调 acquireContext() 触发一次 lazy refresh 路径
  //
  // 动机：AWS SSO OIDC 的 refresh_token 服务端 TTL 对客户端不可见，所以
  // "refresh_token 还活着吗"只能通过实际发一次 refresh 请求来判断。启动时主动
  // 做一次，能把"token 失效"这类故障从"用户第一个请求到来时"提前到"服务启动
  // 时刻"暴露，便于运维诊断。失败不硬挂（log warn）——后续请求仍会走 lazy
  // refresh 路径，给故障恢复留出窗口。
  try {
    await tokenManager.acquireContext();
    logger.info('启动自检完成：凭据就绪');
  } catch (e) {
    logger.warn(
      `启动自检未能获取可用凭据：${(e as Error).message}。将依赖请求到来时的 lazy refresh。`,
    );
  }

  // 4.4. 初始化 plugin host 基础设施（HookBus + CapabilityRegistry）。
  //      具体的第一方企业插件能力作为插件在第 8 步加载。
  const hookBus = new HookBus();
  const capabilities = new CapabilityRegistry();

  // 暴露 'usage-limits' capability：第一方插件通过 ctx.getCapability
  // 取，避免直接依赖 SingleTokenManager 这个 kiro-specific 类。
  const usageLimitsProvider: UsageLimitsProvider = {
    async getUsageLimits() {
      const raw = await tokenManager.getUsageLimits();
      const breakdown = raw.usageBreakdownList?.[0];
      const limit = breakdown?.usageLimitWithPrecision ?? breakdown?.usageLimit ?? 0;
      const current = breakdown?.currentUsageWithPrecision ?? breakdown?.currentUsage ?? 0;
      return { limit, current };
    },
  };
  capabilities.register('usage-limits', usageLimitsProvider);

  // 5. 初始化 count_tokens 配置
  initCountTokensConfig({
    apiUrl: config.countTokensApiUrl,
    apiKey: config.countTokensApiKey,
    authType: config.countTokensAuthType,
  });

  // 6. 构建 Fastify 应用
  //
  // `forceCloseConnections: 'idle'` —— 优雅关闭时立即关掉 idle keep-alive
  // 连接，同时让 active 请求自然完成。设 `true` 会强杀活动请求，导致长流
  // 响应被无故切断；留空（false）则 idle 连接也会被保留，SIGTERM 后 app.close
  // 可能被一个空闲连接卡住超时。`'idle'` 是两者之间的正解。
  const app = Fastify({
    loggerInstance: logger,
    bodyLimit: 50 * 1024 * 1024, // 50 MB
    forceCloseConnections: 'idle',
  });

  // 6.5. 请求级上下文 hook：生成 reqId、包裹 AsyncLocalStorage、记录请求完成日志
  app.addHook('onRequest', (request, reply, done) => {
    const reqId = (request.headers['x-request-id'] as string) || generateReqId();
    reply.header('x-request-id', reqId);
    requestContextStorage.run({ reqId, startTime: Date.now() }, done);
  });

  app.addHook('onResponse', (_request, reply, done) => {
    const ctx = getRequestContext();
    if (ctx) {
      const duration = Date.now() - ctx.startTime;
      getLogger().info({
        msg: 'request completed',
        statusCode: reply.statusCode,
        duration_ms: duration,
      });
    }
    done();
  });

  // 7. 路由注册
  //
  // 三组路由各自走独立的 `fastify.register` 作用域，prefix 和 preHandler
  // 都由这里集中定义，让 index.ts 成为所有 URL 路径的唯一索引。每个 plugin
  // 作用域内的 preHandler 只影响该作用域内的路由，所以 health（无鉴权）
  // 和 Claude/Kiro（有鉴权）之间是互不影响的。
  await app.register(registerHealthRoutes);

  // 两组下游兼容路由共用同一套 handler 依赖，只在 /api 作用域多打一个请求级
  // 标记（见下）——所以 deps 抽成一个 const 复用，避免两处漂移。
  const claudeRouteDeps = {
    apiKey,
    kiroProvider,
    extractThinking: config.extractThinking,
    identityOverride: config.identityOverride,
    rejectUnsupportedDocuments: config.rejectUnsupportedDocuments,
    toolDescriptionMaxLen: config.toolDescriptionMaxLen,
    abortUpstreamOnDisconnect: config.abortUpstreamOnDisconnect,
    emptyStreamRetries: config.emptyStreamRetries,
    captureEmptyDir: config.captureEmptyDir,
    toolCallTextRescue: config.toolCallTextRescue,
    hookBus,
  };

  // 完整 wire 端点：usage 含 plugin 注入的扩展（如 `usage.kiro_metering`）。
  await app.register(
    async (instance) => {
      await registerClaudeRoutes(instance, claudeRouteDeps);
    },
    { prefix: '/claude/v1' },
  );

  // 「去泄漏」镜像端点：同一套 handler，但作用域 preHandler 打上请求级标记
  // `stripPluginUsage`，让 `buildClaudeUsagePayload` 跳过 plugin 注入的 usage 扩展
  // ——产出纯标准 Anthropic usage（无 `kiro_metering` 等 `kiro_*` 字段）。metering
  // 计量仍照常累计，只是不上 wire。Claude SDK client 把 base URL 指到 `.../api/claude`
  // 即可（SDK 自动补 `/v1/messages`）。
  await app.register(
    async (instance) => {
      instance.addHook('preHandler', (_request, _reply, done) => {
        const ctx = getRequestContext();
        if (ctx) ctx.stripPluginUsage = true;
        done();
      });
      await registerClaudeRoutes(instance, claudeRouteDeps);
    },
    { prefix: '/api/claude/v1' },
  );

  // OpenAI Chat Completions 兼容端点。与 `/claude/v1` + `/api/claude/v1` 同构:
  // `/openai/v1` = 完整 usage,`/api/openai/v1` = 去泄漏镜像(同一 stripPluginUsage
  // 标记)。deps 复用 claudeRouteDeps(与 Claude 完全同集)。OpenAI SDK 把 base_url
  // 指到 `.../openai/v1` 即自动补 `/chat/completions`。
  await app.register(
    async (instance) => {
      await registerOpenAiRoutes(instance, claudeRouteDeps);
    },
    { prefix: '/openai/v1' },
  );

  await app.register(
    async (instance) => {
      instance.addHook('preHandler', (_request, _reply, done) => {
        const ctx = getRequestContext();
        if (ctx) ctx.stripPluginUsage = true;
        done();
      });
      await registerOpenAiRoutes(instance, claudeRouteDeps);
    },
    { prefix: '/api/openai/v1' },
  );

  await app.register(
    async (instance) => {
      await registerKiroRoutes(instance, { apiKey, tokenManager });
    },
    { prefix: '/kiro' },
  );

  // 8. Plugin discovery + registration.
  //
  // Source: node_modules packages with keyword 'kiro2claude-plugin'. First-party
  // bundled plugins (metering, derived) are core dependencies, so they resolve
  // from node_modules exactly like third-party plugins.
  //
  // Plugin failures are isolated; the host still boots with the remaining
  // plugins. Capabilities (e.g. 'usage-limits') are already registered above.
  const repoRoot = resolvePluginRoot(process.env);
  // Base context shared across all plugins. `registerHook` is bound per-plugin
  // inside the loop below so hook callbacks land in the hook bus under their
  // actual plugin name — that's the only context field that varies per plugin.
  const pluginCtxBase: Omit<PluginContext, 'registerHook'> = {
    // Cast: core configures Fastify with pino's Logger type, but plugin-api
    // declares the default FastifyBaseLogger surface (no pino leakage).
    // Structurally the methods plugins use are identical.
    app: app as unknown as PluginContext['app'],
    logger: getLogger() as unknown as PluginContext['logger'],
    env: process.env,
    apiKey,
    getCapability: <T>(name: string) => capabilities.get<T>(name),
  };
  try {
    const discovered = await discoverPlugins({
      nodeModulesRoot: path.join(repoRoot, 'node_modules'),
      logger: pluginCtxBase.logger,
    });
    for (const { plugin } of discovered) {
      const scopedCtx: PluginContext = {
        ...pluginCtxBase,
        registerHook: {
          onUsageFinish: (handler) => hookBus.registerUsageFinish(plugin.name, handler),
        },
      };
      try {
        // 拒绝 apiVersion 与 host 主版本不兼容的 plugin(契约保证;loader 发现期不校验
        // 取值,只校验是字符串)。抛错落入下方 catch → 跳过该 plugin 并 warn,不崩 boot。
        assertApiVersion(plugin);
        await plugin.register(scopedCtx);
        getLogger().info({ plugin: plugin.name, version: plugin.version }, 'plugin registered');
      } catch (err) {
        getLogger().warn(
          { plugin: plugin.name, err: err instanceof Error ? err.message : String(err) },
          'plugin registration failed',
        );
      }
    }
    if (discovered.length === 0) {
      getLogger().info('no plugins discovered — running with bare core');
    }
  } catch (err) {
    getLogger().error(
      { err: err instanceof Error ? err.message : String(err) },
      'plugin discovery failed — running with bare core',
    );
  }

  // 10. 启动服务器
  const addr = `${config.host}:${config.port}`;
  const maskedKey = `${apiKey.slice(0, Math.floor(apiKey.length / 2))}***`;

  logger.info(`启动 Claude API 端点: ${addr}`);
  logger.info(`API Key: ${maskedKey}`);

  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (e) {
    logger.error(`服务器启动失败: ${(e as Error).message}`);
    process.exit(1);
  }

  // 打印完整注册的路由树；`listen` 之后 avvio 的 register 队列必然已排空。
  const routeTree = app.printRoutes({ commonPrefix: false });
  logger.info('可用路由:');
  for (const line of routeTree.split('\n')) {
    if (line.length > 0) logger.info(`  ${line}`);
  }

  // 11. 优雅关闭
  const shutdown = async () => {
    logger.info('正在关闭服务器...');
    try {
      await app.close();
    } catch (e) {
      logger.error(`关闭服务器失败: ${(e as Error).message}`);
    }
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// ============================================================================
// 全局异常兜底
// ============================================================================
//
// `unhandledRejection` —— 后台异步操作泄漏的 Promise 拒绝。**不 exit**：
//   对长连接代理服务来说，单次异步泄漏比整个进程崩掉更温和。记录日志让运维
//   看到就够了。
//
// `uncaughtException` —— 同步异常穿透到 event loop。**必须 exit**：
//   Node 官方文档明确 warn 进程状态从此刻起不可推理（可能已经泄漏文件描述符、
//   锁、或持有不一致的内存状态），继续运行只会让故障更隐蔽。记录 fatal 后
//   `process.exit(1)`，让 Docker/systemd 的 restart 策略接管。
process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'unhandledRejection');
});

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaughtException');
  process.exit(1);
});

main().catch((e) => {
  logger.error({ err: e }, '致命错误');
  process.exit(1);
});
