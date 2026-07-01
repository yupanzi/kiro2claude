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
 * Dispatches on `ProviderError.kind.kind` via exhaustive switch. Anything
 * that isn't a `ProviderError` (token manager failures, unexpected throws)
 * falls back to 502 with a generic message; the underlying `err.message`
 * (which may contain "Kiro API ..." text) is logged only, never sent.
 */

import type { FastifyReply } from 'fastify';
import { ProviderError } from '../kiro/provider-error.js';
import { getLogger } from '../shared/logger.js';
import { createErrorResponse } from './types.js';

export function mapProviderError(err: unknown, reply: FastifyReply): void {
  const log = getLogger();

  if (err instanceof ProviderError) {
    switch (err.kind.kind) {
      case 'context_window_full':
        log.warn({ msg: 'upstream rejected: context window full', status: err.kind.status });
        reply
          .status(400)
          .send(
            createErrorResponse(
              'invalid_request_error',
              'Context window is full. Reduce conversation history, system prompt, or tools.',
            ),
          );
        return;
      case 'input_too_long':
        log.warn({ msg: 'upstream rejected: input too long', status: err.kind.status });
        reply
          .status(400)
          .send(
            createErrorResponse(
              'invalid_request_error',
              'Input is too long. Reduce the size of your messages.',
            ),
          );
        return;
      case 'quota_exhausted':
        log.warn({ msg: 'upstream quota exhausted', status: err.kind.status });
        reply
          .status(402)
          .send(
            createErrorResponse(
              'api_error',
              'Service quota exhausted. Please try again later or contact the service administrator.',
            ),
          );
        return;
      case 'bad_request':
        log.warn({ msg: 'upstream: bad request', status: err.kind.status, body: err.body });
        // Do NOT forward `err.body` here — the upstream body can carry
        // backend-identifying signals (e.g. AWS Smithy `__type` fields).
        reply
          .status(400)
          .send(
            createErrorResponse(
              'invalid_request_error',
              'Bad request. Please check your request payload.',
            ),
          );
        return;
      case 'unauthorized':
        log.error({
          msg: 'upstream auth failure',
          status: err.kind.status,
          bearer_invalid: err.kind.bearerInvalid,
        });
        reply
          .status(502)
          .send(
            createErrorResponse(
              'api_error',
              "Service authentication failed. This is not your API key — the service's backend credentials are invalid or unauthorized. Please contact the service administrator.",
            ),
          );
        return;
      case 'rate_limited':
        log.warn({
          msg: 'upstream rate limited',
          status: err.kind.status,
          retry_after_seconds: err.kind.retryAfterSeconds,
        });
        if (err.kind.retryAfterSeconds !== undefined) {
          reply.header('Retry-After', String(err.kind.retryAfterSeconds));
        }
        reply
          .status(429)
          .send(
            createErrorResponse(
              'rate_limit_error',
              'Service is rate limiting requests. Please retry after the indicated delay.',
            ),
          );
        return;
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
        if (err.kind.retryAfterSeconds !== undefined) {
          reply.header('Retry-After', String(err.kind.retryAfterSeconds));
        }
        reply
          .status(downstream)
          .send(
            createErrorResponse('api_error', 'Service is temporarily unavailable. Please retry.'),
          );
        return;
      }
      case 'network':
        log.error({ msg: 'upstream network error', error: String(err.kind.cause) });
        reply
          .status(502)
          .send(createErrorResponse('api_error', 'Service is unreachable. Please retry.'));
        return;
    }
  }

  // Fallback: any non-ProviderError (e.g. token manager failures).
  // The original message is logged for debugging but NOT sent downstream —
  // it may contain "Kiro API ..." / "RefreshTokenInvalid" / etc.
  const msg = err instanceof Error ? err.message : String(err);
  log.error({ msg: 'Kiro API call failed (non-provider error)', error: msg });
  reply
    .status(502)
    .send(createErrorResponse('api_error', 'Service encountered an internal error.'));
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
