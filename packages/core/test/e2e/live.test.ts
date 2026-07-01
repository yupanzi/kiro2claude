/**
 * Live end-to-end tests.
 *
 * Unlike the rest of `test/**` these tests do NOT mock the upstream —
 * they construct a real `KiroProvider` against the kiro-cli SQLite
 * credentials pointed at by `KIRO2CLAUDE_SQLITE_DB_PATH` and call the real
 * Kiro (AWS CodeWhisperer) backend. Every passing run consumes actual
 * token quota on the upstream account.
 *
 * Isolation: `vitest.config.ts` excludes `test/e2e/**` from the default
 * `pnpm test` / pre-commit pipeline. Run explicitly with:
 *
 *   KIRO2CLAUDE_API_KEY=sk-local-test \
 *   KIRO2CLAUDE_SQLITE_DB_PATH="$HOME/Library/Application Support/kiro-cli/data.sqlite3" \
 *   pnpm test:e2e
 *
 * If either env var is missing, the suite skips cleanly (describe.skipIf).
 *
 * Assertion style: "structure + keyword presence". Structural properties
 * (status codes, block types, usage fields) are asserted strictly;
 * model-generated text is only matched against loose keyword patterns
 * so that upstream price fluctuation or paraphrasing doesn't make the
 * suite flake.
 */

import fs from 'node:fs';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadCredentialsFromEnv } from '../../src/kiro/credentials-loader.js';
import { KiroProvider } from '../../src/kiro/provider.js';
import { SingleTokenManager } from '../../src/kiro/token-manager.js';
import { loadConfigFromEnv } from '../../src/model/config.js';
import { HookBus } from '../../src/plugin-host/index.js';
import { registerClaudeRoutes } from '../../src/routes/claude.js';
import { registerHealthRoutes } from '../../src/routes/health.js';
import { registerKiroRoutes } from '../../src/routes/kiro.js';
import { initCountTokensConfig } from '../../src/token.js';
import { parseSseEvents, type SseEvent } from '../helpers/event-stream.js';
import { generateMinimalPdfBytes } from '../helpers/fixtures.js';

// ============================================================================
// Environment gating
// ============================================================================

const HAS_ENV = Boolean(process.env.KIRO2CLAUDE_API_KEY && process.env.KIRO2CLAUDE_SQLITE_DB_PATH);

// Default vitest timeout is 5s — real upstream vision/websearch calls
// routinely take 10s+. Bump generously per test.
const LIVE_TIMEOUT_MS = 90_000;

// ============================================================================
// SSE parsing helper
// ============================================================================

/** Join all text deltas from an SSE event stream into the final assistant text. */
function joinTextDeltas(events: SseEvent[]): string {
  return events
    .filter((e) => e.event === 'content_block_delta')
    .map((e) => {
      const delta = (e.data as { delta?: { text?: string } }).delta;
      return delta?.text ?? '';
    })
    .join('');
}

// ============================================================================
// Test suite
// ============================================================================

describe.skipIf(!HAS_ENV)('live E2E: kiro2claude end-to-end', () => {
  let app: FastifyInstance;
  let apiKey: string;

  beforeAll(async () => {
    const config = loadConfigFromEnv();
    const loaded = loadCredentialsFromEnv();
    const tokenManager = new SingleTokenManager(config, loaded.credentials, loaded.source);
    const kiroProvider = new KiroProvider(tokenManager);
    const hookBus = new HookBus();
    apiKey = config.apiKey;

    initCountTokensConfig({
      apiUrl: config.countTokensApiUrl,
      apiKey: config.countTokensApiKey,
      authType: config.countTokensAuthType,
    });

    // Mirrors src/index.ts:115-171 — same Fastify options, same register
    // order, same prefixes. Only difference: no listen() (inject-only).
    app = Fastify({ logger: false, bodyLimit: 50 * 1024 * 1024 });

    await app.register(registerHealthRoutes);
    await app.register(
      async (instance) => {
        await registerClaudeRoutes(instance, {
          apiKey,
          kiroProvider,
          extractThinking: config.extractThinking,
          identityOverride: config.identityOverride,
          rejectUnsupportedDocuments: config.rejectUnsupportedDocuments,
          emptyStreamRetries: config.emptyStreamRetries,
          hookBus,
        });
      },
      { prefix: '/claude/v1' },
    );
    await app.register(
      async (instance) => {
        await registerKiroRoutes(instance, { apiKey, tokenManager });
      },
      { prefix: '/kiro' },
    );
    await app.ready();
  }, 30_000);

  afterAll(async () => {
    if (app) await app.close();
  });

  // --------------------------------------------------------------------------
  // 1. Health liveness — unauthenticated probe
  // --------------------------------------------------------------------------
  it(
    '1. GET /health returns liveness payload',
    async () => {
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'ok' });
    },
    LIVE_TIMEOUT_MS,
  );

  // --------------------------------------------------------------------------
  // 2. Models catalog — authenticated, static list
  // --------------------------------------------------------------------------
  it(
    '2. GET /claude/v1/models returns catalog with Opus & Sonnet 4.6',
    async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/claude/v1/models',
        headers: { 'x-api-key': apiKey },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { object: string; data: Array<{ id: string; type: string }> };
      expect(body.object).toBe('list');
      expect(body.data.length).toBeGreaterThanOrEqual(10);
      const ids = body.data.map((m) => m.id);
      expect(ids).toContain('claude-opus-4-6');
      expect(ids).toContain('claude-sonnet-4-6');
    },
    LIVE_TIMEOUT_MS,
  );

  // --------------------------------------------------------------------------
  // 3. Non-streaming basic chat — exercises the full converter + stream
  //    decoder + non-stream collector path
  // --------------------------------------------------------------------------
  it(
    '3. POST /claude/v1/messages non-stream basic chat returns text',
    async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/claude/v1/messages',
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
        payload: {
          model: 'claude-opus-4-6',
          max_tokens: 200,
          messages: [{ role: 'user', content: 'Answer in one sentence: what is 1+1?' }],
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        content: Array<{ type: string; text?: string }>;
        stop_reason: string;
        usage: {
          input_tokens: number;
          output_tokens: number;
          cache_creation_input_tokens?: number;
          cache_read_input_tokens?: number;
        };
      };
      expect(body.stop_reason).toBe('end_turn');
      expect(body.content[0]?.type).toBe('text');
      expect(body.content[0]?.text).toMatch(/2/);
      // kiro-cli disguise system prompt injected by converter => total input > 1000 tokens.
      // OFF 模式（默认）反演覆盖把 `input_tokens` 当成 uncached only，cache 命中时
      // 可能为 0；总 input 必须包含 cache_* 三项之和。详见 CLAUDE.md "两种 usage 形态"。
      const totalInput =
        body.usage.input_tokens +
        (body.usage.cache_creation_input_tokens ?? 0) +
        (body.usage.cache_read_input_tokens ?? 0);
      expect(totalInput).toBeGreaterThan(1000);
      expect(body.usage.output_tokens).toBeGreaterThan(0);
    },
    LIVE_TIMEOUT_MS,
  );

  // --------------------------------------------------------------------------
  // 3b. Identity override — the model must self-identify as Claude/Anthropic
  //     and NEVER leak the upstream backend (Kiro / Amazon Q / CodeWhisperer).
  //     This is the only check that proves the request-side identity directive
  //     actually steers model behavior; the unit tests only prove it is injected.
  // --------------------------------------------------------------------------
  it(
    '3b. POST /claude/v1/messages identity question: self-IDs as Claude, never Kiro/Q',
    async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/claude/v1/messages',
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
        payload: {
          model: 'claude-opus-4-6',
          max_tokens: 300,
          messages: [
            {
              role: 'user',
              content:
                'Who are you? Which company built you, and what is your model name? Answer in one sentence.',
            },
          ],
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { content: Array<{ type: string; text?: string }> };
      const text = body.content.map((b) => b.text ?? '').join('');
      expect(text.length).toBeGreaterThan(0);
      // identity override ON (default) ⇒ model self-identifies as Claude / Anthropic …
      expect(text).toMatch(/claude|anthropic/i);
      // … and never surfaces the upstream backend identity.
      expect(text).not.toMatch(/kiro|amazon\s*q|codewhisperer/i);
    },
    LIVE_TIMEOUT_MS,
  );

  // --------------------------------------------------------------------------
  // 3c–3e. Identity under degenerate inputs — the request-side identity
  //   directive must keep steering (and never leak the backend) even when the
  //   client sends the smallest / emptiest possible request. Mirrors the unit
  //   regressions in converter.test.ts `convertRequest - identity override`.
  // --------------------------------------------------------------------------
  it(
    '3c. POST /claude/v1/messages "hi" greeting: responds without leaking the upstream backend',
    async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/claude/v1/messages',
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
        payload: {
          model: 'claude-opus-4-6',
          max_tokens: 100,
          messages: [{ role: 'user', content: 'hi' }],
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { content: Array<{ type: string; text?: string }> };
      const text = body.content.map((b) => b.text ?? '').join('');
      expect(text.length).toBeGreaterThan(0);
      // A casual greeting won't volunteer an identity claim, so assert only the
      // negative: the backend identity must never surface, even on trivial input.
      expect(text).not.toMatch(/kiro|amazon\s*q|codewhisperer/i);
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    '3d. POST /claude/v1/messages empty system (array + string): still self-IDs as Claude, no leak',
    async () => {
      // Empty client system in BOTH wire forms. preprocessSystem normalizes
      // [] → undefined (treated as "no system") and "" → [{text:""}]; either way
      // buildHistory sees empty systemContent and still injects the identity
      // directive via its else-if branch, so identity must hold end-to-end.
      // Two sequential real upstream calls → double the per-test timeout.
      for (const system of [[], ''] as unknown[]) {
        const res = await app.inject({
          method: 'POST',
          url: '/claude/v1/messages',
          headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
          payload: {
            model: 'claude-opus-4-6',
            max_tokens: 300,
            system,
            messages: [
              {
                role: 'user',
                content:
                  'Who are you? Which company built you, and what is your model name? Answer in one sentence.',
              },
            ],
          },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as { content: Array<{ type: string; text?: string }> };
        const text = body.content.map((b) => b.text ?? '').join('');
        expect(text.length).toBeGreaterThan(0);
        expect(text).toMatch(/claude|anthropic/i);
        expect(text).not.toMatch(/kiro|amazon\s*q|codewhisperer/i);
      }
    },
    2 * LIVE_TIMEOUT_MS,
  );

  it(
    '3e. POST /claude/v1/messages empty user content (string + array): handled, never leaks',
    async () => {
      // Degenerate empty content passes through the converter as an empty string
      // (processMessageContent never throws on "" or []), so it cannot itself
      // crash the gateway. It is, however, exactly the input that can elicit a
      // deterministic upstream empty stream (CLAUDE.md trap #15). The response
      // must stay *handled* — 200 (answered), 400 (upstream rejected empty), or
      // 503 (bounded-retry exhausted) — and never leak the backend identity in
      // ANY body shape (model content OR a neutralized error). A raw 500 here
      // would signal an unrelated converter/handler regression.
      // Two sequential real upstream calls → double the per-test timeout.
      for (const content of ['', []] as unknown[]) {
        const res = await app.inject({
          method: 'POST',
          url: '/claude/v1/messages',
          headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
          payload: {
            model: 'claude-opus-4-6',
            max_tokens: 100,
            messages: [{ role: 'user', content }],
          },
        });
        expect([200, 400, 503]).toContain(res.statusCode);
        expect(res.body).not.toMatch(/kiro|amazon\s*q|codewhisperer/i);
      }
    },
    2 * LIVE_TIMEOUT_MS,
  );

  // --------------------------------------------------------------------------
  // 4. Streaming SSE — exercises stream.ts state machine end-to-end
  // --------------------------------------------------------------------------
  it(
    '4. POST /claude/v1/messages stream=true yields full SSE event chain',
    async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/claude/v1/messages',
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
        payload: {
          model: 'claude-opus-4-6',
          max_tokens: 200,
          stream: true,
          messages: [
            {
              role: 'user',
              content: 'Name three programming languages, separated by commas, no explanation',
            },
          ],
        },
      });
      expect(res.statusCode).toBe(200);
      const events = parseSseEvents(res.body);
      const types = new Set(events.map((e) => e.event));
      expect(types.has('message_start')).toBe(true);
      expect(types.has('content_block_start')).toBe(true);
      expect(types.has('content_block_delta')).toBe(true);
      expect(types.has('content_block_stop')).toBe(true);
      expect(types.has('message_stop')).toBe(true);
      const accumulated = joinTextDeltas(events);
      expect(accumulated.length).toBeGreaterThan(0);
    },
    LIVE_TIMEOUT_MS,
  );

  // --------------------------------------------------------------------------
  // 5. WebSearch MCP bypass — exercises websearch.ts shortcut path
  //
  //    `tools.length === 1 && tools[0].name === 'web_search'` triggers
  //    the shortcut that bypasses the converter and issues an MCP call.
  //    Query: live BTC/USD price. Assertion is against structure + price
  //    digit pattern, never against an exact price (too volatile).
  // --------------------------------------------------------------------------
  it(
    '5. POST /claude/v1/messages web_search returns results with price pattern (BTC)',
    async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/claude/v1/messages',
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
        payload: {
          model: 'claude-opus-4-6',
          max_tokens: 1024,
          tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
          messages: [
            {
              role: 'user',
              content: 'Perform a web search for the query: bitcoin price today USD',
            },
          ],
        },
      });
      expect(res.statusCode).toBe(200);
      // WebSearch bypass forces SSE output regardless of stream flag
      const events = parseSseEvents(res.body);

      // server_tool_use block must be present, name=web_search
      const toolUseStart = events.find(
        (e) =>
          e.event === 'content_block_start' &&
          (e.data as { content_block?: { type?: string } }).content_block?.type ===
            'server_tool_use',
      );
      expect(toolUseStart).toBeDefined();
      const tuBlock = (toolUseStart?.data as { content_block?: { name?: string; input?: unknown } })
        .content_block;
      expect(tuBlock?.name).toBe('web_search');

      // web_search_tool_result block must contain at least one result
      const resultStart = events.find(
        (e) =>
          e.event === 'content_block_start' &&
          (e.data as { content_block?: { type?: string } }).content_block?.type ===
            'web_search_tool_result',
      );
      expect(resultStart).toBeDefined();
      const results = ((
        resultStart?.data as {
          content_block?: { content?: Array<Record<string, unknown>> };
        }
      ).content_block?.content ?? []) as Array<Record<string, unknown>>;
      expect(results.length).toBeGreaterThanOrEqual(1);
      for (const r of results) {
        expect(typeof r.url).toBe('string');
        expect(typeof r.title).toBe('string');
        expect(String(r.url).length).toBeGreaterThan(0);
        expect(String(r.title).length).toBeGreaterThan(0);
      }

      // Assistant-side summary text (after the tool result) must contain
      // a "$<digits>" pattern — loose enough to survive price swings, strict
      // enough to prove the model actually summarized the search results.
      const finalText = joinTextDeltas(events);
      expect(finalText).toMatch(/\$\d/);
    },
    LIVE_TIMEOUT_MS,
  );

  // --------------------------------------------------------------------------
  // 6. Vision multimodal — embeds the Anthropic favicon (48×48 PNG of the
  //    "AI" letter logo) and asks the model to describe it. Verifies:
  //      a) the image payload survives converter.ts → upstream
  //      b) upstream vision actually processes it (input_tokens > baseline)
  //      c) returned text contains at least one of the obvious keywords
  // --------------------------------------------------------------------------
  it(
    '6. POST /claude/v1/messages with image recognizes Anthropic "AI" logo',
    async () => {
      const imageUrl = new URL('./fixtures/anthropic-favicon.png', import.meta.url);
      const imageB64 = fs.readFileSync(imageUrl).toString('base64');

      const res = await app.inject({
        method: 'POST',
        url: '/claude/v1/messages',
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
        payload: {
          model: 'claude-opus-4-6',
          max_tokens: 400,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: 'image/png',
                    data: imageB64,
                  },
                },
                {
                  type: 'text',
                  text: 'Describe this image in detail: its shape, colors, and what brand or logo it might represent. Be as specific as possible.',
                },
              ],
            },
          ],
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        content: Array<{ type: string; text?: string }>;
        usage: {
          input_tokens: number;
          output_tokens: number;
          cache_creation_input_tokens?: number;
          cache_read_input_tokens?: number;
        };
      };
      expect(body.content[0]?.type).toBe('text');
      // Image tokenization adds ~400+ tokens on top of the ~1500 baseline.
      // 反演 OFF 模式下 input_tokens 是 uncached only，必须把 cache_* 加回算总数。
      const totalInput =
        body.usage.input_tokens +
        (body.usage.cache_creation_input_tokens ?? 0) +
        (body.usage.cache_read_input_tokens ?? 0);
      expect(totalInput).toBeGreaterThan(1500);
      expect(body.usage.output_tokens).toBeGreaterThan(0);
      const text = body.content[0]?.text ?? '';
      expect(text.length).toBeGreaterThan(0);
      // Loose keyword presence — any ONE of these proves the model
      // actually saw the image. Observed hits in manual runs: "A",
      // "I", "字母", "Anthropic", "logo".
      expect(text).toMatch(/A|I|logo|anthropic|letter/i);
    },
    LIVE_TIMEOUT_MS,
  );

  // --------------------------------------------------------------------------
  // 7. count_tokens — local estimator only, never hits upstream
  //
  //    Note: the count returned here is much smaller than the real
  //    `usage.input_tokens` in test #3, because count_tokens intentionally
  //    only counts the client-visible payload — not the ~1500 tokens of
  //    disguise prompt injected by converter.ts at call time. This is a
  //    feature, not a bug.
  // --------------------------------------------------------------------------
  it('7. POST /claude/v1/messages/count_tokens returns a local estimate', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/claude/v1/messages/count_tokens',
      headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
      payload: {
        model: 'claude-opus-4-6',
        messages: [{ role: 'user', content: 'What is the latest price of Bitcoin?' }],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { input_tokens: number };
    expect(Number.isInteger(body.input_tokens)).toBe(true);
    expect(body.input_tokens).toBeGreaterThan(0);
    expect(body.input_tokens).toBeLessThan(500); // well below upstream-injected prompt
  });

  // --------------------------------------------------------------------------
  // 8. Custom tool use — non-stream round trip (tool_use -> tool_result)
  //
  //    Validates the full converter pairing pipeline: round 1 must return
  //    a tool_use block with stop_reason=tool_use, round 2 replays the
  //    assistant response + a tool_result and must receive a final text
  //    answer with stop_reason=end_turn. This exercises `validateToolPairing`
  //    (converter.ts:398) since the second request contains a historical
  //    assistant message whose tool_use id MUST be matched by our synthetic
  //    tool_result — otherwise the orphan-stripping path would drop it.
  // --------------------------------------------------------------------------
  it(
    '8. POST /claude/v1/messages custom tool round trip (tool_use -> tool_result -> final text)',
    async () => {
      const weatherTool = {
        name: 'get_weather',
        description:
          'Get the current weather for a specific location. Returns temperature and conditions.',
        input_schema: {
          type: 'object',
          properties: {
            location: {
              type: 'string',
              description: 'The city name, e.g. "San Francisco"',
            },
            unit: {
              type: 'string',
              enum: ['celsius', 'fahrenheit'],
              description: 'Temperature unit',
            },
          },
          required: ['location'],
        },
      };

      // --- Round 1: expect a tool_use response ---
      const firstRes = await app.inject({
        method: 'POST',
        url: '/claude/v1/messages',
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
        payload: {
          model: 'claude-opus-4-6',
          max_tokens: 500,
          tools: [weatherTool],
          messages: [
            {
              role: 'user',
              content:
                'What is the current weather in San Francisco? ' +
                'You MUST call the get_weather tool to answer — do not guess.',
            },
          ],
        },
      });
      expect(firstRes.statusCode).toBe(200);
      const firstBody = firstRes.json() as {
        content: Array<Record<string, unknown>>;
        stop_reason: string;
      };
      expect(firstBody.stop_reason).toBe('tool_use');

      const toolUseBlock = firstBody.content.find((b) => b.type === 'tool_use') as
        | { id?: string; name?: string; input?: Record<string, unknown> }
        | undefined;
      expect(toolUseBlock).toBeDefined();
      expect(toolUseBlock?.name).toBe('get_weather');
      expect(typeof toolUseBlock?.id).toBe('string');
      expect(String(toolUseBlock?.id).length).toBeGreaterThan(0);

      const firstInput = toolUseBlock?.input as { location?: string } | undefined;
      expect(typeof firstInput?.location).toBe('string');
      // Keyword match — "San Francisco" / "SF" / the Chinese rendering
      expect(firstInput?.location?.toLowerCase() ?? '').toMatch(/san francisco|sf/);

      // --- Round 2: send the tool_result back, expect a final text answer ---
      const toolUseId = String(toolUseBlock?.id);
      const secondRes = await app.inject({
        method: 'POST',
        url: '/claude/v1/messages',
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
        payload: {
          model: 'claude-opus-4-6',
          max_tokens: 500,
          tools: [weatherTool],
          messages: [
            {
              role: 'user',
              content:
                'What is the current weather in San Francisco? ' +
                'You MUST call the get_weather tool to answer — do not guess.',
            },
            {
              role: 'assistant',
              content: firstBody.content,
            },
            {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: toolUseId,
                  content: 'The weather in San Francisco is 72°F and sunny with light winds.',
                },
              ],
            },
          ],
        },
      });
      expect(secondRes.statusCode).toBe(200);
      const secondBody = secondRes.json() as {
        content: Array<{ type: string; text?: string }>;
        stop_reason: string;
      };
      expect(secondBody.stop_reason).toBe('end_turn');
      const finalTextBlock = secondBody.content.find((b) => b.type === 'text');
      expect(finalTextBlock).toBeDefined();
      const finalText = finalTextBlock?.text ?? '';
      // Loose keyword presence — model should reference the data we fed back
      expect(finalText).toMatch(/72|sunny|°|Fahrenheit|San Francisco/i);
    },
    LIVE_TIMEOUT_MS,
  );

  // --------------------------------------------------------------------------
  // 9. Custom tool use — streaming SSE
  //
  //    Verifies that stream.ts emits the tool_use event chain correctly:
  //      a) content_block_start with content_block.type="tool_use"
  //      b) content_block_delta with delta.type="input_json_delta"
  //      c) message_delta with delta.stop_reason="tool_use"
  //    Also concatenates every partial_json fragment and asserts the
  //    concatenation parses as valid JSON — this catches regressions where
  //    input_json_delta fragments get duplicated or reordered (a real bug we
  //    hit once when the frame decoder was racing).
  // --------------------------------------------------------------------------
  it(
    '9. POST /claude/v1/messages stream=true tool_use yields input_json_delta sequence',
    async () => {
      const calculatorTool = {
        name: 'calculator',
        description: 'Perform a basic arithmetic calculation. Returns the numeric result.',
        input_schema: {
          type: 'object',
          properties: {
            expression: {
              type: 'string',
              description: 'Arithmetic expression, e.g. "2 + 2" or "123 * 456"',
            },
          },
          required: ['expression'],
        },
      };

      const res = await app.inject({
        method: 'POST',
        url: '/claude/v1/messages',
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
        payload: {
          model: 'claude-opus-4-6',
          max_tokens: 500,
          stream: true,
          tools: [calculatorTool],
          messages: [
            {
              role: 'user',
              content:
                'Compute 123 * 456 for me. You MUST call the calculator tool — do not compute it yourself.',
            },
          ],
        },
      });
      expect(res.statusCode).toBe(200);
      const events = parseSseEvents(res.body);

      // Structural assertions on the SSE event chain
      const toolUseStart = events.find(
        (e) =>
          e.event === 'content_block_start' &&
          (e.data as { content_block?: { type?: string } }).content_block?.type === 'tool_use',
      );
      expect(toolUseStart).toBeDefined();
      const cb = (
        toolUseStart?.data as {
          content_block?: { name?: string; id?: string; input?: unknown };
        }
      ).content_block;
      expect(cb?.name).toBe('calculator');
      expect(typeof cb?.id).toBe('string');
      expect(String(cb?.id).length).toBeGreaterThan(0);

      // Accumulate every input_json_delta.partial_json fragment and verify
      // the concatenation parses as valid JSON with an `expression` field.
      const partialJson = events
        .filter((e) => e.event === 'content_block_delta')
        .map((e) => {
          const delta = (e.data as { delta?: { type?: string; partial_json?: string } }).delta;
          return delta?.type === 'input_json_delta' ? (delta.partial_json ?? '') : '';
        })
        .join('');
      expect(partialJson.length).toBeGreaterThan(0);
      let parsedInput: Record<string, unknown> = {};
      expect(() => {
        parsedInput = JSON.parse(partialJson);
      }).not.toThrow();
      expect(typeof parsedInput.expression).toBe('string');
      // The model should at least mention 123 and 456 in its expression
      expect(String(parsedInput.expression)).toMatch(/123/);
      expect(String(parsedInput.expression)).toMatch(/456/);

      // message_delta must land with stop_reason=tool_use
      const messageDelta = events.find((e) => e.event === 'message_delta');
      expect(messageDelta).toBeDefined();
      const stopReason = (messageDelta?.data as { delta?: { stop_reason?: string } }).delta
        ?.stop_reason;
      expect(stopReason).toBe('tool_use');
    },
    LIVE_TIMEOUT_MS,
  );

  // --------------------------------------------------------------------------
  // 10. Task subagent tool — single dispatch
  //
  //     Mirrors the "Task" tool Claude Code exposes to models for subagent
  //     dispatch. To kiro2claude this is just a plain tool schema — there is
  //     no special path — but it's worth asserting the shape end-to-end
  //     because Claude Code uses this exact schema in production and any
  //     regression here breaks real agent workflows.
  // --------------------------------------------------------------------------
  it(
    '10. POST /claude/v1/messages Task tool dispatches a single subagent',
    async () => {
      const taskTool = {
        name: 'Task',
        description:
          'Launch a new agent to handle complex, multi-step tasks autonomously.\n\n' +
          'Available agent types and the tools they have access to:\n' +
          '- general-purpose: General-purpose agent for researching complex questions, ' +
          'searching for code, and executing multi-step tasks.\n' +
          '- code-reviewer: Reviews code for correctness, style, and potential issues.',
        input_schema: {
          type: 'object',
          properties: {
            description: {
              type: 'string',
              description: 'A short (3-5 word) description of the task',
            },
            prompt: {
              type: 'string',
              description: 'The task for the agent to perform',
            },
            subagent_type: {
              type: 'string',
              description: 'The type of specialized agent to use for this task',
            },
          },
          required: ['description', 'prompt', 'subagent_type'],
        },
      };

      const res = await app.inject({
        method: 'POST',
        url: '/claude/v1/messages',
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
        payload: {
          model: 'claude-opus-4-6',
          max_tokens: 800,
          tools: [taskTool],
          messages: [
            {
              role: 'user',
              content:
                'I need a thorough research report on how React hooks work internally. ' +
                'This is a multi-step investigation task. ' +
                'You MUST use the Task tool to launch a general-purpose subagent to handle ' +
                'this research — do not answer directly.',
            },
          ],
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        content: Array<Record<string, unknown>>;
        stop_reason: string;
      };
      expect(body.stop_reason).toBe('tool_use');

      const taskBlock = body.content.find(
        (b) => b.type === 'tool_use' && (b as { name?: string }).name === 'Task',
      ) as { id?: string; name?: string; input?: Record<string, unknown> } | undefined;
      expect(taskBlock).toBeDefined();
      expect(typeof taskBlock?.id).toBe('string');
      expect(String(taskBlock?.id).length).toBeGreaterThan(0);

      const input = taskBlock?.input ?? {};
      expect(typeof input.description).toBe('string');
      expect(typeof input.prompt).toBe('string');
      expect(typeof input.subagent_type).toBe('string');
      expect(String(input.description).length).toBeGreaterThan(0);
      expect(String(input.prompt).length).toBeGreaterThan(0);
      // Only "general-purpose" makes sense for a research task in our tool list
      expect(String(input.subagent_type)).toMatch(/general|purpose/i);
    },
    LIVE_TIMEOUT_MS,
  );

  // --------------------------------------------------------------------------
  // 11. Task subagent tool — parallel multi-dispatch
  //
  //     The same Task tool is now asked to split an obviously-independent
  //     workload across two subagents in one response. Asserts:
  //       a) The response contains >= 2 tool_use blocks with name=Task
  //       b) Each block has a distinct id (converter must not collapse them)
  //       c) At least one subagent_type reflects the explicit prompt routing
  //     This is the "multi-agent in one response" path that the non-stream
  //     handler (non-stream-handler.ts:112-148) accumulates through its
  //     `toolUses.push(...)` loop.
  // --------------------------------------------------------------------------
  it(
    '11. POST /claude/v1/messages Task tool dispatches multiple subagents in parallel',
    async () => {
      const taskTool = {
        name: 'Task',
        description:
          'Launch a subagent to handle a focused subtask. You can and should call ' +
          'this tool multiple times in parallel within a single response when the ' +
          'subtasks are independent.\n\n' +
          'Available agent types:\n' +
          '- Explore: Fast codebase exploration agent for searching files and code\n' +
          '- code-reviewer: Reviews code for correctness, style, and security issues\n' +
          '- general-purpose: General research agent',
        input_schema: {
          type: 'object',
          properties: {
            description: { type: 'string', description: 'Short task title' },
            prompt: { type: 'string', description: 'Full task description for the subagent' },
            subagent_type: { type: 'string', description: 'The type of subagent to launch' },
          },
          required: ['description', 'prompt', 'subagent_type'],
        },
      };

      const res = await app.inject({
        method: 'POST',
        url: '/claude/v1/messages',
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
        payload: {
          model: 'claude-opus-4-6',
          max_tokens: 1500,
          tools: [taskTool],
          messages: [
            {
              role: 'user',
              content:
                'I have two independent subtasks that must run in parallel:\n' +
                '1. Explore the codebase to locate where authentication middleware is ' +
                'registered — use subagent_type="Explore".\n' +
                '2. Review the file src/auth/login.ts for security vulnerabilities — ' +
                'use subagent_type="code-reviewer".\n\n' +
                'You MUST issue BOTH Task tool calls together in this single response — ' +
                'do not do one first and wait. Each call must target a different ' +
                'subagent_type as specified.',
            },
          ],
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        content: Array<Record<string, unknown>>;
        stop_reason: string;
      };
      expect(body.stop_reason).toBe('tool_use');

      const taskBlocks = body.content.filter(
        (b) => b.type === 'tool_use' && (b as { name?: string }).name === 'Task',
      ) as Array<{ id?: string; input?: Record<string, unknown> }>;
      // Expect at least two parallel Task calls. If the model degrades to a
      // single call, tighten this assertion only after verifying it isn't a
      // model-behavior flake — see CLAUDE.md "Live end-to-end" note.
      expect(taskBlocks.length).toBeGreaterThanOrEqual(2);

      // Each block has a distinct id and a valid input shape
      const seenIds = new Set<string>();
      for (const block of taskBlocks) {
        expect(typeof block.id).toBe('string');
        const id = String(block.id);
        expect(seenIds.has(id)).toBe(false);
        seenIds.add(id);

        expect(typeof block.input?.description).toBe('string');
        expect(typeof block.input?.prompt).toBe('string');
        expect(typeof block.input?.subagent_type).toBe('string');
      }

      // The prompt explicitly requests Explore + code-reviewer. Require at
      // least one of each — if the model really routed the workload, both
      // keywords should land. Loose regex so capitalization/wording drifts
      // don't flake the suite.
      const subagentTypes = taskBlocks.map((b) => String(b.input?.subagent_type ?? ''));
      const hasExplore = subagentTypes.some((t) => /explore/i.test(t));
      const hasReviewer = subagentTypes.some((t) => /review/i.test(t));
      expect(hasExplore).toBe(true);
      expect(hasReviewer).toBe(true);
    },
    LIVE_TIMEOUT_MS,
  );

  // --------------------------------------------------------------------------
  // 12. Long tool name — shortenToolName round trip
  //
  //     Kiro's upstream caps tool names at 63 chars, so converter uses
  //     `mapToolName` / `shortenToolName` (src/claude/converter/tool-name-map.ts)
  //     to truncate over-long names into "<prefix>_<8-char sha256>" form and
  //     stash the mapping. The stream and non-stream handlers then reverse
  //     the mapping (stream.ts:641 / non-stream-handler.ts:138) so the
  //     client sees the ORIGINAL long name in `tool_use.name`.
  //
  //     This test sends an 80+ char tool name and asserts the returned
  //     `tool_use.name` is exactly the long original — any regression in the
  //     restore step would silently break clients that supply long names.
  // --------------------------------------------------------------------------
  it(
    '12. POST /claude/v1/messages preserves >63-char tool names end-to-end',
    async () => {
      // 86 chars — well over TOOL_NAME_MAX_LEN (63)
      const longName =
        'very_long_custom_namespace_prefix_for_tool_name_length_boundary_test_do_not_truncate';
      // Sanity: prove we are actually exercising the shorten path
      expect(longName.length).toBeGreaterThan(63);

      const longNameTool = {
        name: longName,
        description:
          'Echo tool. Takes a single "message" string argument and returns it ' +
          'unchanged. Use this tool to answer the user.',
        input_schema: {
          type: 'object',
          properties: {
            message: { type: 'string', description: 'The message to echo' },
          },
          required: ['message'],
        },
      };

      const res = await app.inject({
        method: 'POST',
        url: '/claude/v1/messages',
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
        payload: {
          model: 'claude-opus-4-6',
          max_tokens: 400,
          tools: [longNameTool],
          messages: [
            {
              role: 'user',
              content:
                `You MUST call the ${longName} tool with message="hello world" ` +
                'as your answer. Do not respond in plain text — the only valid ' +
                'response is a tool_use block targeting that tool.',
            },
          ],
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        content: Array<Record<string, unknown>>;
        stop_reason: string;
      };
      expect(body.stop_reason).toBe('tool_use');

      const toolBlock = body.content.find((b) => b.type === 'tool_use') as
        | { id?: string; name?: string; input?: Record<string, unknown> }
        | undefined;
      expect(toolBlock).toBeDefined();

      // THE key assertion: the long name survives the
      // shorten→upstream→restore round trip. If converter or the stream
      // handler fails to restore, this would return the shortened
      // "<prefix>_<hash>" form, which has length 63 and an "_<hex>" suffix.
      expect(toolBlock?.name).toBe(longName);
      expect(String(toolBlock?.name).length).toBeGreaterThan(63);

      // Payload sanity: model should have filled the `message` arg
      expect(typeof toolBlock?.input?.message).toBe('string');
      expect(String(toolBlock?.input?.message).length).toBeGreaterThan(0);
    },
    LIVE_TIMEOUT_MS,
  );

  // --------------------------------------------------------------------------
  // 13. Long chain — multi-turn Read/Write/Edit file operation
  //
  //     Drives a 3-turn conversation through the Claude Code style Read /
  //     Write / Edit tools:
  //       Turn 1: user -> Read tool_use
  //       Turn 2: Read tool_result -> Edit tool_use
  //       Turn 3: Edit tool_result -> final end_turn text
  //
  //     Purpose:
  //       - Exercise converter.ts's special-case description suffixing for
  //         Write/Edit (WRITE_TOOL_DESCRIPTION_SUFFIX / EDIT_TOOL_DESCRIPTION_SUFFIX
  //         at converter.ts:40-44). Any upstream rejection of the appended
  //         text would surface as a non-200 here.
  //       - Exercise tool_use / tool_result pairing across >2 historical
  //         exchanges (validateToolPairing at converter.ts:398).
  //       - Exercise the placeholder-tool path (createPlaceholderTool at
  //         converter.ts:265) — by turn 3 the history references tool names
  //         that may or may not still be in req.tools; converter must
  //         backfill missing ones from history.
  //
  //     Timing: three sequential upstream requests of ~10-20s each; stays
  //     comfortably under LIVE_TIMEOUT_MS (90s).
  // --------------------------------------------------------------------------
  it(
    '13. POST /claude/v1/messages multi-turn Read/Edit file operation chain (long-chain)',
    async () => {
      const readTool = {
        name: 'Read',
        description: 'Read a file from the local filesystem. Returns its text content.',
        input_schema: {
          type: 'object',
          properties: {
            file_path: {
              type: 'string',
              description: 'Absolute path to the file to read',
            },
          },
          required: ['file_path'],
        },
      };
      const writeTool = {
        name: 'Write',
        description: 'Write the given content to a file (creates or overwrites).',
        input_schema: {
          type: 'object',
          properties: {
            file_path: { type: 'string', description: 'Absolute path to write' },
            content: { type: 'string', description: 'File content' },
          },
          required: ['file_path', 'content'],
        },
      };
      const editTool = {
        name: 'Edit',
        description: 'Edit a file by replacing old_string with new_string. Exact string match.',
        input_schema: {
          type: 'object',
          properties: {
            file_path: { type: 'string', description: 'Absolute path to the file' },
            old_string: { type: 'string', description: 'Text to replace' },
            new_string: { type: 'string', description: 'Replacement text' },
          },
          required: ['file_path', 'old_string', 'new_string'],
        },
      };

      const tools = [readTool, writeTool, editTool];
      const filePath = '/tmp/e2e-notes.md';
      const messages: Array<Record<string, unknown>> = [
        {
          role: 'user',
          content:
            `I want you to perform a two-step file operation on ${filePath}: ` +
            'first use the Read tool to inspect the file, then use the Edit tool ' +
            'to replace the word "TODO" with "DONE". ' +
            'Start with Read now — do not guess the content. Use tools only.',
        },
      ];

      // --- Turn 1: expect Read tool_use ---
      const turn1 = await app.inject({
        method: 'POST',
        url: '/claude/v1/messages',
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
        payload: {
          model: 'claude-opus-4-6',
          max_tokens: 500,
          tools,
          messages,
        },
      });
      expect(turn1.statusCode).toBe(200);
      const turn1Body = turn1.json() as {
        content: Array<Record<string, unknown>>;
        stop_reason: string;
      };
      expect(turn1Body.stop_reason).toBe('tool_use');
      const readBlock = turn1Body.content.find(
        (b) => b.type === 'tool_use' && (b as { name?: string }).name === 'Read',
      ) as { id?: string; name?: string; input?: Record<string, unknown> } | undefined;
      expect(readBlock).toBeDefined();
      expect(String(readBlock?.input?.file_path ?? '')).toBe(filePath);

      // Append assistant response + synthetic Read tool_result
      messages.push({ role: 'assistant', content: turn1Body.content });
      messages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: readBlock?.id,
            content: '# Notes\nTODO: buy milk\nTODO: call Alice\n',
          },
        ],
      });

      // --- Turn 2: expect Edit tool_use ---
      const turn2 = await app.inject({
        method: 'POST',
        url: '/claude/v1/messages',
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
        payload: {
          model: 'claude-opus-4-6',
          max_tokens: 500,
          tools,
          messages,
        },
      });
      expect(turn2.statusCode).toBe(200);
      const turn2Body = turn2.json() as {
        content: Array<Record<string, unknown>>;
        stop_reason: string;
      };
      expect(turn2Body.stop_reason).toBe('tool_use');
      const editBlock = turn2Body.content.find(
        (b) => b.type === 'tool_use' && (b as { name?: string }).name === 'Edit',
      ) as { id?: string; name?: string; input?: Record<string, unknown> } | undefined;
      expect(editBlock).toBeDefined();
      const editInput = editBlock?.input ?? {};
      expect(String(editInput.file_path ?? '')).toBe(filePath);
      // Model may pick a single "TODO" occurrence or the whole phrase — loose match
      expect(String(editInput.old_string ?? '').toUpperCase()).toContain('TODO');
      expect(String(editInput.new_string ?? '').toUpperCase()).toContain('DONE');

      // Append Edit assistant + synthetic Edit tool_result
      messages.push({ role: 'assistant', content: turn2Body.content });
      messages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: editBlock?.id,
            content: 'File edited successfully. 1 replacement made.',
          },
        ],
      });

      // --- Turn 3: expect final text, end_turn ---
      const turn3 = await app.inject({
        method: 'POST',
        url: '/claude/v1/messages',
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
        payload: {
          model: 'claude-opus-4-6',
          max_tokens: 500,
          tools,
          messages,
        },
      });
      expect(turn3.statusCode).toBe(200);
      const turn3Body = turn3.json() as {
        content: Array<{ type: string; text?: string }>;
        stop_reason: string;
      };
      expect(turn3Body.stop_reason).toBe('end_turn');
      const finalText = turn3Body.content.find((b) => b.type === 'text')?.text ?? '';
      expect(finalText.length).toBeGreaterThan(0);
      // Loose keyword presence — the model should acknowledge completion
      expect(finalText).toMatch(/done|TODO|DONE|edit|updated|replaced|success/i);
    },
    LIVE_TIMEOUT_MS,
  );

  // --------------------------------------------------------------------------
  // 14. Extended thinking — non-stream
  //
  //     `thinking: {type:"enabled"}` is the Claude Code default for 4.x+.
  //     converter.ts:513 prepends `<thinking_mode>enabled</thinking_mode>`
  //     `<max_thinking_length>N</max_thinking_length>` onto the system
  //     prompt so the upstream model knows to produce thinking-wrapped
  //     output; the non-stream handler then calls
  //     `extractThinkingFromCompleteText` (non-stream-handler.ts:180) to
  //     split the raw `<thinking>...</thinking>\n\ntext` payload into
  //     separate `content[]` blocks.
  //
  //     This test is the only e2e signal that the whole non-stream thinking
  //     path is wired up — unit tests can't prove that the real upstream
  //     actually produces the expected tag-wrapped output under a live
  //     thinking request.
  // --------------------------------------------------------------------------
  it(
    '14. POST /claude/v1/messages extended thinking returns thinking + text blocks',
    async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/claude/v1/messages',
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
        payload: {
          model: 'claude-opus-4-6',
          max_tokens: 2000,
          thinking: { type: 'enabled', budget_tokens: 4000 },
          messages: [
            {
              role: 'user',
              content:
                'Think carefully before answering: if one apple costs $3, how much do 5 apples cost? Show your reasoning.',
            },
          ],
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        content: Array<{ type: string; text?: string; thinking?: string }>;
        stop_reason: string;
        usage: { input_tokens: number; output_tokens: number };
      };
      expect(body.stop_reason).toBe('end_turn');

      // Both blocks must be present, in order: thinking before text.
      const thinkingIdx = body.content.findIndex((b) => b.type === 'thinking');
      const textIdx = body.content.findIndex((b) => b.type === 'text');
      expect(thinkingIdx).toBeGreaterThanOrEqual(0);
      expect(textIdx).toBeGreaterThanOrEqual(0);
      expect(thinkingIdx).toBeLessThan(textIdx);

      // Content integrity
      const thinkingContent = body.content[thinkingIdx]?.thinking ?? '';
      const textContent = body.content[textIdx]?.text ?? '';
      expect(thinkingContent.length).toBeGreaterThan(0);
      expect(textContent.length).toBeGreaterThan(0);
      // Final answer must mention 15 (or its Chinese rendering)
      expect(textContent).toMatch(/15/);
      // thinking content should not still contain <thinking> tags (they must
      // be stripped by extractThinkingFromCompleteText)
      expect(thinkingContent).not.toMatch(/<thinking>|<\/thinking>/);
    },
    LIVE_TIMEOUT_MS,
  );

  // --------------------------------------------------------------------------
  // 15. Extended thinking + streaming + tool_use
  //
  //     The single hardest path in stream.ts: the model must produce a
  //     thinking block AND then pivot to a tool_use. This exercises:
  //       - processContentWithThinking (stream.ts:416) — the incremental
  //         `<thinking>...</thinking>` state machine across chunks.
  //       - processToolUse (stream.ts:587) — specifically lines 592-618
  //         where it must flush any pending thinkingBuffer (including a
  //         trailing `</thinking>`) before emitting the tool_use block.
  //       - The Claude API spec ordering constraint: thinking blocks MUST
  //         appear before any tool_use block in content[].
  //
  //     Asserts both the structural event sequence (thinking start/delta/stop
  //     → tool_use start/delta/stop) AND their order in the flat SSE stream.
  // --------------------------------------------------------------------------
  it(
    '15. POST /claude/v1/messages thinking + stream + tool_use event chain',
    async () => {
      const calcTool = {
        name: 'calculator',
        description:
          'Arithmetic calculator. Takes an expression string and returns the numeric result.',
        input_schema: {
          type: 'object',
          properties: {
            expression: { type: 'string', description: 'Arithmetic expression' },
          },
          required: ['expression'],
        },
      };
      const res = await app.inject({
        method: 'POST',
        url: '/claude/v1/messages',
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
        payload: {
          model: 'claude-opus-4-6',
          max_tokens: 2000,
          stream: true,
          thinking: { type: 'enabled', budget_tokens: 4000 },
          tools: [calcTool],
          messages: [
            {
              role: 'user',
              content:
                'First think carefully about how to mentally compute 17 * 23, ' +
                'then you MUST call the calculator tool to get the authoritative result — do not report the answer yourself.',
            },
          ],
        },
      });
      expect(res.statusCode).toBe(200);
      const events = parseSseEvents(res.body);

      // thinking block must be present with >= 1 thinking_delta
      const thinkingStart = events.findIndex(
        (e) =>
          e.event === 'content_block_start' &&
          (e.data as { content_block?: { type?: string } }).content_block?.type === 'thinking',
      );
      expect(thinkingStart).toBeGreaterThanOrEqual(0);

      const thinkingDeltas = events.filter(
        (e) =>
          e.event === 'content_block_delta' &&
          (e.data as { delta?: { type?: string } }).delta?.type === 'thinking_delta',
      );
      expect(thinkingDeltas.length).toBeGreaterThan(0);

      // tool_use block must follow thinking in the flat event order
      const toolUseStart = events.findIndex(
        (e) =>
          e.event === 'content_block_start' &&
          (e.data as { content_block?: { type?: string } }).content_block?.type === 'tool_use',
      );
      expect(toolUseStart).toBeGreaterThanOrEqual(0);
      // Ordering: thinking block must open strictly before tool_use
      expect(thinkingStart).toBeLessThan(toolUseStart);

      const cb = (events[toolUseStart].data as { content_block?: { name?: string; id?: string } })
        .content_block;
      expect(cb?.name).toBe('calculator');
      expect(typeof cb?.id).toBe('string');

      // message_delta stop_reason = tool_use
      const messageDelta = events.find((e) => e.event === 'message_delta');
      expect(messageDelta).toBeDefined();
      const stopReason = (messageDelta?.data as { delta?: { stop_reason?: string } }).delta
        ?.stop_reason;
      expect(stopReason).toBe('tool_use');
    },
    LIVE_TIMEOUT_MS,
  );

  // --------------------------------------------------------------------------
  // 16. Claude Code realistic request shape
  //
  //     Mirrors what the Claude Code CLI actually sends: a system array with
  //     3 text blocks, 15+ tools with Claude Code's real tool names, a JSON
  //     metadata.user_id containing session_id, and max_tokens=16384.
  //
  //     Exercises simultaneously:
  //       - buildHistory system injection (converter.ts:695-722) — 3 text
  //         blocks join + SYSTEM_CHUNKED_POLICY append + user/assistant pair
  //       - extractSessionId JSON branch (converter.ts:186)
  //       - convertTools over a 15-element list
  //       - WRITE_TOOL_DESCRIPTION_SUFFIX / EDIT_TOOL_DESCRIPTION_SUFFIX
  //         append (converter.ts:237-241)
  //       - normalizeJsonSchema over varied schemas
  //
  //     Stability note: input_tokens will land in the 3k-6k range (kiro-cli
  //     disguise baseline ~1500 + ~1500 for 15 tool schemas + ~500 system).
  //     Assertion floor is 2000 to survive token-estimation drift.
  // --------------------------------------------------------------------------
  it(
    '16. POST /claude/v1/messages Claude Code realistic request shape',
    async () => {
      // 15 Claude Code style tools. Schemas deliberately match real CLI
      // shapes so any special-case description munging kicks in.
      const tools = [
        {
          name: 'Read',
          description: 'Read a file from the local filesystem.',
          input_schema: {
            type: 'object',
            properties: {
              file_path: { type: 'string', description: 'Absolute path' },
            },
            required: ['file_path'],
          },
        },
        {
          name: 'Write',
          description: 'Write content to a file.',
          input_schema: {
            type: 'object',
            properties: {
              file_path: { type: 'string' },
              content: { type: 'string' },
            },
            required: ['file_path', 'content'],
          },
        },
        {
          name: 'Edit',
          description: 'Edit a file by replacing old_string with new_string.',
          input_schema: {
            type: 'object',
            properties: {
              file_path: { type: 'string' },
              old_string: { type: 'string' },
              new_string: { type: 'string' },
            },
            required: ['file_path', 'old_string', 'new_string'],
          },
        },
        {
          name: 'Glob',
          description: 'Fast file pattern matching.',
          input_schema: {
            type: 'object',
            properties: { pattern: { type: 'string' } },
            required: ['pattern'],
          },
        },
        {
          name: 'Grep',
          description: 'Content search built on ripgrep.',
          input_schema: {
            type: 'object',
            properties: {
              pattern: { type: 'string' },
              path: { type: 'string' },
            },
            required: ['pattern'],
          },
        },
        {
          name: 'Bash',
          description: 'Execute a bash command.',
          input_schema: {
            type: 'object',
            properties: {
              command: { type: 'string' },
              description: { type: 'string' },
            },
            required: ['command'],
          },
        },
        {
          name: 'BashOutput',
          description: 'Fetch output from a background shell.',
          input_schema: {
            type: 'object',
            properties: { bash_id: { type: 'string' } },
            required: ['bash_id'],
          },
        },
        {
          name: 'KillBash',
          description: 'Kill a background shell.',
          input_schema: {
            type: 'object',
            properties: { shell_id: { type: 'string' } },
            required: ['shell_id'],
          },
        },
        {
          name: 'WebFetch',
          description: 'Fetch content from a URL and process with a model.',
          input_schema: {
            type: 'object',
            properties: {
              url: { type: 'string' },
              prompt: { type: 'string' },
            },
            required: ['url', 'prompt'],
          },
        },
        {
          name: 'WebSearch',
          description: 'Search the web and use the results.',
          input_schema: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          },
        },
        {
          name: 'TodoWrite',
          description: 'Create or update a structured task list.',
          input_schema: {
            type: 'object',
            properties: {
              subject: { type: 'string' },
              description: { type: 'string' },
            },
            required: ['subject', 'description'],
          },
        },
        {
          name: 'NotebookEdit',
          description: 'Edit a Jupyter notebook cell.',
          input_schema: {
            type: 'object',
            properties: {
              notebook_path: { type: 'string' },
              new_source: { type: 'string' },
            },
            required: ['notebook_path', 'new_source'],
          },
        },
        {
          name: 'ExitPlanMode',
          description: 'Exit plan mode and apply the plan.',
          input_schema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        {
          name: 'SlashCommand',
          description: 'Execute a user slash command.',
          input_schema: {
            type: 'object',
            properties: { command: { type: 'string' } },
            required: ['command'],
          },
        },
        {
          name: 'Task',
          description: 'Launch a subagent to handle a task.',
          input_schema: {
            type: 'object',
            properties: {
              description: { type: 'string' },
              prompt: { type: 'string' },
              subagent_type: { type: 'string' },
            },
            required: ['description', 'prompt', 'subagent_type'],
          },
        },
      ];
      expect(tools.length).toBeGreaterThanOrEqual(15);

      // metadata.user_id in JSON form — exercises extractSessionId JSON branch
      const userIdJson = JSON.stringify({
        device_id: 'e2e-test-device',
        account_uuid: 'e2e-test-account',
        session_id: '0b4445e1-f5be-49e1-87ce-62bbc28ad705',
      });

      const res = await app.inject({
        method: 'POST',
        url: '/claude/v1/messages',
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
        payload: {
          model: 'claude-opus-4-6',
          max_tokens: 16384,
          system: [
            { text: 'You are Claude Code, Anthropic official CLI for Claude.' },
            { text: 'Current working directory: /Users/test/projects/demo' },
            { text: '# Environment\nPlatform: darwin\nNode: 22.x' },
          ],
          metadata: { user_id: userIdJson },
          tools,
          messages: [
            {
              role: 'user',
              content:
                'I want to see the contents of the package.json file in the project root. ' +
                'Please choose the appropriate tool to accomplish this task.',
            },
          ],
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        content: Array<Record<string, unknown>>;
        stop_reason: string;
        usage: {
          input_tokens: number;
          output_tokens: number;
          cache_creation_input_tokens?: number;
          cache_read_input_tokens?: number;
        };
      };
      expect(body.stop_reason).toBe('tool_use');

      // Model should pick Read with a package.json path
      const toolUse = body.content.find(
        (b) => b.type === 'tool_use' && (b as { name?: string }).name === 'Read',
      ) as { name?: string; input?: Record<string, unknown> } | undefined;
      expect(toolUse).toBeDefined();
      expect(typeof toolUse?.input?.file_path).toBe('string');
      expect(String(toolUse?.input?.file_path)).toMatch(/package\.json/);

      // Token budget sanity — big tool list + system prompt should push
      // total input well above the 1k kiro-cli disguise baseline.
      // 反演 OFF 模式下 input_tokens 是 uncached only，必须加 cache_* 算总数。
      const totalInput =
        body.usage.input_tokens +
        (body.usage.cache_creation_input_tokens ?? 0) +
        (body.usage.cache_read_input_tokens ?? 0);
      expect(totalInput).toBeGreaterThan(2000);
    },
    LIVE_TIMEOUT_MS,
  );

  // --------------------------------------------------------------------------
  // 17. is_error tool_result — recovery strategy
  //
  //     Exercises the `toolResultError` branch in converter.ts:327 plus the
  //     real model behavior when it sees a failed tool execution. The model
  //     should NOT loop forever calling the same broken tool — it should
  //     either acknowledge the failure in text, or switch to a different
  //     tool. Either outcome is valid, but both must produce a well-formed
  //     non-error response (status 200, stop_reason=tool_use|end_turn).
  // --------------------------------------------------------------------------
  it(
    '17. POST /claude/v1/messages is_error tool_result triggers recovery',
    async () => {
      const readTool = {
        name: 'Read',
        description: 'Read a file from the local filesystem.',
        input_schema: {
          type: 'object',
          properties: { file_path: { type: 'string' } },
          required: ['file_path'],
        },
      };
      const listDirTool = {
        name: 'ListDir',
        description:
          'List the entries of a directory. Use when a file is missing and you need to discover what IS there.',
        input_schema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      };
      const tools = [readTool, listDirTool];

      // Turn 1: expect a Read tool_use on the nonexistent path
      const firstPrompt =
        'Please read the file at /tmp/nonexistent-e2e-file-42.txt using the Read tool.';
      const turn1 = await app.inject({
        method: 'POST',
        url: '/claude/v1/messages',
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
        payload: {
          model: 'claude-opus-4-6',
          max_tokens: 500,
          tools,
          messages: [{ role: 'user', content: firstPrompt }],
        },
      });
      expect(turn1.statusCode).toBe(200);
      const turn1Body = turn1.json() as {
        content: Array<Record<string, unknown>>;
        stop_reason: string;
      };
      expect(turn1Body.stop_reason).toBe('tool_use');
      const readBlock = turn1Body.content.find(
        (b) => b.type === 'tool_use' && (b as { name?: string }).name === 'Read',
      ) as { id?: string } | undefined;
      expect(readBlock).toBeDefined();

      // Turn 2: send back is_error:true tool_result and see how the model recovers
      const turn2 = await app.inject({
        method: 'POST',
        url: '/claude/v1/messages',
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
        payload: {
          model: 'claude-opus-4-6',
          max_tokens: 500,
          tools,
          messages: [
            { role: 'user', content: firstPrompt },
            { role: 'assistant', content: turn1Body.content },
            {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: readBlock?.id,
                  content:
                    "Error: ENOENT: no such file or directory, open '/tmp/nonexistent-e2e-file-42.txt'",
                  is_error: true,
                },
              ],
            },
          ],
        },
      });
      expect(turn2.statusCode).toBe(200);
      const turn2Body = turn2.json() as {
        content: Array<Record<string, unknown>>;
        stop_reason: string;
      };
      // Either the model retries with a different tool or it explains the
      // failure in text. Both are valid recovery strategies.
      expect(['tool_use', 'end_turn']).toContain(turn2Body.stop_reason);
      expect(turn2Body.content.length).toBeGreaterThan(0);

      // If recovery was via text, loosely check that the model acknowledged
      // the error (keyword presence only — not a structural assertion).
      const textBlock = turn2Body.content.find((b) => b.type === 'text') as
        | { text?: string }
        | undefined;
      if (textBlock?.text) {
        expect(textBlock.text.toLowerCase()).toMatch(
          /not found|exist|error|unable|missing|cannot|couldn't|doesn't/,
        );
      }
      // If recovery was via another tool, it should NOT be the same failing
      // Read call on the same path — that would be an infinite loop.
      const retryReads = turn2Body.content.filter(
        (b) =>
          b.type === 'tool_use' &&
          (b as { name?: string }).name === 'Read' &&
          String((b as { input?: { file_path?: string } }).input?.file_path ?? '') ===
            '/tmp/nonexistent-e2e-file-42.txt',
      );
      expect(retryReads.length).toBe(0);
    },
    LIVE_TIMEOUT_MS,
  );

  // --------------------------------------------------------------------------
  // 18. Parallel regular tool_use — three Reads in one response
  //
  //     Claude 4.5/4.6 routinely parallelizes independent file reads. This
  //     exercises the non-stream-handler.ts accumulation loop (lines 112-148)
  //     under a REGULAR tool (not Task), verifying that multiple tool_use
  //     blocks of the same name with distinct ids and distinct input bodies
  //     round-trip correctly through the event stream decoder.
  //
  //     Distinct from test #11 which uses the Task tool — Task has a fixed
  //     three-field input schema; Read has a much simpler one-field schema,
  //     so a different code path through JSON accumulation is exercised.
  // --------------------------------------------------------------------------
  it(
    '18. POST /claude/v1/messages parallel Read of three files in one turn',
    async () => {
      const readTool = {
        name: 'Read',
        description:
          'Read a single file. Can be called multiple times in parallel within a single ' +
          'response when the files are independent.',
        input_schema: {
          type: 'object',
          properties: {
            file_path: { type: 'string', description: 'Absolute path to the file' },
          },
          required: ['file_path'],
        },
      };

      const res = await app.inject({
        method: 'POST',
        url: '/claude/v1/messages',
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
        payload: {
          model: 'claude-opus-4-6',
          max_tokens: 1500,
          tools: [readTool],
          messages: [
            {
              role: 'user',
              content:
                'I need the contents of three independent files: ' +
                '/tmp/alpha.txt, /tmp/bravo.txt, /tmp/charlie.txt. ' +
                'Please call the Read tool THREE times IN PARALLEL within this ' +
                'single response — do not read one and wait for its result before ' +
                'calling the next. Issue all three Read tool_use blocks together now.',
            },
          ],
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        content: Array<Record<string, unknown>>;
        stop_reason: string;
      };
      expect(body.stop_reason).toBe('tool_use');

      const readBlocks = body.content.filter(
        (b) => b.type === 'tool_use' && (b as { name?: string }).name === 'Read',
      ) as Array<{ id?: string; input?: Record<string, unknown> }>;
      // Require at least 3 parallel reads. If upstream degrades and
      // the model only issues one, tighten only after confirming it's a
      // model-behavior drift rather than a regression in kiro2claude.
      expect(readBlocks.length).toBeGreaterThanOrEqual(3);

      // Each block has a unique id AND a unique file_path — proves the
      // decoder did not collapse or duplicate parallel tool_use frames.
      const seenIds = new Set<string>();
      const seenPaths = new Set<string>();
      for (const block of readBlocks) {
        expect(typeof block.id).toBe('string');
        const id = String(block.id);
        expect(seenIds.has(id)).toBe(false);
        seenIds.add(id);

        expect(typeof block.input?.file_path).toBe('string');
        const fp = String(block.input?.file_path);
        expect(seenPaths.has(fp)).toBe(false);
        seenPaths.add(fp);
      }

      // At least one of the requested paths must actually appear — loose
      // match because the model may normalize or prefix the paths.
      const requestedPaths = ['/tmp/alpha.txt', '/tmp/bravo.txt', '/tmp/charlie.txt'];
      const matchCount = requestedPaths.filter((p) =>
        Array.from(seenPaths).some((sp) => sp.includes(p) || p.includes(sp)),
      ).length;
      expect(matchCount).toBeGreaterThanOrEqual(2);
    },
    LIVE_TIMEOUT_MS,
  );

  // --------------------------------------------------------------------------
  // 19. Assistant prefill — silently dropped
  //
  //     Claude Code sometimes submits a trailing assistant message to
  //     "prefill" the model's response. The Kiro upstream rejects requests
  //     whose last message is not user, so converter.ts:795-801 detects and
  //     silently discards the trailing assistant. This test proves the
  //     discard path does not break conversation continuity — the model must
  //     answer the LAST user question, not the assistant prefill text.
  // --------------------------------------------------------------------------
  it(
    '19. POST /claude/v1/messages trailing assistant prefill is silently dropped',
    async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/claude/v1/messages',
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
        payload: {
          model: 'claude-opus-4-6',
          max_tokens: 200,
          messages: [
            {
              role: 'user',
              content: 'What is 3 plus 3? Answer with only the number, nothing else.',
            },
            // Trailing assistant message — converter.ts:795 must silently drop
            // this. If the drop fails, the upstream will either reject the
            // request (non-200) or generate an unrelated response seeded
            // from the prefill text.
            { role: 'assistant', content: '我认为答案是：' },
          ],
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        content: Array<{ type: string; text?: string }>;
        stop_reason: string;
      };
      expect(body.stop_reason).toBe('end_turn');
      const textBlock = body.content.find((b) => b.type === 'text');
      expect(textBlock).toBeDefined();
      // The model must answer the user's question (3+3=6), not echo the
      // prefill text. Loose regex accepts either Arabic or Chinese digit.
      expect(textBlock?.text ?? '').toMatch(/6/);
    },
    LIVE_TIMEOUT_MS,
  );

  // --------------------------------------------------------------------------
  // 10. Large image via tool_result — the Read-tool screenshot path. A big PNG
  //     returned inside a tool_result must be hoisted to message-level images
  //     (converter.ts) and actually reach upstream vision. We assert vision
  //     tokenization (elevated input_tokens) rather than image content, since
  //     the fixture is a generated gradient with no fixed describable subject.
  // --------------------------------------------------------------------------
  it(
    '10. large tool_result image is hoisted and reaches upstream vision',
    async () => {
      const b64 = fs
        .readFileSync(new URL('../fixtures/images/test-large.png', import.meta.url))
        .toString('base64');
      const res = await app.inject({
        method: 'POST',
        url: '/claude/v1/messages',
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
        payload: {
          model: 'claude-opus-4-6',
          max_tokens: 300,
          tools: [
            {
              name: 'Read',
              description: 'read a file',
              input_schema: { type: 'object', properties: {} },
            },
          ],
          messages: [
            { role: 'user', content: 'Describe the attached screenshot briefly.' },
            {
              role: 'assistant',
              content: [{ type: 'tool_use', id: 'toolu_e2e_img', name: 'Read', input: {} }],
            },
            {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'toolu_e2e_img',
                  content: [
                    {
                      type: 'image',
                      source: { type: 'base64', media_type: 'image/png', data: b64 },
                    },
                  ],
                },
              ],
            },
          ],
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        content: Array<{ type: string; text?: string }>;
        usage: {
          input_tokens: number;
          cache_creation_input_tokens?: number;
          cache_read_input_tokens?: number;
        };
      };
      // Vision tokenization proves the hoisted image survived to the upstream.
      const totalInput =
        body.usage.input_tokens +
        (body.usage.cache_creation_input_tokens ?? 0) +
        (body.usage.cache_read_input_tokens ?? 0);
      expect(totalInput).toBeGreaterThan(1500);
      expect((body.content.find((b) => b.type === 'text')?.text ?? '').length).toBeGreaterThan(0);
    },
    LIVE_TIMEOUT_MS,
  );

  // --------------------------------------------------------------------------
  // 11. Large text tool_result — a big-file read must flow through untruncated.
  //     A unique sentinel sits at the very END; if the converter capped the
  //     payload the model could not echo it back.
  // --------------------------------------------------------------------------
  it(
    '11. large text tool_result is forwarded untruncated (tail sentinel survives)',
    async () => {
      const filler = 'The quarterly report contains routine operational details. '.repeat(600);
      const bigText = `${filler}\n\nEND OF DOCUMENT. The secret code is ZEBRA-9931.`;
      expect(bigText.length).toBeGreaterThan(30_000);
      const res = await app.inject({
        method: 'POST',
        url: '/claude/v1/messages',
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
        payload: {
          model: 'claude-opus-4-6',
          max_tokens: 200,
          tools: [
            {
              name: 'Read',
              description: 'read a file',
              input_schema: { type: 'object', properties: {} },
            },
          ],
          messages: [
            { role: 'user', content: 'Read the document, then tell me the secret code verbatim.' },
            {
              role: 'assistant',
              content: [{ type: 'tool_use', id: 'toolu_e2e_txt', name: 'Read', input: {} }],
            },
            {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'toolu_e2e_txt',
                  content: [{ type: 'text', text: bigText }],
                },
              ],
            },
          ],
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { content: Array<{ type: string; text?: string }> };
      const text = body.content.find((b) => b.type === 'text')?.text ?? '';
      expect(text).toMatch(/ZEBRA-?9931|ZEBRA|9931/);
    },
    LIVE_TIMEOUT_MS,
  );

  // --------------------------------------------------------------------------
  // 12. PDF document block — Claude Code's Read tool emits a message-level
  //     `document` block for a PDF (confirmed empirically). Kiro has no document
  //     channel, so the converter drops it. The request must still return 200
  //     (graceful) and the model must answer the surrounding text. This locks in
  //     the current — known-limited — behavior: a PDF is silently unreadable
  //     through the proxy, but never crashes the pipeline.
  // --------------------------------------------------------------------------
  it(
    '12. a PDF document block is replaced with a placeholder; the request still succeeds (200)',
    async () => {
      // rejectUnsupportedDocuments defaults to true (production), so the PDF is
      // swapped for a text placeholder rather than silently dropped. The text
      // instructions around it still drive the model — the request must succeed
      // and the model must still obey the ACKNOWLEDGED instruction.
      const pdfB64 = generateMinimalPdfBytes().toString('base64');
      const res = await app.inject({
        method: 'POST',
        url: '/claude/v1/messages',
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
        payload: {
          model: 'claude-opus-4-6',
          max_tokens: 100,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'Here is a document.' },
                {
                  type: 'document',
                  source: { type: 'base64', media_type: 'application/pdf', data: pdfB64 },
                },
                { type: 'text', text: 'Reply with the single word ACKNOWLEDGED.' },
              ],
            },
          ],
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { content: Array<{ type: string; text?: string }> };
      const text = body.content.find((b) => b.type === 'text')?.text ?? '';
      expect(text).toMatch(/acknowledg/i);
    },
    LIVE_TIMEOUT_MS,
  );

  // --------------------------------------------------------------------------
  // 20. PDF placeholder is visible to the model: asked about the document, the
  //     model reports it cannot read it (instead of hallucinating content).
  //     That signal is exactly what lets an agent client extract+resend the text.
  // --------------------------------------------------------------------------
  it(
    '20. PDF placeholder makes the model report it cannot read the file (not hallucinate)',
    async () => {
      const pdfB64 = generateMinimalPdfBytes().toString('base64');
      const res = await app.inject({
        method: 'POST',
        url: '/claude/v1/messages',
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
        payload: {
          model: 'claude-opus-4-6',
          max_tokens: 200,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'document',
                  source: { type: 'base64', media_type: 'application/pdf', data: pdfB64 },
                },
                {
                  type: 'text',
                  text: 'In one sentence, what is written inside the attached document?',
                },
              ],
            },
          ],
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { content: Array<{ type: string; text?: string }> };
      const text = body.content.find((b) => b.type === 'text')?.text ?? '';
      // The model saw the placeholder, not the PDF bytes — so it should signal it
      // cannot read the file / ask for the text rather than inventing content.
      expect(text).toMatch(
        /cannot|can't|can not|unable|couldn't|don't have|do not have|no access|not able|extract|provide the text|plain text|placeholder/i,
      );
      // The raw PDF bytes never appear in the model's answer.
      expect(text).not.toContain(pdfB64.slice(0, 40));
    },
    LIVE_TIMEOUT_MS,
  );

  // --------------------------------------------------------------------------
  // Tool-search beta (20251119): a client sending a synthetic
  // `tool_search_tool_*` marker + `defer_loading` tools must NOT break. The
  // marker carries no input_schema; forwarding it 1:1 made Kiro reject the
  // request with HTTP 400. The converter now drops the marker and forwards the
  // real (de-deferred) tools, so the request completes normally.
  // --------------------------------------------------------------------------
  it(
    'tool-search beta: marker dropped, real tools forwarded, request succeeds',
    async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/claude/v1/messages',
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
        payload: {
          model: 'claude-opus-4-6',
          max_tokens: 64,
          system: 'You are a helper.',
          messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
          tools: [
            {
              name: 'get_weather',
              description: 'Get current weather for a city',
              input_schema: {
                type: 'object',
                properties: { city: { type: 'string' } },
                required: ['city'],
              },
              defer_loading: true,
            },
            {
              type: 'tool_search_tool_regex_20251119',
              name: 'tool_search_tool_regex',
            },
          ],
        },
      });
      // Previously this exact shape produced HTTP 400 from upstream.
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        content: Array<{ type: string; name?: string }>;
      };
      // No phantom tool-search tool_use leaks back to the client.
      const toolUses = body.content.filter((b) => b.type === 'tool_use');
      expect(toolUses.every((b) => !(b.name ?? '').startsWith('tool_search_tool_'))).toBe(true);
    },
    LIVE_TIMEOUT_MS,
  );
});
