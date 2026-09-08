#!/usr/bin/env node
/**
 * Real GPT tool round trips across effort levels, protocols and stream modes. Bills upstream.
 * No retries: every failure remains in the report. Uses the shared Responses invariants.
 * K2C_BASE=http://127.0.0.1:8080 K2C_KEY=... K2C_REPORT=/tmp/results.json node gpt-tool-matrix.mjs
 * Optional images: K2C_IMAGE_PATH=picture.png K2C_IMAGE_EXPECTED=expected.json (marker/shapes).
 * Optional scope: K2C_EFFORTS=low,max K2C_CONCURRENCY=2 K2C_SKIP_TOOLS=1.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  GPT_MODEL,
  RESPONSES_PATH,
  checkResponsesInvariants,
  parseSse,
  postJson,
  responsesHeaders,
} from './_harness.mjs';

const efforts = (process.env.K2C_EFFORTS ?? 'default,low,medium,high,xhigh,max,minimal,none').split(',');
const concurrency = Number(process.env.K2C_CONCURRENCY ?? 2);
assert.ok(Number.isInteger(concurrency) && concurrency > 0, 'K2C_CONCURRENCY must be a positive integer');
const results = [];
const reportPath = process.env.K2C_REPORT;
const imagePath = process.env.K2C_IMAGE_PATH;
const imageExpected = process.env.K2C_IMAGE_EXPECTED;
const schema = {
  type: 'object',
  properties: { ticket: { type: 'string' } },
  required: ['ticket'],
  additionalProperties: false,
};

function effortFields(protocol, effort) {
  if (effort === 'default') return {};
  return protocol === 'responses' ? { reasoning: { effort } } : { reasoning_effort: effort };
}

function validateResponseDeltas(events, output) {
  for (const item of output) {
    const family =
      item.type === 'custom_tool_call'
        ? 'custom_tool_call_input'
        : item.type === 'function_call'
          ? 'function_call_arguments'
          : item.type === 'message'
            ? 'output_text'
            : undefined;
    if (!family) continue;
    const relevant = events.filter((event) => event.item_id === item.id);
    const deltas = relevant
      .filter((event) => event.type === `response.${family}.delta`)
      .map((event) => event.delta)
      .join('');
    const expected =
      item.type === 'custom_tool_call'
        ? item.input
        : item.type === 'function_call'
          ? item.arguments
          : item.content.map((part) => part.text ?? '').join('');
    assert.equal(deltas, expected, `${family} deltas must equal the completed item`);
    assert.equal(
      relevant.filter((event) => event.type === `response.${family}.done`).length,
      1,
      `${family} must have exactly one done event`,
    );
  }
  assert.deepEqual(
    events.filter((event) => event.type === 'response.output_item.done').map((event) => event.item),
    output,
  );
}

function parseChat(raw, stream) {
  if (!stream) return JSON.parse(raw).choices?.[0]?.message;
  assert.match(raw, /data: \[DONE\]/);
  const events = parseSse(raw);
  assert.equal(events.filter((event) => event.error).length, 0);
  const choices = events.flatMap((event) => event.choices ?? []);
  assert.equal(choices.filter((choice) => choice.finish_reason != null).length, 1);
  const calls = new Map();
  let content = '';
  for (const { delta } of choices) {
    content += delta?.content ?? '';
    for (const call of delta?.tool_calls ?? []) {
      const current = calls.get(call.index) ?? {
        type: 'function',
        id: '',
        function: { name: '', arguments: '' },
      };
      if (call.id) current.id = call.id;
      current.function.name += call.function?.name ?? '';
      current.function.arguments += call.function?.arguments ?? '';
      calls.set(call.index, current);
    }
  }
  return { role: 'assistant', content: content || null, tool_calls: [...calls.values()] };
}

async function request(protocol, body, trace) {
  const requestId = `${trace.id}-${trace.requests.length + 1}`;
  const record = {
    requestId,
    requestedEffort: body.reasoning?.effort ?? body.reasoning_effort ?? null,
    stream: body.stream,
  };
  trace.requests.push(record);
  const { status, raw } = await postJson(
    protocol === 'responses' ? RESPONSES_PATH : '/openai/v1/chat/completions',
    { ...responsesHeaders(), 'x-request-id': requestId },
    { model: GPT_MODEL, ...body },
  );
  record.httpStatus = status;
  record.responseBytes = Buffer.byteLength(raw);
  assert.equal(status, 200, `HTTP ${status}: ${raw.slice(0, 500)}`);
  if (protocol !== 'responses') return parseChat(raw, body.stream);
  const events = body.stream ? parseSse(raw) : [];
  if (body.stream) assert.deepEqual(checkResponsesInvariants(events), []);
  const response = body.stream
    ? events.find((event) => event.type === 'response.completed')?.response
    : JSON.parse(raw);
  assert.equal(response?.status, 'completed');
  if (body.stream) validateResponseDeltas(events, response.output);
  return response;
}

function toolSetup(protocol, kind, prompt) {
  const description =
    'Retrieve the hidden result for the ticket given by the user. After the result arrives, ' +
    'follow the user instructions without calling this tool again.';
  if (protocol === 'chat') {
    return {
      tools: [{ type: 'function', function: { name: 'lookup', description, parameters: schema } }],
      messages: [{ role: 'user', content: prompt }],
    };
  }
  if (kind === 'custom') {
    return {
      input: [
        {
          type: 'additional_tools',
          tools: [
            {
              type: 'namespace',
              name: 'functions',
              tools: [
                {
                  type: 'custom',
                  name: 'lookup',
                  description: `${description} Input is exactly the raw ticket string, not JSON.`,
                },
              ],
            },
          ],
        },
        { role: 'user', content: prompt },
      ],
    };
  }
  return {
    tools: [{ type: 'function', name: 'lookup', description, parameters: schema }],
    input: [{ role: 'user', content: prompt }],
  };
}

function outputText(protocol, response) {
  return protocol === 'responses'
    ? response.output
        .filter((item) => item.type === 'message')
        .flatMap((item) => item.content)
        .map((part) => part.text ?? '')
        .join('')
    : response.content ?? '';
}

async function roundTrip({ protocol, kind, stream, effort, image }, trace) {
  const ticket = `TICKET-${randomBytes(4).toString('hex')}`;
  const marker = `RESULT-${randomBytes(10).toString('hex')}`;
  const prompt = image
    ? `Call lookup exactly once for ticket ${ticket}. Then visually inspect the returned image. ` +
      'Return only a JSON object containing marker (the exact large code) and shapes ' +
      '(the three colored shapes from left to right). If the image is unavailable say IMAGE_UNAVAILABLE.'
    : `Call lookup exactly once for ticket ${ticket}. You cannot know the result yet. ` +
      'After receiving the tool result, output ONLY its result field verbatim, with no quotes or prose.';
  const common = { stream, ...effortFields(protocol, effort) };
  const setup = toolSetup(protocol, kind, prompt);
  const first = await request(protocol, { ...common, ...setup }, trace);
  const calls =
    protocol === 'responses'
      ? first.output.filter((item) => item.type === `${kind === 'custom' ? 'custom_tool' : 'function'}_call`)
      : first.tool_calls ?? [];
  assert.equal(calls.length, 1, 'Must receive exactly one executable tool call');
  const call = calls[0];
  const name = protocol === 'responses' ? call.name : call.function.name;
  const input =
    kind === 'custom'
      ? call.input
      : JSON.parse(protocol === 'responses' ? call.arguments : call.function.arguments).ticket;
  assert.equal(name, 'lookup');
  assert.equal(input, ticket, 'Tool input must preserve the exact ticket');
  trace.toolType = call.type;
  const result = image
    ? [{ type: 'input_text', text: 'The requested image:' }, image.part]
    : [{ type: 'input_text', text: JSON.stringify({ result: marker }) }];
  const secondSetup =
    protocol === 'responses'
      ? {
          ...setup,
          input: [
            ...setup.input,
            ...first.output,
            {
              type: kind === 'custom' ? 'custom_tool_call_output' : 'function_call_output',
              call_id: call.call_id,
              output: result,
            },
          ],
        }
      : {
          ...setup,
          messages: [
            ...setup.messages,
            first,
            { role: 'tool', tool_call_id: call.id, content: result[0].text },
          ],
        };
  const second = await request(protocol, { ...common, ...secondSetup, tool_choice: 'none' }, trace);
  const text = outputText(protocol, second).trim();
  trace.actual = text;
  trace.expected = image ? image.expected : marker;
  if (image) assert.deepEqual(JSON.parse(text), image.expected);
  else assert.equal(text, marker, 'Final answer must exactly match the result absent from the first request');
}

async function directImage({ protocol, stream, effort, image }, trace) {
  const prompt =
    'Visually inspect this image. Return only JSON with marker (the exact large code) and ' +
    'shapes (the three colored shapes from left to right).';
  const setup =
    protocol === 'responses'
      ? { input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }, image.part] }] }
      : {
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: image.part.image_url } },
              ],
            },
          ],
        };
  const response = await request(protocol, { stream, ...effortFields(protocol, effort), ...setup }, trace);
  trace.actual = outputText(protocol, response).trim();
  trace.expected = image.expected;
  assert.deepEqual(JSON.parse(trace.actual), image.expected);
}

const cases = [];
if (process.env.K2C_SKIP_TOOLS !== '1') {
  for (const effort of efforts) {
    for (const protocol of ['responses', 'chat']) {
      for (const kind of protocol === 'responses' ? ['function', 'custom'] : ['function']) {
        for (const stream of [false, true]) cases.push({ protocol, kind, stream, effort });
      }
    }
  }
}
if (imagePath && imageExpected) {
  const image = {
    part: { type: 'input_image', image_url: `data:image/png;base64,${readFileSync(imagePath).toString('base64')}` },
    expected: JSON.parse(readFileSync(imageExpected, 'utf8')),
  };
  for (const effort of ['low', 'max']) {
    for (const stream of [false, true]) {
      for (const protocol of ['responses', 'chat']) {
        cases.push({ protocol, kind: 'direct-image', stream, effort, image });
      }
      for (const kind of ['function', 'custom']) {
        cases.push({ protocol: 'responses', kind, stream, effort, image });
      }
    }
  }
}

let next = 0;
assert.ok(cases.length > 0, 'No cases selected');
async function worker() {
  while (next < cases.length) {
    const specification = cases[next++];
    const { protocol, kind, stream, effort, image } = specification;
    const trace = {
      id: `gpt-matrix-${randomBytes(5).toString('hex')}`,
      protocol,
      kind,
      stream,
      effort,
      expectedGatewayEffort: effort === 'minimal' ? 'low' : ['default', 'none'].includes(effort) ? null : effort,
      image: Boolean(image),
      requests: [],
      started: new Date().toISOString(),
    };
    const started = Date.now();
    try {
      await (kind === 'direct-image' ? directImage : roundTrip)(specification, trace);
      trace.ok = true;
    } catch (error) {
      trace.ok = false;
      trace.error = String(error);
    }
    trace.durationMs = Date.now() - started;
    results.push(trace);
    if (reportPath) writeFileSync(reportPath, `${JSON.stringify(results, null, 2)}\n`);
    console.log(JSON.stringify(trace));
  }
}
await Promise.all(Array.from({ length: concurrency }, () => worker()));
const failures = results.filter((result) => !result.ok);
console.log(JSON.stringify({ cases: results.length, passed: results.length - failures.length, failed: failures.length }));
process.exitCode = failures.length ? 1 : 0;
