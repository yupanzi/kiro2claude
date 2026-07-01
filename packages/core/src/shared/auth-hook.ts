/**
 * Shared API Key authentication preHandler hook.
 *
 * Validates the API key from the `x-api-key` header or
 * `Authorization: Bearer <token>` header. Used by both the Claude-compatible
 * routes and the Kiro passthrough routes.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import { constantTimeEq, extractApiKey } from './auth.js';
import { authenticationError } from './errors.js';
import { getLogger } from './logger.js';

/** Build a preHandler that checks the incoming request's API key in constant time. */
export function createApiKeyAuthHook(apiKey: string) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const key = extractApiKey(request);
    if (key && constantTimeEq(key, apiKey)) {
      return; // Authenticated
    }

    getLogger().warn({
      msg: 'authentication failed',
      has_key: !!key,
      source: key ? 'invalid_key' : 'missing_key',
    });
    reply.status(401).send(authenticationError());
  };
}
