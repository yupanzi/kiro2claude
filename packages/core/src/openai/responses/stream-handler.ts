/**
 * Responses API 流式 handler(薄封装)。
 *
 * 传输编排全在共享的 `runOpenAiStream`;这里注入 responses 协议:
 * ResponsesEventEncoder + 终止行 `encoder.finalize(usage)` → `response.completed`
 * (Responses 流以 response.completed 收口,无 `[DONE]` 哨兵)。
 */

import type { FastifyReply } from 'fastify';
import type { MessageHandlerResult } from '../../claude/empty-capture.js';
import type { ToolTextRegistry } from '../../claude/tool-call-text.js';
import type { KiroProvider } from '../../kiro/provider.js';
import type { HookBus } from '../../plugin-host/index.js';
import { type OpenAiStreamProtocol, runOpenAiStream } from '../stream-transport.js';
import { buildResponsesUsage } from './response-nonstream.js';
import { ResponsesEventEncoder } from './response-stream.js';

export async function handleResponsesStreamRequest(
  provider: KiroProvider,
  requestBody: string,
  model: string,
  inputTokens: number,
  extractThinking: boolean,
  toolNameMap: Map<string, string>,
  hookBus: HookBus,
  reply: FastifyReply,
  emptyStreamRetries = 0,
  rescueRegistry?: ToolTextRegistry,
): Promise<MessageHandlerResult> {
  const protocol: OpenAiStreamProtocol<ResponsesEventEncoder> = {
    makeEncoder: (m) => new ResponsesEventEncoder(m),
    finalTerminal: (encoder, ctx) =>
      encoder.finalize(
        buildResponsesUsage(ctx.contextInputTokens ?? ctx.inputTokens, ctx.outputTokens),
      ),
    inbandError: (encoder, message, type) => [encoder.errorLine(message, type)],
  };

  return runOpenAiStream(
    protocol,
    provider,
    requestBody,
    model,
    inputTokens,
    extractThinking,
    toolNameMap,
    hookBus,
    reply,
    emptyStreamRetries,
    rescueRegistry,
  );
}
