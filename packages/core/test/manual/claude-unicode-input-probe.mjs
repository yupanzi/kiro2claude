/**
 * Reproduce Unicode tool-argument normalization in an actual Claude Code CLI.
 * A local deterministic Anthropic-shaped server emits equivalent JSON tool
 * arguments using several encodings/chunk boundaries. No model/provider call.
 */
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import assert from 'node:assert/strict';

const image = process.env.K2C_CLAUDE_IMAGE ?? 'kiro2claude-cc:validation-latest';
const model = process.env.K2C_UNICODE_MODEL ?? 'claude-opus-5';
const modes = (process.env.K2C_UNICODE_MODES ?? 'whole-delta,chunks-7,char-deltas,unicode-backslash,start-input').split(',');
const report = resolve(process.env.K2C_UNICODE_REPORT_DIR ?? `test-results/conversation-fixes-2026-09-07/claude-unicode-${Date.now()}`);
const timeout = Number(process.env.K2C_UNICODE_TIMEOUT_MS ?? 120_000);
const source = String.raw`export const cases = {
  nul: '\u0000',
  newline: '\u000a',
  accented: '\u00e9',
  combining: 'e\u0301',
  surrogatePair: '\uD83D\uDE00',
  codePoint: '\u{1f600}',
  escapedBackslash: '\\u000a',
  normalEscape: '\n',
  ordinary: 'unchanged',
  actualUnicode: 'é😀',
};
`;
const bashCommand = String.raw`printf '%s\n' '\u0000' > /workspace/bash-result.txt`;
const sha = value => createHash('sha256').update(value).digest('hex');
const info = value => value === undefined ? null : { bytes: Buffer.byteLength(value), sha256: sha(value) };
const parseJsonl = text => text.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
function streamedToolInputs(entries) {
  const out = new Map(), active = new Map();
  for (const entry of entries) {
    const event = entry.type === 'stream_event' ? entry.event : undefined;
    if (event?.type === 'message_start') active.clear();
    if (event?.type === 'content_block_start' && event.content_block?.type === 'tool_use') active.set(event.index, { id: event.content_block.id, initial: event.content_block.input, chunks: [] });
    if (event?.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') active.get(event.index)?.chunks.push(event.delta.partial_json);
    if (event?.type === 'content_block_stop' && active.has(event.index)) {
      const block = active.get(event.index);
      try { out.set(block.id, block.chunks.length ? JSON.parse(block.chunks.join('')) : block.initial); } catch { out.set(block.id, undefined); }
    }
  }
  return out;
}
if ((await readdir(report).catch(() => [])).length) throw new Error(`Report directory is not empty; choose a fresh K2C_UNICODE_REPORT_DIR to preserve evidence: ${report}`);
await mkdir(report, { recursive: true });
const version = execFileSync('docker', ['run', '--rm', '--entrypoint', 'cat', image, '/etc/cc-version'], { encoding: 'utf8' }).trim();
const imageId = execFileSync('docker', ['image', 'inspect', image, '--format', '{{.Id}}'], { encoding: 'utf8' }).trim();

async function command(args, { onTimeout, limit = timeout } = {}) {
  const started = Date.now(), child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', timedOut = false;
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const timer = setTimeout(() => { timedOut = true; onTimeout?.(); child.kill('SIGTERM'); }, limit);
  const exitCode = await new Promise((accept, reject) => { child.once('error', reject); child.once('close', accept); });
  clearTimeout(timer);
  return { exitCode, timedOut, durationMs: Date.now() - started, stdout, stderr };
}

const runs = new Map();
const blocks = request => (request.messages ?? []).flatMap(message => Array.isArray(message.content) ? message.content : []);
function toolPlan(run) {
  return [
    { id: `toolu_${run.id}_write`, name: 'Write', input: { file_path: '/workspace/result.mjs', content: source } },
    { id: `toolu_${run.id}_read`, name: 'Read', input: { file_path: '/workspace/edit.txt' } },
    { id: `toolu_${run.id}_edit`, name: 'Edit', input: { file_path: '/workspace/edit.txt', old_string: 'EDIT_MARKER', new_string: String.raw`\u000a` } },
    { id: `toolu_${run.id}_bash`, name: 'Bash', input: { command: bashCommand, description: 'Write a literal Unicode escape into an isolated probe file' } },
  ];
}

function responseEvents(run, request, requestId) {
  const all = blocks(request), completed = new Set(all.filter(block => block.type === 'tool_result').map(block => block.tool_use_id));
  const latestPlainUser = (request.messages ?? []).findLast(message => message.role === 'user' && typeof message.content === 'string');
  const followup = latestPlainUser?.content.includes('UNICODE_PHASE:followup');
  const tool = followup ? undefined : toolPlan(run).find(tool => !completed.has(tool.id));
  const events = [{ type: 'message_start', message: { id: `msg_${run.id}_${requestId}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } }];
  if (tool) {
    let json = JSON.stringify(tool.input);
    if (run.mode === 'unicode-backslash') json = json.replaceAll('\\\\', '\\u005c');
    assert.deepEqual(JSON.parse(json), tool.input, 'Every tested encoding must preserve the exact semantic tool input.');
    const parts = run.mode === 'char-deltas' ? [...json] : run.mode === 'chunks-7' ? json.match(/.{1,7}/gs) : [json];
    events.push({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: tool.id, name: tool.name, input: run.mode === 'start-input' ? tool.input : {} } });
    if (run.mode !== 'start-input') for (const partial_json of parts) events.push({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json } });
    events.push({ type: 'content_block_stop', index: 0 });
    run.sentTools.push({ requestId, tool, serializedInput: json, chunks: run.mode === 'start-input' ? [] : parts });
  } else {
    events.push({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `UNICODE_PROBE_FINISHED phase=${followup ? 'followup' : 'build'} observed_tool_results=${completed.size}. This is a synthetic transport probe; individual results may be errors.` } },
      { type: 'content_block_stop', index: 0 });
  }
  events.push({ type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 100 } }, { type: 'message_stop' });
  return events;
}

const server = createServer(async (request, response) => {
  try {
    const id = request.url?.split('/')[2], run = runs.get(id);
    if (!run || request.method !== 'POST' || !request.url.includes('/messages')) { response.writeHead(404).end('unknown probe'); return; }
    let raw = ''; for await (const chunk of request) raw += chunk;
    const parsed = JSON.parse(raw), record = { id: run.requests.length + 1, url: request.url, request: parsed };
    run.requests.push(record);
    if (request.url.includes('count_tokens')) { response.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":100}'); return; }
    const main = parsed.tools?.some(tool => tool.name === 'Bash');
    record.main = main;
    const events = main ? responseEvents(run, parsed, record.id) : [
      { type: 'message_start', message: { id: `msg_title_${record.id}`, type: 'message', role: 'assistant', model: 'claude-opus-5', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Unicode probe' } },
      { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } }, { type: 'message_stop' },
    ];
    record.responseEvents = events;
    record.responseBody = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    for (const event of events) {
      response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      if (run.mode === 'char-deltas' && event.type === 'content_block_delta') await new Promise(accept => setTimeout(accept, 1));
    }
    response.end();
  } catch (error) { response.writeHead(500).end(String(error)); }
});
await new Promise(accept => server.listen(0, '0.0.0.0', accept));
const port = server.address().port;

async function findTranscript(directory, sessionId) {
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) { const found = await findTranscript(path, sessionId); if (found) return found; }
    else if (entry.name === `${sessionId}.jsonl`) return path;
  }
}

const summaries = [];
try {
  for (const mode of modes) {
    const id = randomUUID().slice(0, 8), sessionId = randomUUID(), dir = join(report, mode), workspace = join(dir, 'workspace');
    const run = { id, mode, sessionId, requests: [], sentTools: [] }, container = `k2c-unicode-${id}`;
    runs.set(id, run); await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, 'edit.txt'), 'EDIT_MARKER');
    await writeFile(join(dir, 'expected-result.mjs'), source);
    const created = await command(['run', '-d', '--rm', '--name', container, '--workdir', '/workspace',
      '--mount', `type=bind,source=${workspace},target=/workspace`,
      '-e', `ANTHROPIC_BASE_URL=http://host.docker.internal:${port}/run/${id}/claude`,
      '-e', 'ANTHROPIC_AUTH_TOKEN=local-unicode-probe', '-e', 'ANTHROPIC_API_KEY=local-unicode-probe',
      '-e', 'DISABLE_NONESSENTIAL_TRAFFIC=1', '-e', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY=1', '--entrypoint', 'sleep', image, 'infinity']);
    if (created.exitCode !== 0) throw new Error(created.stderr);
    const rounds = [];
    try {
      for (const phase of ['build', 'followup']) {
        const prompt = `UNICODE_PHASE:${phase}. This is an authorized local Unicode transport test. Use the requested real Write, Read, Edit and Bash tools in the isolated /workspace. Inspect actual results without assuming success. Preserve literal backslash Unicode sequences exactly. ${phase === 'followup' ? 'Continue this same session and report that the prior tool results are available.' : 'Perform the probe actions and report observed results.'}`;
        const cli = await command(['exec', container, '/home/claude/entrypoint.sh', '-p', prompt, '--model', model, '--effort', 'high', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--max-turns', '10', '--tools', 'Read,Write,Edit,Bash', '--dangerously-skip-permissions', '--debug-file', `/home/claude/.claude/unicode-${phase}.log`, ...(phase === 'build' ? ['--session-id', sessionId] : ['--resume', sessionId])], { onTimeout: () => spawn('docker', ['exec', container, 'pkill', '-TERM', '-f', '^claude'], { stdio: 'ignore' }) });
        await writeFile(join(dir, `${phase}.jsonl`), cli.stdout); await writeFile(join(dir, `${phase}.stderr`), cli.stderr);
        const terminal = parseJsonl(cli.stdout).findLast(event => event.type === 'result');
        rounds.push({ phase, exitCode: cli.exitCode, timedOut: cli.timedOut, durationMs: cli.durationMs, sessionId: terminal?.session_id, isError: terminal?.is_error });
        if (cli.timedOut) break;
      }
      const syntax = await command(['exec', container, 'node', '--check', '/workspace/result.mjs']);
      await writeFile(join(dir, 'syntax-check.json'), JSON.stringify(syntax, null, 2));
      await command(['cp', `${container}:/home/claude/.claude`, join(dir, 'claude-state')]);
      const transcript = await findTranscript(join(dir, 'claude-state'), sessionId), entries = transcript ? parseJsonl(await readFile(transcript, 'utf8')) : [];
      const cliStreamInputs = streamedToolInputs(parseJsonl(await readFile(join(dir, 'build.jsonl'), 'utf8')));
      const uses = entries.flatMap(entry => Array.isArray(entry.message?.content) ? entry.message.content.filter(block => block.type === 'tool_use') : []);
      const results = entries.flatMap(entry => Array.isArray(entry.message?.content) ? entry.message.content.filter(block => block.type === 'tool_result') : []);
      const comparisons = run.sentTools.map(({ requestId, tool, chunks, serializedInput }) => {
        const actual = uses.find(use => use.id === tool.id), receipt = results.find(result => result.tool_use_id === tool.id);
        const later = run.requests.filter(request => request.main && request.id > requestId);
        const compareInput = input => tool.name === 'Edit' ? { ...input, replace_all: input?.replace_all ?? false } : input;
        return { requestId, id: tool.id, name: tool.name, deltaCount: chunks.length, inputJsonParsesExactly: isDeepStrictEqual(JSON.parse(serializedInput), tool.input), cliStreamJsonParsesExactly: isDeepStrictEqual(cliStreamInputs.get(tool.id), tool.input), canonicalMatches: actual ? isDeepStrictEqual(compareInput(actual.input), compareInput(tool.input)) : false, expected: tool.input, actual: actual?.input, actualResult: receipt, subsequentReplay: later.map(request => { const use = blocks(request.request).find(block => block.type === 'tool_use' && block.id === tool.id); return { requestId: request.id, present: !!use, sameAsCanonical: use && isDeepStrictEqual(use.input, actual?.input) }; }) };
      });
      const actualSource = await readFile(join(workspace, 'result.mjs'), 'utf8').catch(() => undefined), actualEdit = await readFile(join(workspace, 'edit.txt'), 'utf8').catch(() => undefined), actualBash = await readFile(join(workspace, 'bash-result.txt'), 'utf8').catch(() => undefined);
      const summary = { mode, version, model, imageId, sessionId, rounds, mainRequests: run.requests.filter(request => request.main).length, toolComparisons: comparisons, fileChecks: { write: { passed: actualSource === source, expected: info(source), actual: info(actualSource), syntaxExitCode: syntax.exitCode }, edit: { passed: actualEdit === String.raw`\u000a`, expected: info(String.raw`\u000a`), actual: info(actualEdit) }, bash: { passed: actualBash === `${String.raw`\u0000`}\n`, expected: info(`${String.raw`\u0000`}\n`), actual: info(actualBash) } }, transcript, scope: mode === 'start-input' ? 'Exploratory content_block_start input object; no production recommendation inferred from acceptance by this CLI.' : 'Standard input_json_delta encodings parse to identical original tool inputs. No provider or model was called.' };
      await writeFile(join(dir, 'result.json'), JSON.stringify(summary, null, 2));
      summaries.push(summary);
      console.log(JSON.stringify({ mode, rounds, mainRequests: summary.mainRequests, canonicalMatches: comparisons.map(item => ({ name: item.name, matches: item.canonicalMatches })), files: summary.fileChecks }));
    } finally {
      await writeFile(join(dir, 'wire.json'), JSON.stringify(run, null, 2));
      await command(['rm', '-f', container]);
    }
  }
} finally {
  await new Promise(accept => server.close(accept));
  await writeFile(join(report, 'results.json'), JSON.stringify({ version, model, imageId, port, scenarios: summaries }, null, 2));
}
