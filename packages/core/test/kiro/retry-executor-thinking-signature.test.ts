/**
 * Pin: upstream 400 `THINKING_SIGNATURE_INVALID` triggers exactly one retry with every
 * history `reasoningContent` stripped (kiro-cli KAS does the same). Bodies that carry
 * no reasoningContent are not retried; a second 400 is thrown as-is.
 */

import { describe, expect, it } from 'vitest';

import { ProviderError } from '../../src/kiro/provider-error.js';
import { RetryExecutor } from '../../src/kiro/retry-executor.js';
import {
  makeRequest,
  makeStubAxios,
  makeStubTokenManager,
} from '../helpers/retry-executor-stubs.js';

const INVALID_SIGNATURE_BODY =
  '{"message":"messages.1.content.0: Invalid `signature` in `thinking` block","reason":"THINKING_SIGNATURE_INVALID"}';

const withReasoning = JSON.stringify({
  conversationState: {
    conversationId: 'c1',
    history: [
      { userInputMessage: { content: 'q', modelId: 'claude-opus-5' } },
      {
        assistantResponseMessage: {
          content: 'a',
          reasoningContent: { reasoningText: { text: 'r', signature: 'stale' } },
        },
      },
    ],
    currentMessage: { userInputMessage: { content: 'next', modelId: 'claude-opus-5' } },
  },
});

describe('RetryExecutor — THINKING_SIGNATURE_INVALID strip-retry', () => {
  it('retries once without reasoningContent and returns the second response', async () => {
    const { client, post } = makeStubAxios([
      { status: 400, data: INVALID_SIGNATURE_BODY },
      { status: 200, data: 'ok' },
    ]);
    const executor = new RetryExecutor(makeStubTokenManager(), client);

    const res = await executor.execute(makeRequest(withReasoning));

    expect(res.status).toBe(200);
    expect(post).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(post.mock.calls[0]?.[1] as string);
    const secondBody = JSON.parse(post.mock.calls[1]?.[1] as string);
    expect(firstBody.conversationState.history[1].assistantResponseMessage).toHaveProperty(
      'reasoningContent',
    );
    expect(secondBody.conversationState.history[1].assistantResponseMessage).not.toHaveProperty(
      'reasoningContent',
    );
    // Same logical call: attempt counter advances instead of minting a new invocation.
    const secondHeaders = (post.mock.calls[1]?.[2] as { headers: Record<string, string> }).headers;
    expect(secondHeaders['x-kiro-attempt']).toBe('2;max=3');
    expect(secondBody.conversationState.currentMessage.userInputMessage.content).toBe('next');
  });

  it('does not retry when the body carries no reasoningContent', async () => {
    const { client, post } = makeStubAxios([{ status: 400, data: INVALID_SIGNATURE_BODY }]);
    const executor = new RetryExecutor(makeStubTokenManager(), client);
    const plain = JSON.stringify({
      conversationState: {
        conversationId: 'c1',
        history: [
          { userInputMessage: { content: 'q' } },
          { assistantResponseMessage: { content: 'a' } },
        ],
        currentMessage: { userInputMessage: { content: 'next' } },
      },
    });

    await expect(executor.execute(makeRequest(plain))).rejects.toMatchObject({
      kind: { kind: 'thinking_signature_invalid', status: 400 },
    });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('a second THINKING_SIGNATURE_INVALID after stripping is thrown, never looped', async () => {
    const { client, post } = makeStubAxios([
      { status: 400, data: INVALID_SIGNATURE_BODY },
      { status: 400, data: INVALID_SIGNATURE_BODY },
    ]);
    const executor = new RetryExecutor(makeStubTokenManager(), client);

    const err = await executor.execute(makeRequest(withReasoning)).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toEqual({
      kind: 'thinking_signature_invalid',
      status: 400,
    });
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('other 400 bodies are untouched by the strip path', async () => {
    const { client, post } = makeStubAxios([
      {
        status: 400,
        data: '{"message":"Improperly formed request.","reason":"REQUEST_BODY_INVALID"}',
      },
    ]);
    const executor = new RetryExecutor(makeStubTokenManager(), client);

    await expect(executor.execute(makeRequest(withReasoning))).rejects.toMatchObject({
      kind: { kind: 'bad_request', status: 400 },
    });
    expect(post).toHaveBeenCalledTimes(1);
  });
});
