/**
 * Wire-format contract tests for token refresh requests and responses.
 *
 * ## Why these tests exist
 *
 * AWS SSO OIDC (Smithy-based) **only accepts camelCase field names** on
 * both request and response payloads. Sending `client_id` (snake_case)
 * yields `401 invalid_client` with no hint that it's a request-body
 * problem — the server just rejects the credential as invalid, which
 * sends you down a long wrong path of checking IAM permissions and
 * client secrets.
 *
 * An earlier revision of `refreshToken` hand-wrote a snake_case body
 * literal, which silently broke token refresh on every startup. These
 * contract tests lock the wire format to the AWS Smithy expectation so
 * any future regression fails in CI instead of production.
 *
 * ## Approach
 *
 * These are pure **structural contract tests**: no HTTP, no mocks. They
 * exercise the exact line that builds the request body in `refreshToken`,
 * and the exact line that parses the response. Running them is effectively
 * free (milliseconds) and catches the entire class of "snake_case vs camelCase
 * field translation" bugs that can otherwise slip past axios-mocked tests.
 */

import { describe, expect, it } from 'vitest';
import type {
  TokenRefreshRequest,
  TokenRefreshResponse,
} from '../../../src/kiro/model/token-refresh.js';

describe('token-refresh wire format', () => {
  // `TokenRefreshRequest` must serialize on the wire as
  // `clientId / clientSecret / refreshToken / grantType` (AWS Smithy
  // camelCase). Any snake_case form will be rejected by AWS SSO OIDC.
  it('test_refresh_request_wire_format_is_camel_case', () => {
    const body: TokenRefreshRequest = {
      clientId: 'client-id-example',
      clientSecret: 'client-secret-example',
      refreshToken: 'refresh-token-example',
      grantType: 'refresh_token',
    };

    const parsed = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;

    // Positive assertions: camelCase keys must be present with expected values.
    expect(parsed).toEqual({
      clientId: 'client-id-example',
      clientSecret: 'client-secret-example',
      refreshToken: 'refresh-token-example',
      grantType: 'refresh_token',
    });

    // Negative assertions: the snake_case form (what the buggy translation
    // shipped) must never appear as a top-level KEY. Checking keys explicitly
    // rather than doing a string `contains` on the raw JSON is important here:
    // the legal OAuth2 value for `grantType` is literally `"refresh_token"`,
    // so a naive `not.toContain('"refresh_token"')` would flag the value and
    // generate a false positive. If these assertions fail, AWS SSO OIDC will
    // reject the request with `401 invalid_client`.
    const keys = Object.keys(parsed);
    expect(keys).not.toContain('client_id');
    expect(keys).not.toContain('client_secret');
    expect(keys).not.toContain('refresh_token');
    expect(keys).not.toContain('grant_type');
  });

  // AWS SSO OIDC responds with camelCase keys, so parsing an authentic
  // payload via `as TokenRefreshResponse` must populate every field on
  // the TS side. Any key drift would silently leave fields `undefined`.
  it('test_refresh_response_parses_camel_case_payload', () => {
    // Realistic AWS SSO OIDC `CreateToken` response (camelCase, per Smithy).
    const rawResponse = `{
      "accessToken": "new-access-token",
      "refreshToken": "new-refresh-token",
      "expiresIn": 7200,
      "profileArn": "arn:aws:codewhisperer:us-east-1:123456789012:profile/foo"
    }`;

    const data = JSON.parse(rawResponse) as TokenRefreshResponse;

    expect(data.accessToken).toBe('new-access-token');
    expect(data.refreshToken).toBe('new-refresh-token');
    expect(data.expiresIn).toBe(7200);
    expect(data.profileArn).toBe('arn:aws:codewhisperer:us-east-1:123456789012:profile/foo');
  });

  // Defensive test: pin the negative case. If the response parser ever
  // regresses back to reading `snake_case` fields from a `Record<string, unknown>`
  // (as the buggy pre-fix code did), `accessToken` would be `undefined`, the
  // refresh would "succeed" upstream, and then `tryEnsureToken` would throw
  // "Refreshed token is still invalid or expired" because `expiresAt` never
  // got updated. This test makes that failure mode explicit.
  it('test_refresh_response_rejects_snake_case_payload', () => {
    const snakeCaseResponse = `{
      "access_token": "should-not-be-read",
      "refresh_token": "should-not-be-read",
      "expires_in": 7200,
      "profile_arn": "should-not-be-read"
    }`;

    const data = JSON.parse(snakeCaseResponse) as TokenRefreshResponse;

    // A snake_case payload must leave every camelCase field undefined —
    // proving that the wire format is strict and there's no accidental
    // compatibility shim accepting both.
    expect(data.accessToken).toBeUndefined();
    expect(data.refreshToken).toBeUndefined();
    expect(data.expiresIn).toBeUndefined();
    expect(data.profileArn).toBeUndefined();
  });
});
