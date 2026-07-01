import type { Config } from '../../model/config.js';
import { effectiveApiRegion, effectiveAuthRegion } from '../../model/config.js';

/**
 * Kiro 凭据（device code flow / AWS SSO OIDC）。
 *
 * 这是运行期内存中的凭据对象，加载自 kiro-cli 的本地 SQLite 数据库。
 * `clientId` / `clientSecret` 来自 kiro-cli 设备注册（`auth_kv` 表的
 * `*:device-registration` key），是 AWS SSO OIDC `CreateToken` API 调用
 * 必需的参数——即使是 Builder ID 登录，底层也走同一套 OIDC 流程。
 */
export interface KiroCredentials {
  accessToken?: string;
  refreshToken?: string;
  profileArn?: string;
  expiresAt?: string;
  clientId?: string;
  clientSecret?: string;
  region?: string;
  authRegion?: string;
  apiRegion?: string;
}

/**
 * 获取有效的 Auth Region（用于 Token 刷新）
 * 优先级：凭据.authRegion > 凭据.region > config.authRegion > config.region
 */
export function credentialEffectiveAuthRegion(cred: KiroCredentials, config: Config): string {
  return cred.authRegion ?? cred.region ?? effectiveAuthRegion(config);
}

/**
 * 获取有效的 API Region（用于 API 请求）
 * 优先级：凭据.apiRegion > config.apiRegion > config.region
 */
export function credentialEffectiveApiRegion(cred: KiroCredentials, config: Config): string {
  return cred.apiRegion ?? effectiveApiRegion(config);
}
