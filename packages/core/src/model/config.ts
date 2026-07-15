import { envSchema, envToConfig, formatEnvError } from './schemas/config-schema.js';

export interface Config {
  host: string;
  port: number;
  region: string;
  authRegion?: string;
  apiRegion?: string;
  apiKey: string;
  countTokensApiUrl?: string;
  countTokensApiKey?: string;
  countTokensAuthType: string;
  sqliteDbPath?: string;
  /**
   * 上游偶发返回「200 OK + 零内容帧」的空流(silent failure)。pre-commit 阶段
   * 检测到后,网关对同一请求最多重发这么多次来透明吸收瞬时空流。默认 2;
   * 0 = 关闭重试(立即回 503 overloaded_error,纯转发行为)。
   *
   * 注意:这是对"零重试转发代理"哲学的**有意例外**——空 200 流是下游客户端
   * 无法与真实过载区分的退化失败,网关侧吸收 1-2 次瞬时空流能显著提升可靠性。
   * 已 commit(HTTP 头已发)的尝试绝不重试。每次重试都会真实消耗上游 credit。
   */
  emptyStreamRetries: number;
  /**
   * 诊断用:设为目录路径后,某次请求最终判定为空流时(无论是否发生重试、含
   * `emptyStreamRetries=0` 的单次空响应),把原始 Claude 请求体追加写到该目录下的
   * JSONL,供事后定位确定性空流根因。留空(默认)= 不抓包。
   *
   * ⚠ 原始请求体含完整 system prompt / 对话历史 / 工具定义 / 用户输入,可能含 PII 或
   * 密钥,且以明文落盘(无脱敏 / 轮转 / 权限收紧)。仅在受控诊断环境短期启用。
   */
  captureEmptyDir?: string;
  extractThinking: boolean;
  /**
   * 启用身份覆写 directive。开启时（默认）在 system prompt 末尾追加一段
   * "你是 Claude" 的身份指令，挡住模型自报为 Amazon Q / Kiro 的路径。
   * 关闭可换回更高的 prompt cache 命中率（代价是身份会暴露）。
   */
  identityOverride: boolean;
  /**
   * 检测到下游发来的 `document` 内容块（如 Claude Code 读 PDF 产生的 base64
   * PDF）时的处理方式。Kiro 上游的 `UserInputMessage` 只有 text + images 两个
   * 通道、没有 document 通道，所以 document 块无法原样转发。
   * - `true`（默认）：把 document 块替换成一段中性的文本占位提示，请求照常
   *   成功（200）。模型由此显式得知"这里有个读不了的文档"，可以自行抽取文本
   *   后重发，而不是被静默丢弃后凭空幻觉。
   * - `false`：保留旧行为——静默丢弃 document 块、只打 warn 日志。
   */
  rejectUnsupportedDocuments: boolean;
  /**
   * Tool `description` 的最大长度(code points),超出则截断并 warn。默认 32768(32K)。
   * **不是**单 description 的 Kiro 上限——单个即便极大上游仍照收;真限制是 context
   * window(多 tool + history + system 总量撑爆窗口报 400 "Context window is full")。
   * 32K 覆盖已知最大的合法工具(Workflow)且留有充足余量,兜住畸形超大 description 独吞 context。
   * 由 `KIRO2CLAUDE_TOOL_DESCRIPTION_MAX_LEN` 配置。
   */
  toolDescriptionMaxLen: number;
  /**
   * 客户端断连时是否主动 abort 上游请求(而非 drain 到 EOF 如实计费)。默认 false。
   * 实测 Kiro 对客户端 TCP 断会停止生成计费;网关默认 drain 到 EOF 使断连仍全额
   * 计费。开启省 credit,代价是拿不到尾帧 Metering、per-request 计费记账偏低。
   * 由 `KIRO2CLAUDE_ABORT_UPSTREAM_ON_DISCONNECT` 配置。仅 Claude 端 stream 生效。
   */
  abortUpstreamOnDisconnect: boolean;
  /**
   * 泄漏工具调用文本救援（默认 `true`）。上游偶发把模型的工具调用当**纯文本**
   * 从 assistantResponseEvent 发下来（而非结构化 toolUseEvent），下游看到的
   * 就是一段 `<invoke name="Edit">...` 标记文本，工具调用等于丢失；且泄漏文本
   * 留在会话历史里会被模型模仿，同一会话内确定性复发（自我污染）。开启后：
   * - 响应侧：文本通道里格式完整的泄漏块被就地解析回真正的 tool_use block
   *   （行首 + 代码围栏外 + 工具名已注册 + 语法完整解析,四重门防误报）；
   * - 请求侧：assistant 历史文本里的泄漏块在上送前被剥掉，已污染会话自愈。
   * 详见 `claude/tool-call-text.ts` 文件头。
   */
  toolCallTextRescue: boolean;
  /**
   * 启动时是否调用 `scripts/capture-kiro-cli.sh` 从本机真实 kiro-cli 生成
   * 最新的 client profile。默认 `false`。开启后要求本机已安装并登录
   * kiro-cli（`kiro-cli whoami` 能过）。
   */
  autoCaptureProfile: boolean;
  /**
   * auto-capture 时调用的 kiro-cli 可执行文件。默认在 PATH 里找 `kiro-cli`。
   */
  kiroCliBin?: string;
  /**
   * 启动期 kiro-cli 版本不匹配时是否阻断启动。默认 `false`：mismatch / missing
   * 时仅 warn 继续启动（开发者升级 kiro-cli 的中间态会落到这里）。设为 `true`
   * 时升级为 error+exit——严格模式，确保镜像里 kiro-cli 二进制版本和 fixture
   * 期望版本一致。
   */
  requireCliVersion: boolean;
  /**
   * 首次启动 bootstrap login 的 AWS SSO start URL（如 `https://xxx.awsapps.com/start`）。
   * 设置后，当 KIRO2CLAUDE_SQLITE_DB_PATH 指向的文件不存在时，启动阶段会 spawn
   * `kiro-cli login --use-device-flow` 引导用户完成 device code 认证。
   */
  loginStartUrl?: string;
  /** bootstrap login 的 region；留空时回退到 `KIRO2CLAUDE_REGION` */
  loginRegion?: string;
  /** bootstrap login 的 license，默认 `pro` */
  loginLicense: string;
  /** bootstrap login 的整体超时（毫秒），默认 600_000 = 10 分钟 */
  loginTimeoutMs: number;
}

/** 获取有效的 Auth Region（用于 Token 刷新） */
export function effectiveAuthRegion(config: Config): string {
  return config.authRegion ?? config.region;
}

/** 获取有效的 API Region（用于 API 请求） */
export function effectiveApiRegion(config: Config): string {
  return config.apiRegion ?? config.region;
}

/**
 * 从环境变量加载服务配置。校验失败会抛出具体变量名。
 *
 * 实现由 zod 驱动（见 `schemas/config-schema.ts`）。这里只做三件事：
 * 1. 把 `process.env` 交给 schema 做类型校验和 parsing
 * 2. 失败时把 zod 的 issue 翻译成和旧手写版本一致的 `Error` 消息
 * 3. 成功时把 parsed env 映射到 `Config` 对象（env var name → camelCase）
 *
 * Config interface 本身保持不变——它是项目的公共契约，被 index.ts、
 * token-manager、provider 等多处 import 使用。
 */
export function loadConfigFromEnv(): Config {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(formatEnvError(parsed.error));
  }
  return envToConfig(parsed.data);
}
