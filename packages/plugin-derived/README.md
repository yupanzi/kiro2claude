# plugin-derived

> **first-party runtime plugin**(作为 `@kiro2claude/core` 的依赖随镜像默认启用):通过 [`@kiro2claude/plugin-api`](../plugin-api/) 接入 core gateway,把 Kiro 原始 credit 反演成 Anthropic 风格的 token 拆分。plugin 名(`derived`)与注入的 wire 字段(`usage.kiro_derived`)一致。

## 解决什么问题

Kiro 上游 `meteringUsage` 只给一个聚合 credit 数,缺失下游 Anthropic 客户端期望的 `cache_creation_input_tokens` / `cache_read_input_tokens` 拆分。本 plugin 在 `onUsageFinish` hook 里读 `'kiro.creditsUsed'` meta key,基于回归拟合常数(`KIRO_K_IN` / `KIRO_K_OUT`)反演 cache 字段,通过 `overrideStandardField` 或 `addExtension('kiro_derived', ...)` 注入。

## 依赖

无 `dependsOn`。反演只读 host 注入的 `'kiro.creditsUsed'` meta key(任何路径都存在),不依赖 `metering` 插件的 wire 输出,故与 metering 的加载顺序无关。

## 关键真相源

| 想看 | 文件 |
|---|---|
| KiroPlugin manifest + hook 注册 | `src/index.ts` |
| 反演公式 / 数学常数 `KIRO_K_IN` `KIRO_K_OUT` `KIRO_CACHE_READ_RATIO` | `src/derive.ts` |
| 成本倍率(`KIRO2CLAUDE_COST_MULTIPLIER`)数学边界 + 不亏公式推导 | [`docs/cost-multiplier.md`](./docs/cost-multiplier.md) |

## markup 入口

```bash
KIRO2CLAUDE_COST_MULTIPLIER=1.0   # 默认;客户看到 = Anthropic 公示价
# 0.67 = 任意请求形态数学上不亏(详见 docs/cost-multiplier.md §3)

# cache 反演比例旋钮:未设 = 测量默认 0.5276。调高 → 展示 cache_read 变大 +
# 下游成本变低;只接受 [0,1),聚合封顶 ~87.7%(详见 docs/cost-multiplier.md §「cache 比例旋钮」)
#KIRO2CLAUDE_CACHE_READ_RATIO=0.5276
```

## 测试

```bash
pnpm --filter @kiro2claude/plugin-derived test
```
