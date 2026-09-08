import { describe, expect, it } from 'vitest';
import { EventStreamDecoder } from '../../../src/kiro/parser/decoder.js';
import { buildAssistantResponseFrame, buildMeteringFrame } from '../../helpers/event-stream.js';

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

  it('the same complete byte stream succeeds at every possible chunk boundary', () => {
    const bytes = Buffer.concat([
      buildAssistantResponseFrame('one'),
      buildAssistantResponseFrame('two'),
    ]);
    for (let split = 0; split <= bytes.length; split++) {
      const decoder = new EventStreamDecoder();
      decoder.feed(bytes.subarray(0, split));
      const results = decoder.drainAll();
      decoder.feed(bytes.subarray(split));
      results.push(...decoder.drainAll());
      expect(() => decoder.assertComplete(), `split ${split}`).not.toThrow();
      expect(results.filter((result) => 'frame' in result)).toHaveLength(2);
      expect(decoder.getBufferedLength()).toBe(0);
    }
  });

  it('every nonempty incomplete frame prefix fails only once EOF is known', () => {
    const bytes = buildAssistantResponseFrame('cut at any byte');
    for (let cut = 1; cut < bytes.length; cut++) {
      const decoder = new EventStreamDecoder();
      decoder.feed(bytes.subarray(0, cut));
      expect(decoder.drainAll()).toEqual([]);
      expect(() => decoder.assertComplete(), `cut ${cut}`).toThrow('Incomplete');
    }
  });

  it('recovering a complete tail cannot erase earlier corruption at EOF', () => {
    const corrupt = buildAssistantResponseFrame('missing span');
    corrupt[corrupt.length - 1]! ^= 1;
    const decoder = new EventStreamDecoder();
    decoder.feed(
      Buffer.concat([
        corrupt,
        buildMeteringFrame({ unit: 'credit', unitPlural: 'credits', usage: 0.42 }),
      ]),
    );
    const results = decoder.drainAll();
    expect(results.filter((result) => 'error' in result)).toHaveLength(1);
    expect(results.filter((result) => 'frame' in result)).toHaveLength(1);
    expect(decoder.getBufferedLength()).toBe(0);
    expect(() => decoder.assertComplete()).toThrow('CRC');
  });
});
