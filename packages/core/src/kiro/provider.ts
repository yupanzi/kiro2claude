/**
 * Kiro API Provider
 *
 * 与 Kiro 上游 API 通信的核心组件，同时支持流式和非流式请求。
 * 网关本质是转发——上游 408/429/5xx 一律原样透传给下游（含 Retry-After
 * 头），由下游用 HTTP 标准客户端机制处理退避。唯一例外：上游 401 且
 * 响应体指示 bearer token 失效时，网关用本地 SQLite 凭据做一次 token
 * force-refresh 后重试一次（下游没有 refresh token，无法自己处理）。
 * 所有请求头统一走 kiro-cli client profile（Smithy awsJson1_0）。
 *
 * ## 架构
 *
 * 上游调用状态机统一在 `retry-executor.ts`。这里只做三件事：
 *   1. 为三个公共方法（callApi / callApiStream / callMcp）各自构造一个
 *      `RetryableRequest`，描述 URL/headers/body/axios 配置的差异。
 *   2. 构建 kiro-cli 伪装所需的请求头（单一源在 client-profile.ts）。
 *   3. 把 profileArn 注入到主 API 请求体（MCP 不需要）。
 */

import https from 'node:https';
import axios, { type AxiosInstance, type AxiosResponse } from 'axios';
import { v4 as uuidv4 } from 'uuid';

import {
  getKiroClientProfile,
  renderUserAgent,
  renderXAmzUserAgent,
  requireAmzTarget,
} from './client-profile.js';
import type { KiroCredentials } from './model/credentials.js';
import { credentialEffectiveApiRegion } from './model/credentials.js';
import { isMonthlyRequestLimitBody } from './provider-error.js';
import {
  drainBufferBody,
  drainStreamBody,
  type RetryableRequest,
  RetryExecutor,
} from './retry-executor.js';
import type { SingleTokenManager } from './token-manager.js';

/**
 * Kiro API Provider —— 与上游 Kiro / CodeWhisperer API 通信的核心组件。
 */
export class KiroProvider {
  private tokenManager: SingleTokenManager;
  /** 共享 HTTP 客户端 */
  private client: AxiosInstance;
  /** 上游调用状态机 —— 三个公共方法都走这一个实例 */
  private executor: RetryExecutor;

  constructor(tokenManager: SingleTokenManager) {
    this.tokenManager = tokenManager;
    const httpsAgent = new https.Agent({
      keepAlive: true,
      maxSockets: 50,
      maxFreeSockets: 10,
    });
    this.client = axios.create({ timeout: 720_000, httpsAgent });
    this.executor = new RetryExecutor(tokenManager, this.client);
  }

  /** 主 API 端点（按凭据 region 动态构造） */
  private mainApiUrl(credentials: KiroCredentials): string {
    return `https://runtime.${credentialEffectiveApiRegion(credentials, this.tokenManager.config())}.kiro.dev/generateAssistantResponse`;
  }

  /** MCP API 端点（按凭据 region 动态构造） */
  private mcpApiUrl(credentials: KiroCredentials): string {
    return `https://runtime.${credentialEffectiveApiRegion(credentials, this.tokenManager.config())}.kiro.dev/mcp`;
  }

  /** host header（按凭据 region 动态构造） */
  private buildHost(credentials: KiroCredentials): string {
    return `runtime.${credentialEffectiveApiRegion(credentials, this.tokenManager.config())}.kiro.dev`;
  }

  /** 把凭据里的 profileArn 注入到请求体 JSON 里 */
  static injectProfileArn(requestBody: string, profileArn: string | undefined): string {
    if (!profileArn) return requestBody;
    try {
      const json = JSON.parse(requestBody);
      json.profileArn = profileArn;
      return JSON.stringify(json);
    } catch {
      return requestBody;
    }
  }

  /**
   * 判断响应体是否指示月度请求配额已耗尽。
   *
   * 保留为 static method 以维持对外 API 兼容——`test/kiro/provider.test.ts`
   * 里的契约测试直接调用这个入口。实现下沉到 `provider-error.ts`，这里只是薄壳。
   */
  static isMonthlyRequestLimit(body: string): boolean {
    return isMonthlyRequestLimitBody(body);
  }

  // ========================================================================
  // 公开方法
  // ========================================================================

  /** 发送非流式 API 请求（响应体是 arraybuffer）。 */
  async callApi(requestBody: string): Promise<AxiosResponse> {
    return this.executor.execute(this.buildMainApiRequest(requestBody, false));
  }

  /**
   * 发送流式 API 请求（响应体是 AsyncIterable<Buffer>）。`signal` 用于客户端断连时
   * 主动取消 in-flight 请求，让 Kiro 停止生成、停止计费（见
   * `Config.abortUpstreamOnDisconnect`）。默认 undefined = 不可取消（现有行为）。
   */
  async callApiStream(requestBody: string, signal?: AbortSignal): Promise<AxiosResponse> {
    return this.executor.execute(this.buildMainApiRequest(requestBody, true, signal));
  }

  /** 发送 MCP API 请求（WebSearch 等工具走这条路径）。 */
  async callMcp(requestBody: string): Promise<AxiosResponse> {
    return this.executor.execute(this.buildMcpRequest(requestBody));
  }

  // ========================================================================
  // RetryableRequest 构造
  // ========================================================================

  /** 主 API（generateAssistantResponse）的 RetryableRequest */
  private buildMainApiRequest(
    requestBody: string,
    isStream: boolean,
    signal?: AbortSignal,
  ): RetryableRequest {
    return {
      label: isStream ? 'Stream' : 'Non-stream',
      body: requestBody,
      buildUrl: (c) => this.mainApiUrl(c),
      buildHost: (c) => this.buildHost(c),
      buildHeaders: (_c, token, host) => buildGenerateAssistantResponseHeaders(token, host),
      transformBody: (body, credentials) =>
        KiroProvider.injectProfileArn(body, credentials.profileArn),
      axiosConfig: {
        responseType: isStream ? 'stream' : 'arraybuffer',
        // 客户端断连时主动取消 in-flight 请求（经 retry-executor 的 `...axiosConfig`
        // 透传给 `client.post`）。`undefined` 被 axios 视为「无 signal」= 不可取消（现有
        // 行为），故直接透传无需条件包裹。省 credit，见 Config.abortUpstreamOnDisconnect。
        signal,
      },
      readErrorBody: isStream ? drainStreamBody : drainBufferBody,
    };
  }

  /** MCP API（invokeMcp）的 RetryableRequest */
  private buildMcpRequest(requestBody: string): RetryableRequest {
    return {
      label: 'MCP',
      body: requestBody,
      buildUrl: (c) => this.mcpApiUrl(c),
      buildHost: (c) => this.buildHost(c),
      buildHeaders: (credentials, token, host) => buildMcpHeaders(credentials, token, host),
      transformBody: (body) => body,
      axiosConfig: {
        // MCP 默认 JSON 响应；无 responseType 覆盖
      },
      readErrorBody: drainBufferBody,
    };
  }
}

// ============================================================================
// Header builders —— 统一走 kiro-cli client profile
// ============================================================================

/** 主 API (`GenerateAssistantResponse`) 的 headers 构造 */
function buildGenerateAssistantResponseHeaders(
  token: string,
  host: string,
): Record<string, string> {
  const profile = getKiroClientProfile();
  return {
    ...profile.staticHeaders,
    'x-amz-target': requireAmzTarget(profile, 'generateAssistantResponse'),
    'user-agent': renderUserAgent(profile, 'codewhispererstreaming'),
    'x-amz-user-agent': renderXAmzUserAgent(profile, 'codewhispererstreaming'),
    host,
    'amz-sdk-invocation-id': uuidv4(),
    'amz-sdk-request': 'attempt=1; max=3',
    Authorization: `Bearer ${token}`,
  };
}

/**
 * MCP (`InvokeMCP`) 的 headers 构造。
 *
 * 即使主 API 不带 `x-amzn-kiro-profile-arn`，这里必须带——kiro-cli 二进制里的
 * `invoke_mcp.rs` 明确写了这个头，上游也依赖它。
 */
function buildMcpHeaders(
  credentials: KiroCredentials,
  token: string,
  host: string,
): Record<string, string> {
  const profile = getKiroClientProfile();
  const headers: Record<string, string> = {
    ...profile.staticHeaders,
    'x-amz-target': requireAmzTarget(profile, 'invokeMcp'),
    'user-agent': renderUserAgent(profile, 'codewhispererstreaming'),
    'x-amz-user-agent': renderXAmzUserAgent(profile, 'codewhispererstreaming'),
    host,
    'amz-sdk-invocation-id': uuidv4(),
    'amz-sdk-request': 'attempt=1; max=3',
    Authorization: `Bearer ${token}`,
  };

  if (credentials.profileArn) {
    headers['x-amzn-kiro-profile-arn'] = credentials.profileArn;
  }
  return headers;
}
