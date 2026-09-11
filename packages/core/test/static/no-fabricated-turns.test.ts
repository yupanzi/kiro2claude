/**
 * Static guard: the converter fabricates no assistant turns.
 *
 * ## Motivation
 *
 * Kiro's wire has no system field and its history must strictly alternate
 * user / assistant. Two earlier workarounds satisfied that by *inventing*
 * assistant replies: a synthetic opening turn (`user: <system>` /
 * `assistant: "I will follow these instructions."`, mirroring kiro-cli's own
 * context injection) and an `assistant: "OK"` pushed after a trailing run of
 * user messages. Both are real history to the model — asked to quote its
 * earlier replies it quotes them verbatim (2026-09-10 live probes; the
 * zero-injection baseline answers NONE) — and the "OK" pairing also made the
 * history shape drift between turns. A 24-session / 352-call A/B under
 * 35K–78K context with real tool execution showed the fabricated turns buy
 * nothing, so system text now folds into the first user message and the
 * trailing user run *is* the current turn (see `foldSystemIntoFirstUserMessage`
 * and `buildHistory` in `claude/converter.ts`).
 *
 * ## What this guard can and cannot see
 *
 * It is textual on purpose and cheap: any `createAssistantMessage(<string
 * literal>)` in the converter is, by construction, a turn the client never
 * sent, and the two removed ack strings must not come back. Real assistant
 * turns always pass through `convertAssistantMessage` / `mergeAssistantMessages`,
 * whose argument is a computed string. It cannot see a literal routed through a
 * constant or a hand-built `{ kind: 'assistant', … }` object; the behavioral
 * pin for that is `converter.test.ts` "never fabricates an assistant turn:
 * history maps 1:1 onto the client turns", and the 5923-request replay in
 * `test/manual/replay-content-preservation.ts` (history kinds strictly
 * alternate, one entry per client run).
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SRC_ROOT, stripComments } from '../helpers/static-scan.js';

const converterPath = path.join(SRC_ROOT, 'claude/converter.ts');
/** The two legitimate call sites: convertAssistantMessage and mergeAssistantMessages. */
const LEGITIMATE_CALL_SITES = 2;

function literalCalls(code: string): string[] {
  return code.match(/createAssistantMessage\(\s*['"`]/g) ?? [];
}

describe('claude/converter.ts fabricates no assistant turns', () => {
  // Strip comments so the historical explanation above the code cannot trip the guard.
  const code = stripComments(fs.readFileSync(converterPath, 'utf8'));

  it('still sees the legitimate createAssistantMessage call sites (scanner is not vacuous)', () => {
    const calls = code.match(/createAssistantMessage\(/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(LEGITIMATE_CALL_SITES);
  });

  it('never calls createAssistantMessage with a string literal', () => {
    expect(literalCalls(code)).toEqual([]);
  });

  it('has no synthetic acknowledgement text left behind', () => {
    expect(code).not.toMatch(/I will follow these instructions/);
  });

  it('detects a regression in a synthetic sample', () => {
    // Scanner self-check: the regex must fire on the exact shapes that were removed.
    expect(
      literalCalls(
        "history.push({ kind: 'assistant', assistantResponseMessage: createAssistantMessage('OK') });",
      ),
    ).toHaveLength(1);
    expect(
      literalCalls('createAssistantMessage(`I will follow these instructions.`)'),
    ).toHaveLength(1);
    expect(literalCalls('createAssistantMessage(finalContent)')).toHaveLength(0);
  });
});
