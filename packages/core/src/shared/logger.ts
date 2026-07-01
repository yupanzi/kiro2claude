/**
 * 共享 pino logger 单例。
 *
 * 设计要点：
 * - 模块加载时立即构造：converter/token-manager 等模块会在类方法里直接使用 logger,
 *   不走依赖注入，这样避免 logger 需要沿着调用链透传。
 * - level 由 LOG_LEVEL 环境变量决定，启动后不再改变——配合 Fastify 的
 *   loggerInstance 复用同一个实例，请求日志和业务日志的 level 保持一致。
 * - 测试环境（VITEST=true）自动静默，避免污染 vitest 输出。
 * - transport 仅在 TTY 下启用 pino-pretty，避免在管道/容器场景 fork 无用 worker。
 */
import pino, { type Logger } from 'pino';
import { getRequestContext } from './request-context.js';

const isTestEnv = process.env.VITEST === 'true' || process.env.NODE_ENV === 'test';

function resolveLevel(): string {
  if (isTestEnv) return 'silent';
  return process.env.LOG_LEVEL ?? 'info';
}

/**
 * 绝不允许进日志的字段名（深度防御）。即使调用方不小心把 credentials 对象或
 * AWS SSO OIDC 响应整体 log 出来，这里列出的字段都会被 pino 替换成 `[REDACTED]`。
 *
 * pino redact paths 不支持递归通配（`**` 无效），必须逐层枚举。这里只展开到
 * 一级嵌套——项目里所有现有日志 payload 都是扁平结构或最多一层嵌套。再深的
 * 场景应当在 log 调用处手工挑字段，而不是依赖 redact 兜底。
 */
const SENSITIVE_FIELDS = [
  'accessToken',
  'refreshToken',
  'access_token',
  'refresh_token',
  'clientSecret',
  'client_secret',
  'apiKey',
];

const REDACT_PATHS: string[] = [
  ...SENSITIVE_FIELDS.flatMap((f) => [f, `*.${f}`]),
  // Fastify 默认 req 序列化不包含 headers，但自定义 serializers.req 或手工
  // `log.info({ req: request })` 会命中下面两条——保留作为显式兜底。
  'req.headers.authorization',
  'req.headers["x-api-key"]',
];

export const logger: Logger = pino({
  level: resolveLevel(),
  redact: {
    paths: REDACT_PATHS,
    censor: '[REDACTED]',
  },
  transport:
    !isTestEnv && process.stdout.isTTY
      ? { target: 'pino-pretty', options: { colorize: true, singleLine: true } }
      : undefined,
});

/**
 * 获取当前上下文的 logger。
 *
 * 在请求上下文中返回带 `reqId` 绑定的 child logger，使该请求链路上
 * 所有日志自动携带关联 ID；在启动代码或测试中返回全局 logger。
 *
 * 热路径（如流处理循环）建议在入口处 `const log = getLogger()` 缓存
 * 一次，避免重复调用 `child()`。
 */
export function getLogger(): Logger {
  const ctx = getRequestContext();
  if (ctx) return logger.child({ reqId: ctx.reqId });
  return logger;
}
