/**
 * Zod schema for `POST /claude/v1/messages` request bodies.
 *
 * This schema is **additive**: it can be wired into `handlers.ts` to
 * replace the existing `as unknown as MessagesRequest` double-cast with a
 * real runtime check.
 *
 * ## Design philosophy: be permissive, normalize aggressively
 *
 * This is an API-compatible proxy, not an authoritative validator — the
 * goal is to accept **any request the old double-cast would have accepted**
 * and never start returning 400 on previously-working inputs. Concretely:
 *
 * - Only the three fields the downstream converter absolutely needs
 *   (`model`, `max_tokens`, `messages`) are strictly typed. Everything
 *   else is `z.unknown()` with normalization in the `.transform()` step.
 * - `messages[]` items are `z.unknown()`: the rich `ContentBlock` union
 *   validation lives in `converter.ts` and has years of production
 *   battle-testing; duplicating it here would create drift.
 * - Unknown top-level fields pass through (`.passthrough()`) so
 *   new Claude API fields don't bounce requests.
 *
 * ## Single source of truth for normalization
 *
 * `preprocessSystem` and `clampBudgetTokens` are imported from `types.ts`
 * so the schema and the existing hand-rolled code path produce identical
 * `system` and `thinking` shapes. The hand-rolled spread call in handlers
 * can be removed once this schema is wired in.
 */

import { z } from 'zod';
import {
  type CountTokensRequest,
  clampBudgetTokens,
  type MessagesRequest,
  preprocessSystem,
  type Thinking,
} from '../types.js';

// ============================================================================
// MessagesRequest schema
// ============================================================================

export const messagesRequestSchema = z
  .object({
    // Required: downstream code always dereferences these.
    model: z.string({
      required_error: 'model is required',
      invalid_type_error: 'model must be a string',
    }),
    max_tokens: z.number({
      required_error: 'max_tokens is required',
      invalid_type_error: 'max_tokens must be a number',
    }),
    messages: z.array(z.unknown(), {
      required_error: 'messages is required',
      invalid_type_error: 'messages must be an array',
    }),

    // Optional; schema is intentionally loose on shape — the converter
    // validates deeper structure and emits friendlier errors.
    stream: z.boolean().optional(),
    system: z.unknown().optional(),
    tools: z.array(z.unknown()).optional(),
    tool_choice: z.unknown().optional(),
    thinking: z.unknown().optional(),
    output_config: z.unknown().optional(),
    metadata: z.unknown().optional(),
  })
  .passthrough()
  .transform((raw): MessagesRequest => {
    // Reuse the shared normalizers so the schema and the existing
    // hand-rolled code path produce byte-identical outputs.
    return {
      model: raw.model,
      max_tokens: raw.max_tokens,
      messages: raw.messages as MessagesRequest['messages'],
      stream: raw.stream,
      system: preprocessSystem(raw.system),
      tools: raw.tools as MessagesRequest['tools'],
      tool_choice: raw.tool_choice,
      thinking: clampBudgetTokens(raw.thinking as Thinking | undefined),
      output_config: raw.output_config as MessagesRequest['output_config'],
      metadata: raw.metadata as MessagesRequest['metadata'],
    };
  });

// ============================================================================
// CountTokensRequest schema
// ============================================================================

export const countTokensRequestSchema = z
  .object({
    model: z.string({
      required_error: 'model is required',
      invalid_type_error: 'model must be a string',
    }),
    messages: z.array(z.unknown(), {
      required_error: 'messages is required',
      invalid_type_error: 'messages must be an array',
    }),
    system: z.unknown().optional(),
    tools: z.array(z.unknown()).optional(),
  })
  .passthrough()
  .transform((raw): CountTokensRequest => {
    return {
      model: raw.model,
      messages: raw.messages as CountTokensRequest['messages'],
      system: preprocessSystem(raw.system),
      tools: raw.tools as CountTokensRequest['tools'],
    };
  });

// ============================================================================
// Error formatting
// ============================================================================

/**
 * Flatten a zod error into a single human-readable string suitable for an
 * `invalid_request_error` reply body.
 *
 * The order of fields in the output matters for clients that only read
 * the first 200 chars of the error message — we list missing required
 * fields first, then type mismatches, then everything else.
 */
export function formatRequestError(error: z.ZodError): string {
  const lines: string[] = [];
  for (const issue of error.issues) {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    lines.push(`${path}: ${issue.message}`);
  }
  return lines.join('; ');
}
