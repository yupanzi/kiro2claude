#!/usr/bin/env node
/** Inspect real CLI probe artifacts separately from the probe's overall pass flag. */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const root = resolve(process.argv[2] ?? 'test-results/conversation-fixes-2026-09-07/sessions');
function ssePayloads(body) {
  return body.split(/\r?\n\r?\n/).flatMap(block => {
    const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return [];
    try { return [JSON.parse(data)]; } catch { throw new Error('Malformed SSE data in recorded response'); }
  });
}
const sessions = [];
for (const entry of await readdir(root, { withFileTypes: true })) {
  if (!entry.isDirectory() || !/^(?:claude|codex)-/.test(entry.name)) continue;
  const dir = join(root, entry.name);
  const claude = entry.name.startsWith('claude-');
  const result = await readFile(join(dir, claude ? 'result.json' : 'summary.json'), 'utf8').then(JSON.parse, () => null);
  if (!result) continue;
  const wire = JSON.parse(await readFile(join(dir, claude ? 'wire.json' : 'gateway.json'), 'utf8'));
  const rawFrameText = wire.requests.flatMap(r => r.upstreamRequests.flatMap(a => (a.frameBase64 ?? a.originalFrameBase64 ?? []).map(b => Buffer.from(b, 'base64').toString('utf8')))).join('\n');
  const markers = [...new Set((JSON.stringify(wire) + rawFrameText).match(/(?:THOUGHT_FRAGMENT|THOUGHT_EOF|UNVERIFIED_CLAIM|PARTIAL_ANSWER|CRC_PREFIX|CRC_SUFFIX|MISSING_NEGATION)_\d+/g) ?? [])];
  const preservation = markers.map(marker => {
    const client = wire.requests.filter(r => JSON.stringify(r.request).includes(marker)).map(r => r.id);
    const upstream = wire.requests.filter(r => JSON.stringify(r.upstreamRequests.map(a => a.request)).includes(marker)).map(r => r.id);
    const noAttemptRequests = client.filter(id => !wire.requests.find(r => r.id === id).upstreamRequests.length);
    return { marker, clientRequests: client, upstreamRequests: upstream, noAttemptRequests,
      conversionLossRequests: client.filter(id => !noAttemptRequests.includes(id) && !upstream.includes(id)) };
  });
  const faults = wire.faults.map(fault => {
    const record = wire.requests.find(r => r.id === fault.request);
    const body = record?.response?.body ?? '';
    const events = ssePayloads(body);
    const observations = {
      kind: fault.kind, request: fault.request, step: fault.step, status: record?.response?.status,
      error: events.some(e => e.type === 'error' || e.type === 'response.failed'),
      completed: events.some(e => e.type === 'response.completed' || (e.type === 'message_delta' && e.delta?.stop_reason === 'end_turn')),
      incomplete: events.some(e => e.type === 'response.incomplete' || (e.type === 'message_delta' && e.delta?.stop_reason === 'max_tokens')),
    };
    if (fault.kind === 'crc-error') Object.assign(observations, {
      validPrefixDelivered: body.includes(`CRC_PREFIX_${fault.step}`),
      missingCorruptContentDelivered: body.includes(`MISSING_NEGATION_${fault.step}`),
      suffixAfterDamageDelivered: body.includes(`CRC_SUFFIX_${fault.step}`),
      toolAfterDamageDelivered: body.includes('after_corruption_'),
    });
    return observations;
  });
  const rounds = result.rounds ?? result.phases;
  const verification = result.files ?? result.verification;
  const stageExecutions = verification.ledger.filter(r => r.probeStep).length;
  const verificationExecutions = verification.ledger.filter(r => r.verification).length;
  sessions.push({
    protocol: claude ? 'claude' : 'codex', scenario: result.scenario, runId: result.runId,
    sameSession: result.sameSession, userTurns: rounds.length, httpRequests: wire.requests.length,
    upstreamAttempts: wire.requests.reduce((n, r) => n + r.upstreamRequests.length, 0),
    canonicalToolCalls: claude ? result.history.toolUses.length : undefined,
    wireToolItems: claude ? undefined : wire.requests.reduce((n, r) => n + ssePayloads(r.response.body).filter(e => e.type === 'response.output_item.done' && ['function_call', 'custom_tool_call'].includes(e.item?.type)).length, 0),
    stageExecutions, verificationExecutions, recordedTaskExecutions: stageExecutions + verificationExecutions,
    taskPassed: claude ? result.taskPassed : result.taskIntegrityPassed,
    strictOriginalProbePassed: result.passed,
    duplicateExecutions: (result.files ?? result.verification).duplicates,
    phaseOutcomes: rounds.map(r => {
      const phases = ['build', 'extend', 'audit'];
      const earlier = phases.slice(0, phases.indexOf(r.phase));
      const files = r.files ?? r.verification;
      const currentPhaseViolations = files.violations.filter(v => !earlier.some(p => v.startsWith(`${p} verification`)));
      return { phase: r.phase, exitCode: r.exitCode, timedOut: r.timedOut,
        cumulativeFilesPassed: files.passed, currentPhaseObjectivePassed: currentPhaseViolations.length === 0 };
    }),
    faults, preservation,
    limitation: 'Scripted provider chooses next action from actual receipts. Content retained in history may still be unverified, and task completion does not prove no omissions or hallucinations.',
  });
}
const report = {
  sessions, totals: {
    sessions: sessions.length,
    userTurns: sessions.reduce((n, s) => n + s.userTurns, 0),
    httpRequests: sessions.reduce((n, s) => n + s.httpRequests, 0),
    recordedTaskExecutions: sessions.reduce((n, s) => n + s.recordedTaskExecutions, 0),
    faults: sessions.reduce((n, s) => n + s.faults.length, 0),
    conversionLosses: sessions.flatMap(s => s.preservation.flatMap(p => p.conversionLossRequests)).length,
  },
};
await writeFile(join(root, 'repair-audit.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ totals: report.totals, sessions: sessions.map(({ protocol, scenario, taskPassed, faults, preservation }) => ({ protocol, scenario, taskPassed, faults, preservation })) }));
