# 编写 kiro2claude 插件

插件在不改动 core 的前提下,为 kiro2claude 网关扩展额外路由与 wire 字段变更。契约由 [`@kiro2claude/plugin-api`](../packages/plugin-api/) 提供。

> 本项目不发布到 npm。获取契约的方式:clone 本仓库后在其 pnpm workspace 内开发(依赖写 `"@kiro2claude/plugin-api": "workspace:*"`),或参照 `packages/plugin-api/` 的契约类型自行实现。

## 快速上手

在 workspace 内新建你的插件包:

```jsonc
// packages/my-plugin/package.json
{
  "name": "my-plugin",
  "type": "module",
  "keywords": ["kiro2claude-plugin"],
  "dependencies": {
    "@kiro2claude/plugin-api": "workspace:*"
  },
  "peerDependencies": {
    "fastify": "^5.0.0"
  }
}
```

```ts
// src/index.ts
import { BasePlugin, type PluginContext } from '@kiro2claude/plugin-api';

class MyPlugin extends BasePlugin {
  readonly name = 'my-plugin';
  readonly version = '1.0.0';

  register(ctx: PluginContext) {
    ctx.app.get('/my-route', async () => ({ ok: true }));

    ctx.registerHook.onUsageFinish((event) => {
      event.addExtension('my_namespace', { model: event.model });
    });
  }
}

export default new MyPlugin();
```

带上 `kiro2claude-plugin` keyword 的包,会被 host 的 loader 自动发现。

## 发现机制

core 启动时扫描 **`node_modules/**`** —— 任何 `package.json` 带 `kiro2claude-plugin` keyword 的包都会被发现。内置的 first-party 插件(`metering` / `derived`)是 `@kiro2claude/core` 的依赖,因此进 `node_modules`、走同一条路径被发现,与第三方插件无区别。

加载失败的插件会被隔离:host 打一条 warn 日志并继续加载其余插件。core 的 `/claude/v1/*` 始终可用。

## 契约面

### Manifest

```ts
interface KiroPlugin {
  readonly name: string;          // 'my-plugin' —— 小写 kebab
  readonly version: string;       // '1.0.0'
  readonly apiVersion: '1.x';     // 必须声明 '1.x' 以接入 1.x host 线
  readonly dependsOn?: readonly string[];   // run-after 约束,拓扑排序
  register(ctx: PluginContext): Promise<void> | void;
}
```

继承 `BasePlugin` 可省去 apiVersion 样板。

### Context

```ts
interface PluginContext {
  readonly app: FastifyInstance;
  readonly logger: PluginLogger;
  readonly env: NodeJS.ProcessEnv;
  readonly apiKey: string;
  readonly registerHook: HookRegistrar;
  getCapability<T = unknown>(name: string): T | undefined;
}
```

### Capability(能力)

Capability 是 host 在不暴露内部类型的前提下提供的命名服务。按字符串名查询,消费方自行校验形状。

| Capability 名 | 形状 | 提供方 |
|---|---|---|
| `'usage-limits'` | `UsageLimitsProvider`(`getUsageLimits(): Promise<UsageSnapshot>`) | core |

### Hooks(钩子)

```ts
interface HookRegistrar {
  onUsageFinish(handler: (event: UsageFinishEvent) => void | Promise<void>): void;
}
```

`onUsageFinish` 在每次响应定稿时触发一次——上游流式结束后、core 写出 wire payload 之前。插件可读取 meta 键并改写 usage payload。

### Meta 键

core 把这些约定键写入每个 `UsageFinishEvent`。插件用 `event.getMeta(key)` 读取:

| 键 | 类型 | 说明 |
|---|---|---|
| `kiro.inputTokens` | number | 计费用的最终 token 数 |
| `kiro.outputTokens` | number | |
| `kiro.cacheReadTokens` | number? | 仅当上游报告时 |
| `kiro.cacheCreationTokens` | number? | 仅当上游报告时 |
| `kiro.creditsUsed` | number? | 原始 kiro credit 值(`meteringUsage`) |
| `kiro.pricedModel` | string | 供计价类插件查询价格表的模型 id |
| `kiro.upstreamRaw` | unknown | 预留;给高级插件的完整上游计量 payload |

`event.listMetaKeys()` 返回所有已填充的键。缺失的键应视为"该特性不可用"的信号。

### Wire 改写

两个语义不同的 API,按意图选用:

```ts
// 给 usage payload 加一个带命名空间的扩展字段。
// 命名空间所有权制:不会与其它插件的命名空间冲突。
event.addExtension('my_namespace', { /* ... */ });

// 覆写一个 Anthropic 标准 usage 字段。
// 若两个插件覆写同一字段,host 打 warn 日志。
event.overrideStandardField('input_tokens', 1234, 'reason for override');
```

`StandardUsageField` 为 `'input_tokens' | 'output_tokens' | 'cache_creation_input_tokens' | 'cache_read_input_tokens'`。

### 来源感知

`event.source` 标识网关路径,当前恒为:

- `'http-direct'` —— `/claude/v1/messages` 直发路径

`event.inputTokensSource` 报告输入 token 的可靠性:

- `'client-estimate'` —— 对 wire 请求体做的本地分词估算
- `'upstream-reported'` —— 来自上游的权威计数

## 契约的版本管理

`@kiro2claude/plugin-api` 遵循 semver。插件声明 `apiVersion: '1.x'` 以接入整条 1.x 线。host 拒绝大版本不匹配的插件。

当 2.0 落地(破坏性变更)时,适配后把插件的 `apiVersion` 改为 `'2.x'`。

## 示例

- [`packages/examples/echo-plugin/`](../packages/examples/echo-plugin) —— 最小契约示范
- first-party 企业插件在闭源仓,但同样基于这套契约编写。

## 许可证

`@kiro2claude/plugin-api` 本身是 MIT,所以你的插件(即便闭源)可自由依赖它。
