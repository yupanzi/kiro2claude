import crypto from 'node:crypto';
import type { FastifyRequest } from 'fastify';

/**
 * 从请求中提取 API Key
 *
 * 支持两种认证方式：
 * - x-api-key header
 * - Authorization: Bearer <token> header
 */
export function extractApiKey(request: FastifyRequest): string | undefined {
  // 优先检查 x-api-key
  const xApiKey = request.headers['x-api-key'];
  if (typeof xApiKey === 'string' && xApiKey) {
    return xApiKey;
  }

  // 其次检查 Authorization: Bearer
  const auth = request.headers['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return auth.slice(7);
  }

  return undefined;
}

/**
 * 常量时间字符串比较，防止时序攻击。
 *
 * 无论字符串内容或长度如何，比较所需时间都与字符串长度的最大值保持一致,
 * 不会因为"长度不等"这条快速路径泄漏出 Key 的真实长度。
 *
 * 实现要点：
 * 1. 把两侧先零填充到 `max(lenA, lenB, 1)`，让 `timingSafeEqual` 能接受
 *    （它要求严格等长，否则直接抛 `ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH`）。
 * 2. `timingSafeEqual` 一定要先于 `lengthEqual` 被执行，二者都必须被无条件
 *    评估，避免 JS 短路求值在"长度不等"时跳过恒定时间的 buffer 比较。
 * 3. 最终结果是 `contentEqual && lengthEqual` —— 只有内容和长度都匹配才算通过。
 *
 * 剩下的侧信道只有一维：`maxLen` 本身。这比"长度不等立即 return"的朴素写法
 * 安全得多——攻击者只能测出"我猜的 Key 比真实 Key 长还是短"这类二分信息，
 * 而不是精确的长度。
 */
export function constantTimeEq(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // 至少分配 1 字节，避免 Node 在某些版本对零长 buffer 调用 timingSafeEqual 抛错
  const maxLen = Math.max(bufA.length, bufB.length, 1);

  const paddedA = Buffer.alloc(maxLen);
  const paddedB = Buffer.alloc(maxLen);
  bufA.copy(paddedA);
  bufB.copy(paddedB);

  // 先无条件算完恒定时间比较和长度相等性，再做逻辑 AND——不要依赖短路求值
  const contentEqual = crypto.timingSafeEqual(paddedA, paddedB);
  const lengthEqual = bufA.length === bufB.length;
  return contentEqual && lengthEqual;
}
