/**
 * 原生 reasoning / system wire 字段探针(手工,💰 打真实上游,不进 CI)。
 *
 * 用网关自己的上游层(同一 target)逐项验证上游接不接受、执不执行这些字段:effort 的放法、
 * `thinking.type` / `display`、顶层 `systemPrompt`、history `reasoningContent` 的正常 / 坏签名 /
 * 无签名回传,以及 KAS 用的 `KiroRuntimeService` target。结论见 PITFALLS「原生 reasoning /
 * effort / system 的 wire 真相」。每个场景一次上游调用;`K2C_PROBE_ONLY=a,b` 挑场景,
 * `K2C_PROBE_PROMPT` 换题,`K2C_PROBE_MODEL` 换模型。
 *
 * ```bash
 * cd packages/core && npx tsx test/manual/reasoning-wire-probe.ts
 * ```
 */

import { randomUUID } from 'node:crypto';
import https from 'node:https';
import { type Event, eventFromFrame } from '../../src/kiro/model/events/base.js';
import { parseFrame } from '../../src/kiro/parser/frame.js';
import { KiroProvider } from '../../src/kiro/provider.js';
import { ProviderError } from '../../src/kiro/provider-error.js';
import { createRealUpstream } from './_real-provider.js';

type Obj = Record<string, unknown>;

const MODEL = process.env.K2C_PROBE_MODEL ?? 'claude-opus-5';
const GPT_MODEL = process.env.K2C_PROBE_GPT_MODEL ?? 'gpt-5.6-luna';
const ONLY = new Set((process.env.K2C_PROBE_ONLY ?? '').split(',').filter(Boolean));

const PUZZLE =
  process.env.K2C_PROBE_PROMPT ??
  'Two puzzles. (1) A bat and a ball cost $1.10 in total; the bat costs $1.00 more than the ball. ' +
    '(2) A snail climbs a 10 m well: 3 m up each day, slips 2 m each night; on which day does it reach the top? ' +
    'Reply with ONLY two integers separated by a comma: ball cost in cents, then the day number.';
const NONCE = 'PINEAPPLE-7731';
const CAPITAL_Q = 'What is the capital of France? One word.';

const { provider, tokenManager } = createRealUpstream();

function userMessage(content: string, modelId: string, extra: Obj = {}): Obj {
  return {
    content,
    modelId,
    origin: 'KIRO_CLI',
    userInputMessageContext: {
      toolResults: [],
      tools: [],
      envState: { operatingSystem: 'macos', currentWorkingDirectory: '/tmp/probe' },
    },
    ...extra,
  };
}

function body(current: Obj, history: Obj[] = [], top: Obj = {}): string {
  return JSON.stringify({
    conversationState: {
      conversationId: randomUUID(),
      agentContinuationId: randomUUID(),
      agentTaskType: 'vibe',
      chatTriggerType: 'MANUAL',
      currentMessage: { userInputMessage: current },
      history,
    },
    ...top,
  });
}

interface Summary {
  status: number | string;
  reasoningFrames: number;
  reasoningChars: number;
  signature?: string;
  /** GPT 加密 reasoning 的 base64 累积;非空即可直接回传 `reasoningContent.redactedContent`。 */
  redactedText: string;
  text: string;
  stopReason?: string;
  credits?: number;
  ms: number;
  errorBody?: string;
  reasoningText: string;
}

function emptySummary(): Summary {
  return {
    status: 0,
    reasoningFrames: 0,
    reasoningChars: 0,
    redactedText: '',
    text: '',
    ms: 0,
    reasoningText: '',
  };
}

/** 唯一的帧遍历:把一整段 event-stream 累进 Summary(两种传输共用)。 */
function drainFrames(raw: Buffer, s: Summary): void {
  let buf = raw;
  while (buf.length > 0) {
    const r = parseFrame(buf);
    if (!r) break;
    buf = buf.subarray(r.consumed);
    let ev: Event;
    try {
      ev = eventFromFrame(r.frame);
    } catch {
      continue;
    }
    switch (ev.kind) {
      case 'ReasoningContent':
        if (ev.text) {
          s.reasoningFrames += 1;
          s.reasoningChars += ev.text.length;
          s.reasoningText += ev.text;
        }
        if (ev.signature) s.signature = ev.signature;
        if (ev.redactedContent) s.redactedText += ev.redactedContent;
        break;
      case 'AssistantResponse':
        s.text += ev.content;
        break;
      case 'Metadata':
        s.stopReason = ev.stopReason;
        break;
      case 'Metering':
        s.credits = ev.usage;
        break;
      case 'Error':
      case 'Exception':
        s.errorBody = JSON.stringify(ev);
        break;
      default:
        break;
    }
  }
}

type Transport = (requestBody: string) => Promise<Summary>;

/** 走网关自己的 provider(codewhispererstreaming target、重试头、profileArn 注入全同 runtime)。 */
const viaProvider: Transport = async (requestBody) => {
  const t0 = Date.now();
  const s = emptySummary();
  try {
    const res = await provider.callApiStream(requestBody);
    s.status = res.status;
    const chunks: Buffer[] = [];
    for await (const c of res.data as AsyncIterable<Buffer>) chunks.push(Buffer.from(c));
    drainFrames(Buffer.concat(chunks), s);
  } catch (error) {
    if (error instanceof ProviderError) {
      s.status = `ProviderError:${JSON.stringify(error.kind)}`;
      s.errorBody = error.body.slice(0, 600);
    } else {
      s.status = `Error:${(error as Error).message}`;
    }
  }
  s.ms = Date.now() - t0;
  return s;
};

/**
 * 直接以 KAS 用的 `KiroRuntimeService.GenerateAssistantResponse` target 发同一 body
 * (网关 provider 把 target 钉死在 codewhispererstreaming),看新命名空间接不接受
 * `systemPrompt` 等字段。只用于探针,不进 runtime。
 */
const viaKiroRuntime: Transport = async (requestBody) => {
  const ctx = await tokenManager.acquireContext();
  const payload = KiroProvider.injectProfileArn(requestBody, ctx.credentials.profileArn);
  const t0 = Date.now();
  const s = emptySummary();
  const raw = await new Promise<{ status: number; buf: Buffer }>((resolve, reject) => {
    const req = https.request(
      {
        host: 'runtime.us-east-1.kiro.dev',
        path: '/',
        method: 'POST',
        headers: {
          'content-type': 'application/x-amz-json-1.0',
          'x-amz-target': 'KiroRuntimeService.GenerateAssistantResponse',
          'x-amzn-codewhisperer-optout': 'true',
          'x-amzn-kiro-client-attribution': 'unrecognized',
          'x-amz-user-agent':
            'aws-sdk-js/1.0.0 KiroCLI/2.22.1 KAS/unknown os/macos md/appVersion-2.22.1 app/AmazonQ-For-CLI',
          'user-agent':
            'aws-sdk-js/1.0.0 ua/2.1 os/darwin#25.6.0 lang/js md/nodejs#22.22.2 api/kiroruntime#1.0.0 m/N KiroCLI/2.22.1 KAS/unknown os/macos md/appVersion-2.22.1 app/AmazonQ-For-CLI',
          authorization: `Bearer ${ctx.token}`,
          'content-length': String(Buffer.byteLength(payload)),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, buf: Buffer.concat(chunks) }));
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
  s.status = raw.status;
  if (raw.status === 200) drainFrames(raw.buf, s);
  else s.errorBody = raw.buf.toString('utf8').slice(0, 600);
  s.ms = Date.now() - t0;
  return s;
};

function show(name: string, s: Summary): void {
  const { reasoningText, redactedText, ...rest } = s;
  const sig = s.signature ? `${s.signature.slice(0, 16)}…(${s.signature.length})` : undefined;
  console.log(`\n### ${name}`);
  console.log(
    JSON.stringify({ ...rest, signature: sig, redactedLen: redactedText.length }, null, 1),
  );
  if (reasoningText) console.log('reasoning:', JSON.stringify(reasoningText.slice(0, 400)));
}

function want(name: string): boolean {
  return ONLY.size === 0 || ONLY.has(name);
}

async function main(): Promise<void> {
  const results: Record<string, Summary> = {};
  const run = async (
    name: string,
    rb: string,
    transport: Transport = viaProvider,
  ): Promise<Summary | undefined> => {
    if (!want(name)) return undefined;
    const s = await transport(rb);
    results[name] = s;
    show(name, s);
    return s;
  };
  const claudeTop = (effort: string, thinking: Obj = { type: 'adaptive' }): Obj => ({
    additionalModelRequestFields: { output_config: { effort }, thinking },
  });
  const systemTop: Obj = {
    systemPrompt: `You must end every reply with the exact token ${NONCE}.`,
  };

  // ── effort 三种放法 ─────────────────────────────────────────────
  await run('baseline', body(userMessage(PUZZLE, MODEL)));
  await run(
    'uim-reasoning-low',
    body(userMessage(PUZZLE, MODEL, { reasoning: { effort: 'low' } })),
  );
  await run(
    'uim-reasoning-max',
    body(userMessage(PUZZLE, MODEL, { reasoning: { effort: 'max' } })),
  );
  const amrfMax = await run('amrf-max', body(userMessage(PUZZLE, MODEL), [], claudeTop('max')));
  await run('amrf-low', body(userMessage(PUZZLE, MODEL), [], claudeTop('low')));
  await run(
    'amrf-disabled',
    body(userMessage(PUZZLE, MODEL), [], {
      additionalModelRequestFields: { thinking: { type: 'disabled' } },
    }),
  );
  await run(
    'amrf-max-display-omitted',
    body(
      userMessage(PUZZLE, MODEL),
      [],
      claudeTop('max', { type: 'adaptive', display: 'omitted' }),
    ),
  );

  // ── 顶层 systemPrompt 上游认不认(两个 target) ─────────────────────
  await run('system-prompt-top-level', body(userMessage(CAPITAL_Q, MODEL), [], systemTop));
  await run(
    'kiroruntime-plain',
    body(userMessage(PUZZLE, MODEL), [], { agentMode: 'vibe', ...claudeTop('max') }),
    viaKiroRuntime,
  );
  await run(
    'system-prompt-kiroruntime',
    body(userMessage(CAPITAL_Q, MODEL), [], { agentMode: 'vibe', ...systemTop }),
    viaKiroRuntime,
  );

  // ── history reasoningContent 回传 ──────────────────────────────
  if (amrfMax?.signature && amrfMax.reasoningText) {
    const seed = amrfMax;
    const hist = (sig: string | undefined) => [
      { userInputMessage: userMessage(PUZZLE, MODEL) },
      {
        assistantResponseMessage: {
          content: seed.text,
          reasoningContent: {
            reasoningText: { text: seed.reasoningText, ...(sig ? { signature: sig } : {}) },
          },
        },
      },
    ];
    const follow = userMessage(
      'Now double the first number you gave. Reply with ONLY that number.',
      MODEL,
    );
    const top = claudeTop('low');
    await run('history-signed', body(follow, hist(seed.signature), top));
    await run(
      'history-bad-signature',
      body(follow, hist(`${seed.signature.slice(0, -8)}AAAAAAAA`), top),
    );
    await run('history-unsigned', body(follow, hist(undefined), top));
    await run(
      'history-legacy-text',
      body(
        follow,
        [
          { userInputMessage: userMessage(PUZZLE, MODEL) },
          {
            assistantResponseMessage: {
              content: `<thinking>${seed.reasoningText}</thinking>\n\n${seed.text}`,
            },
          },
        ],
        top,
      ),
    );
  } else {
    console.log('\n(skip history-* : amrf-max 没拿到 signature)');
  }

  // ── GPT redactedContent 回传(seed 一次,回传一次) ────────────────
  if (want('gpt-redacted-roundtrip')) {
    const q = 'What is 6*7? Reply with ONLY the number.';
    const gptTop: Obj = { additionalModelRequestFields: { reasoning: { effort: 'low' } } };
    const seed = await viaProvider(body(userMessage(q, GPT_MODEL), [], gptTop));
    show('gpt-seed', seed);
    if (seed.redactedText) {
      await run(
        'gpt-redacted-roundtrip',
        body(
          userMessage('Add 1 to your previous answer. Reply with ONLY the number.', GPT_MODEL),
          [
            { userInputMessage: userMessage(q, GPT_MODEL) },
            {
              assistantResponseMessage: {
                content: seed.text,
                reasoningContent: { redactedContent: seed.redactedText },
              },
            },
          ],
          gptTop,
        ),
      );
    } else {
      console.log('(skip gpt-redacted-roundtrip : seed 没回 redactedContent)');
    }
  }

  console.log('\n=== summary ===');
  for (const [k, v] of Object.entries(results)) {
    console.log(
      `${k.padEnd(26)} status=${String(v.status).slice(0, 60).padEnd(12)} rFrames=${String(v.reasoningFrames).padStart(3)} rChars=${String(v.reasoningChars).padStart(5)} sig=${v.signature ? 'y' : 'n'} redacted=${v.redactedText.length} credits=${v.credits?.toFixed(3) ?? '-'} text=${JSON.stringify(v.text.slice(0, 40))}${v.errorBody ? ` err=${v.errorBody.slice(0, 160)}` : ''}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
