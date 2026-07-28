/**
 * Static guard: the SSE write path must not conflate flow control with liveness.
 *
 * ## Motivation
 *
 * `stream.write()` returns `false` for **backpressure** (internal buffer above
 * highWaterMark → wait for `'drain'`), on a perfectly healthy socket. Returning
 * that value from `safeWrite` makes every caller read "buffer full" as "client
 * disconnected": the read loop stops forwarding to a live client, the terminal
 * path drops `message_stop`, the upstream is still drained to EOF (full billing),
 * and the log blames the client. Only large byte volumes fill that buffer, so the
 * misread bites exactly the longest and most expensive responses.
 *
 * `test/claude/backpressure.test.ts` covers the behaviour. This guard is textual
 * and covers the two things behavioural tests can't cheaply pin:
 *
 *   1. `safeWrite` never returns `raw.write(...)` directly again — the regression
 *      is a one-token edit (`raw.write(chunk)` → `return raw.write(chunk)`) that
 *      reads perfectly innocent in review.
 *   2. Both stream transports actually call `awaitDrain`. `openai/stream-transport.ts`
 *      is a deliberate copy of the claude one (kept separate so the empty-stream
 *      retry logic can't drift — see the empty-stream red line), which means a fix
 *      applied to one side silently misses the other. That has already happened
 *      once in this area: the drain-grace error-level exemption landed on the
 *      claude side while the OpenAI `catch` had no exemption branch at all.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, '../../src');

const STREAM_TS = path.join(SRC, 'claude/stream.ts');
const TRANSPORTS = [
  path.join(SRC, 'claude/stream-handler.ts'),
  path.join(SRC, 'openai/stream-transport.ts'),
];

/** Strip `//` line comments and block comments so prose can't satisfy a check. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('static guard: SSE backpressure contract', () => {
  it('safeWrite does not return raw.write() (flow control ≠ liveness)', () => {
    const code = stripComments(fs.readFileSync(STREAM_TS, 'utf-8'));
    expect(code).toMatch(/export function safeWrite/);
    // The exact regression shape, in any spacing variant.
    expect(code).not.toMatch(/return\s+raw\.write\s*\(/);
    // And liveness must still be judged on the socket's own state.
    expect(code).toMatch(/destroyed/);
    expect(code).toMatch(/writableEnded/);
  });

  it('safeWrite is documented as returning writability, not write() success', () => {
    // 契约漂移防护:注释与实现必须说同一件事(历史上注释是对的、实现不是)。
    const doc = fs.readFileSync(STREAM_TS, 'utf-8');
    expect(doc).toMatch(/still writable/);
  });

  it('both stream transports await drain in their forward loop', () => {
    for (const file of TRANSPORTS) {
      const code = stripComments(fs.readFileSync(file, 'utf-8'));
      expect(code, `${path.basename(file)} must import awaitDrain`).toMatch(/awaitDrain/);
      expect(code, `${path.basename(file)} must await it`).toMatch(/await\s+awaitDrain\s*\(/);
    }
  });

  it('both stream transports attribute aborts to a source', () => {
    // 'client_close' vs 'write_failed' 的归因完全不同,别退回单一布尔。
    for (const file of TRANSPORTS) {
      const code = stripComments(fs.readFileSync(file, 'utf-8'));
      expect(code, `${path.basename(file)} must record client_close`).toMatch(/'client_close'/);
      expect(code, `${path.basename(file)} must record write_failed`).toMatch(/'write_failed'/);
    }
  });

  it('detects the regression in a synthetic sample', () => {
    // Scanner self-check: the assertions above must fail on known-bad code.
    const bad = stripComments(
      ['export function safeWrite(raw, chunk) {', '  return raw.write(chunk);', '}'].join('\n'),
    );
    expect(bad).toMatch(/return\s+raw\.write\s*\(/);
    expect(bad).not.toMatch(/await\s+awaitDrain\s*\(/);
  });
});
