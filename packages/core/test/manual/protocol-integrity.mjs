#!/usr/bin/env node
/**
 * 双协议流式完整性检测（手工，打真实上游，会计费）。
 *
 * 「丢包」不能靠肉眼看输出像不像，这里做两层独立检查：
 *
 *   1. **内容完整性** —— 让模型输出确定性可验证的序列（1..N），累积后校验有无
 *      缺号/乱序/截断。上游无 temperature/seed，所以不能逐字节对拍，但数字序列
 *      是结构可验证的。
 *   2. **协议不变量** —— 与内容无关的硬性约束，任何一条被破坏都说明网关的事件
 *      编码有问题。两套不变量的实现在 `_harness.mjs`（同目录三个检测器共用）。
 *
 * 用法：K2C_KEY=... node protocol-integrity.mjs [轮数]
 */

import {
  CLAUDE_MODEL,
  CLAUDE_PATH,
  GPT_MODEL,
  RESPONSES_PATH,
  checkClaudeInvariants,
  checkRange,
  checkResponsesInvariants,
  claudeHeaders,
  collectClaude,
  collectResponses,
  parseSse,
  postJson,
  rangeProblems,
  reporter,
  responsesHeaders,
  seqPrompt,
} from './_harness.mjs';

const ROUNDS = Number(process.argv[2] ?? 2);
const N = 300;
const SEQ_PROMPT = seqPrompt(1, N);

const { record, finish } = reporter();

/** 序列校验 → record 一条。 */
function recordSequence(name, text) {
  const problems = rangeProblems(checkRange(text, 1, N));
  record(name, problems.length === 0, problems.length === 0 ? `1..${N} 全到` : problems.join('; '));
}

/** 工具 input JSON 必须可解析，且 ids 1..count 全到。 */
function checkToolIds(json, count) {
  try {
    const ids = new Set((JSON.parse(json).records ?? []).map((x) => x.id));
    const missing = [];
    for (let i = 1; i <= count; i++) if (!ids.has(i)) missing.push(i);
    return missing.length === 0
      ? { ok: true, detail: `${json.length}B JSON, ${count} 条记录全到` }
      : { ok: false, detail: `缺 id: ${missing.slice(0, 10).join(',')}` };
  } catch (e) {
    return { ok: false, detail: `JSON 解析失败 (${json.length}B): ${String(e).slice(0, 80)}` };
  }
}

const BULK_WRITE_SCHEMA = {
  type: 'object',
  properties: {
    records: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'integer' }, note: { type: 'string' } },
        required: ['id', 'note'],
      },
    },
  },
  required: ['records'],
};

async function claudeStream(body) {
  const { raw } = await postJson(CLAUDE_PATH, claudeHeaders(), body);
  const events = parseSse(raw);
  return { events, bytes: raw.length, ...collectClaude(events) };
}

async function responsesStream(body) {
  const { raw } = await postJson(RESPONSES_PATH, responsesHeaders(), body);
  const events = parseSse(raw);
  return { events, bytes: raw.length, ...collectResponses(events) };
}

for (let r = 1; r <= ROUNDS; r++) {
  console.log(`\n──────── 第 ${r}/${ROUNDS} 轮 ────────`);

  // T1 Claude 流式：长序列
  {
    const out = await claudeStream({
      model: CLAUDE_MODEL,
      max_tokens: 8000,
      stream: true,
      messages: [{ role: 'user', content: SEQ_PROMPT }],
    });
    recordSequence(`Claude 流式 · 内容完整性 (${out.bytes}B, ${out.events.length} 事件)`, out.text);
    const inv = checkClaudeInvariants(out.events);
    record('Claude 流式 · 协议不变量', inv.length === 0, inv.join('; ') || '全部满足');
  }

  // T2 Claude 非流式：同样内容，验证两条路径一致收敛
  {
    const { raw } = await postJson(CLAUDE_PATH, claudeHeaders(), {
      model: CLAUDE_MODEL,
      max_tokens: 8000,
      stream: false,
      messages: [{ role: 'user', content: SEQ_PROMPT }],
    });
    const j = JSON.parse(raw);
    const text = (j.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
    recordSequence(`Claude 非流式 · 内容完整性 (stop=${j.stop_reason})`, text);
  }

  // T3 Claude 流式：大工具参数（input JSON 必须可解析且完整）
  {
    const out = await claudeStream({
      model: CLAUDE_MODEL,
      max_tokens: 8000,
      stream: true,
      tool_choice: { type: 'tool', name: 'bulk_write' },
      tools: [
        {
          name: 'bulk_write',
          description: 'Write many records at once',
          input_schema: BULK_WRITE_SCHEMA,
        },
      ],
      messages: [
        {
          role: 'user',
          content:
            'Call bulk_write with exactly 60 records, ids 1..60, each note is a distinct sentence of at least 12 words.',
        },
      ],
    });
    const tool = [...out.toolJson.values()].find((t) => t.name === 'bulk_write');
    const { ok, detail } = tool
      ? checkToolIds(tool.json, 60)
      : { ok: false, detail: '未产出 tool_use' };
    record('Claude 流式 · 工具参数 JSON 完整性', ok, detail);
    const inv = checkClaudeInvariants(out.events);
    record('Claude 流式(工具) · 协议不变量', inv.length === 0, inv.join('; ') || '全部满足');
  }

  // T4 Responses 流式：长序列
  {
    const out = await responsesStream({
      model: GPT_MODEL,
      stream: true,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: SEQ_PROMPT }] }],
    });
    recordSequence(
      `Responses 流式 · 内容完整性 (${out.bytes}B, ${out.events.length} 事件)`,
      out.text,
    );
    const inv = checkResponsesInvariants(out.events);
    record('Responses 流式 · 协议不变量', inv.length === 0, inv.join('; ') || '全部满足');
    const match = out.doneText === null || out.doneText === out.text;
    record(
      'Responses 流式 · done 回填全文 == delta 累积',
      match,
      match ? `${out.text.length} 字符一致` : `done=${out.doneText?.length} vs delta=${out.text.length}`,
    );
  }

  // T5 Responses 流式：工具调用参数完整性
  {
    const out = await responsesStream({
      model: GPT_MODEL,
      stream: true,
      tool_choice: 'auto',
      parallel_tool_calls: false,
      tools: [
        {
          type: 'function',
          name: 'bulk_write',
          description: 'Write many records at once',
          parameters: BULK_WRITE_SCHEMA,
        },
      ],
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: 'Call bulk_write with exactly 40 records, ids 1..40, each note a distinct sentence of at least 10 words.',
            },
          ],
        },
      ],
    });
    const { ok, detail } = out.args
      ? checkToolIds(out.args, 40)
      : { ok: false, detail: '未产出 function_call' };
    record('Responses 流式 · 工具参数 JSON 完整性', ok, detail);
    if (out.doneArgs !== null) {
      const match = out.doneArgs === out.args;
      record(
        'Responses 流式 · args done 回填 == delta 累积',
        match,
        match ? `${out.args.length} 字符一致` : `done=${out.doneArgs.length} vs delta=${out.args.length}`,
      );
    }
    const inv = checkResponsesInvariants(out.events);
    record('Responses 流式(工具) · 协议不变量', inv.length === 0, inv.join('; ') || '全部满足');
  }
}

finish();
