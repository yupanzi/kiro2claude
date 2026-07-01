/**
 * AWS Event Stream parse error definitions.
 */

/** Discriminated union for parse errors */
export type ParseError =
  | { type: 'Incomplete'; needed: number; available: number }
  | { type: 'PreludeCrcMismatch'; expected: number; actual: number }
  | { type: 'MessageCrcMismatch'; expected: number; actual: number }
  | { type: 'InvalidHeaderType'; value: number }
  | { type: 'HeaderParseFailed'; message: string }
  | { type: 'MessageTooLarge'; length: number; max: number }
  | { type: 'MessageTooSmall'; length: number; min: number }
  | { type: 'InvalidMessageType'; message: string }
  | { type: 'PayloadDeserialize'; cause: Error }
  | { type: 'Io'; cause: Error }
  | { type: 'TooManyErrors'; count: number; lastError: string }
  | { type: 'BufferOverflow'; size: number; max: number };

/** Custom error class wrapping a ParseError value */
export class ParseException extends Error {
  public readonly parseError: ParseError;

  constructor(parseError: ParseError) {
    super(formatParseError(parseError));
    this.name = 'ParseException';
    this.parseError = parseError;
  }
}

/** Format a ParseError into a human-readable string */
export function formatParseError(e: ParseError): string {
  switch (e.type) {
    case 'Incomplete':
      return `Incomplete: need ${e.needed} bytes, have ${e.available} bytes`;
    case 'PreludeCrcMismatch':
      return `Prelude CRC mismatch: expected 0x${e.expected.toString(16).padStart(8, '0')}, actual 0x${e.actual.toString(16).padStart(8, '0')}`;
    case 'MessageCrcMismatch':
      return `Message CRC mismatch: expected 0x${e.expected.toString(16).padStart(8, '0')}, actual 0x${e.actual.toString(16).padStart(8, '0')}`;
    case 'InvalidHeaderType':
      return `Invalid header value type: ${e.value}`;
    case 'HeaderParseFailed':
      return `Header parse failed: ${e.message}`;
    case 'MessageTooLarge':
      return `Message too large: ${e.length} bytes (max ${e.max})`;
    case 'MessageTooSmall':
      return `Message too small: ${e.length} bytes (min ${e.min})`;
    case 'InvalidMessageType':
      return `Invalid message type: ${e.message}`;
    case 'PayloadDeserialize':
      return `Payload deserialize failed: ${e.cause.message}`;
    case 'Io':
      return `IO error: ${e.cause.message}`;
    case 'TooManyErrors':
      return `Too many consecutive errors (${e.count}), decoder stopped: ${e.lastError}`;
    case 'BufferOverflow':
      return `Buffer overflow: ${e.size} bytes (max ${e.max})`;
  }
}
