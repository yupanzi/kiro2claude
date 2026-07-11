# 成本倍率（`KIRO2CLAUDE_COST_MULTIPLIER`）参考

本文档说明 `finalCostUsd` 的计算公式、数学上"不亏"的倍率边界，以及推荐取值。

## 1. 计算路径

```
finalCostUsd = max(claudeEquivalentCostUsd × μ, credits × 0.04)
                                                ^^^^^^^^^^^^^^^
                                                floor 兜底（applyFloor）
```

- `claudeEquivalentCostUsd` 由 `src/derive.ts` 基于 Anthropic 公示 token 价 + cache 拆分反演得出
- `μ` = `KIRO2CLAUDE_COST_MULTIPLIER`
- floor 用 `credits × 0.04`（KIRO_OVERAGE_RATE）兜底，确保最终值不低于"假设上游全 overage 计费"的金额

下文讨论的"不亏边界"假设**关闭 floor**，仅看算法路径 `claudeUsd × μ` 是否覆盖上游真实成本。

## 2. 不亏的数学边界

### 2.1 不等式

设上游真实计费率 `r_up ∈ {0.02, 0.04}`，要不亏：

$$
\text{claudeUsd} \times \mu \geq \text{credits} \times r_{up}
$$

代入拟合恒等式 `credits × 0.04 = k_in · P_in · T_in + k_out · P_out · T_out`，并把 `claudeUsd` 写成 cache 模式系数 c 的线性组合：

$$
\text{claudeUsd} = c \cdot P_{in} T_{in} + P_{out} T_{out}, \quad c \in [0.10, 1.25]
$$

| 状态 | c 取值 | 含义 |
|---|---:|---|
| `ok_derived` | [0.10, 1.25] | 主路径：non-read→cache_creation(1.25×)、read→cache_read(0.10×)；c 随命中率从全命中 0.10 连到冷启动 1.25。（含纯 100% 命中 = 0 写入的情形，故状态名取中性的 `ok_derived` 而非 `cache_write`）|
| `below_threshold` / `unknown_model` | 1.00 | uncached only（整段 < 最小可缓存前缀 / 未知模型，不缓存）|

设 `r = (P_out · T_out) / (P_in · T_in)`，化简得：

$$
\mu \geq \frac{k_{in} + k_{out} \cdot r}{c + r} \cdot \frac{r_{up}}{0.04}
$$

### 2.2 求 sup

`∂μ/∂r` 的符号 = `sign(k_out · c − k_in)`。由于 `c ≥ 0.10 > k_in / k_out = 0.0829`，**全域内 ∂μ/∂r > 0**——sup 在 `r → ∞`（纯 output）取得：

$$
\boxed{\mu_{\sup} = k_{out} = 0.6705 \text{（worst case = 上游 overage）}}
$$

上游 in-plan 时 sup ÷ 2 = **0.3353**。

## 3. 不亏倍率边界表

下表汇总各种极端请求形态在**关闭 floor** 时的最小不亏倍率。常数：`k_in = 0.0556`，`k_out = 0.6705`。

| 场景 | μ 下限 | 推导 | 类别 |
|---|---:|---|---|
| **任意请求形态都不亏（上游 overage）** | **0.6705** | `k_out`（r → ∞，纯 output）| 数学绝对上限 |
| **任意请求形态都不亏（上游 in-plan）** | **0.3353** | `k_out / 2` | 数学绝对上限 |
| input 主导 + 全 cache_read（h→1，全命中）| 0.5560 | `k_in / 0.10` | 极端 |
| input 主导 + uncached（below_threshold）| 0.0556 | `k_in` | 极端 |
| input 主导 + 全 cache_creation（h→0，冷启动）| 0.0445 | `k_in / 1.25` | 极端 |
| 回放数据集 p99（input/output ≈ 350:1）| 0.4779 | per-row p99 | 经验值 |
| 回放数据集 p99（按 in-plan 计）| 0.2390 | per-row p99 | 经验值 |
| 回放数据集 p95 | 0.4061 | per-row p95 | 经验值 |
| 总量持平 overage 账单 | 0.0949 | 加权平均 | 经验值 |
| 总量持平 in-plan 账单 | 0.0474 | 加权平均 | 经验值 |

> 经验值行基于 `KIRO_CACHE_READ_RATIO = 0.5276` 反演(2026-07 重校准)在离线回放数据集上
> 回放。相比旧 0.1 反演,更多 input 被归入 cache_read(0.10×),Σ claudeUsd 下降 ~38%,故
> 持平倍率上移(0.0587→0.0949 / 0.0294→0.0474)。数学边界行只依赖价格系数,不受反演分母影响。

> **经验值行待重算(2026-07 拆分修复)**：上表 p99/p95/持平 是「非命中→uncached」旧拆分下的
> 回放结果。`claude -p` 实测真实 Claude Code 确认主路径 non-read→**cache_creation**
> (1.25×，见 `derive.ts` Step 3) → Σ claudeUsd 上升、持平/百分位 μ **下移**;精确值需在回放数据集上按
> 新拆分重跑回放(回放数据未随仓发布,故此处不给具体数字)。数学边界行(0.6705/0.3353/0.5560/0.0556/
> 0.0445)只依赖价格系数,不受拆分影响,仍有效。

## 4. 实务推荐

| 业务目标 | 推荐 μ |
|---|---:|
| 下游看到 = Anthropic 公示价（默认）| **1.0** |
| **任何请求形态都数学上不亏** | **0.67** |
| 95% 流量层面安全 + 保留可见折扣 | 0.50 |
| 当前流量结构下 99% 单笔不亏（不可推广到 output-heavy 场景）| 0.48 |
| 仅总量持平上游账单 | 0.05 ~ 0.10 |

设 μ < 0.67 时 floor 会兜底——服务**不会**真的赔钱，但 `finalCostUsd` 的语义会从"Anthropic 公示价 × μ"退化为"按 overage rate 计费"，multiplier 旋钮失去意义。

## 4b. cache 比例旋钮（`KIRO2CLAUDE_CACHE_READ_RATIO`）

反演分母 `(1 − ratio)` 可经此 env 覆盖；未设 = 测量默认 `0.5276`（重发探针实测，
活体 opus/sonnet 均 ≈0.5278）。这是**显式的展示/策略旋钮，不是重校准**——调高它让
展示的 `cache_read` 占比变大、同时压低 `claudeEquivalentCostUsd`（cache_read 按 0.1×
计价），wire 数字偏离上游真实计费。只接受 `[0, 1)`，`≥1` 拒绝（分母归零/变负）。

离线回放数据集实测代价（相对测量默认 0.5276）：

| ratio | 聚合缓存率 | Σ claudeEquivalentUsd | 说明 |
|---|---:|---:|---|
| 0.5276（默认） | 64.2% | 基线 | 忠实反演 |
| 0.71 | 70.6% | −12% | 放大器 1.63× |
| 0.99 | 84.8% | −40% | 47× 放大，真 miss 被吹成满命中 |
| →1（极限） | 87.7% | — | 冷启动 input 恒不进分子 → **到不了 99%** |

> **Σ/百分比列待重算(2026-07 拆分修复)**：`Σ claudeEquivalentUsd`(基线)与
> −12%/−40% 是「非命中→uncached(1×)」旧拆分下的回放值。新拆分为
> non-read→**cache_creation(1.25×)**(见 `derive.ts` Step 3),移动 token 的价差从
> 1×→0.1×(10×)变成 1.25×→0.1×(12.5×):基线 Σ 更高、调高 ratio 的降幅更陡;精确
> 值需在回放数据集上按新拆分重跑回放(回放数据未随仓发布,故此处不给具体数字)。
> **聚合缓存率列(64.2/70.6/84.8/87.7%)只依赖 cacheRead 反演、与拆分无关,仍有效。**

> 无论怎么调都封顶 ~87.7%：约 14% 请求是满价冷启动（`tEffIn ≥ T_total`，
> `cacheRead=0`），ratio 旋钮对这块无效。要真正抬高命中率只能抬上游真实命中
> （长会话 / TTL 内 / 前缀稳定），反演会如实跟随。

## 5. 监控

- **k_out 是不亏门槛本身**。如果上游 Kiro 调整 output 端折扣（k_out 上升），`μ_sup` 会同步抬高，0.67 这条线会失守
- 常数重拟依赖离线拟合脚本（未随仓发布）：在离线回放数据集上回放校验公式
- `estimatedCacheHitRatio` 异常聚集需**先排除旋钮**:仅当 `KIRO2CLAUDE_CACHE_READ_RATIO` **未设(测量默认)**时,长期贴 0 或贴 1 才指向上游 cache 策略变了、常数需重拟。若旋钮被显式调高(如 0.99),命中率贴 1 是**设计内**的放大效果(§4b),不是上游异常。另注:冷启动 + `below_threshold` + `unknown_model` 恒报 0,§4b 估约 14% 冷启动占比使「部分贴 0」为常态基线——判断上游漂移时看**真实全命中 resend 是否仍反演出 ~1.0**(见下条)比看聚集更可靠
- **`KIRO_CACHE_READ_RATIO` 是反演分母**（缓存命中相对 miss 的 Kiro 价格比，数值与测量出处见 `src/derive.ts` 该常数的 jsdoc）。如果上游调整缓存折扣，`estimatedCacheHitRatio` 会整体漂移（真实全命中请求不再反演出 ~1.0），需要重跑重发探针实验重拟

## 6. 相关源码

- 公式实现：`src/derive.ts`
- 常数来源：离线拟合校准
- 离线回放数据集回放校验
- 上游费率：`getUsageLimits` 接口直接返回 `inPlanRate=$0.02`、`overageRate=$0.04`（关系恒等 `overage = 2 × inPlan`）
