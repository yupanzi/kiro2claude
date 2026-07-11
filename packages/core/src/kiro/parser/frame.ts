/**
 * AWS Event Stream message frame parsing.
 *
 * ## Message Format
 *
 * ```
 * +──────────────+──────────────+──────────────+──────────+──────────+───────────+
 * | Total Length | Header Length| Prelude CRC  | Headers  | Payload  | Msg CRC   |
 * |   (4 bytes)  |   (4 bytes)  |   (4 bytes)  | (var)    | (var)    | (4 bytes) |
 * +──────────────+──────────────+──────────────+──────────+──────────+───────────+
 * ```
 *
 * - Total Length: total message length including itself (4 bytes)
 * - Header Length: length of the headers section
 * - Prelude CRC: CRC32 of the first 8 bytes (Total Length + Header Length)
 * - Headers: header data
 * - Payload: payload data (usually JSON)
 * - Message CRC: CRC32 of the entire message excluding the last 4 bytes
 */

import { crc32 } from './crc.js';
import { ParseException } from './error.js';
import { type Headers, parseHeaders } from './header.js';

/** Prelude fixed size (12 bytes) */
export const PRELUDE_SIZE = 12;

/** Minimum message size (Prelude + Message CRC) */
export const MIN_MESSAGE_SIZE = PRELUDE_SIZE + 4; // 16

/** Maximum message size limit (16 MB) */
export const MAX_MESSAGE_SIZE = 16 * 1024 * 1024;

/**
 * A parsed message frame.
 */
export class Frame {
  /** Message headers */
  public readonly headers: Headers;
  /** Message payload */
  public readonly payload: Buffer;

  constructor(headers: Headers, payload: Buffer) {
    this.headers = headers;
    this.payload = payload;
  }

  /** Get the :message-type header */
  messageType(): string | undefined {
    return this.headers.messageType();
  }

  /** Get the :event-type header */
  eventType(): string | undefined {
    return this.headers.eventType();
  }

  /** Parse payload as JSON */
  payloadAsJson<T = unknown>(): T {
    try {
      return JSON.parse(this.payload.toString('utf-8')) as T;
    } catch (cause) {
      throw new ParseException({
        type: 'PayloadDeserialize',
        cause: cause instanceof Error ? cause : new Error(String(cause)),
      });
    }
  }

  /** Get payload as a UTF-8 string */
  payloadAsStr(): string {
    return this.payload.toString('utf-8');
  }
}

/**
 * Result of a successful frame parse: the frame and number of bytes consumed.
 */
export interface FrameParseResult {
  frame: Frame;
  consumed: number;
}

/**
 * Try to parse a complete frame from the buffer.
 *
 * This is a stateless pure function. Buffer management is handled by the
 * upper-level EventStreamDecoder.
 *
 * @param buffer - Input buffer
 * @returns Parsed frame and consumed byte count, or undefined if data is incomplete
 * @throws ParseException on parse errors (CRC mismatch, invalid data, etc.)
 */
export function parseFrame(buffer: Buffer): FrameParseResult | undefined {
  // Check if we have enough data for the prelude
  if (buffer.length < PRELUDE_SIZE) {
    return undefined;
  }

  // Read prelude
  const totalLength = buffer.readUInt32BE(0);
  const headerLength = buffer.readUInt32BE(4);
  const preludeCrc = buffer.readUInt32BE(8);

  // Validate message length range
  if (totalLength < MIN_MESSAGE_SIZE) {
    throw new ParseException({
      type: 'MessageTooSmall',
      length: totalLength,
      min: MIN_MESSAGE_SIZE,
    });
  }

  if (totalLength > MAX_MESSAGE_SIZE) {
    throw new ParseException({
      type: 'MessageTooLarge',
      length: totalLength,
      max: MAX_MESSAGE_SIZE,
    });
  }

  // Check if we have the full message
  if (buffer.length < totalLength) {
    return undefined;
  }

  // Verify Prelude CRC
  const actualPreludeCrc = crc32(buffer.subarray(0, 8));
  if (actualPreludeCrc !== preludeCrc) {
    throw new ParseException({
      type: 'PreludeCrcMismatch',
      expected: preludeCrc,
      actual: actualPreludeCrc,
    });
  }

  // Read Message CRC (last 4 bytes)
  const messageCrc = buffer.readUInt32BE(totalLength - 4);

  // Verify Message CRC (over everything except the last 4 bytes)
  const actualMessageCrc = crc32(buffer.subarray(0, totalLength - 4));
  if (actualMessageCrc !== messageCrc) {
    throw new ParseException({
      type: 'MessageCrcMismatch',
      expected: messageCrc,
      actual: actualMessageCrc,
    });
  }

  // Parse headers
  const headersStart = PRELUDE_SIZE;
  const headersEnd = headersStart + headerLength;

  // Validate header boundary
  if (headersEnd > totalLength - 4) {
    throw new ParseException({
      type: 'HeaderParseFailed',
      message: 'Header length exceeds message boundary',
    });
  }

  const headers = parseHeaders(buffer.subarray(headersStart, headersEnd), headerLength);

  // subarray shares memory with the source buffer; the streaming decode loop
  // consumes each Frame inside one decodeAll() iteration so the reference never
  // outlives the buffer's natural lifetime.
  const payloadStart = headersEnd;
  const payloadEnd = totalLength - 4;
  const payload = buffer.subarray(payloadStart, payloadEnd);

  return {
    frame: new Frame(headers, payload),
    consumed: totalLength,
  };
}
