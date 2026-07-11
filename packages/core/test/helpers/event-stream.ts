/**
 * Shared test utility for encoding AWS Event Stream frames.
 *
 * Wire format:
 *   [4B totalLen][4B headerLen][4B preludeCRC][headers…][payload…][4B msgCRC]
 *
 * Each String header:
 *   [1B nameLen][name bytes][1B type=7][2B valueLen][value bytes]
 */

import type { KiroMeteringData } from '../../src/kiro/model/events/base.js';
import { crc32 } from '../../src/kiro/parser/crc.js';

/**
 * Encode a single AWS Event Stream frame with String-typed headers.
 */
export function encodeEventStreamFrame(headers: Record<string, string>, payload: Buffer): Buffer {
  const headerParts: Buffer[] = [];
  for (const [name, value] of Object.entries(headers)) {
    const nameBuf = Buffer.from(name, 'utf-8');
    const valueBuf = Buffer.from(value, 'utf-8');
    const part = Buffer.alloc(1 + nameBuf.length + 1 + 2 + valueBuf.length);
    let offset = 0;
    part.writeUInt8(nameBuf.length, offset);
    offset += 1;
    nameBuf.copy(part, offset);
    offset += nameBuf.length;
    part.writeUInt8(7, offset); // HeaderValueType.String
    offset += 1;
    part.writeUInt16BE(valueBuf.length, offset);
    offset += 2;
    valueBuf.copy(part, offset);
    headerParts.push(part);
  }
  const headerBuf = Buffer.concat(headerParts);

  const totalLength = 12 + headerBuf.length + payload.length + 4;
  const frame = Buffer.alloc(totalLength);

  frame.writeUInt32BE(totalLength, 0);
  frame.writeUInt32BE(headerBuf.length, 4);
  const preludeCrc = crc32(frame.subarray(0, 8));
  frame.writeUInt32BE(preludeCrc, 8);

  headerBuf.copy(frame, 12);
  payload.copy(frame, 12 + headerBuf.length);

  const msgCrc = crc32(frame.subarray(0, totalLength - 4));
  frame.writeUInt32BE(msgCrc, totalLength - 4);

  return frame;
}

/** Build a Metering event frame from a KiroMeteringData payload. */
export function buildMeteringFrame(metering: KiroMeteringData): Buffer {
  return encodeEventStreamFrame(
    { ':message-type': 'event', ':event-type': 'meteringEvent' },
    Buffer.from(JSON.stringify(metering), 'utf-8'),
  );
}

/** Build an AssistantResponse frame with the given text. */
export function buildAssistantResponseFrame(content: string): Buffer {
  return encodeEventStreamFrame(
    { ':message-type': 'event', ':event-type': 'assistantResponseEvent' },
    Buffer.from(JSON.stringify({ content }), 'utf-8'),
  );
}

/**
 * Build the `[assistantResponseEvent, meteringEvent]` frame pair used by tests
 * that need a non-empty response carrying metering: the content frame keeps the
 * response non-empty (so the silent-failure detector does not fire) while the
 * metering frame exercises the usage/credits path.
 */
export function framesWithMetering(metering: KiroMeteringData, content = 'hi'): Buffer[] {
  return [buildAssistantResponseFrame(content), buildMeteringFrame(metering)];
}

/**
 * Build a ToolUse frame. `stop` maps to `isComplete` (base.ts). Two distinct
 * shapes:
 *   - `input: ''` + `stop: false` (defaults) = a *truncated* shell frame: the
 *     model announced a tool_use but the complete frame never arrived. No token
 *     output and isComplete=false → both paths treat it as empty (retry → 503).
 *   - `input: ''` + `stop: true` = a *complete* no-argument tool call (e.g.
 *     `browser_snapshot`, all params optional → input `{}`). Real content: the
 *     non-stream path surfaces it as a tool_use, and the stream path must too
 *     (the 2026-07 regression — otherwise stream 503 vs non-stream 200).
 */
export function buildToolUseFrame(
  name: string,
  toolUseId: string,
  input = '',
  stop = false,
): Buffer {
  return encodeEventStreamFrame(
    { ':message-type': 'event', ':event-type': 'toolUseEvent' },
    Buffer.from(JSON.stringify({ name, toolUseId, input, stop }), 'utf-8'),
  );
}

/** Build a ReasoningContent frame (kiro-cli 2.6.0+ native reasoning event). */
export function buildReasoningContentFrame(text: string, signature?: string): Buffer {
  const payload: { text: string; signature?: string } = { text };
  if (signature !== undefined) payload.signature = signature;
  return encodeEventStreamFrame(
    { ':message-type': 'event', ':event-type': 'reasoningContentEvent' },
    Buffer.from(JSON.stringify(payload), 'utf-8'),
  );
}

/**
 * Build a ContextUsage frame. `percentage >= 100` makes the handler resolve a
 * window-exceeded terminal (stop_reason `model_context_window_exceeded`); see
 * `resolveContextUsage` in converter.ts. A ContextUsage frame carries NO content,
 * so on its own it decodes to an empty-but-terminal response — used to assert
 * that the empty-stream retry correctly EXCLUDES this deterministic terminal.
 */
export function buildContextUsageFrame(percentage: number): Buffer {
  return encodeEventStreamFrame(
    { ':message-type': 'event', ':event-type': 'contextUsageEvent' },
    Buffer.from(JSON.stringify({ contextUsagePercentage: percentage }), 'utf-8'),
  );
}

/**
 * Build an upstream `error` message-type frame (`:error-code` header + payload
 * message). Decodes to `{ kind: 'Error', errorCode, errorMessage }` (base.ts).
 */
export function buildErrorFrame(errorCode = 'InternalServerException', message = 'boom'): Buffer {
  return encodeEventStreamFrame(
    { ':message-type': 'error', ':error-code': errorCode },
    Buffer.from(message, 'utf-8'),
  );
}

/**
 * Build an upstream `exception` message-type frame (`:exception-type` header +
 * payload message). Decodes to `{ kind: 'Exception', exceptionType, message }`.
 * `ContentLengthExceededException` is a legitimate max_tokens terminal; any other
 * type is a real error.
 */
export function buildExceptionFrame(exceptionType: string, message = 'exception detail'): Buffer {
  return encodeEventStreamFrame(
    { ':message-type': 'exception', ':exception-type': exceptionType },
    Buffer.from(message, 'utf-8'),
  );
}

// ============================================================================
// SSE response parsing (used by e2e tests)
// ============================================================================

/** Parsed SSE event: `{ event, data }` tuple. */
export interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

/**
 * Parse an SSE response body into `{event, data}` tuples. Tolerates both
 * `\n\n` and `\r\n\r\n` block separators. Skips malformed blocks rather
 * than throwing, because a single bad chunk shouldn't tank the whole
 * assertion chain.
 */
export function parseSseEvents(body: string): SseEvent[] {
  const blocks = body.split(/\r?\n\r?\n/).filter((b) => b.trim().length > 0);
  const events: SseEvent[] = [];
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    let evName = '';
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith('event: ')) evName = line.slice(7);
      else if (line.startsWith('data: ')) dataLines.push(line.slice(6));
    }
    if (!evName || dataLines.length === 0) continue;
    try {
      events.push({ event: evName, data: JSON.parse(dataLines.join('\n')) });
    } catch {
      // ignore malformed chunk
    }
  }
  return events;
}
