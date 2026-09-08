/**
 * Codex multi-agent v2 (subagent) end-to-end probe: real gateway routes/encoders,
 * real Codex CLI, NO upstream account — nothing is billed.
 *
 * Four mounts. `no-expand` is the plain gateway; the other three each simulate one
 * half of the fix, which is what isolated the root cause originally:
 *   /case/no-expand/...  untouched — now exercises the SHIPPED implementation
 *   /case/expand/...     probe flattens `collaboration` in the request only
 *   /case/ns-only/...    probe injects the outbound `namespace` field only
 *   /case/ns-restore/... probe does both
 *
 * Each mount dispatches the SAME `spawn_agent` call back to the client; the answer
 * is in the client's `function_call_output`. 2026-09-07 on Codex 0.153.4:
 * expanding alone still gave `unsupported call: spawn_agent`, while the outbound
 * `namespace` field alone created a real sub-agent — the field, not the expansion,
 * is what the client's tool router dispatches on.
 *
 * Two further signals, both silent failures before the fix:
 *   - the sub-thread's follow-up request carries an `agent_message` NEW_TASK
 *     envelope (see `envelopes`), which used to be dropped as an unknown item;
 *   - `taskBodyReachedUpstream` proves the task body survived into the upstream
 *     request instead of the sub-thread starting with an empty Payload.
 *
 * `K2C_SUBAGENT_TOOL=exec` is the required control: it must really run
 * `echo CONTROL_OK` with `exit_code:0`. A refusal there means this harness is
 * broken, not that the tool is unsupported.
 *
 * Requires `agents.enabled = true` in the client config (the tools/codex harness
 * default does NOT set it). Command lines: tools/codex/README.md subagent section.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AxiosResponse } from 'axios';
import Fastify from 'fastify';
import type { KiroProvider } from '../../src/kiro/provider.js';
import { HookBus } from '../../src/plugin-host/index.js';
import { registerOpenAiRoutes } from '../../src/routes/openai.js';
import {
  buildAssistantResponseFrame,
  buildToolUseFrame,
  completedFrames,
} from '../helpers/event-stream.js';

type Obj = Record<string, any>;

const reportDir = resolve(
  process.env.K2C_SUBAGENT_REPORT_DIR ?? '../../test-results/codex-subagent-probe',
);
await mkdir(reportDir, { recursive: true });

/** Which tool the first response dispatches. `exec` is the known-good control. */
const dispatchTool = process.env.K2C_SUBAGENT_TOOL ?? 'spawn_agent';
/** Unique token inside the spawned task body; presence upstream = envelope survived. */
const TASK_BODY_MARKER = 'SUBAGENT_OK';

const dispatchInput =
  dispatchTool === 'exec'
    ? JSON.stringify({
        input: 'const r = await tools.exec_command({cmd:"echo CONTROL_OK"}); text(r);',
      })
    : JSON.stringify({
        task_name: 'probe',
        fork_turns: 'none',
        message: `Reply with the single word ${TASK_BODY_MARKER}.`,
      });

const COLLAB_TOOLS = new Set([
  'spawn_agent',
  'wait_agent',
  'list_agents',
  'send_message',
  'followup_task',
  'interrupt_agent',
]);

/** Tag every function_call item naming a collaboration tool. Returns true if any changed. */
function tagNamespace(node: unknown): boolean {
  if (Array.isArray(node)) return node.map(tagNamespace).some(Boolean);
  if (!node || typeof node !== 'object') return false;
  const obj = node as Obj;
  let changed = false;
  if (obj.type === 'function_call' && typeof obj.name === 'string' && COLLAB_TOOLS.has(obj.name)) {
    obj.namespace = 'collaboration';
    changed = true;
  }
  for (const value of Object.values(obj)) if (tagNamespace(value)) changed = true;
  return changed;
}

/**
 * The client routes a collaboration call by its `namespace` field, which the
 * gateway's Responses encoder never emits. `ns-restore` injects it into the SSE
 * on the way out, so the ONLY difference from `expand` is that one field.
 * Rewrites whole `data:` lines rather than the raw text: field order is an
 * encoder detail, and a string patch would silently stop matching if it changed.
 */
function restoreNamespace(chunk: string): string {
  if (!chunk.includes('"function_call"')) return chunk;
  return chunk
    .split('\n')
    .map((line) => {
      if (!line.startsWith('data: ')) return line;
      try {
        const payload = JSON.parse(line.slice(6));
        return tagNamespace(payload) ? `data: ${JSON.stringify(payload)}` : line;
      } catch {
        return line;
      }
    })
    .join('\n');
}

const cases = ['no-expand', 'expand', 'ns-restore', 'ns-only'] as const;
const log: Record<string, Obj[]> = {};
const app = Fastify({ logger: false, bodyLimit: 32 * 1024 * 1024 });

app.get('/probe/log', async () => log);

/** Flatten the collaboration namespace in place, mirroring an "expand everything" gateway. */
function expandCollaboration(body: Obj): number {
  let expanded = 0;
  const flatten = (list: any[]): any[] =>
    list.flatMap((t) => {
      if (t?.type === 'namespace' && t.name === 'collaboration' && Array.isArray(t.tools)) {
        expanded += t.tools.length;
        return t.tools;
      }
      return [t];
    });
  if (Array.isArray(body.tools)) body.tools = flatten(body.tools);
  for (const item of Array.isArray(body.input) ? body.input : []) {
    if (item && typeof item === 'object' && Array.isArray(item.tools))
      item.tools = flatten(item.tools);
  }
  return expanded;
}

/** Names of tools the client offered, across both wire shapes. */
function offeredTools(body: Obj): string[] {
  const names: string[] = [];
  const walk = (list: any[]): void => {
    for (const t of list ?? []) {
      if (t?.type === 'namespace')
        names.push(`${t.name}[${(t.tools ?? []).map((s: any) => s.name).join(',')}]`);
      else if (t?.name) names.push(t.name);
    }
  };
  walk(body.tools ?? []);
  for (const item of Array.isArray(body.input) ? body.input : []) {
    if (item && typeof item === 'object' && Array.isArray(item.tools)) walk(item.tools);
  }
  return names;
}

/**
 * Sub-thread envelopes the gateway must survive: NEW_TASK carries the task body
 * in `encrypted_content`, on an item type the converter has never seen.
 */
function envelopes(body: Obj): Obj[] {
  const found: Obj[] = [];
  for (const item of Array.isArray(body.input) ? body.input : []) {
    if (!item || typeof item !== 'object') continue;
    const parts = Array.isArray(item.content) ? item.content : [];
    const partTypes = parts.map((p: any) => p?.type);
    const isNewTask = parts.some(
      (p: any) => typeof p?.text === 'string' && p.text.includes('NEW_TASK'),
    );
    if (isNewTask || partTypes.includes('encrypted_content') || item.type === 'agent_message') {
      found.push({
        itemType: item.type,
        author: item.author,
        recipient: item.recipient,
        partTypes,
        newTask: isNewTask,
        // Body itself is not logged; only whether it survived as readable text.
        encryptedPartCount: partTypes.filter((t: string) => t === 'encrypted_content').length,
      });
    }
  }
  return found;
}

/** What the client sent back for a dispatched call — executed result or refusal. */
function callOutputs(body: Obj): Obj[] {
  const out: Obj[] = [];
  for (const item of Array.isArray(body.input) ? body.input : []) {
    if (item && typeof item === 'object' && String(item.type).includes('call_output')) {
      out.push({ type: item.type, call_id: item.call_id, output: item.output });
    }
  }
  return out;
}

for (const kind of cases) {
  log[kind] = [];
  const state = { requests: 0, outputs: 0 };
  await app.register(
    async (instance) => {
      // ns-restore adds the outbound `namespace` field on top of expand;
      // ns-only adds it WITHOUT expanding, isolating which half does the work.
      if (kind === 'ns-restore' || kind === 'ns-only') {
        instance.addHook('onRequest', async (_request, reply) => {
          const originalWrite = reply.raw.write;
          reply.raw.write = function (chunk, ...args: unknown[]) {
            const patched =
              typeof chunk === 'string' || Buffer.isBuffer(chunk)
                ? restoreNamespace(Buffer.from(chunk as string | Buffer).toString('utf8'))
                : chunk;
            return Reflect.apply(originalWrite, this, [patched, ...args]);
          } as typeof originalWrite;
        });
      }

      instance.addHook('preHandler', async (request) => {
        const body = request.body as Obj;
        if (!body || typeof body !== 'object') return;
        const expanded = kind === 'no-expand' || kind === 'ns-only' ? 0 : expandCollaboration(body);
        state.requests += 1;
        const outputs = callOutputs(body);
        state.outputs = outputs.length;
        const entry = {
          n: state.requests,
          expandedSubTools: expanded,
          offered: offeredTools(body),
          envelopes: envelopes(body),
          outputs,
        };
        log[kind].push(entry);
        console.log(JSON.stringify({ case: kind, ...entry }));
      });

      // Dispatch the call on the first turn only. `exec`'s own description quotes
      // "function_call_output", so scanning the body for that string would report
      // a reply that never happened; the client's actual reply is in state.outputs.
      const nextFrames = (): Buffer[] =>
        state.outputs === 0
          ? completedFrames(buildToolUseFrame(dispatchTool, `call_${kind}_1`, dispatchInput, true))
          : completedFrames(buildAssistantResponseFrame('PROBE_ROUND_TRIP_DONE'));

      /**
       * The decisive end-to-end check: did the sub-thread's task body survive all
       * the way into the UPSTREAM request? Dropping the NEW_TASK envelope is silent
       * — the sub-thread simply starts with an empty Payload. Only the marker is
       * recorded, never the body (log rule: no prompts / sub-task text).
       */
      const recordTaskBodyDelivery = (requestBody: string): void => {
        if (!requestBody.includes(TASK_BODY_MARKER)) return;
        const entry = log[kind]?.at(-1);
        if (entry) entry.taskBodyReachedUpstream = true;
        console.log(JSON.stringify({ case: kind, taskBodyReachedUpstream: true }));
      };

      const provider = {
        async callApiStream(requestBody: string) {
          recordTaskBodyDelivery(requestBody);
          const frames = nextFrames();
          const data = (async function* () {
            yield* frames;
          })();
          return { data, status: 200, headers: {} } as AxiosResponse;
        },
        async callApi(requestBody: string) {
          recordTaskBodyDelivery(requestBody);
          return { data: Buffer.concat(nextFrames()), status: 200, headers: {} } as AxiosResponse;
        },
      } as unknown as KiroProvider;

      await registerOpenAiRoutes(instance, {
        apiKey: 'subagent-probe-key',
        kiroProvider: provider,
        extractThinking: true,
        identityOverride: false,
        rejectUnsupportedDocuments: true,
        toolDescriptionMaxLen: 32768,
        abortUpstreamOnDisconnect: false,
        emptyStreamRetries: 0,
        toolCallTextRescue: false,
        hookBus: new HookBus(),
      });
    },
    { prefix: `/case/${kind}/openai/v1` },
  );
}

const address = await app.listen({
  port: Number(process.env.K2C_SUBAGENT_PORT ?? 18961),
  host: '0.0.0.0',
});
console.log(`CODEX_SUBAGENT_PROBE_READY ${address} dispatching=${dispatchTool}`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await app.close();
    await writeFile(
      resolve(reportDir, `${dispatchTool}-log.json`),
      `${JSON.stringify(log, null, 2)}\n`,
    );
    process.exit(0);
  });
}
