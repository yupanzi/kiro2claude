import type { AxiosResponse } from 'axios';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { MessagesRequest } from '../../src/claude/types.js';
import { handleWebsearchRequest } from '../../src/claude/websearch.js';
import type { KiroProvider } from '../../src/kiro/provider.js';
import { ProviderError } from '../../src/kiro/provider-error.js';
import { HookBus } from '../../src/plugin-host/index.js';
import { registerClaudeRoutes } from '../../src/routes/claude.js';
import { buildToolUseFrame, parseSseEvents } from '../helpers/event-stream.js';

const results = [
  { title: 'Reference', url: 'https://example.com/reference', snippet: 'Verified search result.' },
];
const success = {
  result: { isError: false, content: [{ type: 'text', text: JSON.stringify({ results }) }] },
};
const request: MessagesRequest = {
  model: 'claude-opus-5',
  max_tokens: 1024,
  tools: [{ type: 'web_search_20250305', name: 'web_search' }],
  messages: [{ role: 'user', content: 'Perform a web search for the query: current query' }],
};

async function run(payload: MessagesRequest, result: unknown = success, error?: unknown) {
  const callMcp = vi.fn(async (_body: string) => {
    if (error) throw error;
    return { data: result } as AxiosResponse;
  });
  const app = Fastify({ logger: false });
  app.post('/', async (_req, reply) =>
    handleWebsearchRequest({ callMcp } as unknown as KiroProvider, payload, 12, reply),
  );
  try {
    return { res: await app.inject({ method: 'POST', url: '/' }), callMcp };
  } finally {
    await app.close();
  }
}

function messageFromEvents(body: string) {
  const events = parseSseEvents(body);
  const blocks: Array<Record<string, unknown>> = [];
  for (const event of events) {
    if (event.event === 'content_block_start')
      blocks[event.data.index as number] = {
        ...(event.data.content_block as Record<string, unknown>),
      };
    if (event.event === 'content_block_delta') {
      const delta = event.data.delta as { text?: string };
      const block = blocks[event.data.index as number]!;
      block.text = `${block.text ?? ''}${delta.text ?? ''}`;
    }
  }
  return { events, blocks };
}

describe('WebSearch transport and failure semantics', () => {
  it.each([
    true,
    false,
  ])('a client function named web_search is never executed by the gateway (stream=%s)', async (stream) => {
    const frame = buildToolUseFrame(
      'web_search',
      'toolu_client_search',
      '{"query":"client query"}',
      true,
    );
    const callMcp = vi.fn(async () => ({ data: success }) as AxiosResponse);
    const callApi = vi.fn(async () => ({ data: frame }) as AxiosResponse);
    const callApiStream = vi.fn(
      async () =>
        ({
          data: (async function* () {
            yield frame;
          })(),
        }) as AxiosResponse,
    );
    const app = Fastify({ logger: false });
    await app.register(registerClaudeRoutes, {
      apiKey: 'test',
      kiroProvider: { callMcp, callApi, callApiStream } as unknown as KiroProvider,
      hookBus: new HookBus(),
      extractThinking: true,
      identityOverride: false,
      emptyStreamRetries: 0,
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/messages',
        headers: { 'x-api-key': 'test' },
        payload: {
          ...request,
          stream,
          tools: [
            {
              name: 'web_search',
              input_schema: { type: 'object', properties: { query: { type: 'string' } } },
            },
          ],
        },
      });
      expect(res.statusCode).toBe(200);
      expect(callMcp).not.toHaveBeenCalled();
      expect(stream ? callApiStream : callApi).toHaveBeenCalledOnce();
      expect(res.body).toContain('toolu_client_search');
      expect(res.body).not.toContain('server_tool_use');
    } finally {
      await app.close();
    }
  });

  it('JSON clients receive a Message, with the result linked to its server tool call', async () => {
    const { res } = await run({ ...request, stream: false });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    const message = res.json();
    expect(message.stop_reason).toBe('end_turn');
    const tool = message.content.find(
      (block: { type: string }) => block.type === 'server_tool_use',
    );
    const result = message.content.find(
      (block: { type: string }) => block.type === 'web_search_tool_result',
    );
    expect(result.tool_use_id).toBe(tool.id);
    expect(result.content[0]).toMatchObject({ title: results[0]!.title, url: results[0]!.url });
    expect(message.usage.server_tool_use.web_search_requests).toBe(1);
  });

  it('SSE reconstructs the same content and usage as the JSON response', async () => {
    const json = (await run({ ...request, stream: false })).res.json();
    const { res } = await run({ ...request, stream: true });
    expect(res.headers['content-type']).toContain('text/event-stream');
    const { events, blocks } = messageFromEvents(res.body);
    const normalize = (content: Array<Record<string, unknown>>) =>
      content.map(({ id, tool_use_id, ...block }) => block);
    expect(normalize(blocks)).toEqual(normalize(json.content));
    expect(blocks[2]!.tool_use_id).toBe(blocks[1]!.id);
    expect(events.at(-1)?.event).toBe('message_stop');
    const delta = events.find((event) => event.event === 'message_delta')!;
    expect(delta.data.usage).toMatchObject({
      output_tokens: json.usage.output_tokens,
      server_tool_use: json.usage.server_tool_use,
    });
  });

  it('searches the latest user query instead of reusing the first turn', async () => {
    const { callMcp } = await run({
      ...request,
      messages: [
        { role: 'user', content: 'stale query' },
        { role: 'assistant', content: 'prior result' },
        {
          role: 'user',
          content: [{ type: 'text', text: 'Perform a web search for the query: latest query' }],
        },
      ],
    });
    expect(JSON.parse(callMcp.mock.calls[0]![0]).params.arguments.query).toBe('latest query');
  });

  it.each([
    true,
    false,
  ])('does not disguise upstream rate limiting as zero search results (stream=%s)', async (stream) => {
    const { res } = await run(
      { ...request, stream },
      undefined,
      new ProviderError(
        { kind: 'rate_limited', retryAfterSeconds: 7, status: 429 },
        'private rate limit',
      ),
    );
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('7');
    expect(res.json().error.type).toBe('rate_limit_error');
    expect(res.body).not.toContain('No results found');
  });

  it.each([
    { error: { code: -1, message: 'private upstream search failure' } },
    { result: { isError: true, content: [{ type: 'text', text: 'private upstream failure' }] } },
    { result: { isError: false, content: [{ type: 'text', text: '{broken' }] } },
    { result: { isError: false, content: [{ type: 'text', text: '{"results":[null]}' }] } },
    {
      result: {
        isError: false,
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              results: [{ title: 'x', url: 'https://example.com', snippet: 42 }],
            }),
          },
        ],
      },
    },
  ])('reports invalid/failed search payloads as errors without leaking upstream text', async (result) => {
    const { res } = await run(request, result);
    expect(res.statusCode).toBe(502);
    expect(res.json().error.type).toBe('api_error');
    expect(res.body).not.toMatch(/private|upstream|No results found/);
  });

  it('preserves a genuine empty result as a successful empty search', async () => {
    const { res } = await run(request, {
      result: { isError: false, content: [{ type: 'text', text: '{"results":[]}' }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().content[2].content).toEqual([]);
    expect(res.body).toContain('No results found');
  });
});
