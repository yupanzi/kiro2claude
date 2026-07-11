/**
 * AWS Event Stream stateful decoder.
 *
 * Uses a state machine to process streaming data with error recovery.
 *
 * ## State Machine
 *
 * ```
 * +─────────────────+
 * |      Ready      |  (initial, ready to receive data)
 * +────────┬────────+
 *          | feed() provides data
 *          v
 * +─────────────────+
 * |     Parsing     |  decode() attempts parse
 * +────────┬────────+
 *          |
 *     +────+────────────+
 *     v                 v
 *  [success]         [failure]
 *     |                 |
 *     v                 +-> errorCount++
 * +─────────+           |
 * |  Ready  |           +-> errorCount < maxErrors?
 * +─────────+           |    YES -> Recovering -> Ready
 *                       |    NO  v
 *                  +────────────+
 *                  |   Stopped  | (terminal state)
 *                  +────────────+
 * ```
 */

import { type ParseError, ParseException } from './error.js';
import { type Frame, PRELUDE_SIZE, parseFrame } from './frame.js';

/**
 * Default maximum buffer size (16 MB).
 *
 * AWS Event Stream's message length field is a 32-bit unsigned int, so
 * a single frame can theoretically reach 4 GB. In practice Kiro/CodeWhisperer
 * emits frames well under 1 MB (per-event SSE deltas). 16 MB gives two orders
 * of magnitude of headroom while still bounding memory for runaway streams.
 */
export const DEFAULT_MAX_BUFFER_SIZE = 16 * 1024 * 1024;

/** Default maximum consecutive errors before the decoder enters Stopped. */
export const DEFAULT_MAX_ERRORS = 5;

/**
 * Default initial buffer capacity (8 KB).
 *
 * Most SSE chunks from Kiro are well under this size, so starting at 8 KB
 * avoids a grow cycle for the common case while keeping idle memory minimal.
 */
export const DEFAULT_BUFFER_CAPACITY = 8192;

/** Shared zero-length chunk used by drainAll() to nudge Recovering -> Ready. */
const EMPTY_CHUNK = Buffer.alloc(0);

/**
 * Decoder states (four-state model).
 */
export enum DecoderState {
  /** Ready to receive data */
  Ready = 'Ready',
  /** Currently parsing a frame */
  Parsing = 'Parsing',
  /** Recovering from an error (skipping corrupt data) */
  Recovering = 'Recovering',
  /** Stopped due to too many errors (terminal) */
  Stopped = 'Stopped',
}

/**
 * Streaming event stream decoder.
 *
 * Parses AWS Event Stream message frames from a byte stream.
 *
 * @example
 * ```ts
 * const decoder = new EventStreamDecoder();
 *
 * // Feed stream data
 * decoder.feed(chunk);
 *
 * // Decode all available frames
 * const frames = decoder.decodeAll();
 * for (const frame of frames) {
 *   console.log('Got frame:', frame.eventType());
 * }
 * ```
 */
export class EventStreamDecoder {
  /** Internal buffer: concatenation of unprocessed data */
  private buffer: Buffer;
  /** Current offset into the buffer (acts like BytesMut.advance) */
  private offset: number;
  /** Current state */
  private state: DecoderState;
  /** Number of frames decoded so far */
  private framesDecoded: number;
  /** Consecutive error count */
  private errorCount: number;
  /** Maximum consecutive errors before stopping */
  private maxErrors: number;
  /** Maximum buffer size */
  private maxBufferSize: number;
  /** Bytes skipped during recovery (for debugging) */
  private bytesSkipped: number;

  constructor(capacity: number = DEFAULT_BUFFER_CAPACITY) {
    this.buffer = Buffer.alloc(0);
    this.offset = 0;
    this.state = DecoderState.Ready;
    this.framesDecoded = 0;
    this.errorCount = 0;
    this.maxErrors = DEFAULT_MAX_ERRORS;
    this.maxBufferSize = DEFAULT_MAX_BUFFER_SIZE;
    this.bytesSkipped = 0;
  }

  /** Get the current decoder state */
  getState(): DecoderState {
    return this.state;
  }

  /** Get number of frames decoded so far */
  getFramesDecoded(): number {
    return this.framesDecoded;
  }

  /** Get the number of bytes currently buffered */
  getBufferedLength(): number {
    return this.buffer.length - this.offset;
  }

  /** Get the total number of bytes skipped during error recovery (for debugging) */
  getBytesSkipped(): number {
    return this.bytesSkipped;
  }

  /**
   * Feed data into the decoder.
   *
   * @param data - Chunk of data to append
   * @throws ParseException with BufferOverflow if the buffer would exceed maxBufferSize
   */
  feed(data: Buffer | Uint8Array): void {
    const remaining = this.buffer.length - this.offset;
    const incoming = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const newSize = remaining + incoming.length;

    if (newSize > this.maxBufferSize) {
      throw new ParseException({
        type: 'BufferOverflow',
        size: newSize,
        max: this.maxBufferSize,
      });
    }

    if (remaining === 0) {
      // Buffer fully consumed by previous decodeAll — skip concat, direct assign
      this.buffer = incoming;
      this.offset = 0;
    } else if (this.offset > 0) {
      // Compact: copy remaining data to the front
      const remainingBuf = this.buffer.subarray(this.offset);
      this.buffer = Buffer.concat([remainingBuf, incoming]);
      this.offset = 0;
    } else {
      this.buffer = Buffer.concat([this.buffer, incoming]);
    }

    // Transition from Recovering back to Ready
    if (this.state === DecoderState.Recovering) {
      this.state = DecoderState.Ready;
    }
  }

  /**
   * Try to decode the next frame.
   *
   * @returns The next Frame, or undefined if data is incomplete
   * @throws ParseException on decode errors
   */
  decode(): Frame | undefined {
    // If stopped, throw immediately
    if (this.state === DecoderState.Stopped) {
      throw new ParseException({
        type: 'TooManyErrors',
        count: this.errorCount,
        lastError: 'Decoder stopped',
      });
    }

    // Empty buffer -> stay Ready
    const remaining = this.buffer.length - this.offset;
    if (remaining === 0) {
      this.state = DecoderState.Ready;
      return undefined;
    }

    // Transition to Parsing
    this.state = DecoderState.Parsing;

    const view = this.buffer.subarray(this.offset);

    try {
      const result = parseFrame(view);

      if (result === undefined) {
        // Incomplete data, go back to Ready
        this.state = DecoderState.Ready;
        return undefined;
      }

      // Success
      this.offset += result.consumed;
      this.state = DecoderState.Ready;
      this.framesDecoded += 1;
      this.errorCount = 0; // reset consecutive error count
      return result.frame;
    } catch (e) {
      if (!(e instanceof ParseException)) {
        throw e;
      }

      this.errorCount += 1;
      const errorMsg = e.message;

      // Check if we exceeded max errors
      if (this.errorCount >= this.maxErrors) {
        this.state = DecoderState.Stopped;
        throw new ParseException({
          type: 'TooManyErrors',
          count: this.errorCount,
          lastError: errorMsg,
        });
      }

      // Try to recover based on error type
      this.tryRecover(e.parseError);
      this.state = DecoderState.Recovering;
      throw e;
    }
  }

  /**
   * Decode all available frames.
   *
   * Keeps decoding until data is exhausted or an error occurs.
   * Errors during iteration stop the iteration (the error is collected).
   *
   * @returns Array of results, each either a Frame or a ParseException
   */
  decodeAll(): Array<{ frame: Frame } | { error: ParseException }> {
    const results: Array<{ frame: Frame } | { error: ParseException }> = [];

    while (true) {
      // If Stopped or Recovering, stop iterating
      if (this.state === DecoderState.Stopped || this.state === DecoderState.Recovering) {
        break;
      }

      try {
        const frame = this.decode();
        if (frame === undefined) {
          break;
        }
        results.push({ frame });
      } catch (e) {
        if (e instanceof ParseException) {
          results.push({ error: e });
          break; // stop the iterator on the first parse error
        }
        throw e;
      }
    }

    return results;
  }

  /**
   * Like {@link decodeAll}, but resumes past *recoverable* errors by feeding an
   * empty chunk to clear the Recovering state, looping until the buffer is
   * exhausted or the decoder reaches the terminal Stopped state (after
   * maxErrors).
   *
   * Use on a fully-buffered body (non-stream path) where no further feed() will
   * arrive to resume recovery: decodeAll() alone stops at the first recoverable
   * error and would abandon every frame after it — including the tail Metering
   * frame the request is billed for. Safe on the streaming path too: it only
   * self-feeds while Recovering, never on an incomplete (Ready) frame, so
   * incremental cross-chunk decoding is unaffected.
   */
  drainAll(): Array<{ frame: Frame } | { error: ParseException }> {
    const all: Array<{ frame: Frame } | { error: ParseException }> = [];
    while (true) {
      for (const result of this.decodeAll()) all.push(result);
      if (this.state !== DecoderState.Recovering) break;
      // feed() performs the Recovering -> Ready transition; tryRecover() has
      // already advanced offset past the corrupt frame, so this resumes there.
      this.feed(EMPTY_CHUNK);
    }
    return all;
  }

  /**
   * Attempt error recovery.
   *
   * Strategy depends on the error type:
   * - Prelude-phase errors (CRC mismatch, bad length): skip 1 byte to scan for next frame boundary
   * - Data-phase errors (message CRC, header parse): skip the entire corrupted frame
   */
  private tryRecover(error: ParseError): void {
    const remaining = this.buffer.length - this.offset;
    if (remaining === 0) {
      return;
    }

    switch (error.type) {
      // Prelude-phase errors: frame boundary may be misaligned, scan byte-by-byte
      case 'PreludeCrcMismatch':
      case 'MessageTooSmall':
      case 'MessageTooLarge': {
        this.offset += 1;
        this.bytesSkipped += 1;
        break;
      }

      // Data-phase errors: frame boundary is correct but data is corrupt, skip entire frame
      case 'MessageCrcMismatch':
      case 'HeaderParseFailed': {
        if (remaining >= PRELUDE_SIZE) {
          const view = this.buffer.subarray(this.offset);
          const totalLength = view.readUInt32BE(0);

          // Ensure totalLength is reasonable and we have enough data
          if (totalLength >= 16 && totalLength <= remaining) {
            this.offset += totalLength;
            this.bytesSkipped += totalLength;
            break;
          }
        }

        // Cannot determine frame length, fall back to byte-by-byte skip
        this.offset += 1;
        this.bytesSkipped += 1;
        break;
      }

      // Other errors: skip byte-by-byte
      default: {
        this.offset += 1;
        this.bytesSkipped += 1;
        break;
      }
    }
  }
}
