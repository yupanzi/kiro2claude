#!/usr/bin/env node
/**
 * 慢客户端背压下的完整性检测（手工，打真实上游，会计费）。
 *
 * 专打踩坑「write 背压不是断连」那条红线：`stream.write()` 返回 false 意味着
 * 缓冲超过 highWaterMark、应等 'drain'，socket 是健康的。误判成断连会停读循环、
 * **丢掉终结段 message_stop**，而且因为缓冲要靠**大量字节**才填满，这个 bug
 * 专咬最长最贵的响应——常规快客户端的测试永远碰不到它。
 *
 * 做法：用原始 http.request 连上去，立刻 `pause()`，之后每 `TICK` 毫秒只
 * `read(CHUNK)` 一小口。服务端写入速度远超读取速度，内核缓冲写满后 write()
 * 必然返回 false，网关被迫走 awaitDrain 路径。
 *
 * 检查点用的是 `_harness.mjs` 的**完整**协议不变量集（而不是只看末事件）——
 * 背压路径下 block 配对、序号连续性同样可能被破坏，缩水的检查集发现不了。
 *
 * 用法：K2C_KEY=... node backpressure-integrity.mjs
 */

import http from 'node:http';

import {
  CLAUDE_MODEL,
  CLAUDE_PATH,
  GPT_MODEL,
  RESPONSES_PATH,
  baseHostPort,
  checkClaudeInvariants,
  checkRange,
  checkResponsesInvariants,
  claudeHeaders,
  collectClaude,
  collectResponses,
  parseSse,
  rangeProblems,
  reporter,
  responsesHeaders,
  seqPrompt,
} from './_harness.mjs';

const N = 600;
const PROMPT = seqPrompt(1, N);
const TICK = 40; // ms between reads
const CHUNK = 512; // bytes per read — 远慢于服务端写入

const { record, finish } = reporter();

/**
 * 发请求后**故意慢读**：每 TICK 毫秒只 `read(CHUNK)` 一小口，让写缓冲持续满着。
 * ⚠ 刻意**不**一次抽干——抽干就没有背压，脚本也就没意义了。别改成 while 循环。
 */
function slowRead(path, headers, body) {
  const { host, port } = baseHostPort();
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const req = http.request({ host, port, path, method: 'POST', headers }, (res) => {
      const chunks = [];
      res.pause();
      const timer = setInterval(() => {
        const c = res.read(CHUNK);
        if (c) chunks.push(c);
      }, TICK);
      res.on('end', () => {
        clearInterval(timer);
        resolve({
          status: res.statusCode,
          raw: Buffer.concat(chunks).toString('utf-8'),
          ms: Date.now() - started,
        });
      });
      res.on('error', (e) => {
        clearInterval(timer);
        reject(e);
      });
      // read() 在 paused 模式下需要 readable 事件推动
      res.on('readable', () => {});
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

/** 序列校验 → record 一条。 */
function recordSequence(name, text) {
  const r = checkRange(text, 1, N);
  const problems = rangeProblems(r);
  record(name, problems.length === 0, problems.length === 0 ? `1..${N} 全到（${r.count} 个数字）` : problems.join('; '));
}

// ── Claude ────────────────────────────────────────────────────────────────
{
  const out = await slowRead(CLAUDE_PATH, claudeHeaders(), {
    model: CLAUDE_MODEL,
    max_tokens: 16000,
    stream: true,
    messages: [{ role: 'user', content: PROMPT }],
  });
  const events = parseSse(out.raw);
  const { text, types } = collectClaude(events);
  console.log(
    `\n[Claude] ${out.raw.length}B / ${events.length} 事件 / ${out.ms}ms（慢读 ${CHUNK}B per ${TICK}ms）`,
  );
  const inv = checkClaudeInvariants(events);
  record(
    'Claude 背压 · 协议不变量（含终结段未被吞）',
    inv.length === 0,
    inv.join('; ') || `全部满足，末事件=${types.at(-1)}`,
  );
  recordSequence('Claude 背压 · 内容完整', text);
}

// ── Responses ─────────────────────────────────────────────────────────────
{
  const out = await slowRead(RESPONSES_PATH, responsesHeaders(), {
    model: GPT_MODEL,
    stream: true,
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: PROMPT }] }],
  });
  const events = parseSse(out.raw);
  const { text, types, maxSeq } = collectResponses(events);
  console.log(
    `\n[Responses] ${out.raw.length}B / ${events.length} 事件 / ${out.ms}ms（慢读 ${CHUNK}B per ${TICK}ms）`,
  );
  const inv = checkResponsesInvariants(events);
  record(
    'Responses 背压 · 协议不变量（含终结段未被吞、序号无洞）',
    inv.length === 0,
    inv.join('; ') || `全部满足，末事件=${types.at(-1)}，末序号 ${maxSeq}`,
  );
  recordSequence('Responses 背压 · 内容完整', text);
}

finish();
