/**
 * OpenAI Chat Completions 非流式 handler(薄封装)。
 *
 * 重试/判空/计费循环全在共享的 `runOpenAiNonStream`;这里只注入「归约结果 →
 * chat.completion」的构建。
 */

import type { FastifyReply } from 'fastify';
import type { MessageHandlerResult } from '../claude/empty-capture.js';
import type { ToolTextRegistry } from '../claude/tool-call-text.js';
import type { KiroProvider } from '../kiro/provider.js';
import type { HookBus } from '../plugin-host/index.js';
import { runOpenAiNonStream } from './non-stream-transport.js';
import { buildChatCompletion } from './response-nonstream.js';

export async function handleOpenAiNonStreamRequest(
  provider: KiroProvider,
  requestBody: string,
  model: string,
  inputTokens: number,
  thinkingEnabled: boolean,
  toolNameMap: Map<string, string>,
  hookBus: HookBus,
  reply: FastifyReply,
  emptyStreamRetries = 0,
  rescueRegistry?: ToolTextRegistry,
): Promise<MessageHandlerResult> {
  return runOpenAiNonStream(
    provider,
    requestBody,
    model,
    inputTokens,
    thinkingEnabled,
    toolNameMap,
    hookBus,
    reply,
    emptyStreamRetries,
    rescueRegistry,
    (reduced, promptTokens, completionTokens, extensions) =>
      buildChatCompletion({ reduced, model, promptTokens, completionTokens, extensions }),
  );
}
