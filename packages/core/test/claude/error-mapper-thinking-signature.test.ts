/**
 * Mapper pin for `thinking_signature_invalid`: downstream 400 `invalid_request_error`
 * with neutral wording. Leak detection: the upstream body (Smithy `__type`, the
 * reason token, backend names) must never reach the response text.
 */

import { describe, expect, it } from 'vitest';
import { classifyProviderError } from '../../src/claude/error-mapper.js';
import { ProviderError } from '../../src/kiro/provider-error.js';

const UPSTREAM_BODY =
  '{"__type":"com.amazon.kiro.runtimeservice#ValidationException","message":"messages.1.content.0: Invalid `signature` in `thinking` block","reason":"THINKING_SIGNATURE_INVALID"}';

describe('classifyProviderError: thinking_signature_invalid', () => {
  it('maps to 400 invalid_request_error and mentions the thinking signature', () => {
    const c = classifyProviderError(
      new ProviderError({ kind: 'thinking_signature_invalid', status: 400 }, UPSTREAM_BODY),
    );
    expect(c.status).toBe(400);
    expect(c.errorType).toBe('invalid_request_error');
    expect(c.message.toLowerCase()).toContain('thinking signature');
  });

  it('never leaks the upstream body or backend identity', () => {
    const c = classifyProviderError(
      new ProviderError({ kind: 'thinking_signature_invalid', status: 400 }, UPSTREAM_BODY),
    );
    for (const marker of [
      '__type',
      'THINKING_SIGNATURE_INVALID',
      'com.amazon',
      'ValidationException',
      'messages.1.content.0',
      'Kiro',
      'upstream',
      'AWS',
    ]) {
      expect(c.message).not.toContain(marker);
    }
  });
});
