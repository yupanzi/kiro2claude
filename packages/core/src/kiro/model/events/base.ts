import { getLogger } from '../../../shared/logger.js';
import type { Frame } from '../../parser/frame.js';

/** 事件类型枚举 */
export type EventType =
  | 'AssistantResponse'
  | 'ToolUse'
  | 'Metering'
  | 'ContextUsage'
  | 'ReasoningContent'
  | 'Metadata'
  | 'Unknown';

/** 从事件类型字符串解析 */
export function parseEventType(s: string): EventType {
  switch (s) {
    case 'assistantResponseEvent':
      return 'AssistantResponse';
    case 'toolUseEvent':
      return 'ToolUse';
    case 'meteringEvent':
      return 'Metering';
    case 'contextUsageEvent':
      return 'ContextUsage';
    case 'reasoningContentEvent':
      return 'ReasoningContent';
    case 'metadataEvent':
      return 'Metadata';
    default:
      return 'Unknown';
  }
}

/** 从帧解析事件 */
export function eventFromFrame(frame: Frame): Event {
  const messageType = frame.messageType() ?? 'event';

  switch (messageType) {
    case 'event':
      return parseEvent(frame);
    case 'error':
      return parseError(frame);
    case 'exception':
      return parseException(frame);
    default:
      throw new Error(`Invalid message type: ${messageType}`);
  }
}

/** Known events consume object fields; unknown events remain opaque below. */
function eventPayload(frame: Frame): Record<string, unknown> {
  const payload = frame.payloadAsJson<unknown>();
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Invalid event payload: expected an object');
  }
  return payload as Record<string, unknown>;
}

/** Preserve absent/null defaults, but never coerce a populated wire field. */
function optionalString(payload: Record<string, unknown>, field: string): string | undefined {
  const value = payload[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`Invalid event field: ${field} must be a string`);
  return value;
}

function optionalNumber(payload: Record<string, unknown>, field: string): number | undefined {
  const value = payload[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid event field: ${field} must be a finite number`);
  }
  return value;
}

function parseEvent(frame: Frame): Event {
  const eventTypeStr = frame.eventType() ?? 'unknown';
  const eventType = parseEventType(eventTypeStr);

  switch (eventType) {
    case 'AssistantResponse': {
      const payload = eventPayload(frame);
      return {
        kind: 'AssistantResponse',
        content: optionalString(payload, 'content') ?? '',
      };
    }
    case 'ToolUse': {
      const payload = eventPayload(frame);
      // Type assertions do not validate wire data. In particular, a string
      // "false" is truthy and would release unfinished input as an executable
      // tool call; an object input would become "[object Object]" when joined.
      if (
        typeof payload?.name !== 'string' ||
        !payload.name.trim() ||
        typeof payload.toolUseId !== 'string' ||
        !payload.toolUseId.trim() ||
        (payload.input !== undefined && typeof payload.input !== 'string') ||
        (payload.stop !== undefined && typeof payload.stop !== 'boolean')
      ) {
        throw new Error('Invalid toolUseEvent fields');
      }
      return {
        kind: 'ToolUse',
        name: payload.name,
        toolUseId: payload.toolUseId,
        input: payload.input ?? '',
        isComplete: payload.stop ?? false,
      };
    }
    case 'Metering': {
      const raw = eventPayload(frame);
      getLogger().debug({ msg: 'raw meteringEvent payload', metering_raw: raw });
      return {
        ...raw,
        kind: 'Metering' as const,
        unit: optionalString(raw, 'unit') ?? '',
        unitPlural: optionalString(raw, 'unitPlural') ?? '',
        usage: optionalNumber(raw, 'usage') ?? 0,
      };
    }
    case 'ContextUsage': {
      const payload = eventPayload(frame);
      return {
        kind: 'ContextUsage',
        contextUsagePercentage: optionalNumber(payload, 'contextUsagePercentage') ?? 0,
      };
    }
    case 'ReasoningContent': {
      // kiro-cli 2.6.0+ 原生 reasoning event。payload schema 实测两种形态：
      //   - Claude 4.7/4.8: { "text": "fragment", "signature"?: "<base64 签名>" }
      //     与 Anthropic Extended Thinking 的 thinking_delta / signature_delta 1:1 对应。
      //   - GPT-5.6: { "redactedContent": "<base64 加密 blob>" }（无 text/signature）——
      //     隐藏思维链,内容加密不可读。显式建模 redactedContent 而非落进 text ?? ''
      //     的空串黑洞,让它可观测；下游 stream.ts 的守卫据「无 text 无 signature」丢弃。
      const payload = eventPayload(frame);
      return {
        kind: 'ReasoningContent',
        text: optionalString(payload, 'text') ?? '',
        signature: optionalString(payload, 'signature'),
        redactedContent: optionalString(payload, 'redactedContent'),
      };
    }
    case 'Metadata': {
      // 上游生成**正常收尾**的标记帧。2026-09 对 352 条真实响应(Claude + GPT-5.6,
      // 流式/工具/纯文本)的帧审计:351 条全部以 metadataEvent → contextUsageEvent →
      // meteringEvent 收尾,唯一缺它的那条是 reasoning 中途干净 EOF。故消费方只取
      // 「出现过」这一事实来判「说完了 / 说到一半断了」;`stopReason` 本身不可信——
      // 带工具调用的响应里它同样报 END_TURN(124/325),终态仍由网关自行推断。
      const payload = eventPayload(frame);
      return { kind: 'Metadata', stopReason: optionalString(payload, 'stopReason') };
    }
    case 'Unknown':
      return {
        kind: 'Unknown',
        eventType: eventTypeStr,
        payload: frame.payload,
      };
  }
}

function parseError(frame: Frame): Event {
  const errorCode = frame.headers.errorCode() ?? 'UnknownError';
  const errorMessage = frame.payloadAsStr();
  return { kind: 'Error', errorCode, errorMessage };
}

function parseException(frame: Frame): Event {
  const exceptionType = frame.headers.exceptionType() ?? 'UnknownException';
  const message = frame.payloadAsStr();
  return { kind: 'Exception', exceptionType, message };
}

/**
 * Metering event payload (minus the `kind` discriminant).
 *
 * 已知字段有 unit / unitPlural / usage，但上游可能随时添加新字段（如
 * 计费层级、费率等），index signature 让新字段自动透传到下游响应中。
 */
export interface KiroMeteringData {
  unit: string;
  unitPlural: string;
  usage: number;
  /** 上游未显式声明的额外字段，自动透传 */
  [key: string]: unknown;
}

/** 统一事件类型（discriminated union） */
export type Event =
  | { kind: 'AssistantResponse'; content: string }
  | { kind: 'ToolUse'; name: string; toolUseId: string; input: string; isComplete: boolean }
  | ({ kind: 'Metering' } & KiroMeteringData)
  | { kind: 'ContextUsage'; contextUsagePercentage: number }
  | {
      kind: 'ReasoningContent';
      text: string;
      signature: string | undefined;
      /** GPT-5.6 加密隐藏思维链(base64)；Claude 明文 reasoning 时不带此字段。 */
      redactedContent?: string;
    }
  | { kind: 'Metadata'; stopReason: string | undefined }
  | { kind: 'Unknown'; eventType: string; payload: Buffer }
  | { kind: 'Error'; errorCode: string; errorMessage: string }
  | { kind: 'Exception'; exceptionType: string; message: string };
