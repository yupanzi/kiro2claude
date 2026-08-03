/**
 * Responses API 流式 handler(薄封装)。
 *
 * 传输编排全在共享的 `runOpenAiStream`;这里注入 responses 协议:
 * ResponsesEventEncoder + 终止行 `encoder.finalize(usage)` → `response.completed`
 * (Responses 流以 response.completed 收口,无 `[DONE]` 哨兵)。
 */

import type { FastifyReply } from 'fastify';
import type { MessageHandlerResult } from '../../claude/empty-capture.js';
import { resolvePluginUsageExtensions } from '../../claude/stream.js';
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
  rescueRegistry: ToolTextRegistry | undefined,
  customToolNames: ReadonlySet<string>,
): Promise<MessageHandlerResult> {
  const protocol: OpenAiStreamProtocol<ResponsesEventEncoder> = {
    // customToolNames 走闭包注入:它是 responses 协议特有的,而 runOpenAiStream 的签名
    // 由 chat 端点共用。
    makeEncoder: (m) => new ResponsesEventEncoder(m, customToolNames),
    finalTerminal: (encoder, ctx) =>
      encoder.finalize(
        buildResponsesUsage(
          ctx.contextInputTokens ?? ctx.inputTokens,
          ctx.outputTokens,
          resolvePluginUsageExtensions(ctx.usageFinishEvent),
        ),
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
