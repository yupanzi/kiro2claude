# @kiro2claude/plugin-api

kiro2claude 的插件契约。零运行时:仅类型 + 一个轻量抽象基类。插件作者依赖本包,网关 runtime(`@kiro2claude/core`)提供实现。

> 本项目不发布到 npm。获取契约:clone 本仓库后在其 pnpm workspace 内以 `"@kiro2claude/plugin-api": "workspace:*"` 引用,或参照本包 `src/` 的契约类型自行实现。

## Hello-world 插件

```ts
import { BasePlugin, type PluginContext } from '@kiro2claude/plugin-api';

class HelloPlugin extends BasePlugin {
  readonly name = 'hello';
  readonly version = '1.0.0';

  register(ctx: PluginContext) {
    ctx.app.get('/hello', async () => ({ ok: true }));

    ctx.registerHook.onUsageFinish((event) => {
      event.addExtension('hello', { sawModel: event.model });
    });
  }
}

export default new HelloPlugin();
```

当包的 `package.json` 含以下 keyword 时,会被 host loader 发现:

```json
{
  "keywords": ["kiro2claude-plugin"]
}
```

## 契约面

| 类型 | 用途 |
|---|---|
| `KiroPlugin` | 插件 manifest(name / version / apiVersion / register) |
| `PluginContext` | host 提供的上下文:Fastify、logger、env、capabilities、hooks |
| `HookRegistrar` | `onUsageFinish(handler)` |
| `UsageFinishEvent` | 读上游 meta、注入扩展、覆写标准字段 |
| `UsageLimitsProvider` | capability `'usage-limits'` —— 上游配额 |
| `BasePlugin` | 固定 apiVersion=`'1.x'` 的抽象类 |

## 版本管理

- **major** 升级 = 重命名/删除导出名、类型签名变更
- **minor** 升级 = 新增可选字段、新增 hook 事件
- **patch** 升级 = 文档 / 内部重构

声明 `KiroPlugin.apiVersion = '1.x'` 保证:只要 host 仍在 1.x 线,loader 就接受该插件。

## 许可证

MIT
