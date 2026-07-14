/**
 * Provider → HTTP error mapper.
 *
 * Two audiences, two surfaces:
 *
 *   - **Logs** (`log.warn` / `log.error`) keep the upstream-aware vocabulary
 *     ("upstream", "Kiro") so operators can debug. These never reach the
 *     downstream client.
 *   - **Response body** (`createErrorResponse(...)`) is neutral: it speaks of
 *     "the service" without naming or hinting at the upstream backend. The
 *     downstream client should perceive kiro2claude as an independent API
 *     and treat 4xx/5xx as standard HTTP signals, not as "the gateway's
 *     upstream had an issue."
 *
 * 分类与格式化分离:`classifyProviderError` 是**唯一**的状态/文案/Retry-After
 * 真相源(含日志),`mapProviderError` 只负责把它格式化成 Claude 错误体。OpenAI
 * 端点复用同一个 `classifyProviderError` 再格式化成 OpenAI 形状(openai/
 * error-mapper.ts),两端的状态码/中性文案/leak 安全永远一致。
 *
 * Dispatches on `ProviderError.kind.kind` via exhaustive switch. Anything
 * that isn't a `ProviderError` (token manager failures, unexpected throws)
 * falls back to 502 with a generic message; the underlying `err.message`
 * (which may contain "Kiro API ..." text) is logged only, never sent.
 */

import type { FastifyReply } from 'fastify';
import { ProviderError } from '../kiro/provider-error.js';
import { getLogger } from '../shared/logger.js';
import { createErrorResponse } from './types.js';

/** 分类后的下游错误描述(格式无关)。 */
export interface ClassifiedProviderError {
  status: number;
  /** 错误类型 slug(Claude 与 OpenAI 约定高度重叠,两端复用同一 slug)。 */
  errorType: string;
  /** 中性文案(不泄漏后端身份)。 */
  message: string;
  /** rate_limited / transient 时的 Retry-After 秒数。 */
  retryAfterSeconds?: number;
}

/**
 * 把 provider 抛出的错误分类成 `{status, errorType, message, retryAfterSeconds}`。
 * **含日志副作用**(每种 kind 记不同的运维字段,与下游格式无关)。返回的
 * message 一律中性。这是状态/文案的唯一真相源;新增 case 必须保持文案中性
 * (leak 规则)。
 */
export function classifyProviderError(err: unknown): ClassifiedProviderError {
  const log = getLogger();

  if (err instanceof ProviderError) {
    switch (err.kind.kind) {
      case 'context_window_full':
        log.warn({ msg: 'upstream rejected: context window full', status: err.kind.status });
        return {
          status: 400,
          errorType: 'invalid_request_error',
          message: 'Context window is full. Reduce conversation history, system prompt, or tools.',
        };
      case 'input_too_long':
        log.warn({ msg: 'upstream rejected: input too long', status: err.kind.status });
        return {
          status: 400,
          errorType: 'invalid_request_error',
          message: 'Input is too long. Reduce the size of your messages.',
        };
      case 'quota_exhausted':
        log.warn({ msg: 'upstream quota exhausted', status: err.kind.status });
        return {
          status: 402,
          errorType: 'api_error',
          message:
            'Service quota exhausted. Please try again later or contact the service administrator.',
        };
      case 'bad_request':
        log.warn({ msg: 'upstream: bad request', status: err.kind.status, body: err.body });
        // Do NOT forward `err.body` here — the upstream body can carry
        // backend-identifying signals (e.g. AWS Smithy `__type` fields).
        return {
          status: 400,
          errorType: 'invalid_request_error',
          message: 'Bad request. Please check your request payload.',
        };
      case 'unauthorized':
        log.error({
          msg: 'upstream auth failure',
          status: err.kind.status,
          bearer_invalid: err.kind.bearerInvalid,
        });
        return {
          status: 502,
          errorType: 'api_error',
          message:
            "Service authentication failed. This is not your API key — the service's backend credentials are invalid or unauthorized. Please contact the service administrator.",
        };
      case 'rate_limited':
        log.warn({
          msg: 'upstream rate limited',
          status: err.kind.status,
          retry_after_seconds: err.kind.retryAfterSeconds,
        });
        return {
          status: 429,
          errorType: 'rate_limit_error',
          message: 'Service is rate limiting requests. Please retry after the indicated delay.',
          retryAfterSeconds: err.kind.retryAfterSeconds,
        };
      case 'transient': {
        const upstream = err.kind.status;
        // Forward upstream status verbatim when it carries well-defined
        // HTTP-client semantics:
        //   408 Request Timeout      → downstream should retry with backoff
        //   503 Service Unavailable  → downstream should respect Retry-After
        //   504 Gateway Timeout      → downstream knows the gateway→upstream hop timed out
        // For 500/501/502 and 505+, the upstream is in an unknown failure state
        // and 502 Bad Gateway is the IANA-recommended response.
        const downstream =
          upstream === 408 || upstream === 503 || upstream === 504 ? upstream : 502;
        log.error({
          msg: 'upstream transient error',
          upstream_status: upstream,
          downstream_status: downstream,
          retry_after_seconds: err.kind.retryAfterSeconds,
        });
        return {
          status: downstream,
          errorType: 'api_error',
          message: 'Service is temporarily unavailable. Please retry.',
          retryAfterSeconds: err.kind.retryAfterSeconds,
        };
      }
      case 'network':
        log.error({ msg: 'upstream network error', error: String(err.kind.cause) });
        return {
          status: 502,
          errorType: 'api_error',
          message: 'Service is unreachable. Please retry.',
        };
    }
  }

  // Fallback: any non-ProviderError (e.g. token manager failures).
  // The original message is logged for debugging but NOT sent downstream —
  // it may contain "Kiro API ..." / "RefreshTokenInvalid" / etc.
  const msg = err instanceof Error ? err.message : String(err);
  log.error({ msg: 'Kiro API call failed (non-provider error)', error: msg });
  return {
    status: 502,
    errorType: 'api_error',
    message: 'Service encountered an internal error.',
  };
}

/**
 * Map a provider error into a Claude-shaped error reply (status + neutral body
 * + optional Retry-After). Thin formatter over {@link classifyProviderError}.
 */
export function mapProviderError(err: unknown, reply: FastifyReply): void {
  const c = classifyProviderError(err);
  if (c.retryAfterSeconds !== undefined) {
    reply.header('Retry-After', String(c.retryAfterSeconds));
  }
  reply.status(c.status).send(createErrorResponse(c.errorType, c.message));
}

/**
 * Map a `ConversionError` into the expected 400 body.
 *
 * Kept separate from `mapProviderError` because conversion failures come
 * from `src/claude/converter.ts`, not from the provider layer, and
 * they have a different two-variant discriminator (`code` field instead
 * of `kind`).
 */
export function mapConversionError(
  code: 'UnsupportedModel' | 'EmptyMessages',
  modelName: string,
  reply: FastifyReply,
): void {
  const message =
    code === 'UnsupportedModel' ? `Model not supported: ${modelName}` : 'Messages list is empty';
  reply.status(400).send(createErrorResponse('invalid_request_error', message));
}
