#!/usr/bin/env node
/** Real persisted Codex sessions, three user turns, and an independently verified file task.
 * Start conversation-fault-server.ts first. Default scenarios use a stub upstream;
 * explicit live-* scenarios use the server's real upstream and may incur charges.
 * K2C_CONVERSATION_CASES=baseline node packages/core/test/manual/codex-conversation-probe.mjs
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { prepareWorkspace, verifyWorkspace } from './_conversation-workspace.mjs';

const port = Number(process.env.K2C_CONVERSATION_PORT ?? 18941);
const reportDir = resolve(process.env.K2C_CONVERSATION_REPORT_DIR ?? 'test-results/conversation-integrity-2026-09-07');
const image = process.env.K2C_PROBE_CODEX_IMAGE ?? 'kiro2claude-codex:validation-latest';
const effort = process.env.K2C_CONVERSATION_EFFORT;
const scenarios = process.env.K2C_CONVERSATION_CASES?.split(',') ?? [
  'baseline', 'mixed', 'tool-error', 'thinking-error', 'partial-tool', 'text-error',
  'text-eof', 'tool-then-partial', 'redacted-error', 'text-eof-once', 'thinking-eof-once',
];
const origin = `http://127.0.0.1:${port}`;
const phases = ['build', 'extend', 'audit'];
const markerPattern = /(?:THOUGHT_FRAGMENT|THOUGHT_EOF|UNVERIFIED_CLAIM|DRAFT_PARAMETER|PARTIAL_ANSWER|CRC_PREFIX|CRC_SUFFIX|MISSING_NEGATION)_[A-Za-z0-9_]+/g;
const unique = (items) => [...new Set(items)];

function docker(args, { timeoutMs = 180_000, containerName } = {}) {
  return new Promise((done, reject) => {
    const start = Date.now();
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      timedOut = true;
      if (containerName) spawn('docker', ['rm', '-f', containerName], { stdio: 'ignore' });
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      done({ stdout, stderr, exitCode, signal, timedOut, durationMs: Date.now() - start });
    });
  });
}

function events(stdout) {
  return stdout.split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return { type: 'unparsed', line }; }
  });
}

function analyzeHistory(run) {
  const requests = run.requests ?? [];
  const receiptRegressions = [];
  const callIdsByTask = {};
  const resultIds = new Set();
  let previousSteps = [];
  const requestFacts = requests.map((record) => {
    const input = record.request?.input ?? [];
    const calls = input.filter((item) => ['custom_tool_call', 'function_call'].includes(item.type));
    const outputs = input.filter((item) => ['custom_tool_call_output', 'function_call_output'].includes(item.type));
    for (const call of calls) {
      const task = (call.input ?? call.arguments ?? '').match(/probe-task\.mjs\s+(\d+|verify\s+(?:build|extend|audit))/)?.[1];
      if (task) callIdsByTask[task] = unique([...(callIdsByTask[task] ?? []), call.call_id]);
    }
    for (const output of outputs) resultIds.add(output.call_id);
    const outputText = JSON.stringify(outputs).replace(/\\+"/g, '"');
    const clientReceiptSteps = unique([...outputText.matchAll(/"probeStep"\s*:\s*(\d+)/g)].map((match) => Number(match[1]))).sort((a, b) => a - b);
    const upstreamSteps = record.observed?.steps ?? [];
    const lost = previousSteps.filter((step) => !upstreamSteps.includes(step));
    if (lost.length) receiptRegressions.push({ request: record.id, lost, previousSteps, currentSteps: upstreamSteps });
    previousSteps = upstreamSteps;
    return {
      request: record.id, phase: record.phase, fault: record.fault,
      httpStatus: record.response?.status, inputItems: input.length,
      toolCallIds: calls.map((call) => call.call_id), toolResultIds: outputs.map((output) => output.call_id),
      clientReceiptSteps, upstreamReceiptSteps: upstreamSteps,
      receiptConversionMismatch: clientReceiptSteps.filter((step) => !upstreamSteps.includes(step)),
      faultMarkersInHistory: unique(JSON.stringify(input).match(markerPattern) ?? []),
      upstreamFaultMarkers: unique(JSON.stringify(record.upstreamRequests?.map((attempt) => attempt.request)).match(markerPattern) ?? []),
    };
  });
  const faultHistory = requests.filter((record) => record.fault).map((record) => {
    const wire = record.response?.body ?? '';
    const markers = unique(wire.match(markerPattern) ?? []);
    const callIds = unique([...wire.matchAll(/"call_id"\s*:\s*"([^"]+)"/g)].map((match) => match[1]));
    return {
      request: record.id, phase: record.phase, fault: record.fault, httpStatus: record.response?.status,
      wireMarkers: markers, wireToolCallIds: callIds,
      wireToolCallsWithResultInLaterHistory: callIds.filter((id) => resultIds.has(id)),
      wireToolCallsWithoutResultInLaterHistory: callIds.filter((id) => !resultIds.has(id)),
      markerPropagation: markers.map((marker) => ({
        marker,
        laterClientRequests: requestFacts.filter((item) => item.request > record.id && item.faultMarkersInHistory.includes(marker)).map((item) => item.request),
        laterUpstreamRequests: requestFacts.filter((item) => item.request > record.id && item.upstreamFaultMarkers.includes(marker)).map((item) => item.request),
        laterPhases: unique(requestFacts.filter((item) => item.request > record.id && item.faultMarkersInHistory.includes(marker)).map((item) => item.phase)),
      })),
    };
  });
  return { requestFacts, receiptRegressions, callIdsByTask, faultHistory };
}

async function runCase(scenario) {
  const runId = `codex-${scenario}-${randomUUID().slice(0, 8)}`;
  const dir = resolve(reportDir, runId);
  const workspace = resolve(dir, 'workspace');
  const codexHome = resolve(dir, 'codex-home');
  await mkdir(codexHome, { recursive: true });
  await prepareWorkspace(workspace, runId);
  const registration = await fetch(`${origin}/probe/runs`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: runId, protocol: 'codex', scenario }),
  });
  if (!registration.ok) throw new Error(`Register ${runId}: HTTP ${registration.status}`);
  const phaseResults = [];
  let threadId;
  console.log(JSON.stringify({ event: 'conversation.started', scenario, runId }));
  for (const phase of phases) {
    if (phase !== 'build' && !threadId) break;
    const containerName = `k2c-conversation-${randomUUID()}`;
    const args = [
      'run', '--rm', '--name', containerName,
      '-v', `${workspace}:/workspace`, '-v', `${codexHome}:/home/coder/.codex`, '-w', '/workspace',
      '-e', 'KIRO2CLAUDE_API_KEY=conversation-probe-key',
      '-e', `KIRO2CLAUDE_BASE_URL=http://host.docker.internal:${port}/run/${runId}/openai/v1`,
      '-e', 'CODEX_MODEL=gpt-5.6-sol', image, 'exec',
    ];
    if (phase !== 'build') args.push('resume');
    args.push('--json', '--skip-git-repo-check');
    if (effort) args.push('-c', `model_reasoning_effort=${JSON.stringify(effort)}`);
    if (phase !== 'build') args.push(threadId);
    const task = phase === 'build'
      ? 'Execute stages 1 through 12 in order using node /workspace/probe-task.mjs STEP, then run node /workspace/probe-task.mjs verify build.'
      : phase === 'extend'
        ? 'Continue the existing task from its saved receipts. Execute only stages 13 through 15, then run node /workspace/probe-task.mjs verify extend.'
        : 'Audit the existing result. Run only node /workspace/probe-task.mjs verify audit. Do not repeat any completed stage.';
    args.push(`K2C_LONG_PROBE LONG_PHASE:${phase} run=${runId}. ${task} Keep all completed receipts from our earlier turns. Every stage must execute exactly once. Use one separate tool call per stage and wait for its successful receipt before the next stage. Do not loop or batch commands, and do not read the task script or bypass the prescribed commands. Report the exact proof from the real verification output as LONG_PHASE_DONE:${phase} steps=${phase === 'build' ? 12 : 15} proof=<the real verification proof>. Do not invent results.`);
    const raw = await docker(args, { containerName, timeoutMs: Number(process.env.K2C_CONVERSATION_TIMEOUT_MS ?? 180_000) });
    await Promise.all([
      writeFile(resolve(dir, `${phase}.stdout.jsonl`), raw.stdout),
      writeFile(resolve(dir, `${phase}.stderr.txt`), raw.stderr),
    ]);
    const parsed = events(raw.stdout);
    const phaseThread = parsed.find((event) => event.type === 'thread.started')?.thread_id;
    if (!threadId && phaseThread) threadId = phaseThread;
    const verification = await verifyWorkspace(workspace, {
      expectedStep: phase === 'build' ? 12 : 15,
      expectedPhases: phases.slice(0, phases.indexOf(phase) + 1),
    });
    const completed = parsed.filter((event) => event.type === 'turn.completed');
    const failed = parsed.filter((event) => event.type === 'turn.failed');
    const agentMessages = parsed.filter((event) => event.type === 'item.completed' && event.item?.type === 'agent_message').map((event) => event.item.text);
    const claimsCompletion = agentMessages.some((text) => text.includes(`LONG_PHASE_DONE:${phase}`));
    // A missing verification in an earlier user turn remains a continuity
    // failure, but must not mislabel a later successfully completed phase.
    const earlierPhases = phases.slice(0, phases.indexOf(phase));
    const phaseObjectiveViolations = verification.violations.filter((violation) =>
      !earlierPhases.some((earlier) => violation.startsWith(`${earlier} verification`)));
    const phaseObjectivePassed = phaseObjectiveViolations.length === 0;
    const falseCompletion = raw.exitCode === 0 && completed.length > 0 && !phaseObjectivePassed;
    phaseResults.push({
      phase, threadId: phaseThread, resumedThreadId: phase === 'build' ? null : threadId,
      exitCode: raw.exitCode, timedOut: raw.timedOut, durationMs: raw.durationMs,
      turnCompleted: completed.length, turnFailed: failed.length,
      agentMessages, claimsCompletion, falseCompletion, phaseObjectivePassed, phaseObjectiveViolations,
      finalProofMatches: agentMessages.some((text) => text.includes(verification.expectedProof)),
      errors: parsed.filter((event) => ['error', 'turn.failed'].includes(event.type)),
      verification, command: ['docker', ...args],
    });
    await writeFile(resolve(dir, `${phase}.json`), `${JSON.stringify(phaseResults.at(-1), null, 2)}\n`);
    console.log(JSON.stringify({ event: 'conversation.phase', scenario, phase, exitCode: raw.exitCode,
      turnCompleted: completed.length, workspacePassed: verification.passed, falseCompletion }));
  }
  const snapshot = await fetch(`${origin}/probe/runs/${runId}`).then((response) => response.json());
  await writeFile(resolve(dir, 'gateway.json'), `${JSON.stringify(snapshot, null, 2)}\n`);
  const history = analyzeHistory(snapshot);
  const verification = await verifyWorkspace(workspace);
  const sameSession = phaseResults.length === 3 && phaseResults.every((result) => result.threadId === threadId);
  const passed = sameSession && verification.passed && phaseResults.every((result) =>
    result.exitCode === 0 && result.turnCompleted === 1 && result.turnFailed === 0 && result.finalProofMatches)
    && history.receiptRegressions.length === 0;
  const result = {
    runId, scenario, effort: effort ?? 'client-default', passed, taskIntegrityPassed: passed, threadId, sameSession,
    fakeUpstream: !scenario.startsWith('live'),
    requests: snapshot.requests?.length, faultCount: snapshot.faults?.length,
    phases: phaseResults, verification, history,
    falseCompletion: phaseResults.some((phase) => phase.falseCompletion),
    duplicateExecution: verification.duplicates.length > 0,
    faultMarkersRetainedInClient: unique(history.faultHistory.flatMap((fault) => fault.markerPropagation
      .filter((item) => item.laterClientRequests.length > 0).map((item) => item.marker))),
    faultMarkersForwardedToUpstream: unique(history.faultHistory.flatMap((fault) => fault.markerPropagation
      .filter((item) => item.laterUpstreamRequests.length > 0).map((item) => item.marker))),
    observedServerState: snapshot.state,
  };
  await writeFile(resolve(dir, 'summary.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ event: 'conversation.finished', scenario, runId, passed,
    sameSession, requests: result.requests, faultCount: result.faultCount,
    duplicateExecution: result.duplicateExecution, falseCompletion: result.falseCompletion,
    receiptRegressions: history.receiptRegressions.length }));
  return result;
}

await mkdir(reportDir, { recursive: true });
const version = await docker(['run', '--rm', image, '--version']);
if (version.exitCode !== 0) throw new Error(version.stderr);
const queue = [...scenarios];
const results = [];
await Promise.all(Array.from({ length: Math.min(2, scenarios.length) }, async () => {
  while (queue.length) results.push(await runCase(queue.shift()));
}));
results.sort((a, b) => scenarios.indexOf(a.scenario) - scenarios.indexOf(b.scenario));
const summaryPath = resolve(reportDir, `codex-conversation-${scenarios.join('_')}.json`);
await writeFile(summaryPath, `${JSON.stringify({ version: version.stdout.trim(), image,
  fakeUpstream: results.every((result) => result.fakeUpstream), results }, null, 2)}\n`);
if (results.some((result) => !result.passed)) process.exitCode = 1;
