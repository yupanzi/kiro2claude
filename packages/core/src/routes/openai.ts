/**
 * OpenAI-compatible HTTP routes. Mounted at `/openai/v1` (完整 usage) and
 * `/api/openai/v1` (去泄漏镜像) by the caller.
 *
 *   - `GET  /models`
 *   - `POST /chat/completions`
 *
 * 鉴权与 Claude 路由共用 `KIRO2CLAUDE_API_KEY`(`Authorization: Bearer` 或
 * `x-api-key`)。deps 复用 `ClaudeRoutesDeps`(与 Claude 完全同集)。
 */

import fastifyCors from '@fastify/cors';
import type { FastifyInstance } from 'fastify';
import { createPostChatCompletions, getOpenAiModels } from '../openai/handlers.js';
import { createPostResponses } from '../openai/responses/handlers.js';
import { createApiKeyAuthHook } from '../shared/auth-hook.js';
import type { ClaudeRoutesDeps } from './claude.js';

/** Maximum request body size (50 MB) */
const MAX_BODY_SIZE = 50 * 1024 * 1024;

const corsOptions = {
  origin: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key'],
};

export async function registerOpenAiRoutes(
  fastify: FastifyInstance,
  deps: ClaudeRoutesDeps,
): Promise<void> {
  await fastify.register(fastifyCors, corsOptions);

  fastify.addHook('preHandler', createApiKeyAuthHook(deps.apiKey));

  // `ClaudeRoutesDeps` 是 `PostMessagesDeps` 的结构超集(多一个 apiKey)。
  const postChatCompletions = createPostChatCompletions(deps);

  fastify.get('/models', getOpenAiModels);
  fastify.post('/chat/completions', { bodyLimit: MAX_BODY_SIZE }, postChatCompletions);
  // Responses API(Codex CLI 走这条;wire_api=responses)。
  fastify.post('/responses', { bodyLimit: MAX_BODY_SIZE }, createPostResponses(deps));
}
