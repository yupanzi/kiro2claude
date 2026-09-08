import type { AxiosResponse } from 'axios';
import { describe, expect, it } from 'vitest';
import {
  buildAssistantResponseFrame,
  buildReasoningContentFrame,
  buildRedactedReasoningFrame,
} from '../helpers/event-stream.js';
import {
  createLiveProvider,
  type LiveProbeRun,
  type LiveProvider,
} from './_live-conversation-provider.js';

async function probe(frames: Buffer[], threshold: number, scenario = 'live-mixed') {
  const run: LiveProbeRun = {
    id: 'offline',
    protocol: 'claude',
    scenario,
    requests: [],
    faults: [],
    state: {
      liveProbe: {
        realUpstreamCalls: 0,
        mainRequests: 8,
        injected: ['empty', 'partial-tool'],
      },
    },
  };
  let drained = false;
  const upstream: LiveProvider = {
    async callApiStream() {
      return {
        status: 200,
        headers: {},
        data: (async function* () {
          for (const frame of frames) yield frame;
          drained = true;
        })(),
      } as AxiosResponse;
    },
    async callApi() {
      throw new Error('Unexpected offline non-stream dispatch');
    },
    async callMcp() {
      throw new Error('Unexpected offline MCP dispatch');
    },
  };
  const record = { id: 9, request: { input: 'K2C_LONG_PROBE' }, upstreamRequests: [] };
  const provider = createLiveProvider(record, run, {
    provider: upstream,
    thinkingFaultMinBytes: threshold,
  });
  const response = await provider.callApi('{}');
  return { run, record, response, drained };
}

describe('live fault recorder boundaries without real API calls', () => {
  const prefix = [
    buildReasoningContentFrame('a'.repeat(300)),
    buildReasoningContentFrame('b'.repeat(220)),
  ];
  const tail = buildAssistantResponseFrame('original tail retained only in the evidence');

  it('waits for substantial thinking, forwards the trigger frame, and records the hidden tail', async () => {
    const result = await probe([...prefix, tail], 512);
    expect(result.drained).toBe(true);
    expect(result.run.faults).toHaveLength(1);
    expect(result.run.faults[0]).toMatchObject({
      kind: 'thinking-error',
      triggerFrame: 1,
      thinkingFaultMinBytes: 512,
      forwardedReasoningTextBytesAtFault: 520,
    });
    const attempt = result.record.upstreamRequests[0] as Record<string, any>;
    expect(attempt.originalFrameBase64).toEqual([...prefix, tail].map((x) => x.toString('base64')));
    expect(attempt.forwardedFrameBase64.slice(0, 2)).toEqual(
      prefix.map((x) => x.toString('base64')),
    );
    expect(attempt.forwardedFrameBase64).toHaveLength(3);
    expect(attempt.forwardedFrameBase64[2]).toBe(attempt.injectedErrorFrameBase64);
    expect(attempt.originalDrained).toBe(true);
  });

  it('does not manufacture a thinking fault if real plaintext stays below the threshold', async () => {
    const result = await probe([prefix[0]!, tail], 512);
    expect(result.run.faults).toHaveLength(0);
    expect(result.response.data).toEqual(Buffer.concat([prefix[0]!, tail]));
  });

  it('can interrupt an actual complete redacted block with no invented plaintext', async () => {
    const redacted = buildRedactedReasoningFrame();
    const result = await probe([redacted, tail], 512);
    expect(result.run.faults[0]).toMatchObject({
      kind: 'thinking-error',
      forwardedReasoningTextBytesAtFault: 0,
    });
    expect(result.drained).toBe(true);
  });

  it('keeps baseline bytes identical despite the configured threshold', async () => {
    const result = await probe([...prefix, tail], 512, 'live-baseline');
    expect(result.run.faults).toHaveLength(0);
    expect(result.response.data).toEqual(Buffer.concat([...prefix, tail]));
  });

  it('rejects invalid configuration before dispatch', async () => {
    await expect(probe([tail], -1)).rejects.toThrow('nonnegative safe integer');
    await expect(probe([tail], Number.NaN)).rejects.toThrow('nonnegative safe integer');
  });
});
