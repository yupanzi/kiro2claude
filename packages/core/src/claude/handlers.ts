/**
 * Claude API route handlers — thin glue between Fastify routes and the
 * specialized modules:
 *
 *   - `models-catalog.ts`       — static model list
 *   - `request-validator.ts`    — model-name thinking override
 *   - `error-mapper.ts`         — provider error → HTTP reply
 *   - `stream-handler.ts`       — SSE streaming path
 *   - `non-stream-handler.ts`   — non-streaming collector
 *   - `schemas/messages-request-schema.ts` — zod validation
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import type { KiroRequest } from '../kiro/model/requests/kiro.js';
import { serializeKiroRequest } from '../kiro/model/requests/kiro.js';
import type { KiroProvider } from '../kiro/provider.js';
import type { HookBus } from '../plugin-host/index.js';
import { getLogger } from '../shared/logger.js';
import { getRequestContext } from '../shared/request-context.js';
import { countAllTokens } from '../token.js';
import {
  ConversionError,
  type ConversionResult,
  clientModelHasEncryptedReasoning,
  convertRequest,
} from './converter.js';
import { captureEmptyRequest, type MessageHandlerResult } from './empty-capture.js';
import { mapConversionError } from './error-mapper.js';
import { getModelsResponse } from './models-catalog.js';
import { handleNonStreamRequest } from './non-stream-handler.js';
import { overrideThinkingFromModelName } from './request-validator.js';
import {
  countTokensRequestSchema,
  formatRequestError,
  messagesRequestSchema,
} from './schemas/messages-request-schema.js';
import { handleStreamRequest } from './stream-handler.js';
import { buildToolTextRegistry } from './tool-call-text.js';
import type { CountTokensResponse, MessagesRequest } from './types.js';
import { createErrorResponse, isThinkingEnabled } from './types.js';
import { handleWebsearchRequest, hasWebSearchTool } from './websearch.js';

// ============================================================================
// GET /claude/v1/models
// ============================================================================

export async function getModels(_request: FastifyRequest, reply: FastifyReply): Promise<void> {
  getLogger().info('GET /claude/v1/models');
  reply.send(getModelsResponse());
}

// ============================================================================
// POST /claude/v1/messages
// ============================================================================

export interface PostMessagesDeps {
  kiroProvider: KiroProvider;
  extractThinking: boolean;
  /** 详见 `Config.identityOverride`。 */
  identityOverride: boolean;
  /** 详见 `Config.rejectUnsupportedDocuments`。 */
  rejectUnsupportedDocuments: boolean;
  /** 详见 `Config.emptyStreamRetries`。空流有界重试次数。 */
  emptyStreamRetries: number;
  /** 详见 `Config.captureEmptyDir`。诊断用空流抓包目录,留空则不抓。 */
  captureEmptyDir?: string;
  /** 详见 `Config.toolCallTextRescue`。泄漏工具调用文本救援 + 历史去污染。 */
  toolCallTextRescue: boolean;
  /** Plugin hook bus — invoked at wire finalization to let plugins shape usage. */
  hookBus: HookBus;
}

export function createPostMessages(deps: PostMessagesDeps) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const log = getLogger();

    // Runtime-validate the request body via zod. The schema transform also
    // normalizes `system` (string → [{text}]) and clamps `thinking.budget_tokens`,
    // replacing the old `preprocessSystem` / `clampBudgetTokens` spread.
    const parseResult = messagesRequestSchema.safeParse(request.body);
    if (!parseResult.success) {
      const errorMessage = formatRequestError(parseResult.error);
      log.warn({ msg: 'request body validation failed', error: errorMessage });
      reply.status(400).send(createErrorResponse('invalid_request_error', errorMessage));
      return;
    }
    const payload: MessagesRequest = parseResult.data;

    // Request shape, computed once: shared by the access log and the (rare)
    // empty-stream capture below so the two can't drift and system_length is
    // not reduced twice.
    const requestMeta = {
      stream: payload.stream ?? false,
      max_tokens: payload.max_tokens,
      message_count: payload.messages?.length ?? 0,
      tool_count: payload.tools?.length ?? 0,
      system_length: payload.system?.reduce((n, s) => n + s.text.length, 0) ?? 0,
      thinking_type: payload.thinking?.type,
    };

    log.info({ msg: 'POST /claude/v1/messages', model: payload.model, ...requestMeta });

    const provider = deps.kiroProvider;

    // Override thinking from model name
    overrideThinkingFromModelName(payload);

    // Check for WebSearch request
    if (hasWebSearchTool(payload)) {
      log.info('WebSearch tool detected, routing to WebSearch handler');
      const inputTokens = await countAllTokens(
        payload.model,
        payload.system,
        payload.messages,
        payload.tools,
      );
      return handleWebsearchRequest(provider, payload, inputTokens, reply);
    }

    // 泄漏工具调用文本救援：响应侧检测 + 请求侧历史去污染共用同一注册表。
    // 请求未带任何工具时无从救援（工具名门禁永不放行），直接关闭省开销。
    const rescueRegistry =
      deps.toolCallTextRescue && payload.tools && payload.tools.length > 0
        ? buildToolTextRegistry(payload.tools)
        : undefined;

    // Convert request
    let conversionResult: ConversionResult;
    try {
      conversionResult = convertRequest(payload, {
        identityOverride: deps.identityOverride,
        rejectUnsupportedDocuments: deps.rejectUnsupportedDocuments,
        toolTextRegistry: rescueRegistry,
      });
    } catch (e) {
      if (e instanceof ConversionError) {
        log.warn({ msg: 'request conversion failed', code: e.code, error: e.message });
        mapConversionError(e.code, payload.model, reply);
        return;
      }
      throw e;
    }

    // Build Kiro request
    const kiroRequest: KiroRequest = {
      conversationState: conversionResult.conversationState,
    };

    let requestBody: string;
    try {
      requestBody = serializeKiroRequest(kiroRequest);
    } catch (e) {
      log.error({ msg: 'serialization failed', error: String(e) });
      reply.status(500).send(createErrorResponse('internal_error', `Serialization failed: ${e}`));
      return;
    }

    log.debug({
      msg: 'request converted',
      history_length: conversionResult.conversationState.history.length,
      tool_name_mappings: conversionResult.toolNameMap.size,
      request_body_size: requestBody.length,
    });

    // Estimate input tokens
    const inputTokens = await countAllTokens(
      payload.model,
      payload.system,
      payload.messages,
      payload.tools,
    );

    // 仅 GPT(加密 reasoning)关掉 legacy `<thinking>` 扫描:其 redacted reasoning 不置
    // sawReasoningContent → 运行时无法关闭扫描,靠静态判定兜底。Claude 原生 reasoning
    // (明文)不纳入——靠运行时信号关闭,且需 thinkingEnabled=true 维持 thinking→text 块顺序。
    const extractThinking =
      deps.extractThinking &&
      isThinkingEnabled(payload.thinking) &&
      !clientModelHasEncryptedReasoning(payload.model);
    const toolNameMap = conversionResult.toolNameMap;

    let result: MessageHandlerResult;
    if (payload.stream) {
      result = await handleStreamRequest(
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
    } else {
      result = await handleNonStreamRequest(
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

    // 诊断抓包:重试耗尽仍空(确定性空流)时,落盘原始 Claude 请求体供事后定位
    // 根因。仅在 KIRO2CLAUDE_CAPTURE_EMPTY_DIR 配置后启用,默认不抓。
    if (result.emptyResponse && deps.captureEmptyDir) {
      captureEmptyRequest(deps.captureEmptyDir, {
        reqId: getRequestContext()?.reqId,
        model: payload.model,
        emptyAttempts: result.emptyAttempts,
        rawRequest: request.body,
        meta: requestMeta,
      });
    }
  };
}

// ============================================================================
// POST /claude/v1/messages/count_tokens
// ============================================================================

export async function countTokens(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const log = getLogger();

  const parseResult = countTokensRequestSchema.safeParse(request.body);
  if (!parseResult.success) {
    const errorMessage = formatRequestError(parseResult.error);
    log.warn({ msg: 'count_tokens body validation failed', error: errorMessage });
    reply.status(400).send(createErrorResponse('invalid_request_error', errorMessage));
    return;
  }
  const payload = parseResult.data;

  log.info({
    msg: 'POST /claude/v1/messages/count_tokens',
    model: payload.model,
    message_count: payload.messages?.length ?? 0,
  });

  const totalTokens = await countAllTokens(
    payload.model,
    payload.system,
    payload.messages,
    payload.tools,
  );

  log.debug({ msg: 'token count result', total_tokens: totalTokens });

  const response: CountTokensResponse = {
    input_tokens: Math.max(totalTokens, 1),
  };

  reply.send(response);
}
