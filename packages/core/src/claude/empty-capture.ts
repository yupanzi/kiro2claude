/**
 * 空流(silent failure)处理的共享类型与诊断抓包。
 *
 * ## 背景
 *
 * 上游偶发返回「200 OK + 零内容帧」的空流。两类成因:
 *   - **瞬时**(多数):上游抖动,重发同一请求即恢复 —— 由 handler 层的有界
 *     重试(`KIRO2CLAUDE_EMPTY_STREAM_RETRIES`)透明吸收。
 *   - **确定性**(罕见):某个会话状态被上游确定性拒绝,重试永不恢复。其根因
 *     依赖**真实请求内容**,无法凭合成请求复现 —— 故提供 env-gated 抓包,把
 *     触发空流的原始 Claude 请求体落盘,供事后证据驱动地定位。
 *
 * 抓包**默认关闭**;仅当 `KIRO2CLAUDE_CAPTURE_EMPTY_DIR` 指向一个目录时启用。
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getLogger } from '../shared/logger.js';

/** 两个 message handler(stream / non-stream)的统一返回。 */
export interface MessageHandlerResult {
  /** 重试耗尽后最终仍是空流/空响应。用于触发诊断抓包与上层统计。 */
  emptyResponse: boolean;
  /** 本次请求里返回空的上游尝试次数(含被重试掩盖的)。 */
  emptyAttempts: number;
}

/**
 * 把触发空流的原始 Claude 请求体追加写到 `dir/empty-requests.jsonl`(每行一条
 * JSON)。失败只 warn,绝不影响主请求(诊断功能不能拖垮服务)。
 *
 * `rawRequest` 是**原始 Claude 请求体**(`request.body`),这样事后可直接喂回
 * 转换器 / 重放来定位根因,而不是已转换的 Kiro wire body。
 *
 * ⚠ 落盘内容含完整 system prompt / 对话历史 / 工具定义 / 用户输入(可能含 PII 或
 * 密钥),且为明文、无脱敏 / 轮转 / 权限收紧。这是 env-gated 的诊断功能,仅应在
 * 受控环境短期启用——见 `Config.captureEmptyDir`。
 */
export function captureEmptyRequest(
  dir: string,
  entry: {
    reqId: string | undefined;
    model: string;
    emptyAttempts: number;
    rawRequest: unknown;
    meta: Record<string, unknown>;
  },
): void {
  try {
    // Create the dir if missing (idempotent) — operators commonly point this at
    // a not-yet-created path (e.g. a fresh volume mount); without it appendFileSync
    // would ENOENT every time and capture would silently produce nothing.
    mkdirSync(dir, { recursive: true });
    const line = `${JSON.stringify({ time: Date.now(), ...entry })}\n`;
    appendFileSync(join(dir, 'empty-requests.jsonl'), line);
    getLogger().warn({
      msg: 'captured empty-stream request for diagnosis',
      reqId: entry.reqId,
      empty_attempts: entry.emptyAttempts,
    });
  } catch (e) {
    getLogger().warn({ msg: 'failed to capture empty request', error: String(e) });
  }
}
