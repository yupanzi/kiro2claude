/**
 * OpenAI Chat Completions 流式 handler(薄封装)。
 *
 * 传输编排全在共享的 `runOpenAiStream`(stream-transport.ts);这里只注入 chat
 * 协议:OpenAiChunkEncoder + 终止行(可选 usage chunk + `[DONE]`)。
 */

import type { FastifyReply } from 'fastify';
import type { MessageHandlerResult } from '../claude/empty-capture.js';
import { resolvePluginUsageExtensions } from '../claude/stream.js';
import type { ToolTextRegistry } from '../claude/tool-call-text.js';
import type { KiroProvider } from '../kiro/provider.js';
import type { HookBus } from '../plugin-host/index.js';
import { buildOpenAiUsage } from './response-nonstream.js';
import { OpenAiChunkEncoder } from './response-stream.js';
import { type OpenAiStreamProtocol, runOpenAiStream } from './stream-transport.js';
import { createOpenAiError } from './types.js';

export async function handleOpenAiStreamRequest(
  provider: KiroProvider,
  requestBody: string,
  model: string,
  inputTokens: number,
  extractThinking: boolean,
  toolNameMap: Map<string, string>,
  hookBus: HookBus,
  reply: FastifyReply,
  includeUsage: boolean,
  emptyStreamRetries = 0,
  rescueRegistry?: ToolTextRegistry,
): Promise<MessageHandlerResult> {
  const protocol: OpenAiStreamProtocol<OpenAiChunkEncoder> = {
    makeEncoder: (m) => new OpenAiChunkEncoder(m),
    finalTerminal: (encoder, ctx) => {
      const out: string[] = [];
      if (includeUsage) {
        out.push(
          encoder.usageChunkLine(
            buildOpenAiUsage(
              ctx.contextInputTokens ?? ctx.inputTokens,
              ctx.outputTokens,
              resolvePluginUsageExtensions(ctx.usageFinishEvent),
            ),
          ),
        );
      }
      out.push(encoder.doneLine());
      return out;
    },
    inbandError: (encoder, message, type) => [
      `data: ${JSON.stringify(createOpenAiError(message, type))}\n\n`,
      encoder.doneLine(),
    ],
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
