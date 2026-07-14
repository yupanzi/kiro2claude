/**
 * 流式响应编码器:把 StreamContext 产出的 Claude `SseEvent` 翻成 OpenAI
 * `chat.completion.chunk`(`data: {...}\n\n` 行)。
 *
 * 有状态:整流共享 id/created/model;记录 role chunk 是否已发;维护
 * Claude content-block-index → OpenAI tool_calls index 的映射(Claude 的
 * block index 跨 text/thinking/tool_use 递增,OpenAI 的 tool index 只对工具
 * 递增,必须解耦,否则并发多工具 arguments 会错拼)。
 *
 * usage 语义:**不**取 message_delta 里的 Claude usage(它被 derived 插件
 * override 成缓存拆分语义,prompt_tokens 会失真);usage chunk 由 handler 用
 * StreamContext 原始 token 单独构造(见 openai/stream-handler.ts)。
 */

import { v4 as uuidv4 } from 'uuid';
import type { SseEvent } from '../claude/stream.js';
import type {
  ChatCompletionChunk,
  ChatCompletionChunkDelta,
  OpenAiFinishReason,
  OpenAiUsage,
} from './types.js';

/** Claude stop_reason → OpenAI finish_reason。 */
export function mapFinishReason(stopReason: string | undefined): OpenAiFinishReason {
  switch (stopReason) {
    case 'tool_use':
      return 'tool_calls';
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'length';
    default:
      return 'stop';
  }
}

export class OpenAiChunkEncoder {
  private readonly id = `chatcmpl-${uuidv4().replace(/-/g, '')}`;
  private readonly created = Math.floor(Date.now() / 1000);
  private readonly model: string;

  private roleEmitted = false;
  private readonly toolIndexMap = new Map<number, number>();
  private nextToolIndex = 0;
  /** 收到过 ≥1 个 input_json_delta 的工具块(Claude block index)——空参数兜底用。 */
  private readonly toolArgsSeen = new Set<number>();

  constructor(model: string) {
    this.model = model;
  }

  private chunk(
    delta: ChatCompletionChunkDelta,
    finish_reason: OpenAiFinishReason | null = null,
  ): ChatCompletionChunk {
    return {
      id: this.id,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta, finish_reason, logprobs: null }],
    };
  }

  private line(chunk: ChatCompletionChunk): string {
    return `data: ${JSON.stringify(chunk)}\n\n`;
  }

  /** Claude block index → OpenAI tool index(首见即分配)。 */
  private toolIndex(claudeBlockIndex: number): number {
    let idx = this.toolIndexMap.get(claudeBlockIndex);
    if (idx === undefined) {
      idx = this.nextToolIndex++;
      this.toolIndexMap.set(claudeBlockIndex, idx);
    }
    return idx;
  }

  /** 把一个 Claude SseEvent 翻成 0+ 个 OpenAI chunk 行。 */
  push(ev: SseEvent): string[] {
    const out: string[] = [];

    switch (ev.event) {
      case 'message_start': {
        if (!this.roleEmitted) {
          this.roleEmitted = true;
          out.push(this.line(this.chunk({ role: 'assistant', content: '' })));
        }
        break;
      }

      case 'content_block_start': {
        const cb = ev.data.content_block as
          | { type?: string; id?: string; name?: string }
          | undefined;
        if (cb?.type === 'tool_use') {
          const oaiIdx = this.toolIndex(ev.data.index as number);
          out.push(
            this.line(
              this.chunk({
                tool_calls: [
                  {
                    index: oaiIdx,
                    id: cb.id,
                    type: 'function',
                    function: { name: cb.name, arguments: '' },
                  },
                ],
              }),
            ),
          );
        }
        // text / thinking block start:无 delta,等 content_block_delta。
        break;
      }

      case 'content_block_delta': {
        const delta = ev.data.delta as {
          type?: string;
          text?: string;
          thinking?: string;
          partial_json?: string;
        };
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          out.push(this.line(this.chunk({ content: delta.text })));
        } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          out.push(this.line(this.chunk({ reasoning_content: delta.thinking })));
        } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          const idx = ev.data.index as number;
          this.toolArgsSeen.add(idx);
          out.push(
            this.line(
              this.chunk({
                tool_calls: [
                  { index: this.toolIndex(idx), function: { arguments: delta.partial_json } },
                ],
              }),
            ),
          );
        }
        // signature_delta:OpenAI 无对应字段,丢弃。
        break;
      }

      case 'message_delta': {
        const d = ev.data.delta as { stop_reason?: string } | undefined;
        out.push(this.line(this.chunk({}, mapFinishReason(d?.stop_reason))));
        break;
      }

      case 'content_block_stop': {
        // 空输入工具:上游对无参数 tool_use 不发 input_json_delta,累积的 arguments 会
        // 停在 ""(非法 JSON,客户端 JSON.parse / Codex serde_json 解析报错)。块结束时
        // 补一个 "{}" 增量,使累积成合法空对象——与非流式 reduceKiroResponse 的
        // `if(!buffer) input={}` 归一对齐。非工具块不在 toolIndexMap,天然跳过。
        const idx = ev.data.index as number;
        if (this.toolIndexMap.has(idx) && !this.toolArgsSeen.has(idx)) {
          out.push(
            this.line(
              this.chunk({
                tool_calls: [{ index: this.toolIndex(idx), function: { arguments: '{}' } }],
              }),
            ),
          );
        }
        break;
      }

      // message_delta 之外的 message_stop / ping / error:不由编码器产 chunk
      // (ping 与 error 由 handler 直接写,message_stop 后 handler 收口)。
      default:
        break;
    }

    return out;
  }

  /** include_usage 时的末尾 usage-only chunk(choices 为空)。token 来自 handler。 */
  usageChunkLine(usage: OpenAiUsage): string {
    return this.line({
      id: this.id,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: [],
      usage,
    });
  }

  /** SSE 终止哨兵。 */
  doneLine(): string {
    return 'data: [DONE]\n\n';
  }
}
