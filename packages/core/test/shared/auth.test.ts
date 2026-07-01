import { describe, expect, it } from 'vitest';

import { constantTimeEq } from '../../src/shared/auth.js';

describe('constantTimeEq', () => {
  it('returns true when both strings are identical', () => {
    expect(constantTimeEq('sk-test-abc123', 'sk-test-abc123')).toBe(true);
  });

  it('returns false when strings differ in content but have equal length', () => {
    expect(constantTimeEq('sk-test-abc123', 'sk-test-xyz789')).toBe(false);
  });

  it('returns false when lengths differ (shorter vs longer)', () => {
    expect(constantTimeEq('short', 'longer-key')).toBe(false);
  });

  it('returns false when lengths differ (longer vs shorter)', () => {
    expect(constantTimeEq('longer-key', 'short')).toBe(false);
  });

  it('returns false when one string is a prefix of the other', () => {
    // 长度不等的两串也必须走完填充后的 timingSafeEqual 才返回 false，
    // 不能靠"长度不等立即 return"提前退出（那会泄漏长度）
    expect(constantTimeEq('abc', 'abcd')).toBe(false);
  });

  it('returns true when both strings are empty', () => {
    expect(constantTimeEq('', '')).toBe(true);
  });

  it('returns false when one string is empty and the other is not', () => {
    expect(constantTimeEq('', 'nonempty')).toBe(false);
    expect(constantTimeEq('nonempty', '')).toBe(false);
  });

  it('compares UTF-8 multi-byte characters at byte level', () => {
    // 两个中文字符在 UTF-8 下各占 3 字节，长度相等但内容不同
    expect(constantTimeEq('你好', '你好')).toBe(true);
    expect(constantTimeEq('你好', '世界')).toBe(false);
  });

  it('handles ASCII and multi-byte mixing correctly', () => {
    // ASCII-only 'abc' = 3 bytes; '你' = 3 bytes (UTF-8)
    // 长度在字节层面相等但字符级别不同——必须返回 false
    expect(constantTimeEq('abc', '你')).toBe(false);
  });

  it('does not throw on extreme length mismatch', () => {
    // 确保零填充路径不会在极端长度差下抛
    const short = 'a';
    const long = 'a'.repeat(10_000);
    expect(() => constantTimeEq(short, long)).not.toThrow();
    expect(constantTimeEq(short, long)).toBe(false);
  });
});
