/**
 * Responses API 非流式 handler(薄封装)。
 *
 * 复用共享 `runOpenAiNonStream`,只注入「归约结果 → Response 对象」的构建。
 */

import type { FastifyReply } from 'fastify';
import type { MessageHandlerResult } from '../../claude/empty-capture.js';
import type { ToolTextRegistry } from '../../claude/tool-call-text.js';
import type { KiroProvider } from '../../kiro/provider.js';
import type { HookBus } from '../../plugin-host/index.js';
import { runOpenAiNonStream } from '../non-stream-transport.js';
import { buildResponsesObject } from './response-nonstream.js';

export async function handleResponsesNonStreamRequest(
  provider: KiroProvider,
  requestBody: string,
  model: string,
  inputTokens: number,
  thinkingEnabled: boolean,
  toolNameMap: Map<string, string>,
  hookBus: HookBus,
  reply: FastifyReply,
  createdAt: number,
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
    (reduced, inputTok, outputTok, extensions) =>
      buildResponsesObject({
        reduced,
        model,
        inputTokens: inputTok,
        outputTokens: outputTok,
        createdAt,
        extensions,
      }),
  );
}
