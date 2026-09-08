/**
 * Live upstream recorder and explicit fault injector for conversation probes.
 * Original AWS bytes are always retained, including bytes intentionally hidden
 * by an injected fault. This deliberate test loss must not be attributed to
 * the production gateway. No account/token/header objects enter the report.
 */
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { AxiosResponse } from 'axios';
import { loadCredentialsFromEnv } from '../../src/kiro/credentials-loader.js';
import { type Event, eventFromFrame } from '../../src/kiro/model/events/base.js';
import { MAX_MESSAGE_SIZE, parseFrame } from '../../src/kiro/parser/frame.js';
import { KiroProvider } from '../../src/kiro/provider.js';
import { ProviderError } from '../../src/kiro/provider-error.js';
import { SingleTokenManager } from '../../src/kiro/token-manager.js';
import { loadConfigFromEnv } from '../../src/model/config.js';
import { logger } from '../../src/shared/logger.js';
import { buildExceptionFrame } from '../helpers/event-stream.js';

type Obj = Record<string, any>;
export type LiveProvider = Pick<KiroProvider, 'callApiStream' | 'callApi' | 'callMcp'>;
export interface LiveProbeRun {
  id: string;
  protocol: 'claude' | 'codex';
  scenario: string;
  faults: Obj[];
  requests: Obj[];
  state: Obj;
}

/**
 * Per-run cap on real upstream calls (billing guard). Override with
 * `K2C_LIVE_MAX_CALLS` for a deliberate longer run: Claude opus-5 spends
 * ~75+ calls on the three-phase coding task, Codex ~46.
 */
const MAX_LIVE_CALLS = Number(process.env.K2C_LIVE_MAX_CALLS ?? 65);
const plan = [
  { kind: 'empty', after: 3 },
  { kind: 'partial-tool', after: 6 },
  { kind: 'thinking-error', after: 9 },
  { kind: 'tool-error', after: 12 },
  { kind: 'overloaded', after: 15 },
] as const;
type FaultKind = (typeof plan)[number]['kind'];
let realProvider: KiroProvider | undefined;

function getRealProvider(): KiroProvider {
  if (realProvider) return realProvider;
  try {
    process.loadEnvFile(fileURLToPath(new URL('../../../../.env', import.meta.url)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  // These loaders are synchronous: silence their credential-source diagnostics
  // without suppressing any other asynchronous request's logging.
  const level = logger.level;
  try {
    logger.level = 'silent';
    const config = loadConfigFromEnv();
    const loaded = loadCredentialsFromEnv();
    realProvider = new KiroProvider(
      new SingleTokenManager(config, loaded.credentials, loaded.source),
    );
  } finally {
    logger.level = level;
  }
  return realProvider;
}

function safeError(error: unknown): Obj {
  const e = error as { name?: string; code?: string; kind?: { kind?: string; status?: number } };
  return {
    name: e?.name ?? 'Error',
    code: e?.code,
    providerKind: e?.kind?.kind,
    status: e?.kind?.status,
  };
}

function eventSummary(event: Event, raw: Buffer): Obj {
  if (event.kind === 'AssistantResponse')
    return { kind: event.kind, textBytes: Buffer.byteLength(event.content) };
  if (event.kind === 'ReasoningContent')
    return {
      kind: event.kind,
      textBytes: Buffer.byteLength(event.text),
      hasSignature: Boolean(event.signature),
      rawBytes: raw.length,
    };
  if (event.kind === 'ToolUse')
    return {
      kind: event.kind,
      name: event.name,
      toolUseId: event.toolUseId,
      inputBytes: Buffer.byteLength(event.input),
      isComplete: event.isComplete,
    };
  if (event.kind === 'Error') return { kind: event.kind, code: event.errorCode };
  if (event.kind === 'Exception') return { kind: event.kind, code: event.exceptionType };
  return { kind: event.kind };
}

/**
 * Use once per main HTTP record. `options.provider` is an offline-test seam;
 * ordinary callers omit it and reuse a single real token manager/provider.
 * Side/title requests should use the fault server's existing warmup stub.
 */
export function createLiveProvider(
  record: Obj,
  run: LiveProbeRun,
  options: { provider?: LiveProvider; thinkingFaultMinBytes?: number } = {},
): LiveProvider {
  const thinkingFaultMinBytes =
    options.thinkingFaultMinBytes ?? Number(process.env.K2C_LIVE_THINKING_FAULT_MIN_BYTES ?? 0);
  if (!Number.isSafeInteger(thinkingFaultMinBytes) || thinkingFaultMinBytes < 0)
    throw new Error('K2C_LIVE_THINKING_FAULT_MIN_BYTES must be a nonnegative safe integer.');
  run.state.liveProbe ??= {
    realUpstreamCalls: 0,
    mainRequests: 0,
    injected: [] as string[],
    maxUpstreamCalls: MAX_LIVE_CALLS,
    thinkingFaultMinBytes,
    budgetExceeded: false,
  };
  const state = run.state.liveProbe;
  record.upstreamRequests ??= [];
  const serializedRequest = JSON.stringify(record.request ?? '');
  const isMain =
    serializedRequest.includes('K2C_LONG_PROBE') &&
    !serializedRequest.includes('Write the title in the predominant language of the session');
  if (isMain) record.liveRequestOrdinal ??= ++state.mainRequests;
  const ordinal = record.liveRequestOrdinal ?? 0;
  const due = (kind: FaultKind) =>
    isMain &&
    run.scenario === 'live-mixed' &&
    ordinal >= plan.find((f) => f.kind === kind)!.after &&
    !state.injected.includes(kind);

  async function callApiStream(requestBody: string, signal?: AbortSignal): Promise<AxiosResponse> {
    signal?.throwIfAborted();
    const attempt: Obj = {
      request: JSON.parse(requestBody),
      mainRequestOrdinal: ordinal,
      originalFrameBase64: [],
      forwardedFrameBase64: [],
      eventsSummary: [],
      fault: null,
      dispatched: false,
      originalBytes: 0,
      forwardedBytes: 0,
      started: new Date().toISOString(),
    };
    record.upstreamRequests.push(attempt);
    const inject = (kind: FaultKind, detail: Obj = {}) => {
      const fault = {
        key: `live:${kind}`,
        kind,
        request: record.id,
        mainRequestOrdinal: ordinal,
        upstreamCall: attempt.upstreamCall,
        intentionalInjection: true,
        ...detail,
      };
      state.injected.push(kind);
      run.faults.push(fault);
      record.fault = kind;
      attempt.fault = fault;
    };
    // This guard also applies to non-main traffic and MCP: retries must never
    // turn a diagnostic run into an unbounded real account bill.
    if (state.realUpstreamCalls >= MAX_LIVE_CALLS) {
      state.budgetExceeded = true;
      attempt.budgetExceeded = true;
      attempt.finished = new Date().toISOString();
      throw new ProviderError(
        { kind: 'transient', status: 503 },
        `Live probe stopped: ${MAX_LIVE_CALLS} upstream calls exhausted.`,
      );
    }
    if (due('overloaded')) {
      inject('overloaded', { skippedRealUpstream: true });
      attempt.finished = new Date().toISOString();
      throw new ProviderError({ kind: 'transient', status: 503 }, 'Injected live-probe HTTP 503.');
    }

    attempt.upstreamCall = ++state.realUpstreamCalls;
    const controller = new AbortController();
    const combinedSignal = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
    let response: AxiosResponse;
    try {
      const provider = options.provider ?? getRealProvider();
      attempt.dispatched = true;
      response = await provider.callApiStream(requestBody, combinedSignal);
      attempt.upstreamStatus = response.status;
    } catch (error) {
      attempt.error = safeError(error);
      attempt.finished = new Date().toISOString();
      throw error;
    }
    if (due('empty')) inject('empty');

    const original = (raw: Buffer) => {
      attempt.originalFrameBase64.push(raw.toString('base64'));
      attempt.originalBytes += raw.length;
    };
    const forwarded = (raw: Buffer) => {
      attempt.forwardedFrameBase64.push(raw.toString('base64'));
      attempt.forwardedBytes += raw.length;
      return raw;
    };
    let drained = false;
    const data = (async function* () {
      let pending: Buffer = Buffer.alloc(0);
      let opaque = false;
      let reasoningTextBytes = 0;
      try {
        for await (const chunk of response.data as AsyncIterable<Buffer>) {
          combinedSignal.throwIfAborted();
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          if (opaque) {
            original(bytes);
            if (!attempt.fault) yield forwarded(bytes);
            continue;
          }
          pending = pending.length ? Buffer.concat([pending, bytes]) : bytes;
          while (pending.length >= 4) {
            const size = pending.readUInt32BE(0);
            if (size < 16 || size > MAX_MESSAGE_SIZE) {
              // Preserve corruption exactly; do not silently repair/skip bytes
              // while building the reference recording for production checks.
              original(pending);
              attempt.eventsSummary.push({ kind: 'UnparseableBytes', bytes: pending.length });
              if (!attempt.fault) yield forwarded(pending);
              pending = Buffer.alloc(0);
              opaque = true;
              break;
            }
            if (pending.length < size) break;
            const raw = pending.subarray(0, size);
            pending = pending.subarray(size);
            original(raw);
            let event: Event | undefined;
            let redacted = false;
            try {
              const parsed = parseFrame(raw)!;
              event = eventFromFrame(parsed.frame);
              if (event.kind === 'ReasoningContent') {
                const payload = parsed.frame.payloadAsJson<{ redactedContent?: unknown }>();
                redacted =
                  typeof payload.redactedContent === 'string' && payload.redactedContent.length > 0;
              }
              attempt.eventsSummary.push({
                ...eventSummary(event, raw),
                frame: attempt.originalFrameBase64.length - 1,
                redacted,
              });
            } catch (error) {
              attempt.eventsSummary.push({ kind: 'DecodeError', ...safeError(error) });
            }
            if (attempt.fault) continue;
            if (event?.kind === 'ReasoningContent')
              reasoningTextBytes += Buffer.byteLength(event.text);
            let trigger: FaultKind | undefined;
            if (
              event?.kind === 'ToolUse' &&
              !event.isComplete &&
              event.input &&
              due('partial-tool')
            )
              trigger = 'partial-tool';
            else if (
              event?.kind === 'ReasoningContent' &&
              (redacted ||
                ((event.text || event.signature) && reasoningTextBytes >= thinkingFaultMinBytes)) &&
              due('thinking-error')
            )
              trigger = 'thinking-error';
            else if (event?.kind === 'ToolUse' && event.isComplete && due('tool-error'))
              trigger = 'tool-error';
            if (trigger)
              inject(trigger, {
                triggerFrame: attempt.originalFrameBase64.length - 1,
                triggerEvent: eventSummary(event!, raw),
                ...(trigger === 'thinking-error'
                  ? {
                      thinkingFaultMinBytes,
                      forwardedReasoningTextBytesAtFault: reasoningTextBytes,
                    }
                  : {}),
              });
            // Even the trigger frame remains the actual, byte-identical model
            // output. Only later frames are hidden by this test injection.
            yield forwarded(raw);
            if (trigger === 'thinking-error' || trigger === 'tool-error') {
              if (trigger === 'tool-error') await delay(250, undefined, { signal: combinedSignal });
              const error = buildExceptionFrame(
                'ThrottlingException',
                'Injected live conversation interruption.',
              );
              attempt.injectedErrorFrameBase64 = error.toString('base64');
              yield forwarded(error);
            }
          }
        }
        if (pending.length) {
          original(pending);
          attempt.eventsSummary.push({ kind: 'PartialFrameAtEof', bytes: pending.length });
          if (!attempt.fault) yield forwarded(pending);
        }
        drained = true;
      } catch (error) {
        attempt.error = safeError(error);
        // Bytes received before a source exception remain in the evidence and
        // on the baseline wire, even when they were an incomplete final frame.
        if (pending.length) {
          original(pending);
          if (!attempt.fault) yield forwarded(pending);
          pending = Buffer.alloc(0);
        }
        if (!attempt.fault) throw error;
      } finally {
        attempt.originalDrained = drained;
        attempt.aborted = combinedSignal.aborted;
        attempt.finished = new Date().toISOString();
        attempt.intentionallyHiddenOriginalFrames = attempt.fault
          ? attempt.originalFrameBase64.length -
            (attempt.fault.kind === 'empty' ? 0 : attempt.fault.triggerFrame + 1)
          : 0;
        if (!drained) controller.abort();
      }
    })();
    Object.assign(data, { destroy: () => controller.abort() });
    return { ...response, data };
  }

  return {
    callApiStream,
    async callApi(requestBody: string) {
      const response = await callApiStream(requestBody);
      const chunks: Buffer[] = [];
      for await (const chunk of response.data as AsyncIterable<Buffer>) chunks.push(chunk);
      return { ...response, data: Buffer.concat(chunks) };
    },
    async callMcp() {
      // The long-task probes use local file tools. Do not let an uninstrumented
      // hosted request bypass the 65-call account limit or evidence capture.
      throw new ProviderError(
        { kind: 'transient', status: 503 },
        'Hosted MCP is disabled in the live conversation probe.',
      );
    },
  };
}
