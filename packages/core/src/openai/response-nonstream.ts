/**
 * 非流式响应映射:Claude 归约结果(ReducedAttempt)→ OpenAI chat.completion。
 *
 * usage 直接用 handler 传入的原始 token(promptTokens = 上游 contextUsage 还原
 * 的输入总量,completionTokens = 估算输出),**不**经 buildClaudeUsagePayload
 * (避免 derived 插件的 input_tokens override 污染 prompt_tokens)。plugin 的
 * `addExtension` 扩展(kiro_metering 等)经 `extensions` 参内嵌进 usage——只搬扩展、
 * 不套 override,故 prompt_tokens 语义不受影响(踩坑 #16)。extensions 由 handler 经
 * resolvePluginUsageExtensions 解析(镜像端点 stripPluginUsage 时为 undefined)。
 */

import { v4 as uuidv4 } from 'uuid';
import { type ReducedAttempt, reducedReasoning } from '../claude/non-stream-reduce.js';
import { mapFinishReason } from './response-stream.js';
import type {
  ChatCompletion,
  ChatCompletionResponseMessage,
  ChatCompletionResponseToolCall,
  OpenAiUsage,
} from './types.js';

export function buildOpenAiUsage(
  promptTokens: number,
  completionTokens: number,
  extensions?: ReadonlyMap<string, unknown>,
): OpenAiUsage {
  const usage: OpenAiUsage = {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
  if (extensions) {
    for (const [namespace, value] of extensions) usage[namespace] = value;
  }
  return usage;
}

export function buildChatCompletion(args: {
  reduced: ReducedAttempt;
  model: string;
  promptTokens: number;
  completionTokens: number;
  extensions?: ReadonlyMap<string, unknown>;
}): ChatCompletion {
  const { reduced, model, promptTokens, completionTokens, extensions } = args;

  // Claude 明文 reasoning(reasoningText)或 legacy <thinking>(thinkingText)→
  // reasoning_content;GPT 加密 reasoning 时两者皆空 → 省略该字段。
  const reasoning = reducedReasoning(reduced);

  const toolCalls: ChatCompletionResponseToolCall[] = reduced.toolUses.map((tu) => ({
    id: String(tu.id),
    type: 'function',
    function: { name: String(tu.name), arguments: JSON.stringify(tu.input ?? {}) },
  }));

  const message: ChatCompletionResponseMessage = {
    role: 'assistant',
    // 无可见文本且有 tool_calls → content: null(OpenAI 约定)。
    content: reduced.textContent ? reduced.textContent : null,
  };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  return {
    id: `chatcmpl-${uuidv4().replace(/-/g, '')}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: mapFinishReason(reduced.stopReason),
        logprobs: null,
      },
    ],
    usage: buildOpenAiUsage(promptTokens, completionTokens, extensions),
  };
}
