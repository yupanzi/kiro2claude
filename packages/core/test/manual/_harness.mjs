/**
 * 手工完整性检测脚本的共享脚手架(非 CI,不被 src/ 引用)。
 *
 * 同目录三个检测器各打一类问题(协议不变量 / 背压 / 并发串扰),但发请求、解 SSE、
 * 校验号段、汇总退出码是同一件事。此前三份各写一遍,代价不是体积而是**漏检**:
 * 完整的不变量集只长在 protocol-integrity 里,另两个各手抄两三条,于是背压/并发下
 * 的 block 配对错误、item added/done 失配谁都发现不了。现在三个跑同一套。
 *
 * 单一 `K2C_BASE` 同时供 fetch 与 raw http.request(见 `baseHostPort`),别再回到
 * `K2C_BASE` / `K2C_HOST`+`K2C_PORT` 两套写法。
 */

// ---------------------------------------------------------------------------
// 配置(三个脚本共用同一套 env 名)
// ---------------------------------------------------------------------------

export const KEY = process.env.K2C_KEY;
export const BASE = process.env.K2C_BASE ?? 'http://127.0.0.1:8080';
export const CLAUDE_MODEL = process.env.CLAUDE_MODEL ?? 'claude-opus-4-6';
export const GPT_MODEL = process.env.GPT_MODEL ?? 'gpt-5.6-sol';

export const CLAUDE_PATH = '/claude/v1/messages';
export const RESPONSES_PATH = '/openai/v1/responses';

export const claudeHeaders = () => ({
  'x-api-key': KEY,
  'content-type': 'application/json',
  'anthropic-version': '2023-06-01',
});

export const responsesHeaders = () => ({
  authorization: `Bearer ${KEY}`,
  'content-type': 'application/json',
});

/** 供 raw `http.request` 用的 host/port —— 与 fetch 共用同一个 K2C_BASE。 */
export function baseHostPort() {
  const u = new URL(BASE);
  return { host: u.hostname, port: Number(u.port || (u.protocol === 'https:' ? 443 : 80)) };
}

/** 确定性可验证的输出指令:模型吐 [from, to] 的整数,便于按号段校验完整性。 */
export const seqPrompt = (from, to) =>
  `Output the integers from ${from} to ${to} separated by ", " (comma space). ` +
  'Output ONLY the numbers, no prose, no markdown, no code fence.';

// ---------------------------------------------------------------------------
// 请求
// ---------------------------------------------------------------------------

/** POST 一个 JSON body,把整个响应体按文本取回(SSE 与非 SSE 共用)。 */
export async function postJson(path, headers, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  return { status: res.status, raw };
}

// ---------------------------------------------------------------------------
// SSE 解析
// ---------------------------------------------------------------------------

/**
 * 把 SSE 文本解成 data 载荷数组。**只认 `data:` 行**:Claude 编码器带 `event:` 行而
 * 两个 OpenAI 编码器不带,忽略它才能同时吃下两种(事件类型在 JSON 的 `type` 里)。
 */
export function parseSse(raw) {
  const events = [];
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    try {
      events.push(JSON.parse(line.slice(6)));
    } catch {
      // 非 JSON 载荷(如 `data: [DONE]`)不是事件,跳过
    }
  }
  return events;
}

/** 从 Claude 事件流里累积可见文本、工具 input JSON、事件类型序列。 */
export function collectClaude(events) {
  let text = '';
  const toolJson = new Map();
  const types = [];
  for (const e of events) {
    types.push(e.type);
    const d = e.delta;
    if (e.type === 'content_block_delta' && d?.type === 'text_delta') text += d.text;
    if (e.type === 'content_block_start' && e.content_block?.type === 'tool_use') {
      toolJson.set(e.index, { name: e.content_block.name, json: '' });
    }
    if (e.type === 'content_block_delta' && d?.type === 'input_json_delta') {
      const b = toolJson.get(e.index);
      if (b) b.json += d.partial_json;
    }
  }
  return { text, toolJson, types };
}

/** 从 Responses 事件流里累积可见文本、done 回填全文、工具 args、序号洞数。 */
export function collectResponses(events) {
  let text = '';
  let doneText = null;
  let args = '';
  let doneArgs = null;
  let seqHoles = 0;
  let maxSeq = -1;
  let prev = -1;
  let completed = false;
  const types = [];
  for (const e of events) {
    types.push(e.type);
    if (typeof e.sequence_number === 'number') {
      if (prev >= 0 && e.sequence_number !== prev + 1) seqHoles++;
      prev = e.sequence_number;
      maxSeq = Math.max(maxSeq, e.sequence_number);
    }
    if (e.type === 'response.output_text.delta') text += e.delta ?? '';
    if (e.type === 'response.output_text.done') doneText = e.text ?? null;
    if (e.type === 'response.function_call_arguments.delta') args += e.delta ?? '';
    if (e.type === 'response.function_call_arguments.done') doneArgs = e.arguments ?? null;
    if (e.type === 'response.completed') completed = true;
  }
  return { text, doneText, args, doneArgs, seqHoles, maxSeq, completed, types };
}

// ---------------------------------------------------------------------------
// 内容完整性
// ---------------------------------------------------------------------------

/**
 * 从任意文本里抽出数字,校验 [from, to] 号段:
 *   - `missing`    缺号 —— 丢块的直接证据
 *   - `foreign`    混入号段外的数字 —— 并发串扰判据
 *   - `disordered` 逆序处数 —— 模型偶尔自己乱写,而网关丢块表现为整段消失
 * Set 查表,别退回 `nums.includes(i)` 的 O(N²) 扫描。
 */
export function checkRange(text, from, to) {
  const nums = (text.match(/\d+/g) ?? []).map(Number);
  const seen = new Set(nums);
  const missing = [];
  for (let v = from; v <= to; v++) if (!seen.has(v)) missing.push(v);
  const foreign = nums.filter((v) => v < from || v > to);
  let disordered = 0;
  for (let i = 1; i < nums.length; i++) if (nums[i] < nums[i - 1]) disordered++;
  return { missing, foreign, disordered, count: nums.length };
}

/** `checkRange` 的结果 → 人类可读的问题列表(空数组 = 完整)。 */
export function rangeProblems({ missing, foreign, disordered, count }, { crosstalk = false } = {}) {
  const p = [];
  if (count === 0) return ['无任何数字'];
  if (missing.length) {
    p.push(`缺 ${missing.length} 个: ${missing.slice(0, 12).join(',')}${missing.length > 12 ? '…' : ''}`);
  }
  if (crosstalk && foreign.length) {
    p.push(`★ 串扰:混入 ${foreign.length} 个外区间数字(${foreign.slice(0, 6).join(',')})`);
  }
  if (!crosstalk && disordered > 0) p.push(`逆序 ${disordered} 处`);
  return p;
}

// ---------------------------------------------------------------------------
// 协议不变量 —— 与内容无关的硬性约束,三个检测器共用同一套
// ---------------------------------------------------------------------------

/**
 * Claude:content_block_start/stop 配对、index 不重开、delta 不出现在已 stop 的
 * 块上、message_delta 恰好一次且在所有 stop 之后、message_stop 最后。
 */
export function checkClaudeInvariants(events) {
  const p = [];
  const blocks = new Map(); // index -> {started, stopped, deltas}
  let messageDelta = 0;
  let messageStop = 0;
  let sawStopAfterMessageDelta = false;

  for (const e of events) {
    const t = e.type;
    const idx = e.index;
    if (t === 'content_block_start') {
      if (blocks.get(idx)?.started) p.push(`index ${idx} 被重复 start`);
      blocks.set(idx, { started: true, stopped: false, deltas: 0 });
    } else if (t === 'content_block_delta') {
      const b = blocks.get(idx);
      if (!b?.started) p.push(`index ${idx} 的 delta 早于 start`);
      else if (b.stopped) p.push(`index ${idx} 在 stop 之后仍有 delta`);
      else b.deltas++;
    } else if (t === 'content_block_stop') {
      const b = blocks.get(idx);
      if (!b?.started) p.push(`index ${idx} 的 stop 无对应 start`);
      else if (b.stopped) p.push(`index ${idx} 被重复 stop`);
      else b.stopped = true;
    } else if (t === 'message_delta') {
      messageDelta++;
      for (const [i, b] of blocks) {
        if (b.started && !b.stopped) p.push(`message_delta 时 index ${i} 仍未 stop`);
      }
    } else if (t === 'message_stop') {
      messageStop++;
    }
    if (messageDelta > 0 && t === 'content_block_stop') sawStopAfterMessageDelta = true;
  }
  for (const [i, b] of blocks) if (b.started && !b.stopped) p.push(`index ${i} 从未 stop`);
  if (messageDelta !== 1) p.push(`message_delta 出现 ${messageDelta} 次(应为 1)`);
  if (messageStop !== 1) p.push(`message_stop 出现 ${messageStop} 次(应为 1)`);
  if (sawStopAfterMessageDelta) p.push('content_block_stop 出现在 message_delta 之后');
  if (events.at(-1)?.type !== 'message_stop') p.push('末事件不是 message_stop');
  return p;
}

/**
 * Responses:sequence_number 严格连续无洞、output_item.added/done 配对、
 * output_text.delta 必须在 content_part.added 之后、必须有 response.completed。
 */
export function checkResponsesInvariants(events) {
  const p = [];
  let prevSeq = -1;
  const items = new Map();
  let partOpen = false;
  let sawCompleted = false;

  for (const e of events) {
    const t = e.type;
    if (typeof e.sequence_number === 'number') {
      if (prevSeq >= 0 && e.sequence_number !== prevSeq + 1) {
        p.push(`sequence_number 跳变 ${prevSeq} → ${e.sequence_number}`);
      }
      prevSeq = e.sequence_number;
    }
    if (t === 'response.output_item.added') {
      items.set(e.output_index, { done: false, type: e.item?.type });
    }
    if (t === 'response.output_item.done') {
      const it = items.get(e.output_index);
      if (!it) p.push(`output_index ${e.output_index} 的 done 无对应 added`);
      else if (it.done) p.push(`output_index ${e.output_index} 被重复 done`);
      else it.done = true;
    }
    if (t === 'response.content_part.added') partOpen = true;
    if (t === 'response.output_text.delta' && !partOpen) {
      p.push('output_text.delta 早于 content_part.added');
    }
    if (t === 'response.completed') sawCompleted = true;
  }
  for (const [i, it] of items) if (!it.done) p.push(`output_index ${i}(${it.type}) 从未 done`);
  if (!sawCompleted) p.push('缺 response.completed');
  return p;
}

// ---------------------------------------------------------------------------
// 结果汇总
// ---------------------------------------------------------------------------

/** 逐条打印 + 末尾汇总 + 以失败数决定退出码。三个检测器共用同一种输出形态。 */
export function reporter() {
  const results = [];
  return {
    record(name, ok, detail) {
      results.push({ name, ok, detail });
      console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
    },
    finish() {
      const failed = results.filter((r) => !r.ok);
      console.log(`\n════════ 汇总:${results.length} 项,失败 ${failed.length} 项 ════════`);
      for (const f of failed) console.log(`  ✗ ${f.name} — ${f.detail}`);
      process.exit(failed.length ? 1 : 0);
    },
  };
}
