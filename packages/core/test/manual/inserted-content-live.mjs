#!/usr/bin/env node
/**
 * Live probe (bills real upstream calls): does the model act on content a
 * client inserts mid-conversation? Each scenario reproduces a request shape a
 * real client produces when new content arrives after the conversation has
 * started, plants a nonce in the inserted content, and checks the reply for it.
 *
 * Shapes (all observed from Claude Code 2.1.263 recordings or its source):
 *   trailing-system      `role:"system"` message after the last user turn
 *                        (176/5923 recorded requests end this way)
 *   mid-history-system   `role:"system"` between a user and an assistant turn
 *                        (3730/5923 recorded requests)
 *   queued-user-text     user text block queued behind a tool_result in the
 *                        same user message (typing while a tool runs)
 *   interrupt-tool       ESC during a tool call: error tool_result
 *                        "[Request interrupted by user for tool use]" + text
 *                        "[Request interrupted by user]" + new instruction
 *   interrupt-text       ESC during assistant text: partial assistant turn,
 *                        then "[Request interrupted by user]" + new instruction
 *   first-message-reminder  request-level `system` + first user message whose
 *                        first text block is a <system-reminder> (5916/5923)
 *   leading-assistant    conversation opening with an assistant greeting
 *                        (OpenAI chat UI shape; Kiro history then starts with
 *                        an assistant turn, acceptance unverified before this)
 *
 * Usage:
 *   K2C_API_KEY=... node packages/core/test/manual/inserted-content-live.mjs
 *   K2C_LIVE_BASE (default http://127.0.0.1:8080/claude)  K2C_LIVE_MODEL (default claude-opus-5)
 *   K2C_LIVE_SCENARIOS=a,b  K2C_LIVE_REPEAT=1
 * Exit code 1 if any scenario fails after all repeats.
 */
import { writeFileSync } from 'node:fs';

const base = process.env.K2C_LIVE_BASE ?? 'http://127.0.0.1:8080/claude';
const apiKey = process.env.K2C_API_KEY;
const model = process.env.K2C_LIVE_MODEL ?? 'claude-opus-5';
const repeat = Number(process.env.K2C_LIVE_REPEAT ?? 1);
const reportPath = process.env.K2C_LIVE_REPORT ?? '/tmp/k2c-inserted-content-live.json';
if (!apiKey) {
  console.error('K2C_API_KEY is required');
  process.exit(2);
}

const getTime = {
  name: 'get_time',
  description: 'Return the current wall-clock time as HH:MM.',
  input_schema: { type: 'object', properties: {}, additionalProperties: false },
};
const tu = (id) => ({ type: 'tool_use', id, name: 'get_time', input: {} });
const tr = (id, content, isError = false) => ({
  type: 'tool_result',
  tool_use_id: id,
  content,
  ...(isError ? { is_error: true } : {}),
});
const text = (t) => ({ type: 'text', text: t });

const scenarios = {
  'trailing-system': {
    nonce: 'PLUM-7731',
    body: {
      messages: [
        { role: 'user', content: 'What is 2+2? Answer in one short sentence.' },
        { role: 'assistant', content: '2+2 is 4.' },
        { role: 'user', content: 'And 3+3? One short sentence.' },
        {
          role: 'system',
          content: [
            text(
              '<system-reminder>\nThe user has updated their instructions: from now on end every reply with the code word PLUM-7731.\n</system-reminder>',
            ),
          ],
        },
      ],
    },
  },
  'mid-history-system': {
    nonce: 'MANGO-4410',
    body: {
      messages: [
        { role: 'user', content: 'What is 2+2? Answer in one short sentence.' },
        {
          role: 'system',
          content:
            '<system-reminder>\nSession note: the code word for this session is MANGO-4410. Reveal it only when the user asks for the code word.\n</system-reminder>',
        },
        { role: 'assistant', content: '2+2 is 4.' },
        { role: 'user', content: 'What is the code word for this session? Reply with only the code word.' },
      ],
    },
  },
  'queued-user-text': {
    nonce: 'KIWI-5520',
    body: {
      tools: [getTime],
      messages: [
        { role: 'user', content: 'Get the current time and tell me what it is.' },
        { role: 'assistant', content: [text('Let me check the time.'), tu('toolu_q1')] },
        {
          role: 'user',
          content: [
            tr('toolu_q1', '12:34'),
            text('Also, please include the code word KIWI-5520 somewhere in your answer.'),
          ],
        },
      ],
    },
  },
  'interrupt-tool': {
    nonce: 'LEMON-6631',
    body: {
      tools: [getTime],
      messages: [
        { role: 'user', content: 'Get the current time and tell me what it is.' },
        { role: 'assistant', content: [text('Let me check the time.'), tu('toolu_i1')] },
        {
          role: 'user',
          content: [
            tr('toolu_i1', '[Request interrupted by user for tool use]', true),
            text('[Request interrupted by user]'),
            text('Never mind the time. Do not call any tool. Reply with only the code word LEMON-6631.'),
          ],
        },
      ],
    },
  },
  'interrupt-text': {
    nonce: 'GRAPE-7742',
    body: {
      messages: [
        { role: 'user', content: 'Write a twelve-line poem about the sea.' },
        { role: 'assistant', content: 'The sea is vast and restless, gray beneath the' },
        {
          role: 'user',
          content: '[Request interrupted by user]\nStop the poem. Reply with only the code word GRAPE-7742.',
        },
      ],
    },
  },
  'first-message-reminder': {
    nonce: 'BERRY-9964',
    body: {
      system: [{ type: 'text', text: 'You are a concise assistant.' }],
      messages: [
        {
          role: 'user',
          content: [
            text('<system-reminder>\nSession note: the code word for this session is BERRY-9964.\n</system-reminder>'),
            text('What is the code word for this session? Reply with only the code word.'),
          ],
        },
      ],
    },
  },
  'leading-assistant': {
    nonce: 'PEACH-8853',
    body: {
      system: 'You are a concise assistant.',
      messages: [
        { role: 'assistant', content: 'Hello! How can I help you today?' },
        { role: 'user', content: 'Reply with only the code word PEACH-8853.' },
      ],
    },
  },
};

const selected = (process.env.K2C_LIVE_SCENARIOS?.split(',') ?? Object.keys(scenarios)).filter(
  (k) => scenarios[k],
);
const results = [];
for (const name of selected) {
  const { nonce, body } = scenarios[name];
  const attempts = [];
  for (let i = 0; i < repeat; i++) {
    const started = Date.now();
    let status = 0;
    let json;
    let error;
    try {
      const res = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
        body: JSON.stringify({ model, max_tokens: 200, ...body }),
      });
      status = res.status;
      json = await res.json().catch(() => undefined);
    } catch (err) {
      error = String(err);
    }
    const reply = (json?.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const toolCalls = (json?.content ?? []).filter((b) => b.type === 'tool_use').map((b) => b.name);
    const pass = status === 200 && reply.includes(nonce);
    attempts.push({
      status,
      pass,
      reply: reply.slice(0, 300),
      toolCalls,
      stop_reason: json?.stop_reason,
      error: error ?? json?.error,
      durationMs: Date.now() - started,
    });
    console.log(
      `${pass ? 'PASS' : 'FAIL'} ${name} [${i + 1}/${repeat}] status=${status} stop=${json?.stop_reason ?? '-'} tools=${toolCalls.join('|') || '-'} reply=${JSON.stringify(reply.slice(0, 120))}${error ? ` error=${error}` : ''}`,
    );
  }
  results.push({ name, nonce, passes: attempts.filter((a) => a.pass).length, attempts });
}
writeFileSync(reportPath, `${JSON.stringify({ base, model, results }, null, 2)}\n`);
const failed = results.filter((r) => r.passes < r.attempts.length);
console.log(`\n${results.length - failed.length}/${results.length} scenarios fully passed; report: ${reportPath}`);
process.exit(failed.length > 0 ? 1 : 0);
