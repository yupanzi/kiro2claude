# CLAUDE.md

给在此仓库工作的 Claude Code 看的**规范与地图**,只给指针不复述。使用者介绍与 HTTP 路由见 [README.md](./README.md);plugin 指南见 [docs/PLUGIN-DEVELOPMENT.md](./docs/PLUGIN-DEVELOPMENT.md);每条踩坑的来龙去脉与实测证据见 [docs/PITFALLS.md](./docs/PITFALLS.md);手工探针见 [packages/core/test/manual/README.md](./packages/core/test/manual/README.md)。

## 项目一句话

把 kiro-cli(Kiro 后端)包装成 **Claude + OpenAI 双协议代理**:Claude 全系 + GPT-5.6(Sol / Terra / Luna),两者走**完全相同**的上游、两个协议端点都可用。**MIT**:core 管 HTTP 直发 + plugin 加载;内置插件 `metering`(计量)、`derived`(credit 反演)与第三方插件一样只经 [`@kiro2claude/plugin-api`](./packages/plugin-api/) 接入。运行时 Node ≥ 22 / TypeScript / ESM NodeNext / Fastify / pnpm workspace。

## Monorepo 边界

```
packages/plugin-api/            契约包:types + abstract base class,0 runtime deps
packages/core/                  gateway runtime:HTTP 路由、plugin loader、token manager
packages/plugin-metering/       注入 usage.kiro_metering
packages/plugin-derived/        反演 Kiro credit → Anthropic token,注入 usage.kiro_derived
packages/examples/echo-plugin/  公开示范 plugin
packages/core/test/manual/      手工探针(非 CI;部分打真实上游计费),清单见其 README
tools/claude-code/ tools/codex/ 两款真实 CLI 的 Docker harness(非 runtime)
docker/Dockerfile               单一发布镜像(core + 两个内置插件)
.github/workflows/              ci.yml 全 workspace lint+typecheck+test;release.yml 见「发版」
```

所有插件都是**普通 npm 包**:loader 只扫 `node_modules/**` 里带 `kiro2claude-plugin` keyword 的包,内置与第三方走同一机制(契约不加 tier 字段)。

## 架构地图

```
packages/core/src/
├── index.ts            入口;config → login → creds → SingleTokenManager → plugin-host → Fastify → 路由 → discoverPlugins
│                       /api/{claude,openai}/v1 = 去泄漏镜像(preHandler 打 stripPluginUsage 标记)
├── token.ts            count_tokens 本地估算 + 远程回退
├── model/config.ts     ★ 环境变量单一真相源
├── shared/             横切层(鉴权 / wire-format errors / logger / paths / reqId-ALS),不依赖 kiro claude
├── plugin-host/        ★ 插件契约实现:hook-bus(按注册顺序执行 onUsageFinish)/ usage-finish-event /
│                       capability-registry / loader(keyword 扫描 + 拓扑排序)
├── routes/             HTTP 装配层;唯一可同时 import claude 和 kiro 的地方
├── kiro/               上游适配层(token-manager / client-profile / provider / retry-executor / parser);
│                       SingleTokenManager 经 'usage-limits' capability 暴露给 plugin
└── claude/             下游兼容层
    ├── handlers.ts           路由 handler 薄胶水
    ├── converter.ts          Claude→Kiro 请求;system 拼进首条 user;末尾 user 连串 = currentMessage;不造 assistant 轮次
    ├── stream-handler.ts     流式 handler;deferred commit + 空流有界重试
    ├── non-stream-handler.ts 非流式 handler;判空/重试镜像
    ├── non-stream-reduce.ts  reduceKiroResponse:claude & openai 非流式共用的纯函数
    ├── stream.ts             SSE 状态机;buildClaudeUsagePayload / buildKiroUsageFinishEvent / isMeteringLost 唯一定义点
    ├── empty-capture.ts      空流类型 + 诊断抓包
    ├── tool-call-text.ts     泄漏工具调用的检测/救援/剥除;★ 头注释 = 全部红线
    ├── error-mapper.ts       classifyProviderError + mapProviderError
    ├── models-catalog.ts     静态模型列表
    ├── stream/legacy-thinking-decoder.ts  ★ legacy `<thinking>` 文法唯一定义点,流式/非流式共用
    └── schemas/ · request-validator.ts · websearch.ts · types.ts · converter/ · stream/

openai/                 OpenAI 兼容层(import claude/kiro/shared,不被反向依赖);Chat Completions + Responses(Codex)。
│                       语义核心复用 claude(StreamContext + reduceKiroResponse + provider),只做协议翻译
├── freeform-tool.ts        ★ `type:"custom"` 工具替身编解码的单一真相源
├── stream-transport.ts / non-stream-transport.ts  chat+responses 共用脚手架
├── converter.ts · response-stream.ts · response-nonstream.ts · handlers · error-mapper · models-catalog
└── responses/          Responses API:converter(input items / instructions / additional_tools / namespace 展开)、
                        response-stream(严格语义事件序列)、response-nonstream、handlers、types
```

**依赖方向**(不得反向):`shared → kiro → claude → openai → routes → index`;第三方 plugin 只依赖 `@kiro2claude/plugin-api`。`openai/ → claude/` 靠 review 约束,biome `noRestrictedImports` 只管两个内置插件。

## 找东西去哪里(地图速查)

| 想看 | 真相源 |
|---|---|
| `KIRO2CLAUDE_*` 环境变量 | `model/schemas/config-schema.ts` + `.env.example` |
| Plugin 契约 / 怎么写 plugin | `packages/plugin-api/src/types.ts`;`docs/PLUGIN-DEVELOPMENT.md` + `packages/examples/echo-plugin/` |
| 支持哪些模型 / 加模型要同改哪几处 | `claude/models-catalog.ts` + `mapModel()`;同改清单见 PITFALLS「支持哪些模型」 |
| 原生 reasoning / context window / effort 映射 | `MODELS_WITH_NATIVE_REASONING`、`getContextWindowSize()`、`mapThinkingToEffort()`(`converter.ts`);OpenAI `reasoning_effort` 见 `openai/converter.ts` |
| legacy `<thinking>` 怎么解析 | `claude/stream/legacy-thinking-decoder.ts` 头注释;流式 `processLegacyThinkingItems` 与非流式 `non-stream-reduce.ts` 必须同源 |
| Codex 的工具怎么进来 / freeform 双向 | `openai/responses/converter.ts` `collectTools` + `expandNamespaces`;`openai/freeform-tool.ts`;下行经 `customToolNames` 还原 |
| OpenAI usage / Responses reasoning | `openai/` 直读 reducer 原始 token(踩坑「OpenAI prompt_tokens」);Claude thinking → `reasoning` item,GPT 加密 reasoning 不产 |
| 身份覆写 | `IDENTITY_OVERRIDE_DIRECTIVE` + `KIRO2CLAUDE_IDENTITY_OVERRIDE`(默认关,原因见该常量头注释)|
| 网关往对话里塞了哪些文本 | `buildSystemPrefix` + `foldSystemIntoFirstUserMessage`(Kiro 消息层,首条 user 最前、图例之前);其余 = `converter.ts` 文件头导出常量 + `prependImageLegend` / `imagePlaceholder` / `generateThinkingPrefix` |
| 客户端中途插入的内容会不会丢 | 只走 `foldSystemMessages` + 末尾 user 连串 = 当前轮;其它 role 400 `InvalidRole`。验证工具见 manual README |
| 上游 status → 下游 status / 容量不足三形态 | `claude/error-mapper.ts` + `shared/upstream-status.ts`;`MODEL_CAPACITY_REASONS` 头注释(`kiro/provider-error.ts`)|
| kiro-cli 伪装 wire / fixture 升版本 | `fixtures/kiro-cli-profile.json` + `kiro/client-profile.ts`;`scripts/capture-kiro-cli.sh` → commit `fixtures/`,版本号由 `.releaserc.json` 从 fixture 派生 |
| 重试头 | `applyRetryHeaders`(`kiro/retry-executor.ts`)唯一 owner;三个调用点与红线见 PITFALLS「重试头」;守卫 `test/kiro/retry-headers.test.ts` |
| plugin 注入 `usage` / `kiro.*` meta 键 | `event.addExtension` / `overrideStandardField`;meta 键 = `buildKiroUsageFinishEvent`,文档 `plugin-api/src/types.ts` `getMeta` + PLUGIN-DEVELOPMENT「Meta 键」,守卫 `test/static/usage-meta-contract.test.ts`,**加键同改三处** |
| 上游已扣费但没记账 | `isMeteringLost`(`claude/stream.ts`),估规模前读其头注释的口径偏差 |
| 上游「说完了」还是「说到一半」 | `metadataEvent` 出现过 = 唯一信号(`kiro/model/events/base.ts`);**别用它的 `stopReason`** |
| 流里有没有真实内容 / tool_use 没发完 | `computeHasContent`(`claude/stream.ts`);`StreamContext.hasIncompleteToolUse()`,别退回 `stop_reason === 'tool_use'` |
| 孤儿 tool_use | `synthesizeMissingToolResults`(`claude/converter.ts`)补 isError tool_result,不删 tool_use |
| `/api/*` 怎么剥 plugin 扩展 | `index.ts` 的 `/api/*` register + `buildClaudeUsagePayload` |
| 链路里仍不能保证的 | README「已知限制」;别拿全绿单测当链路无损的证据 |
| kiro-cli 重试 / web_search 执行位置 / 工具与图片 wire / Responses 字节量 / InputValidationError 排查 | PITFALLS「上游与客户端的实测事实」 |
| 发版 / commit 规范 | `CONTRIBUTING.md`「版本与发布」「提交规范」(篇幅 + 脱敏);`.releaserc.json`、`.gitmessage` |

## 不可违反的规范

### 架构 / 插件边界

- 依赖方向单向;所有 plugin(含内置)**必须**经 `@kiro2claude/plugin-api` 集成,**禁止** import core 内部模块(biome 拦截)
- 新增路由:core 自有放 `routes/`;plugin 用 `ctx.app.register(...)`。新增 `KIRO2CLAUDE_*` env:core 进 `config-schema.ts`,plugin 自己读 `ctx.env`

### Plugin 契约

- 契约类型是 SemVer 公开 API,破坏性改动 = major bump;不暴露 kiro-specific 类型,用 capability 命名查询
- `addExtension(namespace, value)` 命名空间所有权;`overrideStandardField(name, value, reason)` 显式 override
- `apiVersion: '1.x'` 必须匹配 host 主版本;`dependsOn` 拓扑排序,hook 注册顺序 = 调用顺序

### TypeScript / 模块系统

- 根 `tsconfig.base.json` 共享 strict + NodeNext + composite;相对导入**必须**带 `.js`;永远 `import`
- 启动期 I/O 保持同步(`readFileSync`),让「加载完成」时点确定

### 错误流转

- 上游非 2xx → `KiroHttpError(status, msg)`;转换失败 → `ConversionError`(`UnsupportedModel` / `EmptyMessages` / `InvalidRole`)→ 400
- `ProviderErrorKind` 新增 variant 由 tsc 强制穷尽:`claude/error-mapper.ts` 用 `assertNever`,`kiro/provider-error.ts` 的 `defaultMessage` 靠结构穷尽(`kiro/` 不能 import `claude/`)
- 408/429/503/504 原样透传(含 Retry-After);500/501/502/505+ 与 401/403 压成 502
- ★ **例外,先于上条判**:5xx 的 body 点名容量不足 → 503 `overloaded_error`;施加点在 `retry-executor.ts` 的 5xx 分支而**非** `classifyErrorBody`,只作用于 5xx。判别子在 `MODEL_CAPACITY_REASONS` 头注释;为什么见 PITFALLS「容量不足的 5xx」
- 402 配额判定(`isMonthlyRequestLimitBody`)**故意**宽松,**别与上条统一**;反向守卫 `test/kiro/provider-error.test.ts`

### 响应文案中性化

- 日志可用 `upstream` / `Kiro`;响应 body 只说 `service`;绝不把 `err.message` 或上游 body 拼进响应;新增 mapper case **必须**加 leak-detection 断言
- 同一底线也管提交历史,禁写字段见 `CONTRIBUTING.md`「脱敏」

### 日志(四条由 `test/static/` 守卫钉住,理由见 PITFALLS「日志四条守卫的理由」)

- **每请求只打一行**:`disableRequestLogging: true`,只留 `index.ts` `onResponse` 那条。守卫 `request-log-single-line.test.ts`
- **业务字段一律 snake_case**(框架自带的 `msg`/`err`/`level`/`time`/`reqId`/`statusCode` 除外)。守卫 `log-field-casing.test.ts`
- **一个指标只有一个 owner**:`capacity_reason` 只在 `kiro/retry-executor.ts` 的 429 与 5xx 分支记。守卫 `log-capacity-reason.test.ts`
- ★ **网关自己造成的结果不记 `error`**:加标志位降 `info`;真实故障仍是 `error`,改豁免须同时写反向守卫

### 原生 reasoning 路径互斥

- 走原生 reasoning 时**同时禁用**请求侧 `<thinking_mode>` 前缀注入与响应侧 `<thinking>` 标签扫描

### 代码风格

`throw` + 自定义 `Error` 子类;`T | undefined` 而非 `null`,用 `??` / `?.`;多形态用 discriminated union;异步互斥用手写 `AsyncMutex`;时间戳 `Date.now()` 毫秒;键值集合 `Map`;二进制 `Buffer` + 自维护 offset、默认大端序;JSON 字段 camelCase;配置启动期同步读 `process.env`。

## 高频踩坑陷阱

> 每条 = 红线 + 真相源;为什么、实测证据、复跑入口在 [docs/PITFALLS.md](./docs/PITFALLS.md) 同名条目。回指写 `踩坑「关键词」`,改标题两处同步。

### 运行时基础设施

- **Fastify logger**:用 `loggerInstance: pinoInstance`,不是 `logger:`
- **Parser Result 类型守卫**:用 `'frame' in result`,不是 `result.ok`
- **CRC32 符号位**:`crc-32` 返回有符号 32-bit,必须 `>>> 0`
- **AWS Event Stream 全 big-endian**:`readUInt32BE` / `readInt16BE` / `readBigInt64BE`
- **AsyncMutex 必要性**:JS 单线程,但 `await` 会让出控制权
- **SIGTERM**:Docker 用 `tini` 作 PID 1,`forceCloseConnections: 'idle'` 是优雅关闭关键

### 鉴权 · 凭据 · 构建部署

- **AWS SSO OIDC wire**:Smithy 协议,请求/响应都是 camelCase
- **API key 比较**:必须 `crypto.timingSafeEqual`
- **SQLite 凭据不可跨机器**:refresh 可能返回新 refreshToken 写回 SQLite
- **better-sqlite3 跨架构**:Mac → Linux 容器构建必须在 builder 阶段编译

### 请求转换 · 工具(Claude→Kiro)

- ★ **注入文本**:system 没有 wire 通道,`buildSystemPrefix` → `foldSystemIntoFirstUserMessage` 在 Kiro 消息层拼进首条 user;网关不造任何 assistant 轮次;中途插入的 `role:system` 只走 `foldSystemMessages`;其它 role 400 `InvalidRole`;OpenAI 侧只提升开头的 system/developer。守卫 `test/static/no-fabricated-turns.test.ts` + `converter.test.ts` system 折叠组
- **core 不发 cachePoint**:Kiro 静默忽略 `cache_control`,`convertTools` 只输出 `{toolSpecification}`
- **convertTools 剥 tool-search marker**:无 `input_schema` 的 marker 上送会 400,`isToolSearchTool()` 丢掉、忽略 `defer_loading`
- **工具调用文本泄漏**:`KIRO2CLAUDE_TOOL_CALL_TEXT_RESCUE` 双向兜底;红线全在 `claude/tool-call-text.ts` 头注释,**改前必读**
- **tool description cap**:`KIRO2CLAUDE_TOOL_DESCRIPTION_MAX_LEN` 只截单个畸形 description,总量靠 Kiro 的 context-window 400
- ★ **多图归属只靠顺序**:`canonicalizeToolResultOrder` + `imagePlaceholder` + `prependImageLegend` 三件套缺一不可。守卫 `test/claude/converter-{tool-result-order,image-placeholder,image-legend}.test.ts`

### 流式传输 · 断连 · 空流

- **空流有界重试**:仅 pre-commit、最多 `KIRO2CLAUDE_EMPTY_STREAM_RETRIES` 次;确定性空流单次定案不耗预算,判据 `sawBillableWork()` 不是 `hasContent()`。红线在 `stream-handler.ts` / `stream.ts` / `empty-capture.ts` 头注释
- ★ **截断 tool_use 必须阻止残缺调用到达客户端**:`pendingToolCalls` 收到 `isComplete` 才上 wire;参数解不出 JSON 即协议错误,**绝不回退 `{}`**;`isComplete` 必须是 boolean;Responses 映射 `incomplete`,不可改 `completed`。守卫 `test/claude/truncated-tool-use.test.ts` + `transport-integrity.test.ts`
- **断连计费**:默认 drain 全额计费;`KIRO2CLAUDE_ABORT_UPSTREAM_ON_DISCONNECT` 省 credit 但 `metering_lost` 恒真
- ★ **write 背压不是断连**:`write()` 返 false 只是等 `'drain'`;存活只看 `destroyed`/`writableEnded`/抛错;`disconnect_source` 别退回单一布尔。守卫 `test/claude/backpressure.test.ts` + `test/static/sse-backpressure-contract.test.ts`
- ★ **legacy thinking 文法**:开标签只认「行首」,两边都错过;文法与终态判定流式/非流式必须同源。真相源 `legacy-thinking-decoder.ts` 头注释;守卫 `test/claude/legacy-thinking-{decoder,nonstream}.test.ts`
- **原生 reasoning 的空帧**:锁 native 模式,但不打断已开的 thinking 块、不 flush 救援检测器。真相源 `processReasoningContent` 头注释
- **上游杀卡住的流**:判别子是 token/s 不是总时长;网关无治本手段,缓解 `armDrainGrace`
- ★ **读坏的 body 是失败的响应**:读流异常 / CRC·JSON 解码失败 / 残留半帧走与上游错误帧同一条路径;缺 Metering 不算损坏,缺 `metadataEvent` 是未完成不是故障;损坏的 body 不可伪装成空流蹭重试。守卫 `test/claude/transport-integrity.test.ts` + `test/kiro/parser/decoder.test.ts`
- ★ **帧边界 EOF**:有内容 + 无错误 + 无 `metadataEvent` → `max_tokens`(Responses `incomplete`);只取「出现过」不用其 `stopReason`;fixture 的正常完成必须带尾帧(`completedFrames()`)。守卫 `test/claude/clean-eof-terminal.test.ts` + `conversation-content-integrity.test.ts`

### 多模型 · GPT · OpenAI · Codex

- **GPT 完全相同上游**:唯一差异 `modelId`;`processReasoningContent` 把「见过原生帧」与「有内容可 surface」分开记,合并即错
- **OpenAI prompt_tokens**:是输入总量,`openai/` usage 直接读 reducer 原始 token、绕过 `buildClaudeUsagePayload`
- **Codex 只说 Responses**:编码器红线在 `openai/responses/response-stream.ts` 头注释,改前先跑真实 Codex(`tools/codex/`)
- ★ **Codex code mode**:工具在 `input[0]` 的 `additional_tools`,判别只看字段在不在;`functions` / `collaboration` namespace 展开与 `namespace` 写回见 `expandNamespaces` 头注释;`agent_message` 三类必转(`convertAgentMessage`);freeform 流式须缓冲到 block 结束。守卫 `test/openai/responses/subagent-wire.test.ts` + `test/static/freeform-tool-contract.test.ts`
- **Messages hosted WebSearch**:`websearch.ts` 保留协议与失败语义,同名普通 function 不能被劫持。守卫 `test/claude/websearch-transport.test.ts`
- **Codex 侧无法用 web search**:要支持是新功能,不是转发能解决的
- **GPT credit 锚定**:`credits×0.04` 是唯一真值,**绝不给 GPT 填 `CLAUDE_PRICE_USD_PER_TOK`**;红线在 `gptCreditAnchoredBreakdown` 头注释

### 错误流转 · 容量事件诊断

- ★ **跨模型对照**:「网关报内部错误」先同容器跨模型对照,再看分钟时间轴、请求形状、region/tier;别按主机/账号先分桶;有界重试无效,缓解是切模型;日志看 `capacity_reason`

## 测试

- vitest,每个 workspace 包自带 `vitest.config.ts`;pre-commit 强制 `biome check + pnpm -r typecheck + pnpm -r test`
- **e2e 不进 CI**(`packages/core/test/e2e/`,消耗真实 token),也不在任何 tsconfig 里,改它要单独 tsc
- **`test/scripts/` 测的是 shell 脚本**:假 `docker` 记录调用参数,断言命令行长什么样;不碰本机 `.env`、凭据、镜像
- **默认测试模型 `claude-opus-5`**,只管真打上游的那几层;单测里的 `claude-opus-4-6` 是 fixture 常量,别全局替换
- 固定测试图 `packages/core/test/fixtures/images/`:`test-small.png` 内联;`test-large.png` 超阈值走 tool_result 回传,converter 须提升到 `images`
