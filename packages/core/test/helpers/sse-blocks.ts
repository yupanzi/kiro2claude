/**
 * Assertions and collectors over a `StreamContext` SSE event sequence.
 *
 * These read the *wire* shape (content_block_start / _delta / _stop), which is
 * what the Anthropic protocol actually constrains — block ordering and the
 * concatenation of deltas. Several suites assert the same two things (what did
 * the thinking channel say, and did its block close before the next one
 * opened), so they live here rather than being re-derived per file.
 */

import { expect } from 'vitest';
import type { SseEvent } from '../../src/claude/stream.js';

type BlockType = 'thinking' | 'text' | 'tool_use';

function blockTypeOf(event: SseEvent): string | undefined {
  return (event.data.content_block as Record<string, unknown> | undefined)?.type as
    | string
    | undefined;
}

function deltaTypeOf(event: SseEvent): string | undefined {
  return (event.data.delta as Record<string, unknown> | undefined)?.type as string | undefined;
}

/** Concatenated `thinking_delta` payloads, in wire order. */
export function collectThinkingText(events: SseEvent[]): string {
  return events
    .filter((e) => e.event === 'content_block_delta' && deltaTypeOf(e) === 'thinking_delta')
    .map((e) => ((e.data.delta as Record<string, unknown>).thinking as string) ?? '')
    .join('');
}

/** Each `thinking_delta` payload as its own entry, including empty ones. */
export function collectThinkingDeltas(events: SseEvent[]): string[] {
  return events
    .filter((e) => e.event === 'content_block_delta' && deltaTypeOf(e) === 'thinking_delta')
    .map((e) => (e.data.delta as Record<string, unknown>).thinking as string);
}

/** Concatenated `text_delta` payloads, in wire order. */
export function collectTextContent(events: SseEvent[]): string {
  return events
    .filter((e) => e.event === 'content_block_delta' && deltaTypeOf(e) === 'text_delta')
    .map((e) => ((e.data.delta as Record<string, unknown>).text as string) ?? '')
    .join('');
}

/**
 * Assert a thinking block was opened, and that it was stopped before the first
 * `nextBlockType` block started.
 *
 * Anthropic clients render blocks in wire order, so a thinking block still open
 * when the next one starts is a protocol violation regardless of the payloads
 * being individually correct — which is why this checks positions rather than
 * content.
 */
export function expectThinkingStoppedBefore(
  events: SseEvent[],
  nextBlockType: BlockType,
  message?: string,
): void {
  const thinkingStartPosition = events.findIndex(
    (event) => event.event === 'content_block_start' && blockTypeOf(event) === 'thinking',
  );
  expect(thinkingStartPosition, message).toBeGreaterThanOrEqual(0);

  const thinkingIndex = events[thinkingStartPosition]?.data.index;
  const thinkingStopPosition = events.findIndex(
    (event) => event.event === 'content_block_stop' && event.data.index === thinkingIndex,
  );
  const nextStartPosition = events.findIndex(
    (event) => event.event === 'content_block_start' && blockTypeOf(event) === nextBlockType,
  );

  expect(thinkingStopPosition, message).toBeGreaterThan(thinkingStartPosition);
  expect(nextStartPosition, message).toBeGreaterThan(thinkingStopPosition);
}
