/**
 * Shared error response primitives.
 *
 * Lives in `shared/` so both the Claude-compatible layer (`claude/`)
 * and the Kiro passthrough layer (`kiro/`) can emit the same wire format
 * without violating the project's "claude/ → kiro/ is single-directional"
 * dependency rule. `claude/types.ts` re-exports these so existing import
 * sites (`import { createErrorResponse } from './types.js'`) keep working.
 */

export interface ErrorResponse {
  error: ErrorDetail;
}

export interface ErrorDetail {
  type: string;
  message: string;
}

/**
 * Build a Claude-compatible error envelope.
 *
 * The `type` field should be one of the Claude error type strings
 * (`invalid_request_error`, `authentication_error`, `api_error`, ...) so
 * downstream Claude SDKs can classify the error correctly.
 */
export function createErrorResponse(errorType: string, message: string): ErrorResponse {
  return {
    error: {
      type: errorType,
      message,
    },
  };
}

/** Standard 401 authentication failure body. */
export function authenticationError(): ErrorResponse {
  return createErrorResponse('authentication_error', 'Invalid API key');
}
