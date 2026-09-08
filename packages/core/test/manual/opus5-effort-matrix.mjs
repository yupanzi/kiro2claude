#!/usr/bin/env node
/** Live Messages matrix. Real upstream calls incur usage; no retries are added here.
 * K2C_BASE=http://127.0.0.1:18092 K2C_KEY=... K2C_REPORT_DIR=/tmp/opus-proof node this-file
 * Optional OPUS_CASES=tools,images,search and OPUS_EFFORTS=default,low,medium,high,xhigh,max.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomInt } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { checkClaudeInvariants, parseSse } from './_harness.mjs';

const BASE = process.env.K2C_BASE ?? 'http://127.0.0.1:8080';
const KEY = process.env.K2C_KEY;
if (!KEY) throw new Error('K2C_KEY is required');
const MODEL = 'claude-opus-5';
const DIR = process.env.K2C_REPORT_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'k2c-opus5-'));
fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
const efforts = (process.env.OPUS_EFFORTS ?? 'default,low,medium,high,xhigh,max').split(',');
const cases = new Set((process.env.OPUS_CASES ?? 'tools,images,search').split(','));
const report = { startedAt: new Date().toISOString(), model: MODEL, gateway: BASE, rows: [] };
const effortFields = (effort) =>
  effort === 'default' ? {} : { thinking: { type: 'adaptive' }, output_config: { effort } };
const save = () => fs.writeFileSync(path.join(DIR, 'report.json'), JSON.stringify(report, null, 2));

function decodeStream(events) {
  const blocks = new Map();
  let model, stop_reason;
  const usage = {};
  for (const e of events) {
    if (e.type === 'message_start') {
      model = e.message?.model;
      Object.assign(usage, e.message?.usage);
    }
    if (e.type === 'message_delta') {
      stop_reason = e.delta?.stop_reason;
      Object.assign(usage, e.usage);
    }
    if (e.type === 'content_block_start') blocks.set(e.index, { ...e.content_block, _input: '' });
    if (e.type === 'content_block_delta') {
      const block = blocks.get(e.index);
      if (!block) continue;
      if (e.delta?.type === 'text_delta') block.text = (block.text ?? '') + e.delta.text;
      if (e.delta?.type === 'thinking_delta')
        block.thinking = (block.thinking ?? '') + e.delta.thinking;
      if (e.delta?.type === 'signature_delta')
        block.signature = (block.signature ?? '') + e.delta.signature;
      if (e.delta?.type === 'input_json_delta') block._input += e.delta.partial_json;
      if (e.delta?.type === 'citations_delta') (block.citations ??= []).push(e.delta.citation);
    }
  }
  const content = [...blocks.values()].map(({ _input, ...block }) => {
    if (_input && (block.type === 'tool_use' || block.type === 'server_tool_use'))
      block.input = JSON.parse(_input);
    return block;
  });
  return { model, stop_reason, content, usage };
}

async function request(body) {
  const start = Date.now();
  const res = await fetch(`${BASE}/claude/v1/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  const raw = await res.text();
  const isSse = res.headers.get('content-type')?.includes('text/event-stream') ?? false;
  const events = isSse ? parseSse(raw) : [];
  const message = isSse ? decodeStream(events) : JSON.parse(raw);
  const content = message.content ?? [];
  const summary = {
    status: res.status,
    durationMs: Date.now() - start,
    requestedStream: body.stream,
    requestedThinking: body.thinking,
    requestedOutputConfig: body.output_config,
    wireFormatMatches: isSse === body.stream,
    contentType: res.headers.get('content-type'),
    responseModel: message.model,
    stopReason: message.stop_reason,
    contentTypes: content.map((b) => b.type),
    thinkingBlocks: content.filter((b) => b.type === 'thinking' || b.type === 'redacted_thinking')
      .length,
    text: content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join(''),
    toolCalls: content
      .filter((b) => b.type === 'tool_use')
      .map((b) => ({ id: b.id, name: b.name, input: b.input })),
    protocolProblems: isSse ? checkClaudeInvariants(events) : [],
    eventTypes: isSse ? events.map((e) => e.type) : undefined,
    inbandErrors: events.filter((e) => e.type === 'error'),
    error: message.error,
    usage: message.usage,
    searchResultCount: content
      .filter((b) => b.type === 'web_search_tool_result')
      .reduce((n, b) => n + (Array.isArray(b.content) ? b.content.length : 0), 0),
    searchUrls: content.flatMap((b) =>
      b.type === 'web_search_tool_result' && Array.isArray(b.content)
        ? b.content.map((r) => r.url).filter(Boolean)
        : [],
    ),
    citationUrls: content.flatMap((b) => (b.citations ?? []).map((c) => c.url).filter(Boolean)),
  };
  if (res.status !== 200 || summary.inbandErrors.length || summary.protocolProblems.length) {
    throw Object.assign(new Error('HTTP or protocol failure'), { summary });
  }
  return { message, summary };
}

async function runRow(name, fn) {
  const row = { name, startedAt: new Date().toISOString(), requests: [], pass: false };
  report.rows.push(row);
  try {
    await fn(row);
    row.pass = true;
  } catch (error) {
    row.error = error.message;
    if (error.summary) row.requests.push(error.summary);
  }
  save();
  console.log(
    JSON.stringify({ name, pass: row.pass, error: row.error, requests: row.requests.length }),
  );
}

const tool = {
  name: 'lookup_reference',
  description: 'Read a generated reference value using its exact key.',
  input_schema: {
    type: 'object',
    properties: { key: { type: 'string' } },
    required: ['key'],
    additionalProperties: false,
  },
};
function validateTool(first, key, name = 'lookup_reference') {
  const calls = first.summary.toolCalls;
  if (
    first.summary.stopReason !== 'tool_use' ||
    calls.length !== 1 ||
    calls[0].name !== name ||
    calls[0].input?.key !== key
  ) {
    throw new Error('Expected one complete tool call with the exact key and stop_reason=tool_use');
  }
  return calls[0];
}

if (cases.has('tools'))
  for (const effort of efforts)
    for (const stream of [false, true]) {
      await runRow(`tools/${effort}/${stream ? 'stream' : 'json'}`, async (row) => {
        const key = `reference-${randomBytes(5).toString('hex')}`;
        const value = `VALUE-${randomBytes(9).toString('hex')}`;
        const messages = [
          {
            role: 'user',
            content: `Call lookup_reference exactly once with key "${key}". After receiving its result, output only the returned value verbatim. The value is unknown until you call the tool.`,
          },
        ];
        const base = {
          model: MODEL,
          max_tokens: 8192,
          stream,
          ...effortFields(effort),
          tools: [tool],
        };
        const first = await request({ ...base, messages });
        row.requests.push(first.summary);
        const call = validateTool(first, key);
        const second = await request({
          ...base,
          messages: [
            ...messages,
            { role: 'assistant', content: first.message.content },
            {
              role: 'user',
              content: [{ type: 'tool_result', tool_use_id: call.id, content: value }],
            },
          ],
        });
        row.requests.push(second.summary);
        row.executedTool = { key, expectedValue: value, toolUseId: call.id };
        if (
          second.summary.text.trim() !== value ||
          second.summary.stopReason !== 'end_turn' ||
          second.summary.toolCalls.length
        )
          throw new Error('Tool result did not produce the exact final answer with end_turn');
        if (row.requests.some((r) => r.responseModel !== MODEL))
          throw new Error('Returned model differs from the requested Opus5');
        if (row.requests.some((r) => !r.wireFormatMatches))
          throw new Error('Response format differs from the requested stream mode');
      });
    }

// Self-contained deterministic OCR fixture: random six digits in a large 5×7 bitmap font.
function markerPng(marker) {
  const glyphs = [
    '01110100011001110101110011000101110',
    '00100011000010000100001000010001110',
    '01110100010000100010001000100011111',
    '11110000010000101110000010000111110',
    '00010001100101010010111110001000010',
    '11111100001000011110000010000111110',
    '01110100001000011110100011000101110',
    '11111000010001000100010000100001000',
    '01110100011000101110100011000101110',
    '01110100011000101111000010000101110',
  ];
  const scale = 18,
    width = 720,
    height = 200;
  const raw = Buffer.alloc((width * 3 + 1) * height, 255);
  for (let y = 0; y < height; y++) raw[y * (width * 3 + 1)] = 0;
  for (let d = 0; d < marker.length; d++)
    for (let gy = 0; gy < 7; gy++)
      for (let gx = 0; gx < 5; gx++)
        if (glyphs[Number(marker[d])][gy * 5 + gx] === '1') {
          for (let yy = 0; yy < scale; yy++)
            for (let xx = 0; xx < scale; xx++) {
              const at =
                (35 + gy * scale + yy) * (width * 3 + 1) +
                1 +
                (45 + d * 6 * scale + gx * scale + xx) * 3;
              raw.fill(0, at, at + 3);
            }
        }
  function chunk(type, data) {
    const label = Buffer.from(type),
      joined = Buffer.concat([label, data]);
    let crc = 0xffffffff;
    for (const byte of joined) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    const out = Buffer.alloc(data.length + 12);
    out.writeUInt32BE(data.length);
    label.copy(out, 4);
    data.copy(out, 8);
    out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4);
    return out;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

if (cases.has('images'))
  for (const [effort, stream] of [
    ['low', true],
    ['max', false],
  ])
    for (const mode of ['direct', 'tool-result']) {
      await runRow(`images/${effort}/${mode}`, async (row) => {
        const marker = String(randomInt(100000, 1000000));
        const png = markerPng(marker);
        fs.writeFileSync(path.join(DIR, `${row.name.replaceAll('/', '-')}.png`), png);
        const image = {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') },
        };
        const base = { model: MODEL, max_tokens: 8192, stream, ...effortFields(effort) };
        let messages;
        if (mode === 'direct')
          messages = [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: 'Read the six digits in this image. Output only those six digits, no other text.',
                },
                image,
              ],
            },
          ];
        else {
          const key = `image-${randomBytes(4).toString('hex')}`;
          messages = [
            {
              role: 'user',
              content: `Call lookup_reference once with key "${key}" to obtain an image. Read the six digits from the returned image and output only those digits.`,
            },
          ];
          const first = await request({ ...base, tools: [tool], messages });
          row.requests.push(first.summary);
          const call = validateTool(first, key);
          messages.push(
            { role: 'assistant', content: first.message.content },
            {
              role: 'user',
              content: [{ type: 'tool_result', tool_use_id: call.id, content: [image] }],
            },
          );
        }
        const final = await request({
          ...base,
          ...(mode === 'tool-result' ? { tools: [tool] } : {}),
          messages,
        });
        row.requests.push(final.summary);
        row.expectedMarker = marker;
        if (final.summary.text.trim() !== marker || final.summary.stopReason !== 'end_turn')
          throw new Error('Image marker recognition or terminal status incorrect');
        if (row.requests.some((r) => !r.wireFormatMatches))
          throw new Error('Response format differs from the requested stream mode');
      });
    }

if (cases.has('search'))
  for (const stream of [true, false]) {
    await runRow(`search/${stream ? 'stream' : 'json'}`, async (row) => {
      const result = await request({
        model: MODEL,
        max_tokens: 4096,
        stream,
        messages: [
          {
            role: 'user',
            content: 'Perform a web search for the query: Python math.isqrt official documentation',
          },
        ],
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }],
      });
      row.requests.push(result.summary);
      if (
        result.summary.searchResultCount === 0 ||
        !result.summary.searchUrls.some((url) => /^https?:\/\//.test(url))
      )
        throw new Error('No structured search results with source URLs');
      if (!stream && result.summary.contentType?.includes('text/event-stream'))
        throw new Error('stream=false returned SSE instead of a JSON Messages response');
    });
  }
report.finishedAt = new Date().toISOString();
save();
console.log(
  JSON.stringify({
    report: path.join(DIR, 'report.json'),
    passed: report.rows.filter((r) => r.pass).length,
    failed: report.rows.filter((r) => !r.pass).length,
  }),
);
process.exitCode = report.rows.some((r) => !r.pass) ? 1 : 0;
