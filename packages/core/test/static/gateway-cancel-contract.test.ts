/**
 * Static guard: every gateway-initiated upstream cancel marks itself as such.
 *
 * ## Motivation
 *
 * Two code paths kill a live upstream response on purpose: the post-disconnect
 * drain grace timer (`upstreamData?.destroy?.()`) and the opt-in abort on client
 * disconnect (`upstreamAbort.abort()`). Both leave a tool_use frozen mid-transfer
 * with no `isComplete` — the exact shape the terminal path reports as
 * `upstream truncated tool_use`, which ops reads as the first triage step for
 * "client reports a bad tool argument" (CLAUDE.md 速查表). Unmarked, every
 * disconnect files a false report against the upstream for a wound we inflicted.
 *
 * `ctx.gatewayTruncatedUpstream` is that mark, and it is set **next to** each
 * cancel because only the caller knows who pulled the trigger. That is precisely
 * the shape this repo has already been bitten by: `sse-backpressure-contract`
 * documents how the drain-grace error-level exemption landed on the claude side
 * while the OpenAI `catch` had no exemption branch at all — the two transports
 * are deliberate copies, so a fix applied to one silently misses the other.
 *
 * So this guard is positional, not existential: it does not ask "is the flag
 * mentioned somewhere", it asks "does *each* cancel site have it nearby". A new
 * cancel path (e.g. an abort branch added to the OpenAI transport, which today
 * only has the grace timer) fails the test until it is attributed.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, '../../src');

const TRANSPORTS = [
  path.join(SRC, 'claude/stream-handler.ts'),
  path.join(SRC, 'openai/stream-transport.ts'),
];
const STREAM_TS = path.join(SRC, 'claude/stream.ts');

/** Deliberate kills of a live upstream response. */
const CANCEL_SITES = [/upstreamData\?\.destroy\?\.\(\)/, /upstreamAbort\.abort\(\)/];
const MARK = /ctx\.gatewayTruncatedUpstream\s*=\s*true/;
/** Lines to look around a cancel site. Both current sites sit within 2 lines. */
const WINDOW = 8;

/** Blank out comments so prose can't satisfy a check, keeping line numbers. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''))
    .replace(/^\s*\/\/.*$/gm, '');
}

/** Line indices where `source` deliberately cancels the upstream. */
function cancelSites(lines: string[]): number[] {
  return lines.flatMap((line, i) => (CANCEL_SITES.some((re) => re.test(line)) ? [i] : []));
}

function markedNearby(lines: string[], site: number): boolean {
  return lines.slice(Math.max(0, site - WINDOW), site + WINDOW + 1).some((line) => MARK.test(line));
}

describe('static guard: gateway-initiated cancels are attributed', () => {
  it('every cancel site in both transports sets gatewayTruncatedUpstream', () => {
    let total = 0;
    for (const file of TRANSPORTS) {
      const lines = stripComments(fs.readFileSync(file, 'utf-8')).split('\n');
      const sites = cancelSites(lines);
      total += sites.length;
      for (const site of sites) {
        expect(
          markedNearby(lines, site),
          `${path.basename(file)}:${site + 1} cancels the upstream without setting ` +
            'ctx.gatewayTruncatedUpstream — the truncated tool_use it causes would be ' +
            'logged as an upstream fault',
        ).toBe(true);
      }
    }
    // Both known sites must still be found; a rename that hides them from the
    // scanner would otherwise turn this whole guard into a no-op.
    expect(total, 'cancel sites should be discoverable in both transports').toBeGreaterThanOrEqual(
      3,
    );
  });

  it('the terminal path splits self-inflicted truncation out of the upstream warn', () => {
    const code = stripComments(fs.readFileSync(STREAM_TS, 'utf-8'));
    expect(code).toMatch(/self_inflicted/);
    // The ops-facing message stays reserved for real upstream faults.
    expect(code).toMatch(/upstream truncated tool_use/);
    expect(code).toMatch(/gateway-initiated upstream cancel/);
  });

  it('detects an unattributed cancel in a synthetic sample', () => {
    // Scanner self-check: the positional assertion must fail on known-bad code.
    const bad = stripComments(
      [
        'const onGrace = () => {',
        '  // ctx.gatewayTruncatedUpstream = true',
        '  upstreamData?.destroy?.();',
        '};',
      ].join('\n'),
    ).split('\n');
    const sites = cancelSites(bad);
    expect(sites).toHaveLength(1);
    expect(markedNearby(bad, sites[0])).toBe(false);
  });
});
