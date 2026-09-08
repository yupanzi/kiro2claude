/**
 * Run the real Claude Code CLI through three turns in one persisted session.
 * Only the local synthetic Kiro provider is contacted. All tools execute in an
 * isolated Docker workspace. A completed reply alone is not an integrity pass:
 * preserve CLI events, saved history, every request, and independently inspect
 * the files and non-idempotent execution ledger.
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile, readdir, rename, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { prepareWorkspace, verifyWorkspace } from './_conversation-workspace.mjs';

const base = process.env.K2C_PROBE_BASE ?? 'http://127.0.0.1:18941';
const dockerBase = process.env.K2C_PROBE_DOCKER_BASE ?? 'http://host.docker.internal:18941';
const image = process.env.K2C_CLAUDE_IMAGE ?? 'kiro2claude-cc:validation-latest';
const reportDir = resolve(process.env.K2C_PROBE_REPORT_DIR ?? 'test-results/conversation-integrity-2026-09-07');
const scenarios = (process.env.K2C_PROBE_SCENARIOS ?? 'baseline,mixed,tool-error,thinking-error,partial-tool,text-error,text-eof,tool-then-partial,text-eof-once,thinking-eof-once').split(',');
const timeoutMs = Number(process.env.K2C_PROBE_TIMEOUT_MS ?? 240_000);
const results = [];
await mkdir(reportDir, { recursive: true });
const version = execFileSync('docker', ['run', '--rm', '--entrypoint', 'cat', image, '/etc/cc-version'], { encoding: 'utf8' }).trim();
const imageId = execFileSync('docker', ['image', 'inspect', image, '--format', '{{.Id}}'], { encoding: 'utf8' }).trim();

async function command(args, onTimeout, limit = timeoutMs) {
  const start = Date.now();
  const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', timedOut = false;
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const timer = setTimeout(() => {
    timedOut = true;
    onTimeout?.();
    child.kill('SIGTERM');
  }, limit);
  const exitCode = await new Promise((accept, reject) => {
    child.once('error', reject);
    child.once('close', accept);
  });
  clearTimeout(timer);
  return { exitCode, timedOut, stdout, stderr, durationMs: Date.now() - start };
}

function parseJsonl(content) {
  return content.split('\n').flatMap(line => {
    if (!line.trim()) return [];
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

async function jsonFiles(dir) {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await jsonFiles(path));
    else if (entry.name.endsWith('.jsonl')) result.push({ path, entries: parseJsonl(await readFile(path, 'utf8')) });
  }
  return result;
}

function historyAudit(files, sessionId) {
  // Prefer the session's canonical transcript. Subagent and debug logs are
  // retained as artifacts but must not multiply the observed tool counts.
  const main = files.find(file => file.path.endsWith(`/${sessionId}.jsonl`));
  const entries = main?.entries ?? [];
  const toolUses = [];
  const toolResults = [];
  for (const entry of entries) {
    for (const block of Array.isArray(entry.message?.content) ? entry.message.content : []) {
      if (block.type === 'tool_use') toolUses.push({ id: block.id, name: block.name, input: block.input, uuid: entry.uuid });
      if (block.type === 'tool_result') toolResults.push({ id: block.tool_use_id, isError: block.is_error, content: block.content, uuid: entry.uuid });
    }
  }
  const useIds = new Set(toolUses.map(tool => tool.id));
  const resultIds = new Set(toolResults.map(tool => tool.id));
  return {
    transcriptPath: main?.path,
    transcriptEntries: entries.length,
    toolUses,
    toolResults,
    toolUsesWithoutResults: toolUses.filter(tool => !resultIds.has(tool.id)),
    toolResultsWithoutUses: toolResults.filter(tool => !useIds.has(tool.id)),
    phaseMarkers: ['build', 'extend', 'audit'].map(phase => ({ phase, present: JSON.stringify(entries).includes(`LONG_PHASE:${phase}`) })),
  };
}

function deliveryAudit(wire, historyText, cliText) {
  return (wire.faults ?? []).map(fault => {
    const record = wire.requests.find(request => request.id === fault.request);
    const later = wire.requests.filter(request => request.id > fault.request);
    const marker = fault.intentionalInjection ? fault.triggerEvent?.toolUseId
      : fault.kind === 'thinking-error' ? `THOUGHT_FRAGMENT_${fault.step}`
      : fault.kind === 'thinking-eof-once' ? `THOUGHT_EOF_${fault.step}`
      : fault.kind === 'crc-error' ? `CRC_PREFIX_${fault.step}`
      : fault.kind === 'text-error' ? `UNVERIFIED_CLAIM_${fault.step}`
        : fault.kind.startsWith('text-eof') ? `PARTIAL_ANSWER_${fault.step}`
          : ['partial-tool', 'tool-then-partial'].includes(fault.kind) ? 'DRAFT_PARAMETER_'
            : fault.kind === 'tool-error' ? `fault_${fault.step}_${fault.request}` : undefined;
    const response = record.response?.body ?? '';
    const contains = value => Boolean(marker && JSON.stringify(value ?? '').includes(marker));
    return {
      ...fault, marker, responseStatus: record.response?.status,
      responseHasErrorEvent: /event: error\n/.test(response),
      responseStopReasons: [...response.matchAll(/"stop_reason":"([^"]+)"/g)].map(match => match[1]),
      inUpstreamFrames: marker ? record.upstreamRequests.some(attempt => (attempt.frameBase64 ?? attempt.originalFrameBase64 ?? []).some(frame => Buffer.from(frame, 'base64').toString('utf8').includes(marker))) : undefined,
      inDownstreamResponse: marker ? response.includes(marker) : undefined,
      inCliOutput: marker ? cliText.includes(marker) : undefined,
      inPersistedTranscript: marker ? historyText.includes(marker) : undefined,
      inNextClientHistory: marker ? contains(later[0]?.request) : undefined,
      inNextKiroHistory: marker ? contains(later[0]?.upstreamRequests.map(attempt => attempt.request)) : undefined,
      laterClientRequestsContainingMarker: marker ? later.filter(request => contains(request.request)).map(request => request.id) : [],
      laterKiroRequestsContainingMarker: marker ? later.filter(request => contains(request.upstreamRequests.map(attempt => attempt.request))).map(request => request.id) : [],
      laterPhasesContainingMarker: marker ? [...new Set(later.filter(request => contains(request.request)).map(request => request.phase))] : [],
      nextClientHasRecoveryNotice: JSON.stringify(later[0]?.request ?? '').includes('Your response above was cut off mid-stream'),
      transcriptMessageStopReasons: marker ? [...new Set(parseJsonl(historyText).filter(entry => contains(entry.message)).map(entry => entry.message?.stop_reason).filter(Boolean))] : [],
      nextObservedReceipts: later[0]?.observed,
    };
  });
}

function receiptContinuityAudit(wire, expectedProofs, secret) {
  const resultTexts = (value, output = []) => {
    if (Array.isArray(value)) for (const item of value) resultTexts(item, output);
    else if (value && typeof value === 'object') {
      if (value.type === 'tool_result') output.push(JSON.stringify(value.content));
      for (const [key, item] of Object.entries(value)) {
        if (key === 'toolResults') output.push(JSON.stringify(item));
        else if (key !== 'content' || value.type !== 'tool_result') resultTexts(item, output);
      }
    }
    return output;
  };
  const observed = new Set(), violations = [], requests = [];
  let secretSeen = false;
  for (const record of wire.requests) {
    const client = resultTexts(record.request).join('\n');
    const kiro = resultTexts(record.upstreamRequests.map(attempt => attempt.request)).join('\n');
    for (const [step, proof] of Object.entries(expectedProofs)) if (client.includes(proof)) observed.add(step);
    if (client.includes(secret)) secretSeen = true;
    for (const step of observed) {
      const proof = expectedProofs[step];
      if (!client.includes(proof)) violations.push({ request: record.id, step, layer: 'client' });
      if (!kiro.includes(proof)) violations.push({ request: record.id, step, layer: 'kiro' });
    }
    if (secretSeen && !client.includes(secret)) violations.push({ request: record.id, layer: 'client', field: 'step1.secret' });
    if (secretSeen && !kiro.includes(secret)) violations.push({ request: record.id, layer: 'kiro', field: 'step1.secret' });
    requests.push({ request: record.id, phase: record.phase, checkedStepProofs: [...observed].map(Number), secretSeen });
  }
  return { passed: violations.length === 0, observedStepProofs: [...observed].map(Number), violations, requests,
    scope: 'Check input-derived exact stage proof hashes and original random secret inside tool_result/toolResults fields in every later client and Kiro request after first receipt. Does not assert preservation of unrelated arbitrary message bytes.' };
}

async function run(scenario) {
  const runId = `claude-${scenario}-${randomUUID().slice(0, 8)}`;
  const sessionId = randomUUID();
  const dir = join(reportDir, `claude-${scenario}`);
  const workspace = join(dir, 'workspace');
  const container = `k2c-long-${runId}`;
  if (await access(dir).then(() => true, () => false)) {
    await rename(dir, `${dir}-previous-${Date.now()}`);
  }
  await mkdir(dir, { recursive: true });
  const prepared = await prepareWorkspace(workspace, runId);
  const registered = await fetch(`${base}/probe/runs`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: runId, protocol: 'claude', scenario }),
  });
  if (!registered.ok) throw new Error(`Register ${scenario}: ${registered.status} ${await registered.text()}`);
  const registration = await registered.json();
  const start = Date.now();
  const rounds = [];
  let started = false;
  let runError;
  try {
    const created = await command(['run', '-d', '--rm', '--name', container,
      '--workdir', '/workspace', '--mount', `type=bind,source=${workspace},target=/workspace`,
      '-e', `ANTHROPIC_BASE_URL=${dockerBase}/run/${runId}/claude`,
      '-e', 'ANTHROPIC_AUTH_TOKEN=conversation-probe-key',
      '-e', 'ANTHROPIC_API_KEY=conversation-probe-key',
      '-e', 'DISABLE_NONESSENTIAL_TRAFFIC=1',
      '-e', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY=1',
      '--entrypoint', 'sleep', image, 'infinity']);
    if (created.exitCode !== 0) throw new Error(`Container failed: ${created.stderr}`);
    started = true;
    for (const [index, phase] of ['build', 'extend', 'audit'].entries()) {
      const prompt = `K2C_LONG_PROBE ${runId} LONG_PHASE:${phase}. ${
        phase === 'build'
          ? 'Complete the long task by running node /workspace/probe-task.mjs STEP for each STEP 1 through 12 in order, then node /workspace/probe-task.mjs verify build. Preserve the facts returned by every tool and report only verified results.'
          : phase === 'extend'
            ? 'Continue the same task and session. Keep all previous facts. Run steps 13 through 15 in order, then node /workspace/probe-task.mjs verify extend. Do not repeat already completed steps.'
            : 'Audit the entire completed task in this same session. Run node /workspace/probe-task.mjs verify audit. Report the original facts and all verified outputs; never claim a tool succeeded without its actual successful result.'
      } Each STEP must use a separate real tool call. Do not combine steps in a loop, batch, or wrapper script. Do not read or modify probe-task.mjs to simulate execution. End with LONG_PHASE_DONE:${phase} steps=${phase === 'build' ? 12 : 15} proof=<the actual verification proof>.`;
      const args = ['exec', container, '/home/claude/entrypoint.sh', '-p', prompt,
        '--model', 'claude-opus-5', '--output-format', 'stream-json', '--verbose',
        '--include-partial-messages', '--max-turns', '60', '--tools', 'Bash',
        '--dangerously-skip-permissions', '--effort', 'high',
        '--debug-file', `/workspace/claude-debug-${phase}.log`,
        ...(index === 0 ? ['--session-id', sessionId] : ['--resume', sessionId]),
      ];
      const outcome = await command(args, () => {
        // Kill only this isolated CLI process. Keep the container alive long
        // enough to retrieve its persisted transcript even after a timeout.
        spawn('docker', ['exec', container, 'pkill', '-TERM', '-f', '^claude'], { stdio: 'ignore' });
      });
      const events = parseJsonl(outcome.stdout);
      const terminal = events.findLast(event => event.type === 'result');
      const reportedSessions = [...new Set(events.map(event => event.session_id).filter(Boolean))];
      const wire = await (await fetch(`${base}/probe/runs/${runId}`)).json();
      const files = await verifyWorkspace(workspace, {
        expectedStep: index === 0 ? 12 : 15,
        expectedPhases: ['build', 'extend', 'audit'].slice(0, index + 1),
      });
      await Promise.all([
        writeFile(join(dir, `${index + 1}-${phase}.jsonl`), outcome.stdout),
        writeFile(join(dir, `${index + 1}-${phase}.stderr`), outcome.stderr),
        writeFile(join(dir, `${index + 1}-${phase}-wire.json`), `${JSON.stringify(wire, null, 2)}\n`),
        writeFile(join(dir, `${index + 1}-${phase}-files.json`), `${JSON.stringify(files, null, 2)}\n`),
      ]);
      const round = { phase, prompt, exitCode: outcome.exitCode, timedOut: outcome.timedOut,
        durationMs: outcome.durationMs, terminal, reportedSessions, files };
      rounds.push(round);
      console.log(JSON.stringify({ protocol: 'claude', scenario, phase, sessionId,
        exitCode: outcome.exitCode, timedOut: outcome.timedOut, durationMs: outcome.durationMs,
        terminal: { subtype: terminal?.subtype, is_error: terminal?.is_error, result: terminal?.result },
        files: { passed: files.passed, violations: files.violations, duplicates: files.duplicates } }));
      if (outcome.timedOut) break;
    }
  } catch (error) {
    runError = error instanceof Error ? error.stack : String(error);
  } finally {
    if (started) {
      const copied = await command(['cp', `${container}:/home/claude/.claude`, join(dir, 'claude-state')], undefined, 30_000);
      await writeFile(join(dir, 'transcript-copy.json'), `${JSON.stringify(copied, null, 2)}\n`);
      await command(['rm', '-f', container], undefined, 30_000);
    }
  }
  const wire = await (await fetch(`${base}/probe/runs/${runId}`)).json();
  await writeFile(join(dir, 'wire.json'), `${JSON.stringify(wire, null, 2)}\n`);
  const files = await verifyWorkspace(workspace);
  const history = historyAudit(await jsonFiles(join(dir, 'claude-state')), sessionId);
  const historyText = history.transcriptPath ? await readFile(history.transcriptPath, 'utf8') : '';
  const cliText = (await Promise.all(rounds.map((round, index) => readFile(join(dir, `${index + 1}-${round.phase}.jsonl`), 'utf8')))).join('\n');
  const delivery = deliveryAudit(wire, historyText, cliText);
  const receiptContinuity = receiptContinuityAudit(wire, files.expectedProofs, prepared.input.secret);
  const sameSession = rounds.length === 3 && rounds.every(round => round.reportedSessions.length === 1 && round.reportedSessions[0] === sessionId);
  const cliCompleted = rounds.length === 3 && rounds.every(round => round.exitCode === 0 && !round.timedOut && round.terminal?.is_error === false && round.terminal?.result?.includes(`LONG_PHASE_DONE:${round.phase}`) && round.terminal.result.includes(round.files.expectedProof));
  const taskPassed = sameSession && cliCompleted && files.passed && rounds.every(round => round.files.passed) && receiptContinuity.passed && !runError;
  const unverifiedClaimInHistory = delivery.some(fault => fault.kind === 'text-error' && fault.inNextKiroHistory);
  const injectedContentMissingFromNextHistory = delivery.filter(fault => fault.marker && fault.inUpstreamFrames && !fault.inNextKiroHistory);
  const passed = taskPassed && !unverifiedClaimInHistory && injectedContentMissingFromNextHistory.length === 0;
  const result = { scenario, runId, sessionId, version, imageId, durationMs: Date.now() - start,
    registration, prepared, runError, passed, taskPassed, sameSession, cliCompleted, rounds, files, history,
    delivery, receiptContinuity, unverifiedClaimInHistory, injectedContentMissingFromNextHistory,
    limitations: [
      'The local Kiro provider deterministically chooses responses from observed tool results; this cannot measure natural-language model hallucination rate.',
      'A successful final turn does not establish content preservation. Inspect file verification, history, and injected payloads separately.',
      'Three user turns run in separate CLI processes using --resume on one persisted session; this does not cover a never-restarted interactive process.',
    ] };
  await Promise.all([
    writeFile(join(dir, 'wire.json'), `${JSON.stringify(wire, null, 2)}\n`),
    writeFile(join(dir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`),
  ]);
  results.push(result);
  console.log(JSON.stringify({ protocol: 'claude', scenario, passed, taskPassed, sameSession, cliCompleted,
    unverifiedClaimInHistory, lostInjectedContent: injectedContentMissingFromNextHistory.map(fault => fault.marker),
    durationMs: result.durationMs, runError, files: { passed: files.passed, violations: files.violations, duplicates: files.duplicates }, history: {
      transcriptEntries: history.transcriptEntries, toolUseCount: history.toolUses.length,
      toolResultCount: history.toolResults.length, unmatchedUses: history.toolUsesWithoutResults.length,
      unmatchedResults: history.toolResultsWithoutUses.length, phaseMarkers: history.phaseMarkers,
    } }));
}

// Separate sessions and workspaces make limited concurrent execution safe.
if (process.env.K2C_PROBE_ANALYZE_ONLY === '1') {
  const analyses = [];
  for (const scenario of scenarios) {
    const dir = join(reportDir, `claude-${scenario}`);
    const result = JSON.parse(await readFile(join(dir, 'result.json'), 'utf8'));
    const wire = JSON.parse(await readFile(join(dir, 'wire.json'), 'utf8'));
    const historyText = result.history.transcriptPath ? await readFile(result.history.transcriptPath, 'utf8') : '';
    const cliText = (await Promise.all(result.rounds.map((round, index) => readFile(join(dir, `${index + 1}-${round.phase}.jsonl`), 'utf8')))).join('\n');
    const delivery = deliveryAudit(wire, historyText, cliText);
    const receiptContinuity = receiptContinuityAudit(wire, result.files.expectedProofs, result.prepared.input.secret);
    const analysis = { scenario, runId: result.runId, sameSession: result.sameSession,
      allPhasesTaskPassed: result.sameSession && result.cliCompleted && result.files.passed && result.rounds.every(round => round.files.passed),
      filesPassed: result.files.passed, duplicateExecutions: result.files.duplicates,
      delivery, receiptContinuity, totalMainRequests: wire.requests.length, totalFaults: wire.faults.length,
      totalToolUses: result.history.toolUses.length, totalToolResults: result.history.toolResults.length,
      limitation: 'Preservation of injected payloads is assessed separately from task completion. Dropped incomplete arguments cannot safely execute; preservation does not mean execution. A scripted upstream does not establish a natural model hallucination rate.',
    };
    await writeFile(join(dir, 'delivery-analysis.json'), `${JSON.stringify(analysis, null, 2)}\n`);
    await writeFile(join(dir, 'receipt-continuity.json'), `${JSON.stringify(receiptContinuity, null, 2)}\n`);
    analyses.push(analysis);
  }
  await writeFile(join(reportDir, 'claude-conversation-analysis.json'), `${JSON.stringify(analyses, null, 2)}\n`);
  console.log(JSON.stringify(analyses.map(analysis => ({ scenario: analysis.scenario, taskPassed: analysis.allPhasesTaskPassed, totalFaults: analysis.totalFaults, totalMainRequests: analysis.totalMainRequests, delivery: analysis.delivery }))));
} else {
  const pending = [...scenarios];
  await Promise.all(Array.from({ length: Math.min(2, scenarios.length) }, async () => {
    while (pending.length) await run(pending.shift());
  }));
  process.exitCode = results.every(result => result.passed) ? 0 : 1;
}
// A focused rerun must not erase summaries for other recorded scenarios.
const recordedResults = [];
for (const entry of await readdir(reportDir, { withFileTypes: true })) {
  if (!entry.isDirectory() || !entry.name.startsWith('claude-') || /-previous-\d+$/.test(entry.name)) continue;
  const recorded = await readFile(join(reportDir, entry.name, 'result.json'), 'utf8').then(JSON.parse, () => null);
  if (recorded) recordedResults.push(recorded);
}
await writeFile(join(reportDir, 'claude-conversation-results.json'), `${JSON.stringify(recordedResults, null, 2)}\n`);
