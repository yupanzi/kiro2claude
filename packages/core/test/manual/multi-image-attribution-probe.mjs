#!/usr/bin/env node
/**
 * Live multi-image attribution probe. Real upstream calls incur usage; no retries.
 *   K2C_KEY=... [K2C_BASE=http://127.0.0.1:8080] node this-file
 *   Optional K2C_ONLY=A-reverse-claude,B-gpt   K2C_REPEAT=2   K2C_REPORT_DIR=/tmp/k2c-images
 *
 * Kiro's wire has message-level `images[]` only (no image channel inside tool results,
 * no position inside the text), so an image is tied to its tool call / label purely by
 * order. Each row sends two 720×200 six-digit images and asks for JSON so the answer is
 * mechanically checkable:
 *   A-natural  two parallel image-returning tool calls, results in call order
 *   A-reverse  same, results in reverse order — before canonicalizeToolResultOrder both
 *              Claude opus-5 and GPT-5.6 swapped the answers (2026-09-09)
 *   B          "LEFT:" <img> "RIGHT:" <img> interleaved labels in one user message
 *   C (info)   two byte-identical images, "how many attachments?" — not asserted: token
 *              accounting shows both are delivered, GPT-5.6 still answers 1 (model judgement)
 *   D          K2C_MANY (default 6) distinct images in one plain user message, digits in
 *              attachment order — probes whether images[] order survives at that count
 *   E-cc       K2C_MANY parallel `Read` calls with opaque ids, each tool result is one image and
 *              the file name lives only in the tool_use input (Claude Code shape). Without the
 *              content legend both models scrambled 4/4 (2026-09-09); this row guards the legend
 *   E-codex    one `exec` call whose single tool result interleaves `text(path)` / image
 *              (Codex code-mode shape); the same legend applies
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BASE,
  CLAUDE_MODEL,
  CLAUDE_PATH,
  GPT_MODEL,
  KEY,
  RESPONSES_PATH,
  claudeHeaders,
  postJson,
  responsesHeaders,
} from './_harness.mjs';
import { randomBytes } from 'node:crypto';
import { markerPng } from './_marker-png.mjs';

if (!KEY) throw new Error('K2C_KEY is required');
const DIR = process.env.K2C_REPORT_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'k2c-images-'));
fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
const only = process.env.K2C_ONLY ? new Set(process.env.K2C_ONLY.split(',')) : undefined;
const REPEAT = Number(process.env.K2C_REPEAT ?? 1);

const A = '417293';
const B = '860541';
const MANY = Number(process.env.K2C_MANY ?? 6);
const manyDigits = Array.from({ length: MANY }, (_, i) => String(100000 + ((i + 1) * 137 * 1009) % 900000));
const manyPngs = manyDigits.map((d) => markerPng(d).toString('base64'));
const pngA = markerPng(A).toString('base64');
const pngB = markerPng(B).toString('base64');
const cImg = (data) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } });
const oImg = (data) => ({ type: 'input_image', image_url: `data:image/png;base64,${data}` });
const SCHEMA = { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] };
const TOOL_DESC = 'Look up a reference image by key.';
const askA =
  'Call lookup twice in parallel: once with key "alpha" and once with key "beta". Each call returns an image showing six digits. ' +
  'After both results arrive, reply with ONLY a JSON object, no prose: {"alpha": "<six digits shown in the alpha image>", "beta": "<six digits shown in the beta image>"}';
const askB =
  'Reply with ONLY a JSON object, no prose: {"left": "<six digits in the LEFT image>", "right": "<six digits in the RIGHT image>"}';
const askC =
  'Some images are attached. Reply with ONLY a JSON object, no prose: {"count": <how many separate image attachments you received>, "digits": [<the six-digit number shown in each attachment, in order>]}';
const askD = `${MANY} images are attached, in order: attachment 1 first through attachment ${MANY} last. Each shows six digits. Reply with ONLY a JSON object, no prose: {"digits": [<six digits of attachment 1>, <attachment 2>, ...]} with exactly ${MANY} entries in attachment order.`;

function bodyA(protocol, reverse) {
  const results = reverse ? [['beta', pngB], ['alpha', pngA]] : [['alpha', pngA], ['beta', pngB]];
  if (protocol === 'claude')
    return {
      model: CLAUDE_MODEL,
      max_tokens: 2048,
      tools: [{ name: 'lookup', description: TOOL_DESC, input_schema: SCHEMA }],
      messages: [
        { role: 'user', content: askA },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_alpha', name: 'lookup', input: { key: 'alpha' } },
            { type: 'tool_use', id: 'toolu_beta', name: 'lookup', input: { key: 'beta' } },
          ],
        },
        {
          role: 'user',
          content: results.map(([k, png]) => ({ type: 'tool_result', tool_use_id: `toolu_${k}`, content: [cImg(png)] })),
        },
      ],
    };
  return {
    model: GPT_MODEL,
    max_output_tokens: 2048,
    tools: [{ type: 'function', name: 'lookup', description: TOOL_DESC, parameters: SCHEMA }],
    input: [
      { role: 'user', content: askA },
      { type: 'function_call', call_id: 'call_alpha', name: 'lookup', arguments: '{"key":"alpha"}' },
      { type: 'function_call', call_id: 'call_beta', name: 'lookup', arguments: '{"key":"beta"}' },
      ...results.map(([k, png]) => ({ type: 'function_call_output', call_id: `call_${k}`, output: [oImg(png)] })),
    ],
  };
}
function bodyB(protocol) {
  if (protocol === 'claude')
    return {
      model: CLAUDE_MODEL,
      max_tokens: 2048,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'LEFT:' }, cImg(pngA), { type: 'text', text: 'RIGHT:' }, cImg(pngB), { type: 'text', text: askB }] }],
    };
  return {
    model: GPT_MODEL,
    max_output_tokens: 2048,
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'LEFT:' }, oImg(pngA), { type: 'input_text', text: 'RIGHT:' }, oImg(pngB), { type: 'input_text', text: askB }] }],
  };
}
function bodyC(protocol) {
  if (protocol === 'claude')
    return { model: CLAUDE_MODEL, max_tokens: 2048, messages: [{ role: 'user', content: [{ type: 'text', text: askC }, cImg(pngA), cImg(pngA)] }] };
  return { model: GPT_MODEL, max_output_tokens: 2048, input: [{ role: 'user', content: [{ type: 'input_text', text: askC }, oImg(pngA), oImg(pngA)] }] };
}

function bodyD(protocol) {
  if (protocol === 'claude')
    return { model: CLAUDE_MODEL, max_tokens: 2048, messages: [{ role: 'user', content: [{ type: 'text', text: askD }, ...manyPngs.map(cImg)] }] };
  return { model: GPT_MODEL, max_output_tokens: 2048, input: [{ role: 'user', content: [{ type: 'input_text', text: askD }, ...manyPngs.map(oImg)] }] };
}

const opaqueId = () => `toolu_${randomBytes(8).toString('hex')}`;
const manyFiles = manyDigits.map((_, i) => `/workspace/img-${i + 1}.png`);
const askE = `There are ${MANY} PNG files: ${manyFiles.join(', ')}. Each shows one six-digit number. View every image with your image tool, then reply with ONLY a JSON object, no prose, mapping each file basename to its six digits, e.g. {"img-1.png":"123456"}.`;
const expectE = Object.fromEntries(manyDigits.map((d, i) => [`img-${i + 1}.png`, d]));
// Both shapes go through the Messages endpoint (either model is accepted there), so the
// exact Claude-side wire is what gets converted.
function bodyE(model, shape) {
  let assistant;
  let results;
  let tools;
  if (shape === 'cc') {
    const ids = manyFiles.map(opaqueId);
    assistant = manyFiles.map((f, i) => ({ type: 'tool_use', id: ids[i], name: 'Read', input: { file_path: f } }));
    results = manyFiles.map((_, i) => ({ type: 'tool_result', tool_use_id: ids[i], content: [cImg(manyPngs[i])] }));
    tools = [{ name: 'Read', description: 'Read a file; image files are returned as an image.', input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } }];
  } else {
    const id = opaqueId();
    assistant = [{ type: 'tool_use', id, name: 'exec', input: { code: `for (const p of ${JSON.stringify(manyFiles)}) { text(p); const r = await tools.view_image({path:p}); image(r.image_url); }` } }];
    const parts = [{ type: 'text', text: 'Script completed\nOutput:' }];
    manyFiles.forEach((f, i) => { parts.push({ type: 'text', text: f }); parts.push(cImg(manyPngs[i])); });
    results = [{ type: 'tool_result', tool_use_id: id, content: parts }];
    tools = [{ name: 'exec', description: 'Run JavaScript with tools.view_image(path) → {image_url}; text(s) and image(url) emit output parts.', input_schema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] } }];
  }
  return { model, max_tokens: 2048, tools, messages: [{ role: 'user', content: askE }, { role: 'assistant', content: assistant }, { role: 'user', content: results }] };
}

const rows = [];
for (const protocol of ['claude', 'gpt']) {
  rows.push({ name: `A-natural-${protocol}`, protocol, body: bodyA(protocol, false), expect: { alpha: A, beta: B } });
  rows.push({ name: `A-reverse-${protocol}`, protocol, body: bodyA(protocol, true), expect: { alpha: A, beta: B } });
  rows.push({ name: `B-${protocol}`, protocol, body: bodyB(protocol), expect: { left: A, right: B } });
  rows.push({ name: `C-identical-${protocol}`, protocol, body: bodyC(protocol), info: true });
  rows.push({ name: `D-many${MANY}-${protocol}`, protocol, body: bodyD(protocol), expect: { digits: manyDigits } });
  const model = protocol === 'claude' ? CLAUDE_MODEL : GPT_MODEL;
  rows.push({ name: `E-cc${MANY}-${protocol}`, protocol: 'claude', body: bodyE(model, 'cc'), expect: expectE, byFile: true });
  rows.push({ name: `E-codex${MANY}-${protocol}`, protocol: 'claude', body: bodyE(model, 'codex'), expect: expectE, byFile: true });
}

function visibleText(protocol, json) {
  if (protocol === 'claude') return (json.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return (json.output ?? []).flatMap((o) => o.content ?? []).filter((p) => p.type === 'output_text').map((p) => p.text).join('');
}

const report = [];
let failures = 0;
for (const row of rows) {
  if (only && !only.has(row.name)) continue;
  for (let k = 0; k < REPEAT; k++) {
    const t0 = Date.now();
    const { status, raw } = await postJson(
      row.protocol === 'claude' ? CLAUDE_PATH : RESPONSES_PATH,
      row.protocol === 'claude' ? claudeHeaders() : responsesHeaders(),
      row.body,
    );
    let json = {};
    try { json = JSON.parse(raw); } catch {}
    const text = visibleText(row.protocol, json);
    let parsed;
    try { parsed = JSON.parse(text.replace(/^```(json)?\s*|\s*```$/g, '')); } catch {}
    const normalized = parsed && Object.fromEntries(Object.entries(parsed).map(([key, v]) => [key, Array.isArray(v) ? v.map(String) : String(v)]));
    const pass0 = row.info ? undefined : status === 200 && JSON.stringify(normalized) === JSON.stringify(row.expect);
    const pass = pass0;
    let positions = row.name.startsWith('D-') && Array.isArray(parsed?.digits) ? row.expect.digits.map((d, i) => (String(parsed.digits[i]) === d ? 'ok' : row.expect.digits.includes(String(parsed.digits[i])) ? 'swap' : 'ocr')) : undefined;
    let verdict = pass;
    if (row.byFile) {
      const hamming = (a, b) => (a.length === b.length ? [...a].filter((ch, i) => ch !== b[i]).length : 99);
      positions = Object.entries(row.expect).map(([name, d]) => { const got = String(parsed?.[name] ?? ''); if (got === d) return 'ok'; return Object.entries(row.expect).some(([n, x]) => n !== name && hamming(got, x) <= 1) ? 'swap' : 'ocr'; });
      // attribution is the gateway's job; an OCR slip is the model's
      verdict = status === 200 && positions.length > 0 && !positions.includes('swap');
    }
    if (verdict === false) failures++;
    const inputTokens = json.usage?.input_tokens ?? json.usage?.prompt_tokens;
    const entry = { name: row.name, status, ms: Date.now() - t0, stop: json.stop_reason ?? json.status, input_tokens: inputTokens, text, parsed, expect: row.expect, pass: verdict, positions };
    report.push(entry);
    console.log(`${row.name.padEnd(20)} ${row.info ? 'INFO' : verdict ? 'PASS' : 'FAIL'} status=${status} stop=${entry.stop} in=${inputTokens} ${entry.ms}ms  ${JSON.stringify(text).slice(0, 160)}${positions ? `  positions=${positions.join(',')}` : ''}`);
  }
}
const file = path.join(DIR, 'multi-image-attribution.json');
fs.writeFileSync(file, JSON.stringify({ base: BASE, claudeModel: CLAUDE_MODEL, gptModel: GPT_MODEL, report }, null, 2));
console.log(`report: ${file}`);
process.exit(failures ? 1 : 0);
