/**
 * Responses API 非流式:Claude 归约结果 → Response 对象。
 *
 * output items:reasoning(有明文思维链时,summary 通道)+ message(有文本时)+ 每个
 * tool_use 一个 function_call item。GPT 加密 reasoning 使 reasoningText 空 → 不产
 * reasoning item。usage 用原始 token(不经 buildClaudeUsagePayload);plugin 的
 * `addExtension` 扩展经 `extensions` 参内嵌进 usage(只搬扩展、不套 override,守 #16)。
 */

import { v4 as uuidv4 } from 'uuid';
import { type ReducedAttempt, reducedReasoning } from '../../claude/non-stream-reduce.js';
import { mergeUsageExtensions, type PluginUsageExtensions } from '../../claude/stream.js';
import type { ResponsesObject, ResponsesOutputItem, ResponsesUsage } from './types.js';

export function buildResponsesUsage(
  inputTokens: number,
  outputTokens: number,
  extensions?: PluginUsageExtensions,
): ResponsesUsage {
  const usage: ResponsesUsage = {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
  };
  mergeUsageExtensions(usage, extensions);
  return usage;
}

export function buildResponsesObject(args: {
  reduced: ReducedAttempt;
  model: string;
  inputTokens: number;
  outputTokens: number;
  createdAt: number;
  extensions?: PluginUsageExtensions;
}): ResponsesObject {
  const { reduced, model, inputTokens, outputTokens, createdAt, extensions } = args;

  const output: ResponsesOutputItem[] = [];

  // reasoning 先于 message/function_call(协议顺序)。Claude 明文思维链经 summary 通道
  // surface;GPT 加密 reasoning 使 reasoningText 保持空 → 不产 item(与流式惰性开对齐)。
  const reasoning = reducedReasoning(reduced);
  if (reasoning) {
    output.push({
      id: `rs_${uuidv4().replace(/-/g, '')}`,
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: reasoning }],
    });
  }

  if (reduced.textContent) {
    output.push({
      id: `msg_${uuidv4().replace(/-/g, '')}`,
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: reduced.textContent, annotations: [] }],
    });
  }

  for (const tu of reduced.toolUses) {
    output.push({
      id: `fc_${uuidv4().replace(/-/g, '')}`,
      type: 'function_call',
      call_id: String(tu.id),
      name: String(tu.name),
      arguments: JSON.stringify(tu.input ?? {}),
      status: 'completed',
    });
  }

  return {
    id: `resp_${uuidv4().replace(/-/g, '')}`,
    object: 'response',
    created_at: createdAt,
    status: 'completed',
    model,
    output,
    usage: buildResponsesUsage(inputTokens, outputTokens, extensions),
    error: null,
    incomplete_details: null,
    metadata: {},
  };
}
