/** Reconvert an actual failed Codex attempt's next request without calling a model.
 * Run from the repository root with pnpm --filter @kiro2claude/core exec tsx ...
 * Paths can be overridden to audit other recorded sessions. Original evidence is read only.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { convertRequest } from '../../src/claude/converter.js';
import { convertResponsesRequest } from '../../src/openai/responses/converter.js';
import type { ResponsesRequest } from '../../src/openai/responses/types.js';

const source = resolve(
  process.env.K2C_HISTORY_REPLAY_SOURCE ??
    '../../test-results/conversation-integrity-2026-09-07/server/codex-coding-live-mixed-a71235d3.json',
);
const destination = resolve(
  process.env.K2C_HISTORY_REPLAY_REPORT ??
    '../../test-results/conversation-fixes-2026-09-07/actual-codex-prefix-replay.json',
);
const sourceBytes = await readFile(source);
const run = JSON.parse(sourceBytes.toString());
const requestId = Number(process.env.K2C_HISTORY_REPLAY_REQUEST ?? 7);
const record = run.requests.find((item: { id: number }) => item.id === requestId);
if (!record) throw new Error(`No recorded request ${requestId}`);
const trailing = record.request.input.at(-1);
if (trailing?.role !== 'assistant' || !Array.isArray(trailing.content))
  throw new Error('The selected request does not end in an assistant message');
const prefixes = trailing.content
  .filter((item: { type: string; text?: unknown }) => item.type === 'output_text')
  .map((item: { text: string }) => item.text);
if (prefixes.length === 0) throw new Error('No output_text prefix to inspect');
const oldUpstream = record.upstreamRequests.map((item: { request: unknown }) => item.request);
const converted = convertResponsesRequest(record.request as ResponsesRequest);
const newUpstream = convertRequest(converted.payload, { identityOverride: false });
const strings = (value: unknown): string[] => {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
};
const oldStrings = strings(oldUpstream);
const newStrings = strings(newUpstream);
const observations = prefixes.map((prefix: string) => ({
  bytes: Buffer.byteLength(prefix),
  sha256: createHash('sha256').update(prefix).digest('hex'),
  clientContainsExactPrefix: true,
  originalConversionContainsExactPrefix: oldStrings.some((value) => value.includes(prefix)),
  repairedConversionContainsExactPrefix: newStrings.some((value) => value.includes(prefix)),
}));
const passed = observations.every(
  (item: { repairedConversionContainsExactPrefix: boolean }) =>
    item.repairedConversionContainsExactPrefix,
);
await mkdir(dirname(destination), { recursive: true });
await writeFile(
  destination,
  `${JSON.stringify(
    {
      source,
      sourceSha256: createHash('sha256').update(sourceBytes).digest('hex'),
      runId: run.id,
      requestId,
      observations,
      passed,
      scope:
        'Actual saved client request through current converters; no new model inference or CLI execution. This proves conversion preservation, not model recall or factual correctness of assistant text.',
      repairedUpstream: newUpstream,
    },
    null,
    2,
  )}\n`,
);
console.log(JSON.stringify({ runId: run.id, requestId, observations, passed, destination }));
if (!passed) process.exitCode = 1;
