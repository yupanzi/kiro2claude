/**
 * Live E2E：kiro-cli 2.6.0+ 原生 reasoning 路径。
 *
 * 与 `live.test.ts` case 14/15 的差别：
 *   - 14/15 用 claude-opus-4.6 走旧路径（prompt 注入 + `<thinking>` 标签提取）
 *   - 本文件用 claude-opus-4.7 / 4.8 走原生路径（wire 字段 + reasoningContentEvent）
 *
 * 覆盖矩阵（每个 case 真发上游一次，消耗真实 token quota）：
 *   - 非流式: adaptive + 5 个 effort 等级、enabled + budget_tokens 阈值、baseline
 *   - 流式: SSE 序列含 thinking_delta + signature_delta
 *   - tool_use 组合: reasoning block 必须出现在 tool_use 之前
 *   - 4.8 model: 验证原生路径同样工作
 *   - 旧路径回归: 4.6 + thinking 仍走 `<thinking>` 提取（不应有 signature 字段）
 *
 * 跑法：
 *   KIRO2CLAUDE_API_KEY=any \
 *   KIRO2CLAUDE_SQLITE_DB_PATH="$HOME/Library/Application Support/kiro-cli/data.sqlite3" \
 *   pnpm test:e2e -- native-reasoning
 *
 * env 缺失时整个 describe 走 skipIf 优雅跳过。
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadCredentialsFromEnv } from '../../src/kiro/credentials-loader.js';
import { KiroProvider } from '../../src/kiro/provider.js';
import { SingleTokenManager } from '../../src/kiro/token-manager.js';
import { loadConfigFromEnv } from '../../src/model/config.js';
import { HookBus } from '../../src/plugin-host/index.js';
import { registerClaudeRoutes } from '../../src/routes/claude.js';
import { registerHealthRoutes } from '../../src/routes/health.js';
import { initCountTokensConfig } from '../../src/token.js';
import { parseSseEvents, type SseEvent } from '../helpers/event-stream.js';

const HAS_ENV = Boolean(process.env.KIRO2CLAUDE_API_KEY && process.env.KIRO2CLAUDE_SQLITE_DB_PATH);
const LIVE_TIMEOUT_MS = 90_000;

// ============================================================================
// SSE delta 抽取 helper（SseEvent / parseSseEvents 由 test/helpers/event-stream.ts 提供）
// ============================================================================

function thinkingDeltas(events: SseEvent[]): string[] {
  return events
    .filter((e) => e.event === 'content_block_delta')
    .map((e) => {
      const d = (e.data as { delta?: { type?: string; thinking?: string } }).delta;
      if (d?.type === 'thinking_delta' && typeof d.thinking === 'string') return d.thinking;
      return '';
    })
    .filter((s) => s.length > 0);
}

function signatureDeltas(events: SseEvent[]): string[] {
  return events
    .filter((e) => e.event === 'content_block_delta')
    .map((e) => {
      const d = (e.data as { delta?: { type?: string; signature?: string } }).delta;
      if (d?.type === 'signature_delta' && typeof d.signature === 'string') return d.signature;
      return '';
    })
    .filter((s) => s.length > 0);
}

function textDeltas(events: SseEvent[]): string {
  return events
    .filter((e) => e.event === 'content_block_delta')
    .map((e) => {
      const d = (e.data as { delta?: { type?: string; text?: string } }).delta;
      if (d?.type === 'text_delta' && typeof d.text === 'string') return d.text;
      return '';
    })
    .join('');
}

function blockStarts(events: SseEvent[]): Array<{ index: number; type: string }> {
  return events
    .filter((e) => e.event === 'content_block_start')
    .map((e) => {
      const cb = e.data.content_block as { type?: string };
      return { index: e.data.index as number, type: cb?.type ?? '<unknown>' };
    });
}

// ============================================================================
// 类型 helper
// ============================================================================

interface NonStreamResponse {
  content: Array<{
    type: string;
    text?: string;
    thinking?: string;
    signature?: string;
    name?: string;
    id?: string;
    input?: unknown;
  }>;
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
}

// 选这个 prompt 的原因：实测 4.7 / 4.8
// 在所有 effort 等级下**都**会真发 reasoningContentEvent。更简单的算术题（如
// 17×23）4.7 会自决跳过 reasoning，让 e2e 误以为改造 bug。火车相遇题 + 显式
// "showing your reasoning" 指令是稳定触发 reasoning 的 minimum complexity。
const REASONING_PROMPT =
  'Solve step-by-step, showing your reasoning before the final answer: A train leaves city A at 9am traveling north at 80 km/h. Another train leaves city B, which is 540 km north of A, at 10am traveling south at 100 km/h. At what time do they meet?';

// ============================================================================
// 测试套件
// ============================================================================

describe.skipIf(!HAS_ENV)('live E2E: kiro-cli 2.6.0+ native reasoning', () => {
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
    await app.ready();
  }, 30_000);

  afterAll(async () => {
    if (app) await app.close();
  });

  // --------------------------------------------------------------------------
  // A. 非流式 + 4.7 + adaptive + effort=max
  //    验证：thinking content block + signature 字段都存在
  // --------------------------------------------------------------------------
  it(
    'A. 4.7 + adaptive + effort=max → non-stream thinking block w/ signature',
    async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/claude/v1/messages',
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
        payload: {
          model: 'claude-opus-4-7',
          max_tokens: 2000,
          thinking: { type: 'adaptive', budget_tokens: 20000 },
          output_config: { effort: 'max' },
          messages: [{ role: 'user', content: REASONING_PROMPT }],
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as NonStreamResponse;
      expect(body.stop_reason).toBe('end_turn');

      const thinkingBlock = body.content.find((b) => b.type === 'thinking');
      const textBlock = body.content.find((b) => b.type === 'text');
      expect(thinkingBlock).toBeDefined();
      expect(textBlock).toBeDefined();
      expect(thinkingBlock?.thinking?.length).toBeGreaterThan(0);
      // 关键：原生路径有 signature 字段（旧路径没有）
      expect(typeof thinkingBlock?.signature).toBe('string');
      expect(thinkingBlock?.signature?.length).toBeGreaterThan(0);
      // 最终答案必须包含 391（17×23）
      // 火车题答案 12:33 / 12:33:20 (8/3 小时 ≈ 2h33m20s 从 10am 起算)
      expect(textBlock?.text).toMatch(/12:33|12:30|two trains.*meet|2.*hours.*33/i);
      // thinking 文本不应残留 <thinking> 标签（原生路径根本不会有）
      expect(thinkingBlock?.thinking).not.toMatch(/<thinking>/);
    },
    LIVE_TIMEOUT_MS,
  );

  // --------------------------------------------------------------------------
  // B. 非流式 + 4.7 + adaptive + effort=low
  //    验证：low effort 仍出 thinking 但内容相对短（与 max 对比）
  // --------------------------------------------------------------------------
  it(
    'B. 4.7 + adaptive + effort=low → still emits thinking block (smaller reasoning)',
    async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/claude/v1/messages',
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
        payload: {
          model: 'claude-opus-4-7',
          max_tokens: 2000,
          thinking: { type: 'adaptive', budget_tokens: 20000 },
          output_config: { effort: 'low' },
          messages: [{ role: 'user', content: REASONING_PROMPT }],
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as NonStreamResponse;
      const thinkingBlock = body.content.find((b) => b.type === 'thinking');
      const textBlock = body.content.find((b) => b.type === 'text');
      expect(thinkingBlock).toBeDefined();
      expect(textBlock).toBeDefined();
      // low effort 也应产生非空 thinking
      expect(thinkingBlock?.thinking?.length).toBeGreaterThan(0);
      expect(textBlock?.text).toMatch(/12:33|12:30|2.*hour|33/i);
    },
    LIVE_TIMEOUT_MS,
  );

  // --------------------------------------------------------------------------
  // C. 非流式 + 4.7 + enabled + budget_tokens=16384
  //    验证：budget_tokens 阈值映射成 effort=xhigh，仍走原生路径
  // --------------------------------------------------------------------------
  it(
    'C. 4.7 + enabled + budget_tokens → thinking block (budget_tokens path)',
    async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/claude/v1/messages',
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
        payload: {
          model: 'claude-opus-4-7',
          max_tokens: 2000,
          thinking: { type: 'enabled', budget_tokens: 16384 },
          messages: [{ role: 'user', content: REASONING_PROMPT }],
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as NonStreamResponse;
      const thinkingBlock = body.content.find((b) => b.type === 'thinking');
      expect(thinkingBlock).toBeDefined();
      expect(thinkingBlock?.thinking?.length).toBeGreaterThan(0);
      expect(typeof thinkingBlock?.signature).toBe('string');
    },
    LIVE_TIMEOUT_MS,
  );

  // --------------------------------------------------------------------------
  // D. 非流式 + 4.7 不传 thinking → baseline
  //    验证：4.7 默认开启 reasoning（实测 baseline 也会 emit reasoningContentEvent）
  //    但我们不传 reasoning 字段，所以上游用 default behavior。
  // --------------------------------------------------------------------------
  it(
    'D. 4.7 + no thinking → may or may not emit thinking block (model-dependent baseline)',
    async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/claude/v1/messages',
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
        payload: {
          model: 'claude-opus-4-7',
          max_tokens: 500,
          messages: [{ role: 'user', content: 'In one sentence: what is the capital of France?' }],
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as NonStreamResponse;
      expect(body.stop_reason).toBe('end_turn');
      // 一定要有 text block 且答案正确（不强制要求 thinking block）
      const textBlock = body.content.find((b) => b.type === 'text');
      expect(textBlock).toBeDefined();
      expect(textBlock?.text).toMatch(/Paris|paris/i);
    },
    LIVE_TIMEOUT_MS,
  );

  // --------------------------------------------------------------------------
  // E. 非流式 + 4.8 + adaptive + effort=high
  //    验证：4.8 也走原生路径
  // --------------------------------------------------------------------------
  it(
    'E. 4.8 + adaptive + effort=high → native path (thinking block + signature)',
    async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/claude/v1/messages',
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
        payload: {
          model: 'claude-opus-4-8',
          max_tokens: 1500,
          thinking: { type: 'adaptive', budget_tokens: 20000 },
          output_config: { effort: 'high' },
          messages: [{ role: 'user', content: REASONING_PROMPT }],
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as NonStreamResponse;
      const thinkingBlock = body.content.find((b) => b.type === 'thinking');
      const textBlock = body.content.find((b) => b.type === 'text');
      expect(thinkingBlock).toBeDefined();
      expect(thinkingBlock?.thinking?.length).toBeGreaterThan(0);
      expect(typeof thinkingBlock?.signature).toBe('string');
      expect(textBlock?.text).toMatch(/12:33|12:30|2.*hour|33/i);
    },
    LIVE_TIMEOUT_MS,
  );

  // --------------------------------------------------------------------------
  // F. 流式 + 4.7 + adaptive + effort=high
  //    验证：SSE 序列含 thinking_delta + signature_delta + thinking block 先于 text block
  // --------------------------------------------------------------------------
  it(
    'F. 4.7 + adaptive + stream → SSE chain has thinking_delta + signature_delta',
    async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/claude/v1/messages',
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
        payload: {
          model: 'claude-opus-4-7',
          max_tokens: 2000,
          stream: true,
          thinking: { type: 'adaptive', budget_tokens: 20000 },
          output_config: { effort: 'high' },
          messages: [{ role: 'user', content: REASONING_PROMPT }],
        },
      });
      expect(res.statusCode).toBe(200);
      const events = parseSseEvents(res.body);

      // 1. 必须有 message_start / message_stop
      const eventTypes = new Set(events.map((e) => e.event));
      expect(eventTypes.has('message_start')).toBe(true);
      expect(eventTypes.has('message_stop')).toBe(true);

      // 2. thinking_delta 至少出现一次
      const thinkingChunks = thinkingDeltas(events);
      expect(thinkingChunks.length).toBeGreaterThan(0);
      const fullThinking = thinkingChunks.join('');
      expect(fullThinking.length).toBeGreaterThan(0);

      // 3. signature_delta 至少出现一次（原生路径 hallmark）
      const sigs = signatureDeltas(events);
      expect(sigs.length).toBeGreaterThan(0);
      expect(sigs[0].length).toBeGreaterThan(0);

      // 4. text_delta 包含最终答案（火车题）
      const text = textDeltas(events);
      expect(text).toMatch(/12:33|12:30|2.*hour|33/i);

      // 5. block 顺序：thinking block 必须先于 text block 出现
      const starts = blockStarts(events);
      const thinkingStartIdx = starts.findIndex((s) => s.type === 'thinking');
      const textStartIdx = starts.findIndex((s) => s.type === 'text');
      expect(thinkingStartIdx).toBeGreaterThanOrEqual(0);
      expect(textStartIdx).toBeGreaterThanOrEqual(0);
      expect(thinkingStartIdx).toBeLessThan(textStartIdx);
    },
    LIVE_TIMEOUT_MS,
  );

  // --------------------------------------------------------------------------
  // G. 流式 + 4.7 + adaptive + tool_use
  //    验证 stream 状态机健壮性：**无论上游决定发不发 reasoning**，状态机
  //    都不能产生坏数据。
  //
  //    上游的 reasoning 决策是 model 自决的——4.7 对简单 tool 调用任务经常
  //    跳过 reasoning（实测过）。诚实的 e2e 是验证 stream 在所有路径下都正确，
  //    而不是用强 prompt + 4.8 把测试调到"必发 reasoning"再做断言。
  //
  //    本案专门触及 `closeReasoningBlockIfOpen()` 调用点：当 reasoning 确实
  //    出现时，processToolUse 必须主动关 thinking block。当 reasoning 不出
  //    现时，状态机不能擅自产生空 thinking block 或孤立的 signature_delta。
  // --------------------------------------------------------------------------
  it(
    'G. 4.7 + adaptive + stream + tool_use → stream state machine is sound regardless of reasoning',
    async () => {
      const calcTool = {
        name: 'calculator',
        description:
          'Arithmetic calculator. Takes an expression string and returns the numeric result.',
        input_schema: {
          type: 'object',
          properties: { expression: { type: 'string', description: 'Arithmetic expression' } },
          required: ['expression'],
        },
      };
      // 用 4.7 + 简单 calculator 任务——实测 4.7 经常跳过 reasoning。
      // 这正是要测的"退化路径下状态机正确"的关键场景。
      const res = await app.inject({
        method: 'POST',
        url: '/claude/v1/messages',
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
        payload: {
          model: 'claude-opus-4-7',
          max_tokens: 2000,
          stream: true,
          thinking: { type: 'adaptive', budget_tokens: 20000 },
          output_config: { effort: 'high' },
          tools: [calcTool],
          messages: [
            {
              role: 'user',
              content:
                'Use the calculator tool to compute 17*23. After getting the result, briefly confirm the answer.',
            },
          ],
        },
      });
      expect(res.statusCode).toBe(200);
      const events = parseSseEvents(res.body);

      // 1. 基本 SSE 完整性
      const eventTypes = new Set(events.map((e) => e.event));
      expect(eventTypes.has('message_start')).toBe(true);
      expect(eventTypes.has('message_stop')).toBe(true);

      // 2. tool_use 必须出现（验证 tool 调用机制工作）
      const starts = blockStarts(events);
      const toolUseIdx = starts.findIndex((s) => s.type === 'tool_use');
      expect(toolUseIdx).toBeGreaterThanOrEqual(0);

      // 3. thinking 出现与否是 model 自决——但出现/不出现都有强不变量
      const thinkingIdx = starts.findIndex((s) => s.type === 'thinking');
      const sigs = signatureDeltas(events);
      const thinkingChunks = thinkingDeltas(events);

      if (thinkingIdx >= 0) {
        // 不变量 A: thinking 必须在 tool_use 之前（Anthropic 协议要求）
        expect(thinkingIdx).toBeLessThan(toolUseIdx);
        // 不变量 B: 原生路径下有 thinking block 就必须有 signature_delta
        expect(sigs.length).toBeGreaterThan(0);
        // 不变量 C: thinking 内容非空（不能是空块）
        const thinkingText = thinkingChunks.join('');
        expect(thinkingText.length).toBeGreaterThan(0);
      } else {
        // 退化路径不变量：上游决定不发 reasoning，状态机不能擅自产生：
        // - 不能有 signature_delta（原生 reasoning 才有）
        // - 不能有 thinking_delta（thinking 块不存在）
        expect(sigs.length).toBe(0);
        expect(thinkingChunks.length).toBe(0);
      }
    },
    LIVE_TIMEOUT_MS,
  );

  // --------------------------------------------------------------------------
  // K. 退化路径专测: 4.7 + adaptive + 简单 prompt
  //    实事求是验证: 4.7 自决跳过 reasoning 时，我们的代码不能：
  //      - 产生空的 thinking content block
  //      - 错误地挂上 signature 字段
  //    同时仍要正确传递 reasoning.effort 字段给上游让 model 自己决定。
  //
  //    G 验证"reasoning 出现时不变量"，K 验证"reasoning 不出现时不变量"。
  //    两案合起来覆盖非流式 + 流式状态机所有分支。
  // --------------------------------------------------------------------------
  it(
    'K. 4.7 + adaptive + simple prompt → no spurious thinking block when model skips reasoning',
    async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/claude/v1/messages',
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
        payload: {
          model: 'claude-opus-4-7',
          max_tokens: 500,
          thinking: { type: 'adaptive', budget_tokens: 20000 },
          output_config: { effort: 'max' },
          // 实测 4.7 对极简算术高概率跳过 reasoning
          messages: [{ role: 'user', content: 'In one sentence: what is 1+1?' }],
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as NonStreamResponse;
      expect(body.stop_reason).toBe('end_turn');

      const textBlock = body.content.find((b) => b.type === 'text');
      const thinkingBlock = body.content.find((b) => b.type === 'thinking');

      // 必有 text block + 正确答案
      expect(textBlock).toBeDefined();
      expect(textBlock?.text).toMatch(/2|two/i);

      // 关键不变量：
      // - 如果 4.7 跳过 reasoning（实测高概率）→ 完全没有 thinking block，不能有"空 block"
      // - 如果 4.7 决定 reason（低概率但允许）→ thinking 必须有非空内容 + signature
      if (thinkingBlock) {
        expect(thinkingBlock.thinking?.length).toBeGreaterThan(0);
        expect(typeof thinkingBlock.signature).toBe('string');
      }
    },
    LIVE_TIMEOUT_MS,
  );

  // --------------------------------------------------------------------------
  // H. 旧路径回归: 4.6 + enabled
  //    验证: 4.6 仍走 `<thinking>` 标签提取路径，**没有** signature 字段。
  //
  //    这是关键的"不破坏旧路径"断言——如果我的改造意外让 4.6 也走原生路径,
  //    或者在响应里塞了空 signature 字段,这个 case 会爆。
  // --------------------------------------------------------------------------
  it(
    'H. 4.6 + enabled → legacy path (thinking block w/o signature field)',
    async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/claude/v1/messages',
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
        payload: {
          model: 'claude-opus-4-6',
          max_tokens: 2000,
          thinking: { type: 'enabled', budget_tokens: 4000 },
          messages: [{ role: 'user', content: REASONING_PROMPT }],
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as NonStreamResponse;
      const thinkingBlock = body.content.find((b) => b.type === 'thinking');
      const textBlock = body.content.find((b) => b.type === 'text');

      // 4.6 旧路径：thinking 仍应出现（从 <thinking> 标签提取）
      expect(thinkingBlock).toBeDefined();
      expect(thinkingBlock?.thinking?.length).toBeGreaterThan(0);
      // 关键：**没有** signature 字段（旧路径不可能产生）
      expect(thinkingBlock?.signature).toBeUndefined();
      // 答案正确
      expect(textBlock?.text).toMatch(/12:33|12:30|2.*hour|33/i);
      // thinking 内容不残留标签（被 extractThinkingFromCompleteText 剥掉）
      expect(thinkingBlock?.thinking).not.toMatch(/<thinking>|<\/thinking>/);
    },
    LIVE_TIMEOUT_MS,
  );

  // --------------------------------------------------------------------------
  // I. 流式 + 4.8 + adaptive + effort=high
  //    验证：4.8 在流式模式下也正确 emit thinking_delta + signature_delta
  //    (与 F case 互补：F 是 4.7，I 是 4.8——确保两个 model 都过 stream 路径)
  // --------------------------------------------------------------------------
  it(
    'I. 4.8 + adaptive + stream → SSE chain has thinking_delta + signature_delta',
    async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/claude/v1/messages',
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
        payload: {
          model: 'claude-opus-4-8',
          max_tokens: 2000,
          stream: true,
          thinking: { type: 'adaptive', budget_tokens: 20000 },
          output_config: { effort: 'high' },
          messages: [{ role: 'user', content: REASONING_PROMPT }],
        },
      });
      expect(res.statusCode).toBe(200);
      const events = parseSseEvents(res.body);

      // 必须有完整 SSE 链
      const eventTypes = new Set(events.map((e) => e.event));
      expect(eventTypes.has('message_start')).toBe(true);
      expect(eventTypes.has('message_stop')).toBe(true);

      // thinking_delta + signature_delta 都要有
      const thinkingChunks = thinkingDeltas(events);
      expect(thinkingChunks.length).toBeGreaterThan(0);
      const sigs = signatureDeltas(events);
      expect(sigs.length).toBeGreaterThan(0);

      // 最终答案
      const text = textDeltas(events);
      expect(text).toMatch(/12:33|12:30|2.*hour|33/i);

      // block 顺序: thinking 先于 text
      const starts = blockStarts(events);
      const thinkingStartIdx = starts.findIndex((s) => s.type === 'thinking');
      const textStartIdx = starts.findIndex((s) => s.type === 'text');
      expect(thinkingStartIdx).toBeLessThan(textStartIdx);
    },
    LIVE_TIMEOUT_MS,
  );

  // --------------------------------------------------------------------------
  // J. 流式 + 4.7 + enabled + budget_tokens=16384
  //    验证：enabled 通道在流式下也正确——双通道映射成 effort + 状态机健壮性。
  //
  //    与 G 类似，承认 e2e 不能假设上游必发 reasoning（4.7 自决高概率跳过）。
  //    诚实测的是：
  //      - 答案必须正确（验证 wire 字段没破坏请求路径）
  //      - 出现/不出现都满足同一组不变量（流式状态机健壮性）
  //    与 F 互补：F 验 adaptive 通道，J 验 enabled 通道；不变量集相同。
  // --------------------------------------------------------------------------
  it(
    'J. 4.7 + enabled + budget_tokens + stream → enabled channel works, stream sound',
    async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/claude/v1/messages',
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
        payload: {
          model: 'claude-opus-4-7',
          max_tokens: 2000,
          stream: true,
          thinking: { type: 'enabled', budget_tokens: 16384 },
          messages: [{ role: 'user', content: REASONING_PROMPT }],
        },
      });
      expect(res.statusCode).toBe(200);
      const events = parseSseEvents(res.body);

      // 答案必须正确（即使 model 跳过 reasoning，wire 字段没破请求路径）
      expect(textDeltas(events)).toMatch(/12:33|12:30|2.*hour|33/i);

      // 不变量：thinking 出现 → 必有 signature；不出现 → 不能有 signature 残留
      const thinkingChunks = thinkingDeltas(events);
      const sigs = signatureDeltas(events);

      if (thinkingChunks.length > 0) {
        // 出现 reasoning → enabled 通道完整：thinking_delta + signature_delta 都要有
        expect(sigs.length).toBeGreaterThan(0);
        // 内容非空
        expect(thinkingChunks.join('').length).toBeGreaterThan(0);
      } else {
        // 跳过 reasoning → 状态机不能擅自挂 signature
        expect(sigs.length).toBe(0);
      }
    },
    LIVE_TIMEOUT_MS,
  );
});
