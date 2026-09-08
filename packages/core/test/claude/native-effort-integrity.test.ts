import { setImmediate } from 'node:timers/promises';
import type { AxiosResponse } from 'axios';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { KiroProvider } from '../../src/kiro/provider.js';
import { HookBus } from '../../src/plugin-host/index.js';
import { registerClaudeRoutes } from '../../src/routes/claude.js';
import { registerOpenAiRoutes } from '../../src/routes/openai.js';
import {
  buildMeteringFrame,
  buildReasoningContentFrame,
  buildRedactedReasoningFrame,
  encodeEventStreamFrame,
} from '../helpers/event-stream.js';

const levels = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const models = ['claude-opus-5', 'gpt-5.6-sol'] as const;
const protocols = ['claude', 'chat', 'responses'] as const;

describe.each(protocols)('%s native effort and reasoning failure boundaries', (protocol) => {
  it.each(
    models.flatMap((model) => levels.map((effort) => ({ model, effort }))),
  )('$model / $effort preserves actual native wire settings and surfaces an error', async ({
    model,
    effort,
  }) => {
    const callApiStream = vi.fn(async (requestBody: string) => {
      // Assert the converter's actual outgoing fields, not the request label.
      const userInput = JSON.parse(requestBody).conversationState.currentMessage.userInputMessage;
      expect(userInput.modelId).toBe(model);
      expect(userInput.reasoning).toEqual({ effort });
      expect(requestBody).not.toContain('<thinking_mode>');
      const data = (async function* () {
        // Claude reasoning commits visible thinking; GPT reasoning remains
        // encrypted and pre-commit. Both must fail, never retry paid work.
        yield model === 'claude-opus-5'
          ? buildReasoningContentFrame('native reasoning', 'native-signature')
          : buildRedactedReasoningFrame();
        yield encodeEventStreamFrame(
          { ':event-type': 'toolUseEvent' },
          Buffer.from(
            JSON.stringify({ name: 'Read', toolUseId: 'invalid', input: '{}', stop: 'false' }),
          ),
        );
        await setImmediate();
        yield buildMeteringFrame({ unit: 'credit', unitPlural: 'credits', usage: 0.03 });
      })();
      return { data, status: 200, headers: {} } as AxiosResponse;
    });
    const hookBus = new HookBus();
    const credits: number[] = [];
    hookBus.registerUsageFinish('test', (event) => {
      credits.push(event.getMeta<number>('kiro.creditsUsed') ?? 0);
    });
    const app = Fastify({ logger: false });
    const deps = {
      apiKey: 'test-key',
      kiroProvider: { callApiStream } as unknown as KiroProvider,
      extractThinking: true,
      identityOverride: false,
      emptyStreamRetries: 2,
      hookBus,
    };
    await app.register((instance) => registerClaudeRoutes(instance, deps), {
      prefix: '/claude/v1',
    });
    await app.register((instance) => registerOpenAiRoutes(instance, deps), {
      prefix: '/openai/v1',
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url:
          protocol === 'claude'
            ? '/claude/v1/messages'
            : protocol === 'chat'
              ? '/openai/v1/chat/completions'
              : '/openai/v1/responses',
        headers: { 'x-api-key': 'test-key' },
        payload: {
          model,
          max_tokens: 4096,
          stream: true,
          ...(protocol === 'responses'
            ? { input: 'read the file', reasoning: { effort } }
            : {
                messages: [{ role: 'user', content: 'read the file' }],
                ...(protocol === 'claude'
                  ? { thinking: { type: 'adaptive' }, output_config: { effort } }
                  : { reasoning_effort: effort }),
              }),
        },
      });
      expect(res.statusCode).toBe(model === 'claude-opus-5' ? 200 : 502);
      expect(res.body).toContain('api_error');
      expect(res.body).not.toContain('message_stop');
      expect(res.body).not.toContain('response.completed');
      expect(res.body).not.toContain('"finish_reason":"stop"');
      expect(res.body).not.toContain('"call_id":"invalid"');
      expect(res.body).not.toContain('"id":"invalid"');
      expect(callApiStream).toHaveBeenCalledTimes(1);
      expect(credits).toEqual([0.03]);
    } finally {
      await app.close();
    }
  });
});
