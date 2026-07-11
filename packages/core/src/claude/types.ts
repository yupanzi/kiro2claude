/**
 * Claude API type definitions
 */

// Error primitives live in `shared/errors.ts` so kiro/ can use them without
// importing from claude/ (which would violate dependency direction).
// Re-exported here for backwards compatibility with existing import sites.
export {
  authenticationError,
  createErrorResponse,
  type ErrorDetail,
  type ErrorResponse,
} from '../shared/errors.js';

// === Models endpoint types ===

export interface Model {
  id: string;
  object: string;
  created: number;
  owned_by: string;
  display_name: string;
  type: string;
  max_tokens: number;
}

export interface ModelsResponse {
  object: string;
  data: Model[];
}

// === Messages endpoint types ===

/** Maximum thinking budget tokens */
const MAX_BUDGET_TOKENS = 24576;

/** Thinking configuration */
export interface Thinking {
  type: 'enabled' | 'disabled' | 'adaptive';
  budget_tokens: number;
}

/** Check if thinking is enabled (enabled or adaptive) */
export function isThinkingEnabled(thinking: Thinking | undefined): boolean {
  if (!thinking) return false;
  return thinking.type === 'enabled' || thinking.type === 'adaptive';
}

/** OutputConfig configuration */
export interface OutputConfig {
  effort: string;
}

/** Claude Code request metadata */
export interface Metadata {
  user_id?: string;
}

/** Messages request body */
export interface MessagesRequest {
  model: string;
  max_tokens: number;
  messages: Message[];
  stream?: boolean;
  system?: SystemMessage[];
  tools?: Tool[];
  tool_choice?: unknown;
  thinking?: Thinking;
  output_config?: OutputConfig;
  metadata?: Metadata;
}

/**
 * Preprocess the system field from raw JSON.
 *
 * The Claude API allows `system` to be either a string or an array of
 * SystemMessage objects. This function normalizes both forms into
 * SystemMessage[] | undefined.
 */
export function preprocessSystem(raw: unknown): SystemMessage[] | undefined {
  if (raw === undefined || raw === null) return undefined;

  if (typeof raw === 'string') {
    return [{ text: raw }];
  }

  if (Array.isArray(raw)) {
    const result: SystemMessage[] = [];
    for (const item of raw) {
      if (item && typeof item === 'object' && 'text' in item && typeof item.text === 'string') {
        result.push({ text: item.text });
      }
    }
    return result.length > 0 ? result : undefined;
  }

  return undefined;
}

/**
 * Clamp budget_tokens to MAX_BUDGET_TOKENS, defaulting to 20000 if absent.
 */
export function clampBudgetTokens(thinking: Thinking | undefined): Thinking | undefined {
  if (!thinking) return undefined;
  const budgetTokens = thinking.budget_tokens ?? 20000;
  return {
    ...thinking,
    budget_tokens: Math.min(budgetTokens, MAX_BUDGET_TOKENS),
  };
}

/** Message */
export interface Message {
  role: string;
  /** Can be string or ContentBlock[] */
  content: unknown;
}

/** System message */
export interface SystemMessage {
  text: string;
}

/**
 * Tool definition
 *
 * Supports several formats:
 * 1. Normal tool: { name, description, input_schema }
 * 2. WebSearch tool: { type: "web_search_20250305", name: "web_search", max_uses: 8 }
 * 3. Tool-search marker (beta 20251119): { type: "tool_search_tool_regex_20251119", name }
 *    — synthetic, no input_schema; dropped in convertTools (Kiro has no tool-search).
 */
export interface Tool {
  /** Tool type, e.g. "web_search_20250305" or "tool_search_tool_regex_20251119" */
  type?: string;
  /** Tool name */
  name: string;
  /** Tool description (absent for WebSearch / tool-search marker tools) */
  description?: string;
  /** Input parameter schema (absent for WebSearch / tool-search marker tools) */
  input_schema?: Record<string, unknown>;
  /** Max uses (WebSearch only) */
  max_uses?: number;
  /**
   * Tool-search beta: when true the client expects this tool to be loaded lazily
   * via server-side search. Kiro has no tool-search, so we ignore this flag and
   * forward the tool with its full schema (no deferral).
   */
  defer_loading?: boolean;
}

/** Content block */
export interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  tool_use_id?: string;
  content?: unknown;
  name?: string;
  input?: unknown;
  id?: string;
  is_error?: boolean;
  source?: ImageSource;
}

/** Image data source */
export interface ImageSource {
  type: string;
  media_type: string;
  data: string;
}

// === Count Tokens endpoint types ===

/** Token count request */
export interface CountTokensRequest {
  model: string;
  messages: Message[];
  system?: SystemMessage[];
  tools?: Tool[];
}

/** Token count response */
export interface CountTokensResponse {
  input_tokens: number;
}
