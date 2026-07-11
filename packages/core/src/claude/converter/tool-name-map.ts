/**
 * Tool-name mapping and shortening.
 *
 * The smallest self-contained unit (zero cross-module dependencies beyond
 * node:crypto) and serves as the anchor for the `converter/` subdirectory.
 *
 * ## Why tool names need shortening
 *
 * Kiro's upstream tool-name field rejects anything longer than 63 characters.
 * Agent tools often produce longer names (e.g. third-party MCP tools use
 * dotted-namespace conventions). We shorten over-long names with a SHA-256
 * suffix and keep a `Map<short, original>` so the stream handler can map
 * the short name back when emitting `tool_use` content blocks.
 */

import crypto from 'node:crypto';

/** Upstream hard cap on tool name length. */
export const TOOL_NAME_MAX_LEN = 63;

/**
 * Shorten an over-long tool name to fit the 63-character limit.
 *
 * Format: `<prefix>_<8-char-sha256-suffix>` where prefix is truncated to
 * `TOOL_NAME_MAX_LEN - 1 - 8 = 54` chars at a Unicode-safe boundary.
 */
export function shortenToolName(name: string): string {
  const hash = crypto.createHash('sha256').update(name).digest('hex');
  const hashSuffix = hash.slice(0, 8);
  // 54 prefix + 1 underscore + 8 hash = 63
  const prefixMax = TOOL_NAME_MAX_LEN - 1 - 8;
  const chars = [...name];
  const prefix = chars.length > prefixMax ? chars.slice(0, prefixMax).join('') : name;
  return `${prefix}_${hashSuffix}`;
}

/**
 * If a tool name exceeds the max length, shorten it and record the mapping
 * (short → original). Otherwise return the original name unchanged.
 *
 * The mapping is consumed by the stream and non-stream handlers to
 * reverse-translate tool_use events back to the client-facing name.
 */
export function mapToolName(name: string, toolNameMap: Map<string, string>): string {
  if (name.length <= TOOL_NAME_MAX_LEN) {
    return name;
  }
  const short = shortenToolName(name);
  toolNameMap.set(short, name);
  return short;
}
