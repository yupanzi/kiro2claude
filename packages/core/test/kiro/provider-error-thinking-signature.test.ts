/**
 * Classification pin for the upstream `THINKING_SIGNATURE_INVALID` reason: its own kind so the
 * executor can strip-retry and the mapper can answer 400 without leaking the upstream body.
 */

import { describe, expect, it } from 'vitest';
import { stripReasoningContent } from '../../src/kiro/model/requests/kiro.js';
import { classifyErrorBody, ProviderError } from '../../src/kiro/provider-error.js';

const CORRUPTED =
  '{"message":"messages.1.content.0: Invalid `signature` in `thinking` block","reason":"THINKING_SIGNATURE_INVALID"}';
const MISSING =
  '{"message":"messages.1.content.0.thinking.signature: Field required","reason":"THINKING_SIGNATURE_INVALID"}';

describe('classifyErrorBody: THINKING_SIGNATURE_INVALID', () => {
  it('both live shapes (corrupted / missing signature) classify as thinking_signature_invalid', () => {
    expect(classifyErrorBody(400, CORRUPTED)).toEqual({
      kind: 'thinking_signature_invalid',
      status: 400,
    });
    expect(classifyErrorBody(400, MISSING)).toEqual({
      kind: 'thinking_signature_invalid',
      status: 400,
    });
  });

  it('generic 400 bodies stay unclassified', () => {
    expect(
      classifyErrorBody(
        400,
        '{"message":"Improperly formed request.","reason":"REQUEST_BODY_INVALID"}',
      ),
    ).toBeUndefined();
  });

  it('default message names the kind without dropping the upstream body (logs only)', () => {
    const err = new ProviderError({ kind: 'thinking_signature_invalid', status: 400 }, CORRUPTED);
    expect(err.message).toContain('thinking signature invalid');
    expect(err.body).toBe(CORRUPTED);
  });
});

describe('stripReasoningContent', () => {
  it('removes every history reasoningContent and reports via a new body', () => {
    const body = JSON.stringify({
      conversationState: {
        history: [
          { userInputMessage: { content: 'q' } },
          {
            assistantResponseMessage: {
              content: 'a',
              reasoningContent: { reasoningText: { text: 'r', signature: 's' } },
            },
          },
          { userInputMessage: { content: 'q2' } },
          {
            assistantResponseMessage: { content: 'b', reasoningContent: { redactedContent: 'x' } },
          },
        ],
        currentMessage: { userInputMessage: { content: 'next' } },
      },
    });
    const stripped = stripReasoningContent(body);
    expect(stripped).toBeDefined();
    expect(stripped).not.toContain('reasoningContent');
    const parsed = JSON.parse(stripped as string);
    expect(parsed.conversationState.history[1]).toEqual({
      assistantResponseMessage: { content: 'a' },
    });
    expect(parsed.conversationState.history[3]).toEqual({
      assistantResponseMessage: { content: 'b' },
    });
    expect(parsed.conversationState.currentMessage.userInputMessage.content).toBe('next');
  });

  it('returns undefined when there is nothing to strip (or the body is not JSON)', () => {
    expect(
      stripReasoningContent(
        JSON.stringify({
          conversationState: { history: [{ assistantResponseMessage: { content: 'a' } }] },
        }),
      ),
    ).toBeUndefined();
    expect(stripReasoningContent(JSON.stringify({ conversationState: {} }))).toBeUndefined();
    expect(stripReasoningContent('not json')).toBeUndefined();
  });
});
