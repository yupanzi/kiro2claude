import type { Event } from '../kiro/model/events/base.js';

/**
 * Ordinary tools require a complete JSON object. Never turn invalid arguments
 * into {}, which could execute a different action. Explicit raw-input tools
 * retain their exact wire string for their protocol-specific codec to interpret.
 */
export function parseCompletedToolInput(
  input: string,
  allowRawInput = false,
): Record<string, unknown> | string {
  if (allowRawInput) return input;
  if (input === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new Error('Invalid completed tool input: expected a JSON object');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid completed tool input: expected a JSON object');
  }
  return parsed as Record<string, unknown>;
}

/**
 * A tool id identifies one immutable invocation in one response. Incremental
 * input can revisit it until completion, but cannot change its name or reuse a
 * completed id. Shared by both reducers so they cannot execute different tools
 * or duplicate calls from the same upstream frames.
 */
export class ToolUseSequence {
  private readonly names = new Map<string, string>();
  private readonly completed = new Set<string>();

  observe(event: Extract<Event, { kind: 'ToolUse' }>): void {
    if (this.completed.has(event.toolUseId)) {
      throw new Error('Tool invocation id reused after completion');
    }
    const name = this.names.get(event.toolUseId);
    if (name !== undefined && name !== event.name) {
      throw new Error('Tool invocation name changed during input');
    }
    this.names.set(event.toolUseId, event.name);
    if (event.isComplete) this.completed.add(event.toolUseId);
  }
}
