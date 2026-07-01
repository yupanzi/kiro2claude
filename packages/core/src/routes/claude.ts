/**
 * Claude-compatible HTTP routes. Mounted at `/claude/v1` by the caller.
 *
 *   - `GET  /models`
 *   - `POST /messages`
 *   - `POST /messages/count_tokens`
 *
 * All routes require API key authentication via the `x-api-key` header
 * or `Authorization: Bearer <token>`.
 */

import fastifyCors from '@fastify/cors';
import type { FastifyInstance } from 'fastify';

import { countTokens, createPostMessages, getModels } from '../claude/handlers.js';
import type { KiroProvider } from '../kiro/provider.js';
import type { HookBus } from '../plugin-host/index.js';
import { createApiKeyAuthHook } from '../shared/auth-hook.js';

/** Maximum request body size (50 MB) */
export const MAX_BODY_SIZE = 50 * 1024 * 1024;

// Local proxy — allow all origins so any downstream Claude SDK client can call it.
const corsOptions = {
  origin: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'x-api-key',
    'anthropic-version',
    'anthropic-beta',
  ],
};

export interface ClaudeRoutesDeps {
  /** API key used to authenticate incoming requests */
  apiKey: string;
  /** KiroProvider used to call the upstream API */
  kiroProvider: KiroProvider;
  /** Whether to extract thinking blocks from non-streaming responses */
  extractThinking: boolean;
  /** 详见 `Config.identityOverride`。 */
  identityOverride: boolean;
  /** 详见 `Config.rejectUnsupportedDocuments`。 */
  rejectUnsupportedDocuments: boolean;
  /** 详见 `Config.emptyStreamRetries`。空流有界重试次数。 */
  emptyStreamRetries: number;
  /** 详见 `Config.captureEmptyDir`。诊断用空流抓包目录,留空则不抓。 */
  captureEmptyDir?: string;
  /** Plugin hook bus — passed to handlers for usage wire format shaping. */
  hookBus: HookBus;
}

export async function registerClaudeRoutes(
  fastify: FastifyInstance,
  deps: ClaudeRoutesDeps,
): Promise<void> {
  await fastify.register(fastifyCors, corsOptions);

  fastify.addHook('preHandler', createApiKeyAuthHook(deps.apiKey));

  // `ClaudeRoutesDeps` is a structural supertype of `PostMessagesDeps` — the
  // extra `apiKey` field is harmless since interfaces aren't strict.
  const postMessagesHandler = createPostMessages(deps);

  fastify.get('/models', getModels);
  fastify.post('/messages', { bodyLimit: MAX_BODY_SIZE }, postMessagesHandler);
  fastify.post('/messages/count_tokens', { bodyLimit: MAX_BODY_SIZE }, countTokens);
}
