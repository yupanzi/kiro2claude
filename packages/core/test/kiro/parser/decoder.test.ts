import { describe, expect, it } from 'vitest';
import { EventStreamDecoder } from '../../../src/kiro/parser/decoder.js';

describe('EventStreamDecoder', () => {
  it('test_decoder_feed', () => {
    const decoder = new EventStreamDecoder();
    expect(() => decoder.feed(Buffer.from([1, 2, 3, 4]))).not.toThrow();
  });

  it('test_decoder_insufficient_data', () => {
    const decoder = new EventStreamDecoder();
    decoder.feed(Buffer.alloc(10));
    // decode() returns undefined when data is insufficient
    const result = decoder.decode();
    expect(result).toBeUndefined();
  });
});
