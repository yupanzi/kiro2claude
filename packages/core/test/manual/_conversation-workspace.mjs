/** Shared real-file task for the Claude Code and Codex conversation probes. */
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const taskSource = String.raw`import { createHash } from 'node:crypto';
import { appendFile, readFile, writeFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('.', import.meta.url));
const path = (name) => join(root, name);
const hash = (text) => createHash('sha256').update(text).digest('hex');
const input = JSON.parse(await readFile(path('input.json'), 'utf8'));
const arg = process.argv[2];
if (arg === 'verify') {
  const probePhase = process.argv[3];
  if (!['build', 'extend', 'audit'].includes(probePhase)) throw new Error('Unknown verification phase');
  const probeVerified = probePhase === 'build' ? 12 : 15;
  const stage = JSON.parse(await readFile(path('stage-' + probeVerified + '.json'), 'utf8'));
  const result = JSON.parse(await readFile(path('result.json'), 'utf8'));
  if (result.proof !== stage.proof || result.step !== probeVerified) throw new Error('Result does not match stage');
  const output = { probeVerified, probePhase, proof: stage.proof };
  await appendFile(path('executions.jsonl'), JSON.stringify({ verification: true, ...output }) + '\n');
  console.log(JSON.stringify(output));
} else {
  const step = Number(arg);
  if (!Number.isInteger(step) || step < 1 || step > 15) throw new Error('STEP must be 1..15');
  const filename = 'stage-' + step + '.json';
  const duplicate = await access(path(filename)).then(() => true, () => false);
  await appendFile(path('executions.jsonl'), JSON.stringify({ probeStep: step, duplicate }) + '\n');
  const previous = step === 1
    ? { values: input.records, proof: hash(JSON.stringify(input)) }
    : JSON.parse(await readFile(path('stage-' + (step - 1) + '.json'), 'utf8'));
  const shift = step % previous.values.length;
  const rotated = previous.values.slice(shift).concat(previous.values.slice(0, shift));
  const secretByte = Number.parseInt(input.secret.slice(((step - 1) % 32) * 2, ((step - 1) % 32) * 2 + 2), 16);
  const values = rotated.map((value, index) => (value * (1 + (index + step) % 7) + secretByte + step) % 10007);
  const proof = hash(previous.proof + ':' + step + ':' + values.join(',') + ':' + input.secret);
  const stage = { step, values, priorProof: previous.proof, proof };
  await writeFile(path(filename), JSON.stringify(stage) + '\n');
  await writeFile(path('result.json'), JSON.stringify(stage) + '\n');
  console.log(JSON.stringify({ probeStep: step, proof, ...(step === 1 ? { secret: input.secret } : {}) }));
}
`;

export async function prepareWorkspace(directory, runId) {
  const dir = resolve(directory);
  await mkdir(dir, { recursive: true });
  const input = {
    runId,
    secret: randomBytes(32).toString('hex'),
    records: Array.from(randomBytes(32), (value, index) => value * 11 + index),
  };
  await writeFile(resolve(dir, 'input.json'), `${JSON.stringify(input, null, 2)}\n`);
  await writeFile(resolve(dir, 'probe-task.mjs'), taskSource);
  await writeFile(resolve(dir, 'TASK.md'), [
    'Run the stage task with: node /workspace/probe-task.mjs STEP',
    'Stages 1..15 must execute exactly once in order. Every stage depends on the prior file.',
    'Build phase: stages 1..12, then node /workspace/probe-task.mjs verify build.',
    'Extend phase: stages 13..15, then node /workspace/probe-task.mjs verify extend.',
    'Audit phase: node /workspace/probe-task.mjs verify audit; do not repeat stages.',
    'Report the proof printed by verification. Do not invent the proof or repeat completed stages.',
    '',
  ].join('\n'));
  return { directory: dir, input };
}

/** Recompute every stage from the original input, independently of the task's stage-file reads. */
export async function verifyWorkspace(directory, { expectedStep = 15, expectedPhases = ['build', 'extend', 'audit'] } = {}) {
  const dir = resolve(directory);
  const input = JSON.parse(await readFile(resolve(dir, 'input.json'), 'utf8'));
  const ledgerText = await readFile(resolve(dir, 'executions.jsonl'), 'utf8').catch(() => '');
  const ledger = ledgerText.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const violations = [];
  const executionCounts = {};
  const verificationCounts = {};
  for (const entry of ledger) {
    if (entry.probeStep) executionCounts[entry.probeStep] = (executionCounts[entry.probeStep] ?? 0) + 1;
    if (entry.verification) verificationCounts[entry.probePhase] = (verificationCounts[entry.probePhase] ?? 0) + 1;
  }
  let values = [...input.records];
  let proof = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const expectedProofs = {};
  for (let step = 1; step <= expectedStep; step++) {
    const priorProof = proof;
    const nextValues = [];
    const offset = step % values.length;
    const secretByte = Buffer.from(input.secret, 'hex')[(step - 1) % 32];
    for (let index = 0; index < values.length; index++) {
      const oldValue = values[(index + offset) % values.length];
      nextValues.push((oldValue * ((index + step) % 7 + 1) + secretByte + step) % 10007);
    }
    values = nextValues;
    proof = createHash('sha256').update(`${priorProof}:${step}:${values.join(',')}:${input.secret}`).digest('hex');
    expectedProofs[step] = proof;
    const stage = await readFile(resolve(dir, `stage-${step}.json`), 'utf8').then(JSON.parse, () => null);
    if (!stage || stage.step !== step || stage.proof !== proof || stage.priorProof !== priorProof
      || JSON.stringify(stage.values) !== JSON.stringify(values)) violations.push(`stage-${step} differs from input-derived expected result`);
    if (executionCounts[step] !== 1) violations.push(`stage-${step} executed ${executionCounts[step] ?? 0} times (expected exactly once)`);
  }
  const result = await readFile(resolve(dir, 'result.json'), 'utf8').then(JSON.parse, () => null);
  if (result?.step !== expectedStep || result?.proof !== proof || JSON.stringify(result?.values) !== JSON.stringify(values)) {
    violations.push('result.json differs from the final expected stage');
  }
  for (const phase of expectedPhases) {
    const count = verificationCounts[phase] ?? 0;
    if (count !== 1) violations.push(`${phase} verification executed ${count} times (expected exactly once)`);
    const expectedVerified = phase === 'build' ? 12 : 15;
    for (const entry of ledger.filter((entry) => entry.verification && entry.probePhase === phase)) {
      if (entry.probeVerified !== expectedVerified || entry.proof !== expectedProofs[expectedVerified]) {
        violations.push(`${phase} verification proof differs from expected stage`);
      }
    }
  }
  return {
    passed: violations.length === 0, violations,
    fileIntegrityPassed: !violations.some((violation) => violation.startsWith('result.json')
      || violation.includes('differs from input-derived expected result')),
    executionIntegrityPassed: Array.from({ length: expectedStep }, (_, index) => index + 1)
      .every((step) => executionCounts[step] === 1),
    phaseVerificationPassed: !violations.some((violation) => expectedPhases
      .some((phase) => violation.startsWith(`${phase} verification`))),
    expectedProof: proof, actualProof: result?.proof, expectedProofs,
    executionCounts, verificationCounts,
    duplicates: ledger.filter((entry) => entry.duplicate), ledger,
  };
}
