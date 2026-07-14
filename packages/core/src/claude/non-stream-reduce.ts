/**
 * 非流式响应归约器(纯函数,无 I/O)。
 *
 * 把上游一次性返回的 event-stream body(Buffer)归约成「完全后处理」的
 * `ReducedAttempt`:帧解码 → 累积 text/tool/reasoning/metering → legacy
 * `<thinking>` 提取 → 泄漏工具调用救援(坑 #14) → stop_reason 定稿 →
 * silent-failure 判定。
 *
 * 抽出来的动机:Claude 非流式 handler 与 OpenAI 非流式 handler 共用这套
 * 语义,只在「重试循环 + 计费 hook + 响应体形状」上分叉。让归约逻辑(含
 * 救援这类 #14 敏感代码)只有一份真相源,两端自动同步,杜绝漂移。被
 * `midstream-error` / `empty-retry` / `reasoning-native` 现有测试覆盖。
 */

import { v4 as uuidv4 } from 'uuid';
import type { Event, KiroMeteringData } from '../kiro/model/events/base.js';
import { eventFromFrame } from '../kiro/model/events/base.js';
import { EventStreamDecoder } from '../kiro/parser/decoder.js';
import { getLogger } from '../shared/logger.js';
import { resolveContextUsage } from './converter.js';
import {
  assertNever,
  classifyUpstreamErrorEvent,
  extractThinkingFromCompleteText,
  type PendingUpstreamError,
} from './stream.js';
import { extractToolCallsFromCompleteText, type ToolTextRegistry } from './tool-call-text.js';

/** 一次上游响应归约后的完整结果。 */
export interface ReducedAttempt {
  /** 原生 reasoning 累积(GPT redacted 不入,保持空;Claude 明文累积) */
  reasoningText: string;
  reasoningSignature: string | undefined;
  /** legacy `<thinking>` 标签提取出的思考(与 reasoningText 互斥) */
  thinkingText: string | undefined;
  /** 提取 thinking + 救援后的最终可见文本 */
  textContent: string;
  /** tool_use 块(含救援转化的) */
  toolUses: Record<string, unknown>[];
  hasToolUse: boolean;
  /** 定稿后的 stop_reason(hasToolUse 且 end_turn → tool_use) */
  stopReason: string;
  contextInputTokens: number | undefined;
  kiroMetering: KiroMeteringData | undefined;
  /** 上游 mid-stream Error/Exception 帧(非 ContentLength);命中则 handler 明确报错 */
  upstreamError: PendingUpstreamError | undefined;
  /** 空响应(silent failure):无 text/tool/reasoning 且非确定性终止 */
  silentFailure: boolean;
  // 诊断
  eventCounts: Map<string, number>;
  announcedToolNames: Set<string>;
  unknownEventTypes: Set<string>;
}

/**
 * 归约结果的 reasoning 文本(优先级:原生明文 `reasoningText` > legacy `<thinking>`
 * `thinkingText` > 空)。二者互斥,GPT 加密 reasoning 使两者皆空 → `''`。
 * chat/responses 非流式响应体 + 输出 token 估算三处共用,precedence 规则单一归属。
 */
export function reducedReasoning(reduced: ReducedAttempt): string {
  return reduced.reasoningText || reduced.thinkingText || '';
}

/**
 * 归约一次上游响应 body。行为与旧 non-stream-handler 内联循环逐字节一致。
 */
export function reduceKiroResponse(
  bodyBytes: Buffer,
  model: string,
  thinkingEnabled: boolean,
  toolNameMap: Map<string, string>,
  rescueRegistry: ToolTextRegistry | undefined,
): ReducedAttempt {
  const log = getLogger();

  // Parse event stream
  const decoder = new EventStreamDecoder();
  try {
    decoder.feed(bodyBytes);
  } catch (e) {
    log.warn({ msg: 'buffer overflow in decoder', error: String(e) });
  }

  let textContent = '';
  const toolUses: Record<string, unknown>[] = [];
  let hasToolUse = false;
  let stopReason = 'end_turn';
  let contextInputTokens: number | undefined;
  let kiroMetering: KiroMeteringData | undefined;
  // kiro-cli 2.6.0+ 原生 reasoning 累积。一旦 reasoningText 非空就走新路径
  // （直接塞 thinking content block），跳过 `<thinking>` 标签的 regex 提取。
  let reasoningText = '';
  let reasoningSignature: string | undefined;

  // Collect tool call incremental JSON
  const toolJsonBuffers = new Map<string, string>();
  const eventCounts = new Map<string, number>();
  // 上游宣告过的 tool_use 名字(含没吐完参数的空壳帧)——空流诊断线索
  const announcedToolNames = new Set<string>();
  // 上游 mid-stream Error/Exception 帧(非 ContentLength)。命中 → drain 后明确
  // 报错(retryable→503 / fatal→502),而非静默返回部分内容或被误判成空流。
  let upstreamError: PendingUpstreamError | undefined;
  // 未识别 event-type(前向兼容诊断,进「完成」日志)
  const unknownEventTypes = new Set<string>();

  for (const result of decoder.drainAll()) {
    if (!('frame' in result)) {
      log.warn({ msg: 'event decode failed', error: String(result.error) });
      continue;
    }

    let event: Event;
    try {
      event = eventFromFrame(result.frame);
    } catch {
      continue;
    }

    eventCounts.set(event.kind, (eventCounts.get(event.kind) ?? 0) + 1);

    switch (event.kind) {
      case 'AssistantResponse':
        textContent += event.content;
        break;

      case 'ReasoningContent':
        // GPT redacted reasoning: event.text='' → reasoningText 保持空 →
        // 下面 `if (reasoningText)` 为假 → 不产 thinking 块(天然正确)。
        reasoningText += event.text;
        if (event.signature) reasoningSignature = event.signature;
        break;

      case 'ToolUse': {
        hasToolUse = true;
        announcedToolNames.add(toolNameMap.get(event.name) ?? event.name);

        // Accumulate tool JSON input
        let buffer = toolJsonBuffers.get(event.toolUseId) ?? '';
        buffer += event.input;
        toolJsonBuffers.set(event.toolUseId, buffer);

        // If complete tool call, add to list
        if (event.isComplete) {
          let input: unknown;
          if (!buffer) {
            input = {};
          } else {
            try {
              input = JSON.parse(buffer);
            } catch (e) {
              log.warn({
                msg: 'tool input JSON parse failed',
                tool_use_id: event.toolUseId,
                error: String(e),
              });
              input = {};
            }
          }

          const originalName = toolNameMap.get(event.name) ?? event.name;

          toolUses.push({
            type: 'tool_use',
            id: event.toolUseId,
            name: originalName,
            input,
          });
        }
        break;
      }

      case 'ContextUsage': {
        const { inputTokens: ctxInput, exceeded } = resolveContextUsage(
          model,
          event.contextUsagePercentage,
        );
        contextInputTokens = ctxInput;
        if (exceeded) {
          stopReason = 'model_context_window_exceeded';
        }
        break;
      }

      case 'Metering': {
        const { kind: _, ...metering } = event;
        kiroMetering = metering;
        break;
      }

      case 'Error':
        // 上游 error 帧:此前落 default 被静默吞掉(无日志、无客户端错误)。
        // 现在记日志 + 分类(retryable),drain 后明确报错。
        log.error({
          msg: 'received error event from upstream (non-stream)',
          error_code: event.errorCode,
          error_message: event.errorMessage,
        });
        upstreamError = classifyUpstreamErrorEvent(event);
        break;

      case 'Exception': {
        const classified = classifyUpstreamErrorEvent(event);
        if (classified === undefined) {
          // ContentLengthExceededException = 合法的 max_tokens 终止,保持原行为
          // (不记为错误、不打日志)。
          stopReason = 'max_tokens';
        } else {
          log.warn({
            msg: 'received exception event from upstream (non-stream)',
            exception_type: event.exceptionType,
            exception_message: event.message,
          });
          upstreamError = classified;
        }
        break;
      }

      case 'Unknown':
        unknownEventTypes.add(event.eventType);
        break;

      default:
        // Event 是封闭联合:新增一个 kind 会在此变成编译错误,而非被静默丢弃。
        assertNever(event);
    }
  }

  // 先做 legacy `<thinking>` 标签提取（非原生 reasoning 且开启 thinking 时），
  // 让下面的救援只作用于**非 thinking** 文本——模型在思考里起草的调用不是
  // 真实调用，物化它会造成幻影执行。与流式路径行为对齐（流式的 thinking
  // 内容走 thinking_delta，从不经过救援检测器）。
  let thinkingText: string | undefined;
  if (!reasoningText && thinkingEnabled && textContent) {
    const [thinking, remainingText] = extractThinkingFromCompleteText(textContent);
    if (thinking) {
      thinkingText = thinking;
      textContent = remainingText;
    }
  }

  // 泄漏工具调用文本救援：上游偶发把模型的工具调用当纯文本发下来（而非
  // toolUseEvent）。对聚合后的完整文本做一次检测,格式完整的泄漏块转成
  // 真正的 tool_use block（名字经 toolNameMap 反映射）,其余文本原样保留
  // ——包括结构悬空的截断尾巴（永不丢弃,见 tool-call-text.ts 文件头）,
  // 因此 rescued.text 变化 ⟺ 有完整调用被救援。放在 stop_reason 判定和
  // silent-failure 检测之前:纯泄漏 turn 救援后 stop_reason 应为 tool_use,
  // 且不算空响应。
  if (rescueRegistry && textContent) {
    const rescued = extractToolCallsFromCompleteText(textContent, rescueRegistry);
    if (rescued.calls.length > 0) {
      log.warn({
        msg: 'rescued leaked tool-call text into tool_use blocks',
        rescued_calls: rescued.calls.length,
        tools: rescued.calls.map((c) => c.name),
      });
      textContent = rescued.text;
      hasToolUse = true;
      for (const call of rescued.calls) {
        toolUses.push({
          type: 'tool_use',
          id: `toolu_${uuidv4().replace(/-/g, '')}`,
          name: toolNameMap.get(call.name) ?? call.name,
          input: call.input,
        });
      }
    }
  }

  // Determine stop_reason
  if (hasToolUse && stopReason === 'end_turn') {
    stopReason = 'tool_use';
  }

  // Silent-failure detection: upstream occasionally returns a 200 OK
  // event-stream body that decodes into zero content frames. 判空 = 无 text、
  // 无 toolUses、无 reasoning;但排除 model_context_window_exceeded / max_tokens
  // 这两个带空 content 的合法终止信号。`!reasoningText` guard:纯原生-reasoning
  // 响应仍产 thinking content block,不算空。
  const silentFailure =
    textContent === '' &&
    toolUses.length === 0 &&
    !reasoningText &&
    !thinkingText &&
    stopReason !== 'model_context_window_exceeded' &&
    stopReason !== 'max_tokens';

  return {
    reasoningText,
    reasoningSignature,
    thinkingText,
    textContent,
    toolUses,
    hasToolUse,
    stopReason,
    contextInputTokens,
    kiroMetering,
    upstreamError,
    silentFailure,
    eventCounts,
    announcedToolNames,
    unknownEventTypes,
  };
}
