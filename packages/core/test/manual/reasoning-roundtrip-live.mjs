#!/usr/bin/env node
/**
 * 走网关的原生 reasoning 端到端验收(💰 打真实上游,不进 CI):签名原样回传无剥离重试;改坏签名
 * 触发恰好一次剥离重试后成功;`display: omitted` 回空文本 + 签名且可回传;effort max 计费高于 low;
 * GPT / sonnet-4.6 正常;流式含 `thinking_delta` + `signature_delta` 且过协议不变量。
 *
 * env 与其它 💰 探针同一套(`_harness.mjs`):`K2C_KEY`(必填)、`K2C_BASE`,另加 `K2C_GATEWAY_LOG`
 * (默认 /tmp/k2c-gateway.log,用来数剥离重试行)。
 *
 * ```bash
 * pnpm dev > /tmp/k2c-gateway.log 2>&1 &
 * K2C_KEY=$(grep '^KIRO2CLAUDE_API_KEY=' .env | cut -d= -f2-) \
 *   node packages/core/test/manual/reasoning-roundtrip-live.mjs
 * ```
 */

import fs from 'node:fs';
import {
  CLAUDE_PATH,
  checkClaudeInvariants,
  claudeHeaders,
  KEY,
  parseSse,
  postJson,
  reporter,
} from './_harness.mjs';

const LOG = process.env.K2C_GATEWAY_LOG ?? '/tmp/k2c-gateway.log';
const MODEL = process.env.K2C_PROBE_MODEL ?? 'claude-opus-5';
const PUZZLE =
  process.env.K2C_PROBE_PROMPT ??
  'How many positive integers below 1000 are divisible by 7 or by 11 but not by both? Work it out carefully. Reply with ONLY the number.';
const STRIP_MSG = 'retrying without reasoningContent';

if (!KEY) {
  console.error('K2C_KEY missing');
  process.exit(1);
}

const report = reporter();

function stripCount() {
  try {
    return fs.readFileSync(LOG, 'utf8').split('\n').filter((l) => l.includes(STRIP_MSG)).length;
  } catch {
    return 0;
  }
}

async function messages(body) {
  const { status, raw } = await postJson(CLAUDE_PATH, claudeHeaders(), body);
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    json = undefined;
  }
  return { status, json, raw };
}

/** plugin-metering 的契约(`packages/plugin-metering/src/index.ts`):`usage.kiro_metering.usage` = credits。 */
const credits = (json) => json?.usage?.kiro_metering?.usage;
const thinkingBlock = (json) => (json?.content ?? []).find((b) => b.type === 'thinking');
const textOf = (json) =>
  (json?.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');

async function main() {
  const base = { model: MODEL, max_tokens: 2048, stream: false };
  const think = (effort, extra = {}) => ({
    thinking: { type: 'adaptive', ...extra },
    output_config: { effort },
  });
  const ask = (content, opts) => messages({ ...base, ...opts, messages: [{ role: 'user', content }] });
  const follow = { role: 'user', content: 'Now double that number. Reply with ONLY the number.' };

  // ── 1. 第一轮:拿 thinking + signature ────────────────────────────────
  const t1 = await ask(PUZZLE, think('max'));
  const tb1 = thinkingBlock(t1.json);
  report.record('turn1 200', t1.status === 200, `status=${t1.status}`);
  report.record(
    'turn1 has thinking block with signature',
    !!tb1?.signature,
    `sig=${tb1?.signature?.slice(0, 12)}… text=${JSON.stringify((tb1?.thinking ?? '').slice(0, 60))}`,
  );
  report.record('turn1 answer', textOf(t1.json).includes('208'), `text=${JSON.stringify(textOf(t1.json))}`);
  console.log('  usage:', JSON.stringify(t1.json?.usage));
  if (!tb1?.signature) {
    console.log('cannot continue without a signature');
    report.finish();
  }
  const history = [
    { role: 'user', content: PUZZLE },
    { role: 'assistant', content: t1.json.content },
  ];

  // ── 2. 原样回传:200,且无剥离重试 ──────────────────────────────────
  const before2 = stripCount();
  const t2 = await messages({ ...base, ...think('low'), messages: [...history, follow] });
  report.record('turn2 (signed round trip) 200', t2.status === 200, `status=${t2.status} ${t2.raw.slice(0, 120)}`);
  report.record('turn2 answer doubled', textOf(t2.json).includes('416'), `text=${JSON.stringify(textOf(t2.json))}`);
  report.record('turn2 no strip-retry in gateway log', stripCount() === before2);

  // ── 3. 改坏签名:网关剥掉重发一次 → 200,日志 +1 ───────────────────
  const corrupted = t1.json.content.map((b) =>
    b.type === 'thinking' ? { ...b, signature: `${b.signature.slice(0, -8)}AAAAAAAA` } : b,
  );
  const before3 = stripCount();
  const t3 = await messages({
    ...base,
    ...think('low'),
    messages: [history[0], { role: 'assistant', content: corrupted }, follow],
  });
  report.record('turn3 (corrupted signature) still 200 via strip-retry', t3.status === 200, `status=${t3.status} ${t3.raw.slice(0, 160)}`);
  report.record('turn3 answer', textOf(t3.json).includes('416'), `text=${JSON.stringify(textOf(t3.json))}`);
  report.record('turn3 exactly one strip-retry log line', stripCount() === before3 + 1, `delta=${stripCount() - before3}`);

  // ── 4. display: omitted → 只回签名;回传仍 200 ────────────────────────
  const t4 = await ask(PUZZLE, think('high', { display: 'omitted' }));
  const tb4 = thinkingBlock(t4.json);
  report.record('turn4 (display omitted) 200', t4.status === 200, `status=${t4.status}`);
  report.record(
    'turn4 thinking block: empty text + signature',
    !!tb4 && tb4.thinking === '' && !!tb4.signature,
    `thinking=${JSON.stringify(tb4?.thinking)} sig=${!!tb4?.signature}`,
  );
  if (tb4?.signature) {
    const before5 = stripCount();
    const t5 = await messages({
      ...base,
      ...think('low'),
      messages: [{ role: 'user', content: PUZZLE }, { role: 'assistant', content: t4.json.content }, follow],
    });
    report.record('turn5 (omitted round trip) 200', t5.status === 200, `status=${t5.status} ${t5.raw.slice(0, 120)}`);
    report.record('turn5 no strip-retry', stripCount() === before5, `delta=${stripCount() - before5}`);
  }

  // ── 5. effort A/B 计费(顶层 additionalModelRequestFields 生效)────────
  const lo = await ask(PUZZLE, think('low'));
  const hi = await ask(PUZZLE, think('max'));
  console.log('  effort low usage:', JSON.stringify(lo.json?.usage));
  console.log('  effort max usage:', JSON.stringify(hi.json?.usage));
  const cl = Number(credits(lo.json));
  const ch = Number(credits(hi.json));
  report.record(
    'effort max costs more credits than low',
    Number.isFinite(cl) && Number.isFinite(ch) && ch > cl,
    `low=${cl} max=${ch}`,
  );

  // ── 6. GPT:reasoning.effort 顶层字段 → 200 ────────────────────────
  const g = await ask('What is 6*7? Reply with ONLY the number.', { model: 'gpt-5.6-luna', ...think('low') });
  report.record('gpt-5.6-luna with effort 200', g.status === 200, `status=${g.status} text=${JSON.stringify(textOf(g.json))}`);

  // ── 7. sonnet-4.6:新入原生集合,应回 thinking + signature ────────────
  const s46 = await ask(PUZZLE, { model: 'claude-sonnet-4-6', ...think('high') });
  const tbs = thinkingBlock(s46.json);
  report.record('sonnet-4.6 200', s46.status === 200, `status=${s46.status}`);
  report.record(
    'sonnet-4.6 native thinking block with signature',
    !!tbs?.signature,
    `text=${JSON.stringify((tbs?.thinking ?? '').slice(0, 60))} sig=${!!tbs?.signature}`,
  );

  // ── 8. 流式:thinking_delta + signature_delta + 协议不变量 ────────────
  const sres = await postJson(CLAUDE_PATH, claudeHeaders(), {
    ...base,
    stream: true,
    ...think('high'),
    messages: [{ role: 'user', content: PUZZLE }],
  });
  const events = parseSse(sres.raw);
  const deltaTypes = new Set(events.filter((e) => e.type === 'content_block_delta').map((e) => e.delta?.type));
  report.record('stream 200', sres.status === 200, `status=${sres.status}`);
  report.record('stream has thinking_delta', deltaTypes.has('thinking_delta'));
  report.record('stream has signature_delta', deltaTypes.has('signature_delta'));
  const problems = checkClaudeInvariants(events);
  report.record('stream protocol invariants', problems.length === 0, problems.join('; '));

  report.finish();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
