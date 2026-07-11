# plugin-metering

> **免费 runtime 插件**(MIT)。通过 [`@kiro2claude/plugin-api`](../plugin-api/) 接入 core 网关,注册 `onUsageFinish` 钩子,累加 Kiro credit 用量并注入 `usage.kiro_metering`。
>
> 随 core 镜像打包(core 依赖 `@kiro2claude/plugin-metering`),**默认启用**——每个部署都会上报每请求的 credit。

## 解决什么问题

Kiro 上游每次返回原始 credit 数,但没有"我已经用了多少 / 还剩多少"的快照。本 plugin 启动期通过 `usage-limits` capability 拉初始 quota(`getUsageLimits`),每次请求 hook 累加 credit,在 `usage` 里注入 `kiro_metering`:给下游本次消耗的 credit 计数(`unit` / `usage`)以及累计用量与配额(`accumulated` / `limit`)。

本 plugin 只做 credit **计量**,不做定价。USD 成本由独立的计价插件负责([`@kiro2claude/plugin-derived`](../plugin-derived/),MIT、随 core 镜像内置;它单独读 `kiro.creditsUsed` host meta、输出 `usage.kiro_derived`),两者互不依赖。

## env 开关

```bash
KIRO2CLAUDE_METERING_DISABLE=true   # 默认启用;设为 true 才关闭
```

默认启用(被 loader 发现即生效)。设置 `KIRO2CLAUDE_METERING_DISABLE=true` 时本 plugin idle(register 时立刻 return,不注册 hook,不影响 wire 输出)。若 `usage-limits` capability 不可用或上游返回零 quota,也会优雅 idle。

## wire 输出

插入到响应 `usage` 下的 `kiro_metering` 扩展字段(名字与 plugin 名一致)。`usage` 是**本次请求**消耗的 credit(绝非累计值);`accumulated` 才是累计:

```jsonc
{
  "usage": {
    "input_tokens": 1234,
    "output_tokens": 567,
    "kiro_metering": {
      "unit": "credit",
      "unitPlural": "credits",
      "usage": 0.737,          // 本次请求消耗的 credits
      "accumulated": 12.5,     // 启动至今累计 credits
      "limit": 20000           // plan 配额 (credits)
    }
  }
}
```

USD 成本不在这里——需要金额时读 `usage.kiro_derived`(由 [`@kiro2claude/plugin-derived`](../plugin-derived/) 注入,随 core 镜像内置)。

## 关键真相源

| 想看 | 文件 |
|---|---|
| KiroPlugin manifest + hook 注册 + wire 注入 | `src/index.ts` |
| 累加逻辑 / `MeteringResult` 形状 | `src/counter.ts` |

## 已知限制

**单实例部署专用**:state 在内存里(`MeteringCounter` 类),多副本部署会各自计数;重启清零并在下次启动时从 `getUsageLimits` 快照重新同步。要跨副本持久化需自己再上 Redis 或文件 store。

## 测试

```bash
pnpm --filter @kiro2claude/plugin-metering test
```
