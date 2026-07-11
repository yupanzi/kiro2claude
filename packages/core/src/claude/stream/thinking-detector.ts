/**
 * Thinking-tag detection for streaming and non-streaming text.
 *
 * The three scanner functions (`findRealThinkingStartTag`,
 * `findRealThinkingEndTag`, `findRealThinkingEndTagAtBufferEnd`) share a
 * single `findRealTagNoQuoteWrap` helper: one "walk the buffer, skip quoted
 * tags" loop where the **suffix** rule applied after the tag is a
 * single-function parameter.
 *
 * ## Suffix decision protocol
 *
 * The suffix predicate returns one of three states that drive the scanner:
 *
 *  - `match` — this position is a real tag, return it
 *  - `retry` — not a real tag, continue scanning forward
 *  - `wait`  — insufficient context (streaming buffer too short), return
 *              `undefined` so the caller can feed more data and try again
 *
 * The three public scanners differ **only** in this predicate:
 *
 *  - Start tag:  always `match` (no suffix requirement)
 *  - End tag (normal stream):
 *      `after.length < 2` → `wait` (need to see `\n\n` or non-whitespace)
 *      `after.startsWith('\n\n')` → `match`
 *      otherwise → `retry`
 *  - End tag (buffer-end boundary, e.g. right before tool_use):
 *      `after.trim() === ''` → `match`
 *      otherwise → `retry`
 *
 * The `test/claude/stream.test.ts` assertions pin this behavior.
 */

// ============================================================================
// Character boundary helpers
// ============================================================================

/**
 * Find the nearest valid character boundary <= target position.
 * In JavaScript strings are UTF-16, so we need to handle surrogate pairs.
 */
export function findCharBoundary(s: string, target: number): number {
  if (target >= s.length) return s.length;
  if (target === 0) return 0;

  let pos = target;
  while (pos > 0 && isLowSurrogate(s.charCodeAt(pos))) {
    pos--;
  }
  return pos;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

// ============================================================================
// Quote-character protection
// ============================================================================

/**
 * Quote characters that indicate a tag is being referenced, not used literally.
 * When thinking tags are wrapped by these characters, they are quotes rather
 * than real tags.
 */
const QUOTE_CHARS = new Set<number>([
  0x60, // ` backtick
  0x22, // " double quote
  0x27, // ' single quote
  0x5c, // \ backslash
  0x23, // #
  0x21, // !
  0x40, // @
  0x24, // $
  0x25, // %
  0x5e, // ^
  0x26, // &
  0x2a, // *
  0x28, // (
  0x29, // )
  0x2d, // -
  0x5f, // _
  0x3d, // =
  0x2b, // +
  0x5b, // [
  0x5d, // ]
  0x7b, // {
  0x7d, // }
  0x3b, // ;
  0x3a, // :
  0x3c, // <
  0x3e, // >
  0x2c, // ,
  0x2e, // .
  0x3f, // ?
  0x2f, // /
]);

function isQuoteChar(buffer: string, pos: number): boolean {
  if (pos < 0 || pos >= buffer.length) return false;
  return QUOTE_CHARS.has(buffer.charCodeAt(pos));
}

// ============================================================================
// Generic scanner
// ============================================================================

type SuffixDecision = 'match' | 'retry' | 'wait';

/**
 * Find the first occurrence of `tag` in `buffer` that is NOT quoted by
 * surrounding characters AND satisfies the caller-provided suffix rule.
 *
 * Returns the position (tag start index) on success, `undefined` when
 * the scanner either ran out of buffer ('wait') or the tag isn't present.
 */
function findRealTagNoQuoteWrap(
  buffer: string,
  tag: string,
  suffixDecide: (after: string) => SuffixDecision,
): number | undefined {
  let searchStart = 0;

  while (true) {
    const pos = buffer.indexOf(tag, searchStart);
    if (pos === -1) return undefined;

    const hasQuoteBefore = pos > 0 && isQuoteChar(buffer, pos - 1);
    const afterPos = pos + tag.length;
    const hasQuoteAfter = isQuoteChar(buffer, afterPos);

    if (hasQuoteBefore || hasQuoteAfter) {
      searchStart = pos + 1;
      continue;
    }

    const afterContent = buffer.slice(afterPos);
    const decision = suffixDecide(afterContent);
    if (decision === 'match') return pos;
    if (decision === 'wait') return undefined;
    // retry
    searchStart = pos + 1;
  }
}

// ============================================================================
// Public scanners (three suffix rules)
// ============================================================================

const START_TAG_DECIDE = (): SuffixDecision => 'match';

const END_TAG_DECIDE = (after: string): SuffixDecision => {
  if (after.length < 2) return 'wait';
  if (after.startsWith('\n\n')) return 'match';
  return 'retry';
};

const END_TAG_AT_BUFFER_END_DECIDE = (after: string): SuffixDecision =>
  after.trim() === '' ? 'match' : 'retry';

/**
 * Find the first real `<thinking>` tag — not wrapped by quote characters.
 * No suffix requirement; any unquoted occurrence is a match.
 */
export function findRealThinkingStartTag(buffer: string): number | undefined {
  return findRealTagNoQuoteWrap(buffer, '<thinking>', START_TAG_DECIDE);
}

/**
 * Find a real `</thinking>` tag followed by a double newline.
 *
 * Used by the mid-stream scanner: requires `\n\n` after the tag so we
 * don't falsely close on a quoted reference. If the buffer ends with
 * only `</thinking>` + one newline, returns undefined ('wait').
 */
export function findRealThinkingEndTag(buffer: string): number | undefined {
  return findRealTagNoQuoteWrap(buffer, '</thinking>', END_TAG_DECIDE);
}

/**
 * Find a real `</thinking>` tag at the tail of a buffer.
 *
 * Used by boundary scanners (end-of-stream, right before tool_use) where
 * the `\n\n` suffix may not arrive — only trailing whitespace is allowed.
 */
export function findRealThinkingEndTagAtBufferEnd(buffer: string): number | undefined {
  return findRealTagNoQuoteWrap(buffer, '</thinking>', END_TAG_AT_BUFFER_END_DECIDE);
}

// ============================================================================
// Non-streaming extractor
// ============================================================================

/**
 * Extract a thinking block from complete text (used by the non-streaming
 * response collector). Returns `[thinking, remainingText]`.
 *
 * Uses the same tag detection logic as the streaming scanner.
 */
export function extractThinkingFromCompleteText(text: string): [string | undefined, string] {
  const startPos = findRealThinkingStartTag(text);
  if (startPos === undefined) return [undefined, text];

  const before = text.slice(0, startPos);
  const afterOpen = text.slice(startPos + '<thinking>'.length);

  let thinkingRaw: string;
  let textAfter: string;

  const endPos = findRealThinkingEndTag(afterOpen);
  if (endPos !== undefined) {
    thinkingRaw = afterOpen.slice(0, endPos);
    textAfter = afterOpen.slice(endPos + '</thinking>\n\n'.length);
  } else {
    const endPosBufferEnd = findRealThinkingEndTagAtBufferEnd(afterOpen);
    if (endPosBufferEnd !== undefined) {
      thinkingRaw = afterOpen.slice(0, endPosBufferEnd);
      const afterTag = endPosBufferEnd + '</thinking>'.length;
      textAfter = afterOpen.slice(afterTag).trimStart();
    } else {
      // No valid end tag found, don't extract
      return [undefined, text];
    }
  }

  // Strip leading newline (model outputs <thinking>\n)
  const thinkingContent = thinkingRaw.startsWith('\n') ? thinkingRaw.slice(1) : thinkingRaw;

  // Assemble remaining text: skip pure-whitespace before part
  let remaining = '';
  if (before.trim()) {
    remaining += before;
  }
  remaining += textAfter;

  if (!thinkingContent) {
    return [undefined, remaining];
  }

  return [thinkingContent, remaining];
}
