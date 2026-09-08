import type { AxiosResponse } from 'axios';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reduceKiroResponse } from '../../src/claude/non-stream-reduce.js';
import type { KiroProvider } from '../../src/kiro/provider.js';
import { HookBus } from '../../src/plugin-host/index.js';
import { registerClaudeRoutes } from '../../src/routes/claude.js';
import { registerOpenAiRoutes } from '../../src/routes/openai.js';
import { logger } from '../../src/shared/logger.js';
import {
  buildAssistantResponseFrame,
  buildContextUsageFrame,
  buildErrorFrame,
  buildExceptionFrame,
  buildMetadataFrame,
  buildMeteringFrame,
  buildReasoningContentFrame,
  buildRedactedReasoningFrame,
  buildToolUseFrame,
  encodeEventStreamFrame,
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

type Attempt = { frames: Buffer[]; error?: Error };

describe.each(endpoints)('$name transport integrity', ({ name, url, input }) => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
  });

  async function setup(attempts: Attempt[]) {
    let next = 0;
    const callApiStream = vi.fn(async () => {
      const attempt = attempts[Math.min(next++, attempts.length - 1)]!;
      const data = (async function* () {
        for (const frame of attempt.frames) yield frame;
        if (attempt.error) throw attempt.error;
      })();
      return { data, status: 200, headers: {} } as AxiosResponse;
    });
    const callApi = vi.fn(async () => {
      const attempt = attempts[Math.min(next++, attempts.length - 1)]!;
      if (attempt.error) throw attempt.error;
      return { data: Buffer.concat(attempt.frames), status: 200, headers: {} } as AxiosResponse;
    });
    const bus = new HookBus();
    const billed: number[] = [];
    bus.registerUsageFinish('test', (event) => {
      billed.push(event.getMeta<number>('kiro.creditsUsed') ?? 0);
    });
    app = Fastify({ logger: false });
    const deps = {
      apiKey: 'test-key',
      kiroProvider: { callApiStream, callApi } as unknown as KiroProvider,
      extractThinking: true,
      identityOverride: false,
      rejectUnsupportedDocuments: true,
      emptyStreamRetries: 2,
      hookBus: bus,
    };
    await app.register((instance) => registerClaudeRoutes(instance, deps), {
      prefix: '/claude/v1',
    });
    await app.register((instance) => registerOpenAiRoutes(instance, deps), {
      prefix: '/openai/v1',
    });
    const request = (stream = true, overrides: Record<string, unknown> = {}) =>
      app!.inject({
        method: 'POST',
        url,
        headers: { 'x-api-key': 'test-key' },
        payload: { model: 'claude-opus-4-6', max_tokens: 1024, stream, ...input, ...overrides },
      });
    return { request, callApiStream, callApi, billed };
  }

  it('a broken socket after partial text never becomes a successful terminal', async () => {
    const { request, callApiStream, billed } = await setup([
      {
        frames: [
          buildAssistantResponseFrame('partial answer'),
          buildMeteringFrame({ unit: 'credit', unitPlural: 'credits', usage: 0.42 }),
        ],
        error: Object.assign(new Error('private upstream ECONNRESET'), { code: 'ECONNRESET' }),
      },
    ]);
    const res = await request();
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('partial answer');
    expect(res.body).toContain('"error"');
    expect(res.body).not.toContain('private upstream');
    expect(res.body).not.toContain('message_stop');
    expect(res.body).not.toContain('response.completed');
    if (name === 'Chat') expect(res.body).not.toMatch(/"finish_reason":"(?:stop|tool_calls)"/);
    expect(callApiStream).toHaveBeenCalledTimes(1);
    expect(billed).toEqual([0.42]);
  });

  it.each([
    'crc',
    'json',
    'explicit-error',
  ] as const)('%s never joins later generated content across the failure', async (damage) => {
    const corrupt = buildAssistantResponseFrame('lost middle');
    corrupt[corrupt.length - 1]! ^= 1;
    const fault =
      damage === 'crc'
        ? corrupt
        : damage === 'json'
          ? encodeEventStreamFrame(
              { ':event-type': 'assistantResponseEvent' },
              Buffer.from('{broken'),
            )
          : buildErrorFrame('error', 'private error');
    const frames = [
      buildAssistantResponseFrame('valid prefix'),
      fault,
      buildAssistantResponseFrame('AFTER_ERROR_TEXT'),
      buildReasoningContentFrame('AFTER_ERROR_THINKING'),
      buildToolUseFrame('Read', 'toolu_after_error', '{"file_path":"/later"}', true),
      buildMeteringFrame({ unit: 'credit', unitPlural: 'credits', usage: 0.42 }),
    ];
    // Fully buffered reduction must freeze its content too, even though its
    // HTTP adapter already hides the reduced prefix behind an error response.
    const reduced = reduceKiroResponse(Buffer.concat(frames), 'claude-opus-4-6', false, new Map());
    expect(reduced.textContent).toBe('valid prefix');
    expect(reduced.reasoningText).toBe('');
    expect(reduced.toolUses).toEqual([]);
    expect(reduced.upstreamError).toBeDefined();
    expect(reduced.kiroMetering?.usage).toBe(0.42);

    // Both one-buffer and frame-per-chunk delivery must preserve the failure
    // boundary. This catches a decoder draining recovered frames in one call.
    for (const chunks of [frames, [Buffer.concat(frames)]]) {
      const { request, callApiStream, billed } = await setup([{ frames: chunks }]);
      const res = await request();
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('valid prefix');
      expect(res.body).toContain('api_error');
      expect(res.body).not.toContain('AFTER_ERROR');
      expect(res.body).not.toContain('toolu_after_error');
      expect(res.body).not.toContain('message_stop');
      expect(res.body).not.toContain('response.completed');
      expect(callApiStream).toHaveBeenCalledTimes(1);
      expect(billed).toEqual([0.42]);
      await app!.close();
      app = undefined;
    }
  });

  it.each([
    true,
    false,
  ])('native thinking alone is incomplete without a request thinking flag (stream=%s)', async (stream) => {
    const { request, callApiStream, callApi } = await setup([
      { frames: [buildReasoningContentFrame('unfinished reasoning', 'signature')] },
    ]);
    const res = await request(stream);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('unfinished reasoning');
    if (name === 'Claude') expect(res.body).toContain('"stop_reason":"max_tokens"');
    if (name === 'Chat') expect(res.body).toContain('"finish_reason":"length"');
    if (name === 'Responses') {
      expect(res.body).toContain('"status":"incomplete"');
      expect(res.body).toContain('"reason":"max_output_tokens"');
      if (stream) {
        expect(res.body).toContain('response.incomplete');
        expect(res.body).not.toContain('response.completed');
      }
    }
    expect(stream ? callApiStream : callApi).toHaveBeenCalledTimes(1);
  });

  it('keeps the thinking-only error placeholder without admitting post-error text or a success terminal', async () => {
    const { request, callApiStream, billed } = await setup([
      {
        frames: [
          buildReasoningContentFrame('unfinished reasoning', 'signature'),
          buildErrorFrame('error', 'private error'),
          buildAssistantResponseFrame('AFTER_ERROR_TEXT'),
          buildMeteringFrame({ unit: 'credit', unitPlural: 'credits', usage: 0.42 }),
        ],
      },
    ]);
    const res = await request();
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('unfinished reasoning');
    expect(res.body).toContain(name === 'Chat' ? '"content":" "' : '"text":" "');
    expect(res.body).toContain('api_error');
    expect(res.body).not.toContain('AFTER_ERROR_TEXT');
    expect(res.body).not.toContain('message_stop');
    expect(res.body).not.toContain('response.completed');
    expect(res.body).not.toContain('response.incomplete');
    expect(res.body).not.toContain('"finish_reason":"stop"');
    expect(callApiStream).toHaveBeenCalledTimes(1);
    expect(billed).toEqual([0.42]);
  });

  it.each([
    true,
    false,
  ])('native thinking followed by real text completes only with the metadata frame; Metering stays optional (stream=%s)', async (stream) => {
    const { request } = await setup([
      {
        frames: [
          buildReasoningContentFrame('reasoning'),
          buildAssistantResponseFrame('actual answer'),
          buildMetadataFrame(),
        ],
      },
      {
        frames: [
          buildReasoningContentFrame('reasoning'),
          buildAssistantResponseFrame('cut off answer'),
        ],
      },
    ]);
    const res = await request(stream);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('actual answer');
    if (name === 'Claude') expect(res.body).toContain('"stop_reason":"end_turn"');
    if (name === 'Chat') expect(res.body).toContain('"finish_reason":"stop"');
    if (name === 'Responses') expect(res.body).toContain('"status":"completed"');

    // Same bytes minus the marker = a clean EOF mid-response: never a success terminal.
    const info = vi.spyOn(logger, 'info');
    try {
      const cut = await request(stream);
      expect(cut.statusCode).toBe(200);
      expect(cut.body).toContain('cut off answer');
      expect(cut.body).not.toContain('api_error');
      if (name === 'Claude') expect(cut.body).toContain('"stop_reason":"max_tokens"');
      if (name === 'Chat') expect(cut.body).toContain('"finish_reason":"length"');
      if (name === 'Responses') expect(cut.body).toContain('"status":"incomplete"');
      // The completion log must carry the terminal actually sent, not the
      // pre-terminal snapshot (ops read stop_reason from this line).
      if (stream) {
        const completed = info.mock.calls
          .map((c) => c[0] as { msg?: string; stop_reason?: string })
          .filter((f) => f.msg === 'stream completed' || f.msg === 'openai stream completed');
        expect(completed.at(-1)?.stop_reason).toBe('max_tokens');
      }
    } finally {
      info.mockRestore();
    }
  });

  it('encrypted reasoning followed by socket failure is never retried as empty', async () => {
    const { request, callApiStream, billed } = await setup([
      {
        frames: [
          buildRedactedReasoningFrame(),
          buildMeteringFrame({ unit: 'credit', unitPlural: 'credits', usage: 0.37 }),
        ],
        error: new Error('socket reset'),
      },
    ]);
    const res = await request();
    expect(res.statusCode).toBe(502);
    expect(callApiStream).toHaveBeenCalledTimes(1);
    expect(billed).toEqual([0.37]);
  });

  it('EOF in tool input never exposes an executable call to a client', async () => {
    const { request, callApiStream } = await setup([
      {
        frames: [
          buildAssistantResponseFrame('reading now'),
          buildToolUseFrame('Read', 'toolu_truncated', '{"file_path":"/unfinished', false),
        ],
      },
    ]);
    const res = await request();
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('reading now');
    expect(res.body).not.toContain('toolu_truncated');
    expect(res.body).not.toContain('/unfinished');
    if (name === 'Claude') expect(res.body).toContain('"stop_reason":"max_tokens"');
    if (name === 'Chat') expect(res.body).toContain('"finish_reason":"length"');
    if (name === 'Responses') expect(res.body).toContain('"type":"response.incomplete"');
    expect(callApiStream).toHaveBeenCalledTimes(1);
  });

  it.each([
    true,
    false,
  ])('clean EOF in a partial AWS frame is a failure (stream=%s)', async (stream) => {
    const last = buildAssistantResponseFrame('this frame is cut off');
    const attempts = [1, 11, 12, last.length - 1].map((cut) => ({
      frames: [buildAssistantResponseFrame('visible prefix'), last.subarray(0, cut)],
    }));
    const { request, callApiStream, callApi } = await setup(attempts);
    for (const _ of attempts) {
      const res = await request(stream);
      expect(res.statusCode).toBe(stream ? 200 : 502);
      expect(res.body).toContain('api_error');
      expect(res.body).not.toContain('message_stop');
      expect(res.body).not.toContain('response.completed');
      expect(res.body).not.toContain('"finish_reason":"stop"');
    }
    expect(stream ? callApiStream : callApi).toHaveBeenCalledTimes(attempts.length);
  });

  it.each([
    true,
    false,
  ])('CRC recovery keeps metering but never completes a damaged tool (stream=%s)', async (stream) => {
    const corrupt = buildToolUseFrame('Read', 'toolu_damaged', '"/wrong"', false);
    corrupt[corrupt.length - 1]! ^= 1;
    const { request, callApiStream, callApi, billed } = await setup([
      {
        frames: [
          buildAssistantResponseFrame('visible prefix'),
          buildToolUseFrame('Read', 'toolu_valid', '{"file_path":"/valid"}', true),
          buildToolUseFrame('Read', 'toolu_damaged', '{"file_path":', false),
          corrupt,
          buildToolUseFrame('Read', 'toolu_damaged', '}', true),
          buildMeteringFrame({ unit: 'credit', unitPlural: 'credits', usage: 0.42 }),
        ],
      },
    ]);
    const res = await request(stream);
    expect(res.statusCode).toBe(stream ? 200 : 502);
    expect(res.body).toContain('api_error');
    expect(res.body).not.toContain('toolu_damaged');
    expect(res.body).not.toContain('message_stop');
    expect(res.body).not.toContain('response.completed');
    if (stream) expect(res.body).toContain('toolu_valid');
    expect(stream ? callApiStream : callApi).toHaveBeenCalledTimes(1);
    expect(billed).toEqual([0.42]);
  });

  it.each([
    true,
    false,
  ])('a known event with invalid JSON cannot be silently dropped (stream=%s)', async (stream) => {
    const { request } = await setup([
      {
        frames: [
          buildAssistantResponseFrame('visible prefix'),
          encodeEventStreamFrame(
            { ':event-type': 'assistantResponseEvent' },
            Buffer.from('{broken'),
          ),
        ],
      },
    ]);
    const res = await request(stream);
    expect(res.statusCode).toBe(stream ? 200 : 502);
    expect(res.body).toContain('api_error');
    expect(res.body).not.toContain('message_stop');
    expect(res.body).not.toContain('response.completed');
  });

  it.each([
    true,
    false,
  ])('known event field corruption cannot become text or token usage (stream=%s)', async (stream) => {
    const attempts = (
      [
        ['assistantResponseEvent', '{"content":{"text":"silently coerced"}}'],
        ['reasoningContentEvent', '{"text":{"value":"silently coerced"}}'],
        ['meteringEvent', '{"usage":1e400}'],
        ['contextUsageEvent', '{"contextUsagePercentage":{}}'],
      ] as const
    ).map(([eventType, payload]) => ({
      frames: [
        buildAssistantResponseFrame('visible prefix'),
        encodeEventStreamFrame({ ':event-type': eventType }, Buffer.from(payload)),
        buildMeteringFrame({ unit: 'credit', unitPlural: 'credits', usage: 0.1 }),
      ],
    }));
    const { request, callApiStream, callApi, billed } = await setup(attempts);
    for (const _ of attempts) {
      const res = await request(stream);
      expect(res.statusCode).toBe(stream ? 200 : 502);
      expect(res.body).toContain('api_error');
      expect(res.body).not.toContain('[object Object]');
      expect(res.body).not.toContain('message_stop');
      expect(res.body).not.toContain('response.completed');
    }
    expect(stream ? callApiStream : callApi).toHaveBeenCalledTimes(attempts.length);
    expect(billed).toEqual(attempts.map(() => 0.1));
  });

  it.each([
    true,
    false,
  ])('tool wire fields and invocation identity are validated before execution (stream=%s)', async (stream) => {
    const malformed = (fields: Record<string, unknown>) =>
      encodeEventStreamFrame(
        { ':event-type': 'toolUseEvent' },
        Buffer.from(JSON.stringify(fields)),
      );
    const attempts = [
      [malformed({ name: 'Read', toolUseId: 'bad', input: { file_path: '/a' }, stop: true })],
      [malformed({ name: 'Read', toolUseId: 'bad', input: '{"file_path":"/a', stop: 'false' })],
      [malformed({ name: 'Read', input: '{}', stop: true })],
      [buildToolUseFrame('Read', 'bad', '{"file_path":"/unfinished', true)],
      [buildToolUseFrame('Read', 'bad', 'null', true)],
      [buildToolUseFrame('Read', 'bad', '[]', true)],
      [buildToolUseFrame('Read', 'bad', '42', true)],
      [
        buildToolUseFrame('Read', 'bad', '{"file_path":', false),
        buildToolUseFrame('Write', 'bad', '"/a"}', true),
      ],
      [
        buildToolUseFrame('Read', 'valid', '{}', true),
        buildToolUseFrame('Read', 'valid', '{}', true),
      ],
    ].map((frames) => ({
      frames: [
        buildAssistantResponseFrame('visible prefix'),
        ...frames,
        buildMeteringFrame({ unit: 'credit', unitPlural: 'credits', usage: 0.1 }),
      ],
    }));
    const { request, callApiStream, callApi, billed } = await setup(attempts);
    for (const _ of attempts) {
      const res = await request(stream);
      expect(res.statusCode).toBe(stream ? 200 : 502);
      expect(res.body).toContain('api_error');
      expect(res.body).not.toContain('"id":"bad"');
      expect(res.body).not.toContain('"call_id":"bad"');
      expect(res.body).not.toContain('message_stop');
      expect(res.body).not.toContain('response.completed');
    }
    expect(stream ? callApiStream : callApi).toHaveBeenCalledTimes(attempts.length);
    expect(billed).toEqual(attempts.map(() => 0.1));
  });

  it.each([
    true,
    false,
  ])('a damaged zero-content body is not mistaken for a retryable empty rejection (stream=%s)', async (stream) => {
    const attempts = [
      [buildAssistantResponseFrame('truncated').subarray(0, 8)],
      [buildToolUseFrame('Read', 'bad', '{broken', true)],
      [
        encodeEventStreamFrame({ ':event-type': 'toolUseEvent' }, Buffer.from('{broken')),
        buildErrorFrame('InternalServerException'),
      ],
    ].map((frames) => ({ frames }));
    const { request, callApiStream, callApi } = await setup(attempts);
    for (const _ of attempts) {
      const res = await request(stream);
      expect(res.statusCode).toBeGreaterThanOrEqual(500);
      expect(res.body).not.toContain('message_stop');
      expect(res.body).not.toContain('response.completed');
    }
    expect(stream ? callApiStream : callApi).toHaveBeenCalledTimes(attempts.length);
  });

  it('complete frames split byte by byte remain valid, including Unknown events and no Metering', async () => {
    const body = Buffer.concat([
      buildAssistantResponseFrame('whole answer'),
      encodeEventStreamFrame(
        { ':event-type': 'futureEvent' },
        Buffer.from('opaque future payload'),
      ),
      buildMetadataFrame(),
    ]);
    const { request, callApiStream } = await setup([
      { frames: Array.from(body, (byte) => Buffer.from([byte])) },
    ]);
    const res = await request();
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('whole answer');
    expect(res.body).not.toContain('api_error');
    expect(res.body).toContain(
      name === 'Claude' ? 'message_stop' : name === 'Chat' ? '[DONE]' : 'response.completed',
    );
    expect(callApiStream).toHaveBeenCalledTimes(1);
  });

  if (name === 'Responses') {
    it.each([
      true,
      false,
    ])('explicit custom tools preserve wrapped and raw input (stream=%s)', async (stream) => {
      const cases = [
        { wire: '{"input":"text(42)"}', input: 'text(42)' },
        { wire: 'text("raw code")', input: 'text("raw code")' },
        { wire: '{"input":""}', input: '' },
      ];
      const { request, callApiStream, callApi } = await setup(
        cases.map(({ wire }) => ({ frames: [buildToolUseFrame('exec', 'raw_tool', wire, true)] })),
      );
      for (const expected of cases) {
        const res = await request(stream, {
          tools: [{ type: 'custom', name: 'exec', description: 'Execute code' }],
        });
        expect(res.statusCode).toBe(200);
        const item = stream
          ? res.body
              .split('\n')
              .filter((line) => line.startsWith('data: '))
              .map((line) => JSON.parse(line.slice(6)))
              .find((event) => event.type === 'response.output_item.done')?.item
          : res.json().output[0];
        expect(item).toMatchObject({
          type: 'custom_tool_call',
          input: expected.input,
          status: 'completed',
        });
        expect(res.body).not.toContain('api_error');
      }
      expect(stream ? callApiStream : callApi).toHaveBeenCalledTimes(cases.length);
    });
  }

  it.each([
    true,
    false,
  ])('a zero-frame rejection can recover within the configured retry budget (stream=%s)', async (stream) => {
    const { request, callApiStream, callApi } = await setup([
      { frames: [buildErrorFrame('InternalServerException', 'transient')] },
      { frames: [buildAssistantResponseFrame('recovered')] },
    ]);
    const res = await request(stream);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('recovered');
    expect(res.body).not.toMatch(/"error":\{|"type":"error"/);
    expect(stream ? callApiStream : callApi).toHaveBeenCalledTimes(2);
  });

  it.each([
    true,
    false,
  ])('an incomplete tool shell is a deterministic empty response, never retried (stream=%s)', async (stream) => {
    const { request, callApiStream, callApi } = await setup([
      { frames: [buildToolUseFrame('Read', 'toolu_x')] },
    ]);
    const res = await request(stream);
    expect(res.statusCode).toBe(503);
    expect(res.body).toContain('compact or trim');
    expect(stream ? callApiStream : callApi).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['max_tokens', buildExceptionFrame('ContentLengthExceededException')],
    ['model_context_window_exceeded', buildContextUsageFrame(100)],
  ])('an empty %s terminal is delivered as HTTP 200, never overload', async (reason, frame) => {
    const { request, callApiStream } = await setup([{ frames: [frame as Buffer] }]);
    const res = await request();
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('overloaded_error');
    if (name === 'Claude') {
      expect(res.body).toContain(`"stop_reason":"${reason}"`);
      expect(res.body).toContain('message_stop');
    } else if (name === 'Chat') {
      expect(res.body).toContain('"finish_reason":"length"');
      expect(res.body).toContain('[DONE]');
    } else {
      expect(res.body).toContain('"type":"response.incomplete"');
      expect(res.body).toContain('"incomplete_details":{"reason":"max_output_tokens"}');
      expect(res.body).not.toContain('response.completed');
    }
    expect(callApiStream).toHaveBeenCalledTimes(1);
  });
});
