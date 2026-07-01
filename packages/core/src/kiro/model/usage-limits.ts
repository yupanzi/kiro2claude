/**
 * 使用额度查询响应 (`GET https://q.{region}.amazonaws.com/getUsageLimits`)
 *
 * 这是 AWS CodeWhisperer / Q Developer 返回的上游协议形态，由 kiro2claude 的
 * `getUsageLimits()` (src/kiro/token-manager.ts) 消费。本接口**只声明了项目当前
 * 真正使用的字段**，响应里还有若干额外字段在 TypeScript `as` 断言下被静默丢弃 ——
 * 需要扩展功能（用户标识、超额计费、多币种等）时直接往这里加即可。
 *
 * ## 已知完整响应结构（实测抓取，us-east-1，KIRO POWER 订阅，2026-04-10）
 *
 * ```json
 * {
 *   "daysUntilReset": 0,
 *   "limits": [],
 *   "nextDateReset": 1777593600,
 *   "overageConfiguration": {
 *     "overageLimit": null,
 *     "overageStatus": "DISABLED"          // "DISABLED" | "ENABLED"
 *   },
 *   "subscriptionInfo": {
 *     "overageCapability": "OVERAGE_CAPABLE",
 *     "subscriptionManagementTarget": "MANAGE",
 *     "subscriptionTitle": "KIRO POWER",   // 展示名：KIRO FREE / KIRO POWER / ...
 *     "type": "Q_DEVELOPER_STANDALONE_POWER", // 机读 SKU
 *     "upgradeCapability": "UPGRADE_INCAPABLE"
 *   },
 *   "totalUsage": null,
 *   "usageBreakdown": null,
 *   "usageBreakdownList": [
 *     {
 *       "bonuses": [],
 *       "currency": "USD",
 *       "currentOverages": 0,
 *       "currentOveragesWithPrecision": 0,
 *       "currentUsage": 5469,
 *       "currentUsageWithPrecision": 5469.38,
 *       "displayName": "Credit",
 *       "displayNamePlural": "Credits",
 *       "freeTrialInfo": null,
 *       "nextDateReset": 1777593600,
 *       "overageCap": 10000,
 *       "overageCapWithPrecision": 10000,
 *       "overageCharges": 0,
 *       "overageRate": 0.04,               // 每次超额请求单价，单位见 currency
 *       "resourceType": "CREDIT",          // 观测到的唯一取值
 *       "unit": "INVOCATIONS",
 *       "usageLimit": 10000,
 *       "usageLimitWithPrecision": 10000
 *     }
 *   ],
 *   "userInfo": {
 *     "email": "user@example.com",         // 请求带 isEmailRequired=true 时返回真实邮箱；
 *                                          // 不带此参数时恒为 null（上游的 PII 默认）
 *     "userId": "d-<directoryId>.<userSubId>"  // IAM Identity Center directory user ID
 *   }
 * }
 * ```
 *
 * 注意：邮箱是否可见由请求参数 `isEmailRequired` 决定。kiro2claude 在
 * `token-manager.ts` 里把 `isEmailRequired=true` 写死进了 URL，所以
 * `/kiro/usage` 会下发邮箱（前提是上游对应账户绑定了邮箱）。
 *
 * ## 字段消费情况
 *
 * 本项目把 `getUsageLimits` 上游响应作为**透传数据**暴露给客户端（`GET /kiro/usage`
 * 端点）。服务器端**不做字段加工、不做业务逻辑判断**，所以这里只保留类型定义供
 * 类型安全的 `response.data as UsageLimitsResponse` 断言使用。
 *
 * 响应里还有若干字段没被声明（`userInfo` / `subscriptionInfo.type` / `overageConfiguration` /
 * `daysUntilReset` / `usageBreakdownList[0].{currency, overageRate, ...}` 等），
 * 它们在 as 断言下被静默保留到 JSON 响应里传回客户端——客户端如果需要这些字段，
 * 自己解析即可；如果 TypeScript 代码需要用到，再补进接口声明。
 */
export interface UsageLimitsResponse {
  nextDateReset?: number;
  subscriptionInfo?: SubscriptionInfo;
  usageBreakdownList: UsageBreakdown[];
  userInfo?: UserInfo;
}

/**
 * 用户标识。`email` 只有在请求带 `isEmailRequired=true` 时才会被上游填充；
 * 否则恒为 null。`userId` 对 SSO 用户形如 `d-<directoryId>.<userSubId>`。
 */
export interface UserInfo {
  email: string | null;
  userId?: string;
}

/** 订阅信息 */
export interface SubscriptionInfo {
  subscriptionTitle?: string;
}

/** 使用量明细 */
export interface UsageBreakdown {
  currentUsage: number;
  currentUsageWithPrecision: number;
  bonuses: Bonus[];
  freeTrialInfo?: FreeTrialInfo;
  nextDateReset?: number;
  usageLimit: number;
  usageLimitWithPrecision: number;
}

/** 奖励额度 */
export interface Bonus {
  currentUsage: number;
  usageLimit: number;
  status?: string;
}

/** 免费试用信息 */
export interface FreeTrialInfo {
  currentUsage: number;
  currentUsageWithPrecision: number;
  freeTrialExpiry?: number;
  freeTrialStatus?: string;
  usageLimit: number;
  usageLimitWithPrecision: number;
}
