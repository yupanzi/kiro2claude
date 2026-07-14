/**
 * Responses API 流式事件编码器:Claude `SseEvent` → 严格的 Responses SSE 事件序列。
 *
 * Codex 对该序列**极其挑剔**(实测踩坑):
 *   - 文本必须 `output_item.added(message)` → `content_part.added` → `output_text.delta`
 *     → `output_text.done` → `content_part.done` → `output_item.done`;缺 content_part.added
 *     会导致 Codex 丢弃全部 delta(`OutputTextDelta without active item`)。
 *   - done 事件必须回填**累积的完整文本/参数**(不能空)。
 *   - `response.completed` 的 `response.output` 要带完整 items。
 *   - 工具调用走 `function_call_arguments.delta/done`。
 *
 * usage 用 StreamContext 原始 token(不经 buildClaudeUsagePayload,理由同 chat 端点)。
 * Claude 明文 thinking → reasoning summary item(惰性开:首个 thinking_delta 才产 item,见
 * reasoningDelta;summary 通道,兼容面最广)。GPT 加密 reasoning(redacted)在归约层已被丢、
 * 编码器收不到 thinking 事件 → 天然不产 reasoning item(Codex 路径逐字节不变,踩坑 #17)。
 * signature_delta 仍丢弃:它是 continuation 凭证、非用户可读内容,本版只做下行显示。
 */

import { v4 as uuidv4 } from 'uuid';
import type { SseEvent } from '../../claude/stream.js';
import type {
  ResponsesObject,
  ResponsesOutputItem,
  ResponsesReasoningOutputItemOut,
  ResponsesUsage,
} from './types.js';

type CurrentItem =
  | { kind: 'message'; claudeIdx: number; index: number; itemId: string; text: string }
  | { kind: 'reasoning'; claudeIdx: number; index: number; itemId: string; summaryText: string }
  | {
      kind: 'function_call';
      claudeIdx: number;
      index: number;
      itemId: string;
      args: string;
      callId: string;
      name: string;
    };

export class ResponsesEventEncoder {
  private seq = 0;
  private readonly responseId = `resp_${uuidv4().replace(/-/g, '')}`;
  private readonly createdAt = Math.floor(Date.now() / 1000);
  private readonly model: string;

  private createdEmitted = false;
  private outputIndex = 0;
  private current: CurrentItem | undefined;
  private readonly completedItems: ResponsesOutputItem[] = [];

  constructor(model: string) {
    this.model = model;
  }

  /** 把事件对象序列化成一行 SSE(带自增 sequence_number)。 */
  private line(obj: Record<string, unknown>): string {
    obj.sequence_number = this.seq++;
    return `data: ${JSON.stringify(obj)}\n\n`;
  }

  private responseObject(status: ResponsesObject['status']): ResponsesObject {
    return {
      id: this.responseId,
      object: 'response',
      created_at: this.createdAt,
      status,
      model: this.model,
      output: [...this.completedItems],
      usage: null,
      error: null,
      incomplete_details: null,
      metadata: {},
    };
  }

  /** 把一个 Claude SseEvent 翻成 0+ 个 Responses SSE 行。 */
  push(ev: SseEvent): string[] {
    switch (ev.event) {
      case 'message_start': {
        if (this.createdEmitted) return [];
        this.createdEmitted = true;
        return [
          this.line({ type: 'response.created', response: this.responseObject('in_progress') }),
          this.line({ type: 'response.in_progress', response: this.responseObject('in_progress') }),
        ];
      }

      case 'content_block_start': {
        const cb = ev.data.content_block as
          | { type?: string; id?: string; name?: string }
          | undefined;
        const idx = ev.data.index as number;
        // text block 惰性开:等首个 text_delta 才发 output_item.added(见 textDelta),
        // 避免「模型直接调工具、无前导文本」时产出空 message item(Codex 会误判成
        // 空的 last agent message)。tool_use 立即开 function_call item。
        if (cb?.type === 'tool_use') return this.openFunctionCall(idx, cb.id, cb.name ?? 'tool');
        // text / thinking block 均惰性开(等首个 delta):见 textDelta / reasoningDelta
        return [];
      }

      case 'content_block_delta': {
        const d = ev.data.delta as {
          type?: string;
          text?: string;
          partial_json?: string;
          thinking?: string;
        };
        if (d.type === 'text_delta' && typeof d.text === 'string') {
          return this.textDelta(d.text, ev.data.index as number);
        }
        if (d.type === 'thinking_delta' && typeof d.thinking === 'string') {
          return this.reasoningDelta(d.thinking, ev.data.index as number);
        }
        if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
          return this.argsDelta(d.partial_json);
        }
        return []; // signature_delta 丢弃(continuation 凭证,非用户可读内容)
      }

      case 'content_block_stop':
        return this.closeIfCurrent(ev.data.index as number);

      // message_delta / message_stop / ping:completion 由 handler 调 finalize() 收口
      default:
        return [];
    }
  }

  private openMessage(claudeIdx: number): string[] {
    const out = this.closeCurrent();
    const itemId = `msg_${uuidv4().replace(/-/g, '')}`;
    const index = this.outputIndex;
    this.current = { kind: 'message', claudeIdx, index, itemId, text: '' };
    out.push(
      this.line({
        type: 'response.output_item.added',
        output_index: index,
        item: {
          id: itemId,
          type: 'message',
          role: 'assistant',
          status: 'in_progress',
          content: [],
        },
      }),
    );
    out.push(
      this.line({
        type: 'response.content_part.added',
        item_id: itemId,
        output_index: index,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      }),
    );
    return out;
  }

  private textDelta(text: string, claudeIdx: number): string[] {
    // 惰性开 message:首个 text_delta 到达才发 output_item.added + content_part.added,
    // 用该 delta 的 block index(content_block_stop 据此关闭)。
    const out: string[] = [];
    if (!this.current || this.current.kind !== 'message') {
      out.push(...this.openMessage(claudeIdx));
    }
    const cur = this.current as Extract<CurrentItem, { kind: 'message' }>;
    cur.text += text;
    out.push(
      this.line({
        type: 'response.output_text.delta',
        item_id: cur.itemId,
        output_index: cur.index,
        content_index: 0,
        delta: text,
      }),
    );
    return out;
  }

  /** 惰性开 reasoning item:发 output_item.added(reasoning) + reasoning_summary_part.added。 */
  private openReasoning(claudeIdx: number): string[] {
    const out = this.closeCurrent();
    const itemId = `rs_${uuidv4().replace(/-/g, '')}`;
    const index = this.outputIndex;
    this.current = { kind: 'reasoning', claudeIdx, index, itemId, summaryText: '' };
    out.push(
      this.line({
        type: 'response.output_item.added',
        output_index: index,
        item: { id: itemId, type: 'reasoning', summary: [] },
      }),
    );
    out.push(
      this.line({
        type: 'response.reasoning_summary_part.added',
        item_id: itemId,
        output_index: index,
        summary_index: 0,
        part: { type: 'summary_text', text: '' },
      }),
    );
    return out;
  }

  private reasoningDelta(text: string, claudeIdx: number): string[] {
    // 惰性开 reasoning item:首个 thinking_delta 到达才发 output_item.added +
    // reasoning_summary_part.added,用该 delta 的 block index(content_block_stop 据此关闭)。
    const out: string[] = [];
    if (!this.current || this.current.kind !== 'reasoning') {
      out.push(...this.openReasoning(claudeIdx));
    }
    const cur = this.current as Extract<CurrentItem, { kind: 'reasoning' }>;
    cur.summaryText += text;
    out.push(
      this.line({
        type: 'response.reasoning_summary_text.delta',
        item_id: cur.itemId,
        output_index: cur.index,
        summary_index: 0,
        delta: text,
      }),
    );
    return out;
  }

  private openFunctionCall(claudeIdx: number, id: string | undefined, name: string): string[] {
    const out = this.closeCurrent();
    const itemId = `fc_${uuidv4().replace(/-/g, '')}`;
    const callId = id ?? `call_${uuidv4().replace(/-/g, '')}`;
    const index = this.outputIndex;
    this.current = { kind: 'function_call', claudeIdx, index, itemId, args: '', callId, name };
    out.push(
      this.line({
        type: 'response.output_item.added',
        output_index: index,
        item: {
          id: itemId,
          type: 'function_call',
          call_id: callId,
          name,
          arguments: '',
          status: 'in_progress',
        },
      }),
    );
    return out;
  }

  private argsDelta(partial: string): string[] {
    if (!this.current || this.current.kind !== 'function_call') return [];
    this.current.args += partial;
    return [
      this.line({
        type: 'response.function_call_arguments.delta',
        item_id: this.current.itemId,
        output_index: this.current.index,
        delta: partial,
      }),
    ];
  }

  private closeIfCurrent(claudeIdx: number): string[] {
    if (this.current && this.current.claudeIdx === claudeIdx) return this.closeCurrent();
    return [];
  }

  /** 关闭当前 open item(发 done 事件、回填完整文本/参数、进 completedItems)。幂等。 */
  private closeCurrent(): string[] {
    const cur = this.current;
    if (!cur) return [];
    this.current = undefined;
    this.outputIndex++;
    const out: string[] = [];

    if (cur.kind === 'message') {
      const part = { type: 'output_text' as const, text: cur.text, annotations: [] };
      out.push(
        this.line({
          type: 'response.output_text.done',
          item_id: cur.itemId,
          output_index: cur.index,
          content_index: 0,
          text: cur.text,
        }),
      );
      out.push(
        this.line({
          type: 'response.content_part.done',
          item_id: cur.itemId,
          output_index: cur.index,
          content_index: 0,
          part,
        }),
      );
      const item: ResponsesOutputItem = {
        id: cur.itemId,
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [part],
      };
      out.push(this.line({ type: 'response.output_item.done', output_index: cur.index, item }));
      this.completedItems.push(item);
    } else if (cur.kind === 'reasoning') {
      // reasoning:summary_text.done → summary_part.done → output_item.done(回填完整摘要)
      out.push(
        this.line({
          type: 'response.reasoning_summary_text.done',
          item_id: cur.itemId,
          output_index: cur.index,
          summary_index: 0,
          text: cur.summaryText,
        }),
      );
      out.push(
        this.line({
          type: 'response.reasoning_summary_part.done',
          item_id: cur.itemId,
          output_index: cur.index,
          summary_index: 0,
          part: { type: 'summary_text', text: cur.summaryText },
        }),
      );
      const item: ResponsesReasoningOutputItemOut = {
        id: cur.itemId,
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: cur.summaryText }],
      };
      out.push(this.line({ type: 'response.output_item.done', output_index: cur.index, item }));
      this.completedItems.push(item);
    } else {
      // 空输入工具:上游无 input_json_delta → args 停在 ""(非法 JSON,Codex serde_json
      // 解析报错)。补 "{}" 使 arguments 合法,delta+done 两通道一致——与非流式
      // reduceKiroResponse 的 `if(!buffer) input={}` 归一对齐。
      if (cur.args.length === 0) {
        cur.args = '{}';
        out.push(
          this.line({
            type: 'response.function_call_arguments.delta',
            item_id: cur.itemId,
            output_index: cur.index,
            delta: '{}',
          }),
        );
      }
      out.push(
        this.line({
          type: 'response.function_call_arguments.done',
          item_id: cur.itemId,
          output_index: cur.index,
          arguments: cur.args,
        }),
      );
      const item: ResponsesOutputItem = {
        id: cur.itemId,
        type: 'function_call',
        call_id: cur.callId,
        name: cur.name,
        arguments: cur.args,
        status: 'completed',
      };
      out.push(this.line({ type: 'response.output_item.done', output_index: cur.index, item }));
      this.completedItems.push(item);
    }
    return out;
  }

  /** 收口:关掉残留 open item,发 response.completed(带完整 output + usage)。 */
  finalize(usage: ResponsesUsage): string[] {
    const out = this.closeCurrent();
    const resp = this.responseObject('completed');
    resp.usage = usage;
    out.push(this.line({ type: 'response.completed', response: resp }));
    return out;
  }

  /** committed 后的 in-band 错误事件(Responses 流用 `type:"error"` 事件)。 */
  errorLine(message: string, type: string): string {
    return this.line({ type: 'error', code: type, message, param: null });
  }
}
