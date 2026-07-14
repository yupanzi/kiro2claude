/**
 * Zod schema for `POST /openai/v1/chat/completions` request bodies.
 *
 * 与 claude/schemas/messages-request-schema.ts 同哲学:**宽松、passthrough、
 * 归一在 transform**。只强类型 converter 一定要读的 `model` + `messages`,其余
 * 全 `z.unknown().optional()`,深层结构由 openai/converter.ts 防御式读取
 * (不重复校验、不制造 drift)。未知顶层字段 passthrough,新 OpenAI 字段不弹请求。
 */

import { z } from 'zod';
import type { ChatCompletionRequest } from '../types.js';

export const chatCompletionRequestSchema = z
  .object({
    model: z.string({
      required_error: 'model is required',
      invalid_type_error: 'model must be a string',
    }),
    messages: z.array(z.unknown(), {
      required_error: 'messages is required',
      invalid_type_error: 'messages must be an array',
    }),
    tools: z.array(z.unknown()).optional(),
    tool_choice: z.unknown().optional(),
    reasoning_effort: z.unknown().optional(),
    max_completion_tokens: z.unknown().optional(),
    max_tokens: z.unknown().optional(),
    stream: z.boolean().optional(),
    stream_options: z.unknown().optional(),
    user: z.unknown().optional(),
  })
  .passthrough()
  .transform((raw): ChatCompletionRequest => {
    // 深层结构(messages/tools/content parts)交给 converter 防御式处理。
    // 这里只把已知标量字段收窄到 ChatCompletionRequest 形状。
    const so = raw.stream_options;
    const include_usage =
      so && typeof so === 'object' && 'include_usage' in so
        ? Boolean((so as { include_usage?: unknown }).include_usage)
        : undefined;
    return {
      model: raw.model,
      messages: raw.messages as ChatCompletionRequest['messages'],
      tools: raw.tools as ChatCompletionRequest['tools'],
      tool_choice: raw.tool_choice,
      reasoning_effort: typeof raw.reasoning_effort === 'string' ? raw.reasoning_effort : undefined,
      max_completion_tokens:
        typeof raw.max_completion_tokens === 'number' ? raw.max_completion_tokens : undefined,
      max_tokens: typeof raw.max_tokens === 'number' ? raw.max_tokens : undefined,
      stream: raw.stream,
      stream_options: include_usage === undefined ? undefined : { include_usage },
      user: typeof raw.user === 'string' ? raw.user : undefined,
    };
  });

/** 复用 claude schema 的错误格式化(同一 `path: message; …` 形态)。 */
export { formatRequestError } from '../../claude/schemas/messages-request-schema.js';
