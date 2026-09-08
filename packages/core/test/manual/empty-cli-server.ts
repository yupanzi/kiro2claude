/**
 * Fault injection through the real gateway routes/decoders/encoders, with no
 * upstream account or credentials. Run with pnpm --filter @kiro2claude/core
 * exec tsx test/manual/empty-cli-server.ts, then run the CLI probe scripts.
 * Each protocol/scenario owns its own counters; runners reset their own cases.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { AxiosResponse } from 'axios';
import Fastify from 'fastify';
import type { KiroProvider } from '../../src/kiro/provider.js';
import { HookBus } from '../../src/plugin-host/index.js';
import { registerClaudeRoutes } from '../../src/routes/claude.js';
import { registerOpenAiRoutes } from '../../src/routes/openai.js';
import {
  buildAssistantResponseFrame,
  buildMetadataFrame,
  buildRedactedReasoningFrame,
  buildToolUseFrame,
} from '../helpers/event-stream.js';

const scenarios = [
  'empty-recover',
  'exhausted-recover',
  'slow-empty-recover',
  'truncated-only-recover',
  'redacted-only-recover',
  'shell-recover',
  'empty-always',
  'slow-empty-always',
  'truncated-only-always',
];
const reportDir = resolve(
  process.env.K2C_PROBE_REPORT_DIR ?? '../../test-results/empty-response-2026-09-07',
);
await mkdir(reportDir, { recursive: true });
const stats: Record<string, { attempts: unknown[]; requests: unknown[] }> = {};
const app = Fastify({ logger: false });
// Claude Code also sends a session-title request containing the user's prompt.
// Matching only the marker lets that side request consume the injected fault.
function isProbeRequest(serialized: string): boolean {
  return (
    serialized.includes('EMPTY_PROBE_RECOVERED') &&
    !serialized.includes('Write the title in the predominant language of the session')
  );
}
app.get('/probe/stats', async () => stats);
app.post<{ Body: { scenario: string; protocol: string } }>(
  '/probe/reset',
  async (request, reply) => {
    const state = stats[`${request.body.scenario}/${request.body.protocol}`];
    if (!state) return reply.status(404).send({ error: 'Unknown probe case' });
    state.attempts.length = 0;
    state.requests.length = 0;
    return { reset: true };
  },
);

for (const scenario of scenarios) {
  for (const protocol of ['claude', 'codex']) {
    const key = `${scenario}/${protocol}`;
    const state = { attempts: [] as unknown[], requests: [] as unknown[] };
    stats[key] = state;
    await app.register(
      async (instance) => {
        instance.addHook('onRequest', async (request, reply) => {
          if (request.method !== 'POST' || request.url.includes('count_tokens')) return;
          const start = Date.now();
          const chunks: Buffer[] = [];
          const originalWrite = reply.raw.write;
          const originalEnd = reply.raw.end;
          reply.raw.write = function (chunk, ...args: unknown[]) {
            if (typeof chunk === 'string' || Buffer.isBuffer(chunk))
              chunks.push(Buffer.from(chunk));
            return Reflect.apply(originalWrite, this, [chunk, ...args]);
          } as typeof originalWrite;
          reply.raw.end = function (chunk, ...args: unknown[]) {
            if (typeof chunk === 'string' || Buffer.isBuffer(chunk))
              chunks.push(Buffer.from(chunk));
            return Reflect.apply(originalEnd, this, [chunk, ...args]);
          } as typeof originalEnd;
          reply.raw.once('finish', () => {
            // Claude Code issues a separate warmup request at startup. It must
            // neither consume a fault nor make the main request look recovered.
            if (!isProbeRequest(JSON.stringify(request.body) ?? '')) return;
            const result = {
              status: reply.raw.statusCode,
              durationMs: Date.now() - start,
              body: Buffer.concat(chunks).toString('utf8'),
            };
            state.requests.push(result);
            console.log(JSON.stringify({ key, ...result }));
          });
        });
        const next = (requestBody: string) => {
          if (!isProbeRequest(requestBody)) {
            return {
              frames: [buildAssistantResponseFrame('WARMUP_NO_FAULT'), buildMetadataFrame()],
              waitMs: 0,
            };
          }
          const attempt = state.attempts.length + 1;
          const failing =
            scenario.endsWith('always') || attempt <= (scenario === 'exhausted-recover' ? 3 : 1);
          const frames = failing
            ? scenario.startsWith('truncated')
              ? [
                  buildToolUseFrame(
                    protocol === 'claude' ? 'Read' : 'exec',
                    'toolu_incomplete',
                    '{"input":"DO_NOT_EXECUTE',
                    false,
                  ),
                ]
              : scenario.startsWith('redacted')
                ? [buildRedactedReasoningFrame()]
                : scenario.startsWith('shell')
                  ? [
                      buildToolUseFrame(
                        protocol === 'claude' ? 'Read' : 'exec',
                        'toolu_incomplete',
                        '',
                        false,
                      ),
                    ]
                  : []
            : [buildAssistantResponseFrame('EMPTY_PROBE_RECOVERED'), buildMetadataFrame()];
          const waitMs = failing && scenario.startsWith('slow') ? 16_000 : 0;
          state.attempts.push({ attempt, failing, waitMs, frameCount: frames.length });
          return { frames, waitMs };
        };
        const provider = {
          async callApiStream(requestBody: string) {
            const { frames, waitMs } = next(requestBody);
            const data = (async function* () {
              if (waitMs) await delay(waitMs);
              yield* frames;
            })();
            return { data, status: 200, headers: {} } as AxiosResponse;
          },
          async callApi(requestBody: string) {
            const { frames, waitMs } = next(requestBody);
            if (waitMs) await delay(waitMs);
            return { data: Buffer.concat(frames), status: 200, headers: {} } as AxiosResponse;
          },
        } as unknown as KiroProvider;
        const deps = {
          apiKey: 'empty-probe-key',
          kiroProvider: provider,
          extractThinking: true,
          identityOverride: false,
          rejectUnsupportedDocuments: true,
          toolDescriptionMaxLen: 32768,
          abortUpstreamOnDisconnect: false,
          emptyStreamRetries: scenario === 'exhausted-recover' ? 2 : 0,
          toolCallTextRescue: false,
          hookBus: new HookBus(),
        };
        if (protocol === 'claude') await registerClaudeRoutes(instance, deps);
        else await registerOpenAiRoutes(instance, deps);
      },
      { prefix: `/case/${scenario}/${protocol === 'claude' ? 'claude' : 'openai'}/v1` },
    );
  }
}

const address = await app.listen({
  port: Number(process.env.K2C_PROBE_PORT ?? 18931),
  host: '0.0.0.0',
});
console.log(`EMPTY_CLI_PROBE_READY ${address}`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await app.close();
    await writeFile(
      resolve(reportDir, 'gateway-stats.json'),
      `${JSON.stringify(stats, null, 2)}\n`,
    );
    process.exit(0);
  });
}
