import { describe, expect, it } from 'vitest';
import { crc32 } from '../../../src/kiro/parser/crc.js';
import { ParseException } from '../../../src/kiro/parser/error.js';
import { parseFrame } from '../../../src/kiro/parser/frame.js';

describe('frame parser', () => {
  it('test_frame_insufficient_data', () => {
    const buffer = Buffer.alloc(10); // less than PRELUDE_SIZE
    expect(parseFrame(buffer)).toBeUndefined();
  });

  it('test_frame_message_too_small', () => {
    // Build a prelude with total_length = 10 (less than min)
    const buffer = Buffer.alloc(16);
    buffer.writeUInt32BE(10, 0); // total_length
    buffer.writeUInt32BE(0, 4); // header_length
    const preludeCrc = crc32(buffer.subarray(0, 8));
    buffer.writeUInt32BE(preludeCrc, 8);

    try {
      parseFrame(buffer);
      expect.fail('Expected parseFrame to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ParseException);
      expect((e as ParseException).parseError.type).toBe('MessageTooSmall');
    }
  });
});
