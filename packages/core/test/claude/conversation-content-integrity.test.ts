/**
 * Replay retention regressions and remaining content boundaries across failure.
 * An error terminal is not proof of lossless conversation recovery. These tests
 * pin gateway behavior; real CLI probes must separately inspect replayed history.
 */
import type { AxiosResponse } from 'axios';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { convertRequest, INTERRUPTED_TOOL_RESULT_TEXT } from '../../src/claude/converter.js';
import type { MessagesRequest } from '../../src/claude/types.js';
import type { KiroProvider } from '../../src/kiro/provider.js';
import { convertResponsesRequest } from '../../src/openai/responses/converter.js';
import { HookBus } from '../../src/plugin-host/index.js';
import { registerClaudeRoutes } from '../../src/routes/claude.js';
import { registerOpenAiRoutes } from '../../src/routes/openai.js';
import {
  buildAssistantResponseFrame,
  buildErrorFrame,
  buildMetadataFrame,
  buildReasoningContentFrame,
  buildRedactedReasoningFrame,
  buildToolUseFrame,
} from '../helpers/event-stream.js';

const options = { identityOverride: false };
const request = (messages: MessagesRequest['messages']): MessagesRequest => ({
  model: 'claude-opus-4-6',
  max_tokens: 1024,
  messages,
});

describe('conversation replay content boundaries', () => {
  it('preserves a trailing partial assistant and marks its missing tool result as unknown', () => {
    const upstream = JSON.stringify(
      convertRequest(
        request([
          { role: 'user', content: 'ORIGINAL_TASK' },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'PARTIAL_ANSWER_ONLY_IN_FAILED_ATTEMPT' },
              { type: 'tool_use', id: 'completed_before_failure', name: 'Read', input: {} },
            ],
          },
        ]),
        options,
      ),
    );
    expect(upstream).toContain('ORIGINAL_TASK');
    expect(upstream).toContain('PARTIAL_ANSWER_ONLY_IN_FAILED_ATTEMPT');
    expect(upstream).toContain('completed_before_failure');
    expect(upstream).toContain(INTERRUPTED_TOOL_RESULT_TEXT);
  });

  it('adding a continuation user preserves the partial answer and marks a missing tool result as unknown', () => {
    const upstream = JSON.stringify(
      convertRequest(
        request([
          { role: 'user', content: 'ORIGINAL_TASK' },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'PARTIAL_ANSWER_CANARY' },
              { type: 'tool_use', id: 'completed_before_failure', name: 'Read', input: {} },
            ],
          },
          { role: 'user', content: 'Continue.' },
        ]),
        options,
      ),
    );
    expect(upstream).toContain('PARTIAL_ANSWER_CANARY');
    expect(upstream).toContain('completed_before_failure');
    expect(upstream).toContain(INTERRUPTED_TOOL_RESULT_TEXT);
  });

  it('preserves a tool result as quoted evidence if its invocation is missing from client history', () => {
    const upstream = JSON.stringify(
      convertRequest(
        request([
          { role: 'user', content: 'Read the file.' },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'CONTINUATION_USER' },
              {
                type: 'tool_result',
                tool_use_id: 'invocation_missing_after_failure',
                content: 'UNIQUE_TOOL_RESULT_NOT_AVAILABLE_ELSEWHERE',
              },
            ],
          },
        ]),
        options,
      ),
    );
    expect(upstream).toContain('CONTINUATION_USER');
    expect(upstream).toContain('UNIQUE_TOOL_RESULT_NOT_AVAILABLE_ELSEWHERE');
  });

  it('Claude thinking text survives replay as legacy text, but its signature does not', () => {
    const upstream = JSON.stringify(
      convertRequest(
        request([
          { role: 'user', content: 'Question.' },
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'THOUGHT_CANARY', signature: 'SIGNATURE_CANARY' },
              { type: 'text', text: 'VISIBLE_CANARY' },
            ],
          },
          { role: 'user', content: 'Continue.' },
        ]),
        options,
      ),
    );
    expect(upstream).toContain('<thinking>THOUGHT_CANARY</thinking>');
    expect(upstream).toContain('VISIBLE_CANARY');
    expect(upstream).not.toContain('SIGNATURE_CANARY');
  });

  it('Responses preserves plaintext reasoning summaries without pretending to decrypt opaque content', () => {
    const converted = convertResponsesRequest({
      model: 'claude-opus-4-6',
      input: [
        { role: 'user', content: 'Question.' },
        {
          type: 'reasoning',
          id: 'rs_previous',
          summary: [{ type: 'summary_text', text: 'PLAINTEXT_REASONING_CANARY' }],
          encrypted_content: 'ENCRYPTED_REASONING_CANARY',
        },
        { role: 'assistant', content: 'VISIBLE_CANARY' },
        { role: 'user', content: 'Continue.' },
      ],
    });
    const upstream = JSON.stringify(convertRequest(converted.payload, options));
    expect(upstream).toContain('VISIBLE_CANARY');
    expect(upstream).toContain('PLAINTEXT_REASONING_CANARY');
    expect(upstream).not.toContain('ENCRYPTED_REASONING_CANARY');
  });
});

describe.each([
  {
    name: 'Claude',
    url: '/claude/v1/messages',
    input: { messages: [{ role: 'user', content: 'TASK' }] },
  },
  { name: 'Responses', url: '/openai/v1/responses', input: { input: 'TASK' } },
])('$name response content boundaries', ({ name, url, input }) => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
  });

  async function setup(attempts: Buffer[][]) {
    const upstreamRequests: string[] = [];
    let next = 0;
    const take = (body: string) => {
      upstreamRequests.push(body);
      return attempts[Math.min(next++, attempts.length - 1)]!;
    };
    const provider = {
      callApiStream: vi.fn(async (body: string) => {
        const frames = take(body);
        return {
          data: (async function* () {
            yield* frames;
          })(),
          status: 200,
          headers: {},
        } as AxiosResponse;
      }),
      callApi: vi.fn(
        async (body: string) =>
          ({
            data: Buffer.concat(take(body)),
            status: 200,
            headers: {},
          }) as AxiosResponse,
      ),
    } as unknown as KiroProvider;
    const deps = {
      apiKey: 'test-key',
      kiroProvider: provider,
      extractThinking: true,
      identityOverride: false,
      rejectUnsupportedDocuments: true,
      emptyStreamRetries: 2,
      hookBus: new HookBus(),
    };
    app = Fastify({ logger: false });
    await app.register((instance) => registerClaudeRoutes(instance, deps), {
      prefix: '/claude/v1',
    });
    await app.register((instance) => registerOpenAiRoutes(instance, deps), {
      prefix: '/openai/v1',
    });
    const send = (
      stream: boolean,
      model = 'claude-opus-4-6',
      extra: Record<string, unknown> = {},
    ) =>
      app!.inject({
        method: 'POST',
        url,
        headers: { 'x-api-key': 'test-key' },
        payload: { model, max_tokens: 1024, stream, ...input, ...extra },
      });
    return { send, upstreamRequests };
  }

  it.each([
    true,
    false,
  ])('complete tool A survives while incomplete tool B is lost (stream=%s)', async (stream) => {
    const { send } = await setup([
      [
        buildToolUseFrame('Read', 'tool_A', '{"path":"A_COMPLETE_CANARY"}', true),
        buildToolUseFrame('Read', 'tool_B', '{"path":"B_INCOMPLETE_CANARY', false),
      ],
    ]);
    const res = await send(stream);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('tool_A');
    expect(res.body).toContain('A_COMPLETE_CANARY');
    expect(res.body).not.toContain('tool_B');
    expect(res.body).not.toContain('B_INCOMPLETE_CANARY');
    expect(res.body).toContain(
      name === 'Claude' ? '"stop_reason":"max_tokens"' : '"status":"incomplete"',
    );
  });

  it.each([
    true,
    false,
  ])('an overload preserves already streamed text/thinking/tool but discards all non-stream output (stream=%s)', async (stream) => {
    const { send } = await setup([
      [
        buildReasoningContentFrame('THOUGHT_BEFORE_FAILURE', 'SIG_BEFORE_FAILURE'),
        buildAssistantResponseFrame('TEXT_BEFORE_FAILURE'),
        buildToolUseFrame('Read', 'tool_A', '{"path":"TOOL_BEFORE_FAILURE"}', true),
        buildErrorFrame('ThrottlingException'),
      ],
    ]);
    const res = await send(stream);
    expect(res.statusCode).toBe(stream ? 200 : 503);
    expect(res.body).toContain('overloaded_error');
    for (const marker of ['THOUGHT_BEFORE_FAILURE', 'TEXT_BEFORE_FAILURE', 'TOOL_BEFORE_FAILURE']) {
      expect(res.body.includes(marker)).toBe(stream);
    }
    expect(res.body).not.toContain('response.completed');
    expect(res.body).not.toContain('message_stop');
  });

  it('a retry that omits the failed assistant gets no gateway-side restoration of its prefix', async () => {
    const { send, upstreamRequests } = await setup([
      [
        buildAssistantResponseFrame('PREFIX_ONLY_IN_FAILED_ATTEMPT'),
        buildErrorFrame('ThrottlingException'),
      ],
      [buildAssistantResponseFrame('NEW_ATTEMPT_CONTENT')],
    ]);
    const failed = await send(true);
    const recovered = await send(true);
    expect(failed.body).toContain('PREFIX_ONLY_IN_FAILED_ATTEMPT');
    expect(recovered.body).toContain('NEW_ATTEMPT_CONTENT');
    expect(recovered.body).not.toContain('PREFIX_ONLY_IN_FAILED_ATTEMPT');
    expect(upstreamRequests).toHaveLength(2);
    expect(upstreamRequests[1]).not.toContain('PREFIX_ONLY_IN_FAILED_ATTEMPT');
  });

  it.each([
    true,
    false,
  ])('a clean frame-boundary EOF after partial text is incomplete; the metadata frame marks completion (stream=%s)', async (stream) => {
    // 351/352 audited real responses end with metadataEvent; the one that did
    // not was exactly this shape. Without the marker a task-running client
    // treated the partial answer as done (real Claude Code: 4 of 12 steps, exit 0).
    const { send } = await setup([
      [buildAssistantResponseFrame('One of several requested facts: ')],
      [buildAssistantResponseFrame('All requested facts.'), buildMetadataFrame()],
    ]);
    const truncated = await send(stream);
    expect(truncated.statusCode).toBe(200);
    expect(truncated.body).toContain('One of several requested facts: ');
    expect(truncated.body).toContain(
      name === 'Claude'
        ? '"stop_reason":"max_tokens"'
        : stream
          ? 'response.incomplete'
          : '"status":"incomplete"',
    );
    if (name === 'Claude') expect(truncated.body).not.toContain('end_turn');
    else if (stream) expect(truncated.body).not.toContain('response.completed');
    const complete = await send(stream);
    expect(complete.statusCode).toBe(200);
    expect(complete.body).toContain('All requested facts.');
    expect(complete.body).toContain(
      name === 'Claude'
        ? '"stop_reason":"end_turn"'
        : stream
          ? 'response.completed'
          : '"status":"completed"',
    );
  });

  it('thinking-only EOF is incomplete regardless of the request thinking flag or protocol', async () => {
    const { send } = await setup([
      [buildReasoningContentFrame('ONLY_UNFINISHED_THINKING', 'test-signature')],
    ]);
    const model = name === 'Claude' ? 'claude-opus-4-6' : 'gpt-5.6-sol';
    const noThinkingRequest = await send(true, model);
    expect(noThinkingRequest.body).toContain(
      name === 'Claude' ? '"stop_reason":"max_tokens"' : 'response.incomplete',
    );
    const res = await send(
      true,
      model,
      name === 'Claude'
        ? { max_tokens: 64000, thinking: { type: 'adaptive' }, output_config: { effort: 'high' } }
        : {},
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('ONLY_UNFINISHED_THINKING');
    expect(res.body).toContain(
      name === 'Claude' ? '"stop_reason":"max_tokens"' : 'response.incomplete',
    );
  });

  it('GPT encrypted reasoning is discarded even when the visible answer succeeds', async () => {
    const { send } = await setup([
      [
        buildRedactedReasoningFrame('OPAQUE_REASONING_CANARY'),
        buildAssistantResponseFrame('VISIBLE_ANSWER_CANARY'),
      ],
    ]);
    const res = await send(true, 'gpt-5.6-sol');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('VISIBLE_ANSWER_CANARY');
    expect(res.body).not.toContain('OPAQUE_REASONING_CANARY');
  });

  it('freezes generated content at the first corrupt frame instead of joining text around missing bytes', async () => {
    const missing = buildAssistantResponseFrame('MISSING_NEGATION_CANARY');
    missing[missing.length - 1]! ^= 1;
    const { send } = await setup([
      [
        buildAssistantResponseFrame('PREFIX_CANARY'),
        missing,
        buildAssistantResponseFrame('SUFFIX_AFTER_CORRUPTION_CANARY'),
        buildToolUseFrame('Read', 'tool_after_corruption', '{}', true),
      ],
    ]);
    const res = await send(true);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('api_error');
    expect(res.body).toContain('PREFIX_CANARY');
    expect(res.body).not.toContain('SUFFIX_AFTER_CORRUPTION_CANARY');
    expect(res.body).not.toContain('MISSING_NEGATION_CANARY');
    expect(res.body).not.toContain('tool_after_corruption');
  });
});
