/**
 * Kiro passthrough HTTP routes. Mounted at `/kiro` by the caller.
 *
 *   - `GET /usage` — upstream `getUsageLimits` passthrough (raw Kiro response)
 *
 * Authentication reuses the main `KIRO2CLAUDE_API_KEY` via the shared
 * `createApiKeyAuthHook` — no separate admin key because these endpoints are
 * read-only and expose the same scope as the Claude routes.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { KiroHttpError, type SingleTokenManager } from '../kiro/token-manager.js';
import { createApiKeyAuthHook } from '../shared/auth-hook.js';
import { createErrorResponse } from '../shared/errors.js';
import { getLogger } from '../shared/logger.js';

export interface KiroRoutesDeps {
  /** API key used to authenticate incoming requests */
  apiKey: string;
  /** Token manager used to call the upstream `getUsageLimits` API */
  tokenManager: SingleTokenManager;
}

export async function registerKiroRoutes(
  fastify: FastifyInstance,
  deps: KiroRoutesDeps,
): Promise<void> {
  fastify.addHook('preHandler', createApiKeyAuthHook(deps.apiKey));

  fastify.get('/usage', async (_request: FastifyRequest, reply: FastifyReply) => {
    const log = getLogger();
    log.info('GET /kiro/usage');
    try {
      const usage = await deps.tokenManager.getUsageLimits();
      log.info('GET /kiro/usage succeeded');
      // 中性化:剔除 userInfo —— 它含后端身份(IAM Identity Center 目录 userId
      // `d-<directoryId>.<userSubId>` 与请求 isEmailRequired=true 带回的真实 email)。
      // 浅拷贝后删除该键,其余额度/订阅等使用字段照常透传(含 as 断言下保留的上游字段)。
      const safe: Record<string, unknown> = { ...usage };
      // biome-ignore lint/performance/noDelete: explicit strip of a security-sensitive field (cold path); delete guarantees removal vs relying on the serializer to omit undefined
      delete safe.userInfo;
      reply.send(safe);
    } catch (e) {
      const internalMsg = e instanceof Error ? e.message : String(e);
      log.error({ msg: '/kiro/usage failed', error: internalMsg });

      // Status + message translation aligned with `mapProviderError`:
      // the downstream client sees only neutral "service" messaging, and
      // 401/403 are masked as 502 to prevent the client from misdiagnosing
      // its own API key as wrong.
      const { status, message } = translateUsageError(e);
      reply.status(status).send(createErrorResponse('api_error', message));
    }
  });
}

/**
 * Translate a `/kiro/usage` failure into a neutral downstream-facing
 * (status, message) pair. The internal `err.message` (which may carry
 * "Kiro" / "AWS" / token-manager vocabulary) stays in the logs and is
 * never forwarded.
 */
function translateUsageError(e: unknown): { status: number; message: string } {
  if (!(e instanceof KiroHttpError)) {
    return { status: 500, message: 'Service encountered an internal error.' };
  }
  const s = e.status;
  if (s === 401 || s === 403) {
    return {
      status: 502,
      message:
        "Service authentication failed. This is not your API key — the service's backend credentials are invalid or unauthorized. Please contact the service administrator.",
    };
  }
  if (s === 429) {
    return {
      status: 429,
      message: 'Service is rate limiting requests. Please retry after a short delay.',
    };
  }
  if (s === 408 || s === 503 || s === 504) {
    return { status: s, message: 'Service is temporarily unavailable. Please retry.' };
  }
  if (s >= 500 && s < 600) {
    return { status: 502, message: 'Service is temporarily unavailable. Please retry.' };
  }
  // Other 4xx (404 etc.) — pass status through but keep message generic.
  return { status: s, message: 'Request failed.' };
}
