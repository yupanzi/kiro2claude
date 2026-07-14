/**
 * Provider 错误 → OpenAI 形状错误 reply。
 *
 * 复用 claude/error-mapper 的 `classifyProviderError`(唯一的状态/文案/
 * Retry-After 真相源,含日志),只把结果格式化成 OpenAI `{error:{...}}` 信封。
 */

import type { FastifyReply } from 'fastify';
import { classifyProviderError } from '../claude/error-mapper.js';
import { createOpenAiError } from './types.js';

export function mapProviderErrorOpenAi(err: unknown, reply: FastifyReply): void {
  const c = classifyProviderError(err);
  if (c.retryAfterSeconds !== undefined) {
    reply.header('Retry-After', String(c.retryAfterSeconds));
  }
  reply.status(c.status).send(createOpenAiError(c.message, c.errorType));
}
