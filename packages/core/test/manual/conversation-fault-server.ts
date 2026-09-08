/** Real gateway conversion/transport around an evidence-driven, scripted upstream.
 * The upstream advances ONLY from tool receipts present in its incoming history.
 * It never reads the workspace and cannot declare success from a request count.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { AxiosResponse } from 'axios';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { createPostMessages } from '../../src/claude/handlers.js';
import type { KiroProvider } from '../../src/kiro/provider.js';
import { ProviderError } from '../../src/kiro/provider-error.js';
import { createPostResponses } from '../../src/openai/responses/handlers.js';
import { HookBus } from '../../src/plugin-host/index.js';
import {
  buildAssistantResponseFrame,
  buildExceptionFrame,
  buildMetadataFrame,
  buildReasoningContentFrame,
  buildRedactedReasoningFrame,
  buildToolUseFrame,
} from '../helpers/event-stream.js';

type Obj = Record<string, any>;
type Run = {
  id: string;
  protocol: 'claude' | 'codex';
  scenario: string;
  requests: Obj[];
  faults: Obj[];
  state: Obj;
};
const runs = new Map<string, Run>();
const reportDir = resolve(
  process.env.K2C_CONVERSATION_REPORT_DIR ??
    '../../test-results/conversation-integrity-2026-09-07/server',
);
await mkdir(reportDir, { recursive: true });
const app = Fastify({ logger: false, bodyLimit: 50 * 1024 * 1024 });
app.post<{ Body: { id: string; protocol: 'claude' | 'codex'; scenario: string } }>(
  '/probe/runs',
  async (req, reply) => {
    const { id, protocol, scenario } = req.body;
    if (!/^[a-z0-9_-]+$/i.test(id) || !['claude', 'codex'].includes(protocol))
      return reply.status(400).send({ error: 'Invalid run' });
    if (runs.has(id)) return reply.status(409).send({ error: 'Run already exists' });
    const run: Run = { id, protocol, scenario, requests: [], faults: [], state: {} };
    runs.set(id, run);
    return { id };
  },
);
app.get<{ Params: { id: string } }>(
  '/probe/runs/:id',
  async (req, reply) => runs.get(req.params.id) ?? reply.status(404).send({ error: 'Unknown run' }),
);

function resultStrings(value: unknown, strings: string[] = []): string[] {
  if (Array.isArray(value)) for (const item of value) resultStrings(item, strings);
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key === 'toolResults') strings.push(JSON.stringify(item).replace(/\\+"/g, '"'));
      else resultStrings(item, strings);
    }
  }
  return strings;
}
function observedReceipts(body: Obj) {
  const strings = resultStrings(body);
  const steps: number[] = [];
  const verified: { phase: string; steps: number; proof: string }[] = [];
  for (const raw of strings) {
    for (const m of raw.matchAll(/"probeStep"\s*:\s*(\d+)/g)) steps.push(Number(m[1]));
    for (const m of raw.matchAll(/\{[^{}]*"probeVerified"[^{}]*\}/g)) {
      try {
        const v = JSON.parse(m[0]);
        verified.push({ phase: v.probePhase, steps: v.probeVerified, proof: v.proof });
      } catch {
        /* unrelated tool output */
      }
    }
  }
  return { steps: [...new Set(steps)].sort((a, b) => a - b), verified };
}
function phaseOf(body: Obj) {
  const all = [...JSON.stringify(body).matchAll(/LONG_PHASE:(build|extend|audit)/g)];
  return all.at(-1)?.[1] ?? 'build';
}
function callFrame(
  protocol: Run['protocol'],
  step: number | string,
  callId: string,
  complete = true,
) {
  const command = `node /workspace/probe-task.mjs ${step}`;
  const args =
    protocol === 'claude'
      ? { command, description: `Run receipt task ${step}`, timeout: 30000 }
      : {
          input: `const result = await tools.exec_command({cmd:${JSON.stringify(command)},max_output_tokens:2000}); text(result);`,
        };
  const json = JSON.stringify(args);
  return buildToolUseFrame(
    protocol === 'claude' ? 'Bash' : 'exec',
    callId,
    complete ? json : `${json.slice(0, Math.floor(json.length / 2))}DRAFT_PARAMETER_${callId}`,
    complete,
  );
}
function faultFor(run: Run, step: number): string | undefined {
  if (run.scenario === 'mixed')
    return (
      {
        3: 'empty',
        5: 'partial-tool',
        7: 'thinking-error',
        9: 'tool-error',
        11: 'text-error',
        13: 'overloaded',
      } as Record<number, string>
    )[step];
  if (step === 5 && run.scenario !== 'baseline') return run.scenario;
  return undefined;
}

async function handle(request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
  const run = runs.get(request.params.id);
  if (!run) return reply.status(404).send({ error: 'Unknown run' });
  const body = request.body as Obj;
  const isSideRequest =
    !JSON.stringify(body).includes('K2C_LONG_PROBE') ||
    JSON.stringify(body).includes('Write the title in the predominant language of the session');
  const record: Obj = {
    id: run.requests.length + 1,
    request: body,
    upstreamRequests: [],
    response: null,
    started: new Date().toISOString(),
  };
  record.phase = phaseOf(body);
  if (!isSideRequest) run.requests.push(record);
  const chunks: Buffer[] = [];
  const start = Date.now();
  const write = reply.raw.write;
  const end = reply.raw.end;
  reply.raw.write = function (this: typeof reply.raw, chunk, ...args: unknown[]) {
    if (typeof chunk === 'string' || Buffer.isBuffer(chunk)) chunks.push(Buffer.from(chunk));
    return Reflect.apply(write, this, [chunk, ...args]);
  } as typeof write;
  reply.raw.end = function (this: typeof reply.raw, chunk, ...args: unknown[]) {
    if (typeof chunk === 'string' || Buffer.isBuffer(chunk)) chunks.push(Buffer.from(chunk));
    return Reflect.apply(end, this, [chunk, ...args]);
  } as typeof end;
  let saved = false;
  const save = (closed: boolean) => {
    if (saved || isSideRequest) return;
    saved = true;
    if (!record.observed && record.upstreamRequests[0]?.request) {
      record.observed = observedReceipts(record.upstreamRequests[0].request);
    }
    record.response = {
      status: reply.raw.statusCode,
      body: Buffer.concat(chunks).toString(),
      durationMs: Date.now() - start,
      closed,
    };
    console.log(
      JSON.stringify({
        run: run.id,
        request: record.id,
        phase: record.phase,
        status: record.response.status,
        fault: record.fault,
        seenSteps: record.observed?.steps,
      }),
    );
    void writeFile(resolve(reportDir, `${run.id}.json`), `${JSON.stringify(run, null, 2)}\n`);
  };
  reply.raw.once('finish', () => save(false));
  reply.raw.once('close', () => save(true));
  const produce = (requestBody: string) => {
    if (isSideRequest) return [buildAssistantResponseFrame('Task session'), buildMetadataFrame()];
    const upstream = JSON.parse(requestBody);
    const seen = observedReceipts(upstream);
    const phase = phaseOf(body);
    const target = phase === 'build' ? 12 : 15;
    const missing = Array.from({ length: target }, (_, i) => i + 1).find(
      (step) => !seen.steps.includes(step),
    );
    record.phase = phase;
    record.observed = seen;
    const attempt: Obj = { request: upstream, seen, frameBase64: [] };
    record.upstreamRequests.push(attempt);
    const step = missing ?? target + 1;
    const fault = faultFor(run, step);
    const faultKey = run.scenario.endsWith('-once')
      ? `${step}:${fault}`
      : `${phase}:${step}:${fault}`;
    let frames: Buffer[];
    if (fault && !run.faults.some((f) => f.key === faultKey)) {
      run.faults.push({ key: faultKey, phase, step, kind: fault, request: record.id });
      record.fault = fault;
      const id = `fault_${step}_${record.id}`;
      const error = buildExceptionFrame('ThrottlingException', `injected ${fault}`);
      if (fault === 'overloaded')
        throw new ProviderError({ kind: 'transient', status: 503 }, 'injected capacity rejection');
      if (fault === 'empty') frames = [];
      else if (fault === 'partial-tool') frames = [callFrame(run.protocol, step, id, false)];
      else if (fault === 'tool-error') frames = [callFrame(run.protocol, step, id), error];
      else if (fault === 'thinking-error')
        frames = [
          buildReasoningContentFrame(
            `THOUGHT_FRAGMENT_${step}: retain the receipts; step ${step} has NOT run.`,
            `fake-signature-${step}`,
          ),
          error,
        ];
      else if (fault === 'thinking-eof-once')
        frames = [
          buildReasoningContentFrame(
            `THOUGHT_EOF_${step}: the next required operation has not run; planning is unfinished.`,
            `fake-signature-${step}`,
          ),
        ];
      else if (fault === 'crc-error') {
        const corrupt = buildAssistantResponseFrame(`MISSING_NEGATION_${step}: NOT`);
        corrupt[corrupt.length - 1]! ^= 1;
        frames = [
          buildAssistantResponseFrame(`CRC_PREFIX_${step}: the next operation has `),
          corrupt,
          buildAssistantResponseFrame(`CRC_SUFFIX_${step}: succeeded.`),
          callFrame(run.protocol, step, `after_corruption_${id}`),
        ];
      } else if (fault === 'text-error')
        frames = [
          buildAssistantResponseFrame(
            `UNVERIFIED_CLAIM_${step}: step ${step} is done. This claim has no tool receipt yet.`,
          ),
          error,
        ];
      else if (fault === 'redacted-error')
        frames = [buildRedactedReasoningFrame('synthetic-private-state'), error];
      else if (fault === 'text-eof' || fault === 'text-eof-once')
        frames = [
          buildAssistantResponseFrame(`PARTIAL_ANSWER_${step}: the next required operation is`),
        ];
      else if (fault === 'tool-then-partial')
        frames = [
          callFrame(run.protocol, step, id),
          callFrame(run.protocol, step + 1, `${id}_next`, false),
        ];
      else frames = [error];
    } else if (missing) {
      // Normal replies end with the real completion marker (metadataEvent); the
      // `text-eof` / `thinking-eof-once` faults above omit it, exactly like the
      // one audited real response that stopped mid-generation.
      frames = [
        buildReasoningContentFrame(
          `THOUGHT_VALID_${missing}: step ${missing} follows observed receipts ${seen.steps.join(',')}.`,
          `fake-signature-${missing}`,
        ),
        callFrame(run.protocol, missing, `step_${missing}_${record.id}`),
        buildMetadataFrame(),
      ];
    } else if (!seen.verified.some((v) => v.phase === phase && v.steps === target)) {
      frames = [
        callFrame(run.protocol, `verify ${phase}`, `verify_${phase}_${record.id}`),
        buildMetadataFrame(),
      ];
    } else {
      const receipt = seen.verified.findLast((v) => v.phase === phase && v.steps === target)!;
      frames = [
        buildAssistantResponseFrame(
          `LONG_PHASE_DONE:${phase} steps=${target} proof=${receipt.proof}`,
        ),
        buildMetadataFrame(),
      ];
      run.state[phase] = {
        complete: true,
        observedSteps: seen.steps,
        proof: receipt.proof,
        request: record.id,
      };
    }
    attempt.frameBase64 = frames.map((frame) => frame.toString('base64'));
    return frames;
  };
  const scriptedProvider = {
    async callApiStream(requestBody: string) {
      const frames = produce(requestBody);
      return {
        status: 200,
        headers: {},
        data: (async function* () {
          // Let completed tools reach the client before a later fault: yielding
          // one concatenated buffer would hide real execution-vs-error races.
          for (const frame of frames) {
            yield frame;
            await delay(150);
          }
        })(),
      } as AxiosResponse;
    },
    async callApi(requestBody: string) {
      return {
        status: 200,
        headers: {},
        data: Buffer.concat(produce(requestBody)),
      } as AxiosResponse;
    },
  } as unknown as KiroProvider;
  const provider =
    run.scenario.startsWith('live-') && !isSideRequest
      ? ((await import('./_live-conversation-provider.js')).createLiveProvider(
          record,
          run,
        ) as unknown as KiroProvider)
      : scriptedProvider;
  const deps = {
    kiroProvider: provider,
    hookBus: new HookBus(),
    extractThinking: true,
    identityOverride: false,
    rejectUnsupportedDocuments: true,
    toolDescriptionMaxLen: 32768,
    abortUpstreamOnDisconnect: false,
    emptyStreamRetries: 0,
    toolCallTextRescue: true,
  };
  await (run.protocol === 'claude' ? createPostMessages(deps) : createPostResponses(deps))(
    request,
    reply,
  );
}
app.post('/run/:id/claude/v1/messages', handle);
app.post('/run/:id/openai/v1/responses', handle);
app.post('/run/:id/claude/v1/messages/count_tokens', async () => ({ input_tokens: 1000 }));
const address = await app.listen({
  port: Number(process.env.K2C_CONVERSATION_PORT ?? 18941),
  host: '0.0.0.0',
});
console.log(`CONVERSATION_PROBE_READY ${address}`);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, async () => {
    await app.close();
    process.exit(0);
  });
