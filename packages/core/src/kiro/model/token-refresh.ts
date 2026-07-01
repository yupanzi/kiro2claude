/**
 * AWS SSO OIDC Token 刷新的请求/响应类型。
 *
 * 协议：AWS SSO OIDC `CreateToken`（Smithy 风格），请求/响应体字段都是
 * **camelCase**——snake_case（`client_id` / `refresh_token`）会让 AWS 返回
 * `401 invalid_client`。`test/kiro/model/token-refresh.test.ts` 的契约测试
 * 锁定了 wire 格式，防止回归。
 */

/** Token 刷新请求体 */
export interface TokenRefreshRequest {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  grantType: string;
}

/** Token 刷新响应体 */
export interface TokenRefreshResponse {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  profileArn?: string;
}
