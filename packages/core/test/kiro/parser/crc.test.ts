import { describe, expect, it } from 'vitest';
import { crc32 } from '../../../src/kiro/parser/crc.js';

describe('crc32', () => {
  it('test_crc32_empty', () => {
    // Empty data should produce 0
    expect(crc32(Buffer.alloc(0))).toBe(0);
  });

  it('test_crc32_known_value', () => {
    // "123456789" CRC32 (ISO-HDLC) = 0xCBF43926
    const data = Buffer.from('123456789', 'utf-8');
    expect(crc32(data)).toBe(0xcbf43926);
  });
});
