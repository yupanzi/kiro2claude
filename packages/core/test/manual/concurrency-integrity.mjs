#!/usr/bin/env node
/**
 * 并发下的双协议隔离/完整性检测（手工，打真实上游，会计费）。
 *
 * 部署形态是多容器同机 + 并发请求，串扰在这里才暴露：每个请求让模型输出一段
 * **各不相同的可验证序列**（起点不同），若网关的流状态（block index、
 * sequence_number、tool 缓冲）在请求间泄漏，收到的序列就会串号或缺段。
 * 判据是 `checkRange` 的 `foreign`——混入外区间数字即串扰。
 *
 * 协议不变量用 `_harness.mjs` 的完整集：并发下 block 配对与 item added/done
 * 失配同样是状态泄漏的表现，只看末事件会漏掉。
 *
 * 用法：K2C_KEY=... node concurrency-integrity.mjs [并发数]
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

const CONC = Number(process.argv[2] ?? 4);
const SPAN = 100;

const { record, finish } = reporter();

/** 第 i 个任务输出 [base, base+SPAN)，各任务区间互不重叠。 */
function taskFor(i) {
  const base = 1000 + i * 1000;
  return { base, last: base + SPAN - 1, prompt: seqPrompt(base, base + SPAN - 1) };
}

async function claudeTask(i) {
  const { base, last, prompt } = taskFor(i);
  const { raw } = await postJson(CLAUDE_PATH, claudeHeaders(), {
    model: CLAUDE_MODEL,
    max_tokens: 4000,
    stream: true,
    messages: [{ role: 'user', content: prompt }],
  });
  const events = parseSse(raw);
  const { text } = collectClaude(events);
  return {
    proto: 'claude',
    base,
    last,
    bytes: raw.length,
    problems: [
      ...rangeProblems(checkRange(text, base, last), { crosstalk: true }),
      ...checkClaudeInvariants(events),
    ],
  };
}

async function responsesTask(i) {
  const { base, last, prompt } = taskFor(i);
  const { raw } = await postJson(RESPONSES_PATH, responsesHeaders(), {
    model: GPT_MODEL,
    stream: true,
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] }],
  });
  const events = parseSse(raw);
  const { text } = collectResponses(events);
  return {
    proto: 'responses',
    base,
    last,
    bytes: raw.length,
    problems: [
      ...rangeProblems(checkRange(text, base, last), { crosstalk: true }),
      ...checkResponsesInvariants(events),
    ],
  };
}

const tasks = [];
for (let i = 0; i < CONC; i++) tasks.push(claudeTask(i));
for (let i = 0; i < CONC; i++) tasks.push(responsesTask(CONC + i));

console.log(`并发 ${tasks.length} 个请求（${CONC} Claude + ${CONC} Responses），各自区间互不重叠…\n`);
const started = Date.now();
const out = await Promise.all(tasks);
console.log(`全部完成，用时 ${((Date.now() - started) / 1000).toFixed(1)}s\n`);

for (const r of out) {
  record(
    `[${r.proto}] 区间 ${r.base}..${r.last} (${r.bytes}B)`,
    r.problems.length === 0,
    r.problems.length === 0 ? '完整且无串扰' : r.problems.join('; '),
  );
}

finish();
