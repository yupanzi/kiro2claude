import { getLogger } from '../../../shared/logger.js';
import type { Frame } from '../../parser/frame.js';

/** 事件类型枚举 */
export type EventType =
  | 'AssistantResponse'
  | 'ToolUse'
  | 'Metering'
  | 'ContextUsage'
  | 'ReasoningContent'
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

function parseEvent(frame: Frame): Event {
  const eventTypeStr = frame.eventType() ?? 'unknown';
  const eventType = parseEventType(eventTypeStr);

  switch (eventType) {
    case 'AssistantResponse': {
      const payload = frame.payloadAsJson<{ content?: string }>();
      return {
        kind: 'AssistantResponse',
        content: payload.content ?? '',
      };
    }
    case 'ToolUse': {
      const payload = frame.payloadAsJson<{
        name: string;
        toolUseId: string;
        input?: string;
        stop?: boolean;
      }>();
      return {
        kind: 'ToolUse',
        name: payload.name,
        toolUseId: payload.toolUseId,
        input: payload.input ?? '',
        isComplete: payload.stop ?? false,
      };
    }
    case 'Metering': {
      const raw = frame.payloadAsJson<Record<string, unknown>>();
      getLogger().debug({ msg: 'raw meteringEvent payload', metering_raw: raw });
      return {
        ...raw,
        kind: 'Metering' as const,
        unit: typeof raw.unit === 'string' ? raw.unit : '',
        unitPlural: typeof raw.unitPlural === 'string' ? raw.unitPlural : '',
        usage: typeof raw.usage === 'number' ? raw.usage : 0,
      };
    }
    case 'ContextUsage': {
      const payload = frame.payloadAsJson<{ contextUsagePercentage?: number }>();
      return {
        kind: 'ContextUsage',
        contextUsagePercentage: payload.contextUsagePercentage ?? 0,
      };
    }
    case 'ReasoningContent': {
      // kiro-cli 2.6.0+ 原生 reasoning event。payload schema 实测两种形态：
      //   - Claude 4.7/4.8: { "text": "fragment", "signature"?: "<base64 签名>" }
      //     与 Anthropic Extended Thinking 的 thinking_delta / signature_delta 1:1 对应。
      //   - GPT-5.6: { "redactedContent": "<base64 加密 blob>" }（无 text/signature）——
      //     隐藏思维链,内容加密不可读。显式建模 redactedContent 而非落进 text ?? ''
      //     的空串黑洞,让它可观测；下游 stream.ts 的守卫据「无 text 无 signature」丢弃。
      const payload = frame.payloadAsJson<{
        text?: string;
        signature?: string;
        redactedContent?: string;
      }>();
      return {
        kind: 'ReasoningContent',
        text: payload.text ?? '',
        signature: typeof payload.signature === 'string' ? payload.signature : undefined,
        redactedContent:
          typeof payload.redactedContent === 'string' ? payload.redactedContent : undefined,
      };
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
  | { kind: 'Unknown'; eventType: string; payload: Buffer }
  | { kind: 'Error'; errorCode: string; errorMessage: string }
  | { kind: 'Exception'; exceptionType: string; message: string };
