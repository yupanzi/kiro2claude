import type { ConversationState } from './conversation.js';

/** Kiro API 请求 */
export interface KiroRequest {
  conversationState: ConversationState;
  profileArn?: string;
}

/**
 * 序列化 KiroRequest 为 Kiro API 期望的 wire format。
 *
 * ⚠️ 为什么不能直接 `JSON.stringify(req)`:
 *
 * `ConversationState.history` 里的 `Message` 是 TS 侧的 discriminated union
 * （`{ kind: 'user' | 'assistant', ... }`）。Kiro API 的线上格式是**未加标签的
 * 联合**（untagged union）—— variant 的字段直接平铺到 JSON，没有 discriminator。
 * 但 `JSON.stringify` 会天真地把 `kind` 字段也写出去，导致线上报文长这样：
 *   `{"kind":"user","userInputMessage":{...}}`
 * 而 Kiro API 期望的是：
 *   `{"userInputMessage":{...}}`
 *
 * 当前 Kiro API 对多出来的 `kind` 字段是容忍的（因此单轮对话的冒烟测试能通），
 * 但这仍然是**协议偏离**：AWS Smithy 后端对未知字段的处理策略并不保证稳定，
 * 并且任何基于字段签名的缓存/校验都会被这个"噪声字段"破坏。
 *
 * 另一个 wire 细节：Kiro 后端对空 `history` 数组的处理不稳定 —— 有时会拒绝
 * 带 `"history": []` 同时又带 `currentMessage` 的请求。所以空数组要从 wire
 * 输出里完全去掉，而不是保留一个空的 `"history": []`。
 */
export function serializeKiroRequest(req: KiroRequest): string {
  return JSON.stringify(req, (key, value) => {
    // 剥离 Message union 上的 discriminator tag
    if (key === 'kind' && (value === 'user' || value === 'assistant')) {
      return undefined;
    }
    // 空 history 数组完全从 wire 输出中省略
    if (key === 'history' && Array.isArray(value) && value.length === 0) {
      return undefined;
    }
    return value;
  });
}
