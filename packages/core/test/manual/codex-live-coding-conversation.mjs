#!/usr/bin/env node
/** Real Codex coding sessions against the real-upstream recording server.
 * This manual probe incurs real model charges. The server enforces 65 upstream
 * calls per run. Independent acceptance code reaches a separate Node process
 * through stdin and is never written into the model's workspace.
 */
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import {
  acceptanceSource,
  codingPrompt,
  prepareCodingPhase,
  prepareCodingWorkspace,
  verifyCodingWorkspace,
} from './_live-coding-workspace.mjs';

const port = Number(process.env.K2C_CONVERSATION_PORT ?? 18943);
const reportDir = resolve(process.env.K2C_CODING_REPORT_DIR ?? 'test-results/live-coding-integrity-2026-09-07');
const image = process.env.K2C_PROBE_CODEX_IMAGE ?? 'kiro2claude-codex:validation-latest';
const scenarios = process.env.K2C_CODING_CASES?.split(',') ?? ['live-baseline', 'live-mixed'];
if (scenarios.length > 2 || scenarios.some((scenario) => !['live-baseline', 'live-mixed'].includes(scenario))) {
  throw new Error('This charged probe permits at most the two live-baseline/live-mixed runs.');
}
const origin = `http://127.0.0.1:${port}`;
const phases = ['build', 'extend', 'audit'];
const unique = (items) => [...new Set(items)];
const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function docker(args, { stdin = '', timeoutMs = 480_000, containerName, onJsonEvent } = {}) {
  return new Promise((done, reject) => {
    const started = Date.now();
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let pendingLine = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (onJsonEvent) {
        pendingLine += chunk;
        const lines = pendingLine.split('\n');
        pendingLine = lines.pop();
        for (const line of lines) {
          try { onJsonEvent(JSON.parse(line)); } catch { /* Preserve non-JSON output in the raw log. */ }
        }
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
    const timer = setTimeout(() => {
      timedOut = true;
      if (containerName) spawn('docker', ['rm', '-f', containerName], { stdio: 'ignore' });
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      done({ stdout, stderr, exitCode, signal, timedOut, durationMs: Date.now() - started });
    });
  });
}

function jsonEvents(stdout) {
  return stdout.split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return { type: 'unparsed', text: line }; }
  });
}

function analyzeHistory(run) {
  const requests = run.requests ?? [];
  const seenResults = new Map();
  const resultMutations = [];
  const resultRegressions = [];
  let previousIds = [];
  const facts = requests.map((request) => {
    const input = request.request?.input ?? [];
    const toolCalls = input.filter((item) => ['custom_tool_call', 'function_call'].includes(item.type));
    const outputs = input.filter((item) => ['custom_tool_call_output', 'function_call_output'].includes(item.type));
    const resultIds = outputs.map((item) => item.call_id);
    for (const output of outputs) {
      const digest = sha(output.output);
      if (seenResults.has(output.call_id) && seenResults.get(output.call_id).digest !== digest) {
        resultMutations.push({ request: request.id, callId: output.call_id,
          previous: seenResults.get(output.call_id), currentDigest: digest });
      }
      seenResults.set(output.call_id, { digest, request: request.id });
    }
    const missing = previousIds.filter((id) => !resultIds.includes(id));
    if (missing.length) resultRegressions.push({ request: request.id, missing });
    previousIds = resultIds;
    const wireEvents = (request.response?.body ?? '').split('\n').filter((line) => line.startsWith('data: ')).map((line) => {
      try { return JSON.parse(line.slice(6)); } catch { return null; }
    }).filter(Boolean);
    const emittedTools = wireEvents.filter((event) => event.type === 'response.output_item.done'
      && ['custom_tool_call', 'function_call'].includes(event.item?.type)).map((event) => event.item);
    const textByItem = {};
    for (const event of wireEvents) if (event.type === 'response.output_text.delta') {
      textByItem[event.item_id] = (textByItem[event.item_id] ?? '') + event.delta;
    }
    return {
      request: request.id, phase: request.phase, fault: request.fault,
      httpStatus: request.response?.status, inputItems: input.length,
      clientToolCallIds: toolCalls.map((call) => call.call_id), clientToolResultIds: resultIds,
      emittedTools: emittedTools.map((call) => ({ callId: call.call_id, name: call.name, input: call.input ?? call.arguments })),
      emittedText: Object.values(textByItem),
      wireTerminalEvents: wireEvents.filter((event) => ['error', 'response.failed', 'response.incomplete', 'response.completed'].includes(event.type)),
      liveAttempts: (request.upstreamRequests ?? []).map((attempt) => ({
        upstreamCall: attempt.upstreamCall, fault: attempt.fault,
        originalFrames: attempt.originalFrameBase64?.length, forwardedFrames: attempt.forwardedFrameBase64?.length,
        intentionallyHiddenOriginalFrames: attempt.intentionallyHiddenOriginalFrames,
        originalDrained: attempt.originalDrained, error: attempt.error,
        completedOriginalTools: attempt.eventsSummary?.filter((event) => event.kind === 'ToolUse' && event.isComplete),
      })),
    };
  });
  for (const fact of facts) for (const call of fact.emittedTools) {
    call.resultObservedInLaterHistory = facts.some((later) => later.request > fact.request
      && later.clientToolResultIds.includes(call.callId));
  }
  const failedTextPropagation = facts.filter((fact) => fact.fault || fact.wireTerminalEvents
    .some((event) => event.type !== 'response.completed')).flatMap((fact) => fact.emittedText
    .filter((text) => text.length >= 20).map((text) => {
      const encoded = JSON.stringify(text).slice(1, -1);
      return { request: fact.request, fault: fact.fault, text,
        laterClientRequests: requests.filter((later) => later.id > fact.request
          && JSON.stringify(later.request?.input).includes(encoded)).map((later) => later.id),
        laterUpstreamRequests: requests.filter((later) => later.id > fact.request
          && JSON.stringify(later.upstreamRequests?.map((attempt) => attempt.request)).includes(encoded)).map((later) => later.id) };
    }));
  return { requests: facts, toolResultMutations: resultMutations, toolResultRegressions: resultRegressions,
    distinctToolResults: seenResults.size,
    failedTextPropagation,
    faultRequests: facts.filter((request) => request.fault) };
}

async function runCase(scenario) {
  const runId = `codex-coding-${scenario}-${randomUUID().slice(0, 8)}`;
  const dir = resolve(reportDir, runId);
  const workspace = resolve(dir, 'workspace');
  const codexHome = resolve(dir, 'codex-home');
  await mkdir(codexHome, { recursive: true });
  const fixture = await prepareCodingWorkspace(workspace, runId);
  await writeFile(resolve(dir, 'fixture.json'), `${JSON.stringify(fixture, null, 2)}\n`);
  const registration = await fetch(`${origin}/probe/runs`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: runId, protocol: 'codex', scenario }),
  });
  if (!registration.ok) throw new Error(`Register ${runId}: HTTP ${registration.status}`);
  const phaseResults = [];
  let threadId;
  console.log(JSON.stringify({ event: 'coding.started', runId, scenario }));
  for (const phase of phases) {
    if (phase !== 'build' && !threadId) break;
    await prepareCodingPhase(workspace, phase);
    const containerName = `k2c-live-coding-${randomUUID()}`;
    const args = [
      'run', '--rm', '--name', containerName,
      '-v', `${workspace}:/workspace`, '-v', `${codexHome}:/home/coder/.codex`, '-w', '/workspace',
      '-e', 'KIRO2CLAUDE_API_KEY=conversation-probe-key',
      '-e', `KIRO2CLAUDE_BASE_URL=http://host.docker.internal:${port}/run/${runId}/openai/v1`,
      '-e', 'CODEX_MODEL=gpt-5.6-sol', image, 'exec',
    ];
    if (phase !== 'build') args.push('resume');
    args.push('--json', '--skip-git-repo-check', '-c', 'model_reasoning_effort="high"');
    if (phase !== 'build') args.push(threadId);
    args.push(codingPrompt(phase, runId));
    let completedToolCount = 0;
    const raw = await docker(args, { containerName,
      timeoutMs: Number(process.env.K2C_CODING_PHASE_TIMEOUT_MS ?? 480_000),
      onJsonEvent: (event) => {
        if (event.type === 'item.completed' && event.item
          && !['agent_message', 'reasoning'].includes(event.item.type)) {
          completedToolCount++;
          console.log(JSON.stringify({ event: 'coding.tool', runId, phase,
            completedToolCount, toolType: event.item.type }));
        }
        if (event.type === 'error') console.log(JSON.stringify({ event: 'coding.retry', runId, phase, message: event.message }));
      } });
    await Promise.all([
      writeFile(resolve(dir, `${phase}.stdout.jsonl`), raw.stdout),
      writeFile(resolve(dir, `${phase}.stderr.txt`), raw.stderr),
    ]);
    const parsed = jsonEvents(raw.stdout);
    const phaseThread = parsed.find((event) => event.type === 'thread.started')?.thread_id;
    if (!threadId) threadId = phaseThread;
    const acceptanceContainer = `k2c-coding-acceptance-${randomUUID()}`;
    const acceptanceRaw = await docker([
      'run', '--rm', '-i', '--name', acceptanceContainer, '--entrypoint', 'node', '-v', `${workspace}:/workspace`, '-w', '/workspace',
      image, '--input-type=module',
    ], { stdin: acceptanceSource(phase), timeoutMs: 60_000, containerName: acceptanceContainer });
    await Promise.all([
      writeFile(resolve(dir, `${phase}.acceptance.stdout.jsonl`), acceptanceRaw.stdout),
      writeFile(resolve(dir, `${phase}.acceptance.stderr.txt`), acceptanceRaw.stderr),
      writeFile(resolve(dir, `${phase}.acceptance.mjs`), acceptanceSource(phase)),
    ]);
    const acceptance = jsonEvents(acceptanceRaw.stdout).findLast((event) => typeof event.passed === 'boolean');
    const acceptancePassed = acceptanceRaw.exitCode === 0 && acceptance?.passed === true;
    const workspaceContract = await verifyCodingWorkspace(workspace, phase);
    const snapshot = workspaceContract.snapshot;
    const sourceSnapshot = resolve(dir, `${phase}-files`);
    await cp(workspace, sourceSnapshot, { recursive: true,
      filter: (path) => !['node_modules', '.git', '.codex'].includes(basename(path)) });
    const completed = parsed.filter((event) => event.type === 'turn.completed');
    const failed = parsed.filter((event) => event.type === 'turn.failed');
    const agentMessages = parsed.filter((event) => event.type === 'item.completed'
      && event.item?.type === 'agent_message').map((event) => event.item.text);
    const toolEvents = parsed.filter((event) => event.type === 'item.completed'
      && !['agent_message', 'reasoning'].includes(event.item?.type));
    const result = {
      phase, threadId: phaseThread, resumedThreadId: phase === 'build' ? null : threadId,
      exitCode: raw.exitCode, signal: raw.signal, timedOut: raw.timedOut, durationMs: raw.durationMs,
      turnCompleted: completed.length, turnFailed: failed.length, agentMessages, toolEvents,
      errors: parsed.filter((event) => ['error', 'turn.failed'].includes(event.type)),
      acceptanceExitCode: acceptanceRaw.exitCode, acceptance, acceptancePassed,
      completedWithFailingAcceptance: raw.exitCode === 0 && completed.length > 0 && !acceptancePassed,
      snapshot, workspaceContract, command: ['docker', ...args],
    };
    phaseResults.push(result);
    await writeFile(resolve(dir, `${phase}.json`), `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify({ event: 'coding.phase', runId, phase, exitCode: raw.exitCode,
      durationMs: raw.durationMs, toolEvents: toolEvents.length, acceptancePassed,
      completedWithFailingAcceptance: result.completedWithFailingAcceptance }));
  }
  const gateway = await fetch(`${origin}/probe/runs/${runId}`).then((response) => response.json());
  await writeFile(resolve(dir, 'gateway.json'), `${JSON.stringify(gateway, null, 2)}\n`);
  const history = analyzeHistory(gateway);
  const sameSession = phaseResults.length === 3 && phaseResults.every((phase) => phase.threadId === threadId);
  const realUpstreamCalls = gateway.state?.liveProbe?.realUpstreamCalls ?? 0;
  const passed = sameSession && phaseResults.every((phase) => phase.acceptancePassed
    && phase.exitCode === 0 && phase.turnCompleted === 1 && phase.turnFailed === 0)
    && history.toolResultMutations.length === 0 && history.toolResultRegressions.length === 0;
  const result = {
    runId, scenario, model: 'gpt-5.6-sol', effort: 'high', fakeUpstream: false,
    passed, sameSession, threadId, phases: phaseResults, history,
    realUpstreamCalls, mainHttpRequests: gateway.requests?.length,
    reachedLongConversationTarget: realUpstreamCalls >= 15,
    faults: gateway.faults, serverState: gateway.state,
  };
  await writeFile(resolve(dir, 'summary.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ event: 'coding.finished', runId, passed, sameSession,
    realUpstreamCalls, mainHttpRequests: result.mainHttpRequests, faults: gateway.faults?.length,
    acceptance: phaseResults.map((phase) => ({ phase: phase.phase, passed: phase.acceptancePassed })) }));
  return result;
}

await mkdir(reportDir, { recursive: true });
const version = await docker(['run', '--rm', image, '--version'], { timeoutMs: 30_000 });
if (version.exitCode !== 0) throw new Error(version.stderr);
const results = [];
// Live cases are sequential to keep model load and the charged call budget explicit.
for (const scenario of scenarios) results.push(await runCase(scenario));
await writeFile(resolve(reportDir, `codex-live-coding-${scenarios.join('_')}.json`), `${JSON.stringify({
  version: version.stdout.trim(), image, fakeUpstream: false, results,
}, null, 2)}\n`);
if (results.some((result) => !result.passed)) process.exitCode = 1;
