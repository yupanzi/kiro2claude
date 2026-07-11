/**
 * AWS Event Stream header parsing.
 *
 * Implements parsing for all 10 header value types defined by the
 * AWS Event Stream protocol.
 */

import { ParseException } from './error.js';

/**
 * Header value type identifiers (10 types defined by the protocol).
 */
export enum HeaderValueType {
  BoolTrue = 0,
  BoolFalse = 1,
  Byte = 2,
  Short = 3,
  Integer = 4,
  Long = 5,
  ByteArray = 6,
  String = 7,
  Timestamp = 8,
  Uuid = 9,
}

/**
 * Convert a raw byte to a HeaderValueType, or throw on invalid values.
 */
function headerValueTypeFromByte(value: number): HeaderValueType {
  if (value >= 0 && value <= 9) {
    return value as HeaderValueType;
  }
  throw new ParseException({ type: 'InvalidHeaderType', value });
}

/** Discriminated union for header values */
export type HeaderValue =
  | { kind: 'Bool'; value: boolean }
  | { kind: 'Byte'; value: number } // i8
  | { kind: 'Short'; value: number } // i16
  | { kind: 'Integer'; value: number } // i32
  | { kind: 'Long'; value: bigint } // i64
  | { kind: 'ByteArray'; value: Buffer }
  | { kind: 'String'; value: string }
  | { kind: 'Timestamp'; value: bigint } // i64 millis
  | { kind: 'Uuid'; value: Buffer }; // 16 bytes

/**
 * Try to extract the string value from a HeaderValue.
 * Returns undefined if the value is not a String.
 */
export function headerValueAsStr(hv: HeaderValue): string | undefined {
  return hv.kind === 'String' ? hv.value : undefined;
}

/**
 * Message header collection.
 */
export class Headers {
  private readonly inner: Map<string, HeaderValue> = new Map();

  /** Insert a header */
  insert(name: string, value: HeaderValue): void {
    this.inner.set(name, value);
  }

  /** Get a header value by name */
  get(name: string): HeaderValue | undefined {
    return this.inner.get(name);
  }

  /** Get a string-typed header value */
  getString(name: string): string | undefined {
    const v = this.get(name);
    return v ? headerValueAsStr(v) : undefined;
  }

  /** Get the :message-type header */
  messageType(): string | undefined {
    return this.getString(':message-type');
  }

  /** Get the :event-type header */
  eventType(): string | undefined {
    return this.getString(':event-type');
  }

  /** Get the :exception-type header */
  exceptionType(): string | undefined {
    return this.getString(':exception-type');
  }

  /** Get the :error-code header */
  errorCode(): string | undefined {
    return this.getString(':error-code');
  }
}

/**
 * Parse headers from a binary buffer.
 *
 * @param data - The buffer containing header data
 * @param headerLength - Total length of header data in bytes
 * @returns Parsed Headers
 * @throws ParseException on parse errors
 */
export function parseHeaders(data: Buffer, headerLength: number): Headers {
  // Validate data length
  if (data.length < headerLength) {
    throw new ParseException({
      type: 'Incomplete',
      needed: headerLength,
      available: data.length,
    });
  }

  const headers = new Headers();
  let offset = 0;

  while (offset < headerLength) {
    // Read header name length (1 byte)
    if (offset >= data.length) {
      break;
    }
    const nameLen = data[offset];
    offset += 1;

    // Validate name length
    if (nameLen === 0) {
      throw new ParseException({
        type: 'HeaderParseFailed',
        message: 'Header name length cannot be 0',
      });
    }

    // Read header name
    if (offset + nameLen > data.length) {
      throw new ParseException({
        type: 'Incomplete',
        needed: nameLen,
        available: data.length - offset,
      });
    }
    const name = data.subarray(offset, offset + nameLen).toString('utf-8');
    offset += nameLen;

    // Read value type (1 byte)
    if (offset >= data.length) {
      throw new ParseException({
        type: 'Incomplete',
        needed: 1,
        available: 0,
      });
    }
    const valueType = headerValueTypeFromByte(data[offset]);
    offset += 1;

    // Parse value based on type
    const result = parseHeaderValue(data, offset, valueType);
    headers.insert(name, result.value);
    offset = result.newOffset;
  }

  return headers;
}

/**
 * Ensure there are enough bytes remaining in the buffer.
 */
function ensureBytes(data: Buffer, offset: number, needed: number): void {
  const available = data.length - offset;
  if (available < needed) {
    throw new ParseException({
      type: 'Incomplete',
      needed,
      available,
    });
  }
}

/**
 * Parse a single header value from the buffer at the given offset.
 * Returns the parsed value and the new offset after consuming the value bytes.
 */
function parseHeaderValue(
  data: Buffer,
  offset: number,
  valueType: HeaderValueType,
): { value: HeaderValue; newOffset: number } {
  switch (valueType) {
    case HeaderValueType.BoolTrue:
      return { value: { kind: 'Bool', value: true }, newOffset: offset };

    case HeaderValueType.BoolFalse:
      return { value: { kind: 'Bool', value: false }, newOffset: offset };

    case HeaderValueType.Byte: {
      ensureBytes(data, offset, 1);
      const v = data.readInt8(offset);
      return { value: { kind: 'Byte', value: v }, newOffset: offset + 1 };
    }

    case HeaderValueType.Short: {
      ensureBytes(data, offset, 2);
      const v = data.readInt16BE(offset);
      return { value: { kind: 'Short', value: v }, newOffset: offset + 2 };
    }

    case HeaderValueType.Integer: {
      ensureBytes(data, offset, 4);
      const v = data.readInt32BE(offset);
      return { value: { kind: 'Integer', value: v }, newOffset: offset + 4 };
    }

    case HeaderValueType.Long: {
      ensureBytes(data, offset, 8);
      const v = data.readBigInt64BE(offset);
      return { value: { kind: 'Long', value: v }, newOffset: offset + 8 };
    }

    case HeaderValueType.ByteArray: {
      ensureBytes(data, offset, 2);
      const len = data.readUInt16BE(offset);
      ensureBytes(data, offset, 2 + len);
      const v = Buffer.from(data.subarray(offset + 2, offset + 2 + len));
      return { value: { kind: 'ByteArray', value: v }, newOffset: offset + 2 + len };
    }

    case HeaderValueType.String: {
      ensureBytes(data, offset, 2);
      const len = data.readUInt16BE(offset);
      ensureBytes(data, offset, 2 + len);
      const v = data.subarray(offset + 2, offset + 2 + len).toString('utf-8');
      return { value: { kind: 'String', value: v }, newOffset: offset + 2 + len };
    }

    case HeaderValueType.Timestamp: {
      ensureBytes(data, offset, 8);
      const v = data.readBigInt64BE(offset);
      return { value: { kind: 'Timestamp', value: v }, newOffset: offset + 8 };
    }

    case HeaderValueType.Uuid: {
      ensureBytes(data, offset, 16);
      const v = Buffer.from(data.subarray(offset, offset + 16));
      return { value: { kind: 'Uuid', value: v }, newOffset: offset + 16 };
    }
  }
}
