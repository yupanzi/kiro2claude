/**
 * OpenAI Responses API handler(POST /openai/v1/responses)。
 *
 * 镜像 chat handler:convertResponsesRequest → convertRequest(复用全链路)→
 * serialize → stream/non-stream 分派。Codex CLI 走这条(wire_api=responses)。
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  ConversionError,
  type ConversionResult,
  clientModelHasEncryptedReasoning,
  convertRequest,
} from '../../claude/converter.js';
import { captureEmptyRequest, type MessageHandlerResult } from '../../claude/empty-capture.js';
import type { PostMessagesDeps } from '../../claude/handlers.js';
import { buildToolTextRegistry } from '../../claude/tool-call-text.js';
import { isThinkingEnabled } from '../../claude/types.js';
import type { KiroRequest } from '../../kiro/model/requests/kiro.js';
import { serializeKiroRequest } from '../../kiro/model/requests/kiro.js';
import { getLogger } from '../../shared/logger.js';
import { getRequestContext } from '../../shared/request-context.js';
import { countAllTokens } from '../../token.js';
import { createOpenAiError } from '../types.js';
import { convertResponsesRequest } from './converter.js';
import { handleResponsesNonStreamRequest } from './non-stream-handler.js';
import { handleResponsesStreamRequest } from './stream-handler.js';
import type { ResponsesRequest } from './types.js';

export function createPostResponses(deps: PostMessagesDeps) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const log = getLogger();

    // Responses 请求宽松:只强校验 model + input 存在,其余交 converter 防御式处理。
    const body = request.body as Partial<ResponsesRequest> | undefined;
    if (!body || typeof body !== 'object' || typeof body.model !== 'string') {
      reply.status(400).send(createOpenAiError('model is required', 'invalid_request_error'));
      return;
    }
    if (body.input === undefined || body.input === null) {
      reply.status(400).send(createOpenAiError('input is required', 'invalid_request_error'));
      return;
    }
    const oaiReq = body as ResponsesRequest;
    const stream = oaiReq.stream ?? false;

    log.info({
      msg: 'POST /openai/v1/responses',
      model: oaiReq.model,
      stream,
      input_type: Array.isArray(oaiReq.input) ? `items[${oaiReq.input.length}]` : 'string',
      tool_count: oaiReq.tools?.length ?? 0,
      reasoning_effort: oaiReq.reasoning?.effort,
    });

    const payload = convertResponsesRequest(oaiReq);
    const provider = deps.kiroProvider;

    const rescueRegistry =
      deps.toolCallTextRescue && payload.tools && payload.tools.length > 0
        ? buildToolTextRegistry(payload.tools)
        : undefined;

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
            : 'input produced no messages';
        log.warn({ msg: 'responses conversion failed', code: e.code });
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
      log.error({ msg: 'responses serialization failed', error: String(e) });
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
      result = await handleResponsesStreamRequest(
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
      result = await handleResponsesNonStreamRequest(
        provider,
        requestBody,
        payload.model,
        inputTokens,
        extractThinking,
        toolNameMap,
        deps.hookBus,
        reply,
        Math.floor(Date.now() / 1000),
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
        meta: { stream, endpoint: 'responses' },
      });
    }
  };
}
