import type { AxiosResponse } from 'axios';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

const endpoints = [
  {
    name: 'Claude',
    url: '/claude/v1/messages',
    input: { messages: [{ role: 'user', content: 'hi' }] },
  },
  {
    name: 'Chat',
    url: '/openai/v1/chat/completions',
    input: { messages: [{ role: 'user', content: 'hi' }] },
  },
  { name: 'Responses', url: '/openai/v1/responses', input: { input: 'hi' } },
];

// Real route + AWS wire-frame tests: distinguish HTTP failure, in-band failure,
// and an explicit incomplete terminal. None may become an empty success.
describe.each(endpoints)('$name empty-response contract', ({ name, url, input }) => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    vi.useRealTimers();
    await app?.close();
  });

  async function setup(
    attempts: Buffer[][],
    waitAtEof?: { reached: () => void; gate: Promise<void> },
  ) {
    let next = 0;
    const frames = () => attempts[Math.min(next++, attempts.length - 1)]!;
    const callApiStream = vi.fn(async () => {
      const attempt = frames();
      const data = (async function* () {
        for (const frame of attempt) yield frame;
        if (waitAtEof) {
          waitAtEof.reached();
          await waitAtEof.gate;
        }
      })();
      return { data, status: 200, headers: {} } as AxiosResponse;
    });
    const callApi = vi.fn(async () => ({
      data: Buffer.concat(frames()),
      status: 200,
      headers: {},
    }));
    app = Fastify({ logger: false });
    const deps = {
      apiKey: 'test-key',
      kiroProvider: { callApiStream, callApi } as unknown as KiroProvider,
      extractThinking: true,
      identityOverride: false,
      rejectUnsupportedDocuments: true,
      emptyStreamRetries: 2,
      hookBus: new HookBus(),
    };
    await app.register((instance) => registerClaudeRoutes(instance, deps), {
      prefix: '/claude/v1',
    });
    await app.register((instance) => registerOpenAiRoutes(instance, deps), {
      prefix: '/openai/v1',
    });
    await app.ready();
    const request = (stream: boolean, model = 'claude-opus-4-6') =>
      app!.inject({
        method: 'POST',
        url,
        headers: { 'x-api-key': 'test-key' },
        payload: { model, max_tokens: 1024, stream, ...input },
      });
    return { request, callApiStream, callApi };
  }

  function expectNoSuccessfulTerminal(body: string) {
    expect(body).not.toContain('"stop_reason":"end_turn"');
    expect(body).not.toContain('"stop_reason":"tool_use"');
    expect(body).not.toContain('"finish_reason":"stop"');
    expect(body).not.toContain('"finish_reason":"tool_calls"');
    expect(body).not.toContain('response.completed');
  }

  describe.each([true, false])('stream=%s', (stream) => {
    it.each([
      { label: 'zero frames', frames: [], model: 'claude-opus-4-6' },
      {
        label: 'empty text frame',
        frames: [buildAssistantResponseFrame('')],
        model: 'claude-opus-4-6',
      },
      {
        label: 'encrypted reasoning only',
        frames: [buildRedactedReasoningFrame()],
        model: 'gpt-5.6-sol',
      },
    ])('$label exhausts the retry budget as HTTP 503', async ({ frames, model }) => {
      const { request, callApiStream, callApi } = await setup([frames]);
      const res = await request(stream, model);
      expect(res.statusCode).toBe(503);
      expect(res.headers['content-type']).toContain('application/json');
      expect(res.json().error.type).toBe('overloaded_error');
      expectNoSuccessfulTerminal(res.body);
      expect(stream ? callApiStream : callApi).toHaveBeenCalledTimes(3);
    });

    it('a tool shell returns HTTP 503 without spending the retry budget', async () => {
      const { request, callApiStream, callApi } = await setup([
        [buildToolUseFrame('Read', 'toolu_hidden')],
        [buildAssistantResponseFrame('must not retry')],
      ]);
      const res = await request(stream);
      expect(res.statusCode).toBe(503);
      expect(res.json().error.type).toBe('overloaded_error');
      expect(res.body).not.toContain('toolu_hidden');
      expectNoSuccessfulTerminal(res.body);
      expect(stream ? callApiStream : callApi).toHaveBeenCalledTimes(1);
    });

    it('discarded partial tool input has an incomplete terminal and no executable tool', async () => {
      const { request, callApiStream, callApi } = await setup([
        [buildToolUseFrame('Read', 'toolu_hidden', '{"file_path":"/unfinished', false)],
      ]);
      const res = await request(stream);
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain('toolu_hidden');
      expect(res.body).not.toContain('/unfinished');
      expectNoSuccessfulTerminal(res.body);
      if (name === 'Claude') expect(res.body).toContain('"stop_reason":"max_tokens"');
      if (name === 'Chat') expect(res.body).toContain('"finish_reason":"length"');
      if (name === 'Responses') {
        expect(res.body).toContain('"status":"incomplete"');
        expect(res.body).toContain('"incomplete_details":{"reason":"max_output_tokens"}');
        if (stream) expect(res.body).toContain('"type":"response.incomplete"');
      }
      expect(stream ? callApiStream : callApi).toHaveBeenCalledTimes(1);
    });

    it('a completed tool with empty input is real content and remains executable', async () => {
      const { request, callApiStream, callApi } = await setup([
        [buildToolUseFrame('snapshot', 'toolu_complete', '', true), buildMetadataFrame()],
      ]);
      const res = await request(stream);
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('toolu_complete');
      expect(res.body).not.toContain('overloaded_error');
      if (name === 'Claude') expect(res.body).toContain('"stop_reason":"tool_use"');
      if (name === 'Chat') expect(res.body).toContain('"finish_reason":"tool_calls"');
      if (name === 'Responses') expect(res.body).toContain('"status":"completed"');
      expect(stream ? callApiStream : callApi).toHaveBeenCalledTimes(1);
    });
  });

  it.each([
    { label: 'zero frames', frames: [], model: 'claude-opus-4-6' },
    {
      label: 'encrypted reasoning only',
      frames: [buildRedactedReasoningFrame()],
      model: 'gpt-5.6-sol',
    },
    {
      label: 'incomplete tool shell',
      frames: [buildToolUseFrame('Read', 'toolu_hidden')],
      model: 'claude-opus-4-6',
    },
  ])('$label after the commit timeout is an in-band error, never an empty success', async ({
    frames,
    model,
  }) => {
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const { request, callApiStream } = await setup([frames], { gate, reached });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    // inject() is thenable: attaching then starts dispatch before waiting on entered.
    const pending = request(true, model).then((res) => res);
    await entered;
    try {
      await vi.advanceTimersByTimeAsync(15_000);
    } finally {
      release();
    }
    const res = await pending;
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.body).toContain('overloaded_error');
    expect(res.body).not.toContain('toolu_hidden');
    expect(res.body).not.toContain('message_stop');
    expectNoSuccessfulTerminal(res.body);
    expect(callApiStream).toHaveBeenCalledTimes(1);
  });
});
