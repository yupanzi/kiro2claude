/**
 * OpenAI 兼容路由 handler(薄胶水,镜像 claude/handlers.ts):
 *   - GET  /models
 *   - POST /chat/completions
 *
 * 复用 claude 链路:convertOpenAiRequest → convertRequest(全部历史/配对/
 * native reasoning 注入)→ serializeKiroRequest → provider。仅请求/响应的
 * 协议翻译是 OpenAI 特有。deps 与 Claude 完全同集(PostMessagesDeps)。
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  ConversionError,
  type ConversionResult,
  clientModelHasEncryptedReasoning,
  convertRequest,
} from '../claude/converter.js';
import { captureEmptyRequest, type MessageHandlerResult } from '../claude/empty-capture.js';
import type { PostMessagesDeps } from '../claude/handlers.js';
import { buildToolTextRegistry } from '../claude/tool-call-text.js';
import { isThinkingEnabled } from '../claude/types.js';
import type { KiroRequest } from '../kiro/model/requests/kiro.js';
import { serializeKiroRequest } from '../kiro/model/requests/kiro.js';
import { getLogger } from '../shared/logger.js';
import { getRequestContext } from '../shared/request-context.js';
import { countAllTokens } from '../token.js';
import { convertOpenAiRequest } from './converter.js';
import { getOpenAiModelsResponse } from './models-catalog.js';
import { handleOpenAiNonStreamRequest } from './non-stream-handler.js';
import {
  chatCompletionRequestSchema,
  formatRequestError,
} from './schemas/chat-completion-schema.js';
import { handleOpenAiStreamRequest } from './stream-handler.js';
import { createOpenAiError } from './types.js';

// ============================================================================
// GET /openai/v1/models
// ============================================================================

export async function getOpenAiModels(
  _request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  getLogger().info('GET /openai/v1/models');
  reply.send(getOpenAiModelsResponse());
}

// ============================================================================
// POST /openai/v1/chat/completions
// ============================================================================

export function createPostChatCompletions(deps: PostMessagesDeps) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const log = getLogger();

    const parseResult = chatCompletionRequestSchema.safeParse(request.body);
    if (!parseResult.success) {
      const errorMessage = formatRequestError(parseResult.error);
      log.warn({ msg: 'openai request body validation failed', error: errorMessage });
      reply.status(400).send(createOpenAiError(errorMessage, 'invalid_request_error'));
      return;
    }
    const oaiReq = parseResult.data;
    const stream = oaiReq.stream ?? false;
    const includeUsage = oaiReq.stream_options?.include_usage ?? false;

    log.info({
      msg: 'POST /openai/v1/chat/completions',
      model: oaiReq.model,
      stream,
      message_count: oaiReq.messages?.length ?? 0,
      tool_count: oaiReq.tools?.length ?? 0,
      reasoning_effort: oaiReq.reasoning_effort,
    });

    // OpenAI → Claude MessagesRequest（reasoning_effort 已在此映射成
    // thinking/output_config，故不调 overrideThinkingFromModelName）。
    const payload = convertOpenAiRequest(oaiReq);

    const provider = deps.kiroProvider;

    // 泄漏工具调用救援:响应侧检测 + 请求侧历史去污染共用同一注册表。
    const rescueRegistry =
      deps.toolCallTextRescue && payload.tools && payload.tools.length > 0
        ? buildToolTextRegistry(payload.tools)
        : undefined;

    // Convert to Kiro conversationState（复用现有全链路）。
    let conversionResult: ConversionResult;
    try {
      conversionResult = convertRequest(payload, {
        identityOverride: deps.identityOverride,
        rejectUnsupportedDocuments: deps.rejectUnsupportedDocuments,
        toolTextRegistry: rescueRegistry,
      });
    } catch (e) {
      if (e instanceof ConversionError) {
        const message =
          e.code === 'UnsupportedModel'
            ? `Model not supported: ${oaiReq.model}`
            : 'Messages list is empty';
        log.warn({ msg: 'openai request conversion failed', code: e.code, error: e.message });
        reply.status(400).send(createOpenAiError(message, 'invalid_request_error'));
        return;
      }
      throw e;
    }

    const kiroRequest: KiroRequest = { conversationState: conversionResult.conversationState };

    let requestBody: string;
    try {
      requestBody = serializeKiroRequest(kiroRequest);
    } catch (e) {
      log.error({ msg: 'openai serialization failed', error: String(e) });
      reply.status(500).send(createOpenAiError(`Serialization failed: ${e}`, 'api_error'));
      return;
    }

    const inputTokens = await countAllTokens(
      payload.model,
      payload.system,
      payload.messages,
      payload.tools,
    );

    // 仅 GPT(加密 reasoning)关掉 legacy `<thinking>` 扫描:其 redacted reasoning 不置
    // sawReasoningContent → 运行时无法关闭扫描,靠静态判定兜底,否则 GPT 可见输出里的
    // 字面 `<thinking>` 会被误剥离。Claude 原生 reasoning(明文)不纳入(见 converter.ts)。
    const extractThinking =
      deps.extractThinking &&
      isThinkingEnabled(payload.thinking) &&
      !clientModelHasEncryptedReasoning(payload.model);
    const toolNameMap = conversionResult.toolNameMap;

    let result: MessageHandlerResult;
    if (stream) {
      result = await handleOpenAiStreamRequest(
        provider,
        requestBody,
        payload.model,
        inputTokens,
        extractThinking,
        toolNameMap,
        deps.hookBus,
        reply,
        includeUsage,
        deps.emptyStreamRetries,
        rescueRegistry,
      );
    } else {
      result = await handleOpenAiNonStreamRequest(
        provider,
        requestBody,
        payload.model,
        inputTokens,
        extractThinking,
        toolNameMap,
        deps.hookBus,
        reply,
        deps.emptyStreamRetries,
        rescueRegistry,
      );
    }

    if (result.emptyResponse && deps.captureEmptyDir) {
      captureEmptyRequest(deps.captureEmptyDir, {
        reqId: getRequestContext()?.reqId,
        model: payload.model,
        emptyAttempts: result.emptyAttempts,
        rawRequest: request.body,
        meta: {
          stream,
          max_tokens: payload.max_tokens,
          message_count: oaiReq.messages?.length ?? 0,
          tool_count: oaiReq.tools?.length ?? 0,
          system_length: payload.system?.reduce((n, s) => n + s.text.length, 0) ?? 0,
          thinking_type: payload.thinking?.type,
        },
      });
    }
  };
}
