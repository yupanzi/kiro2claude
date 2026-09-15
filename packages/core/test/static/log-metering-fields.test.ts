/**
 * Static guard: the terminal-log metering pair (`kiro_metering` + `metering_lost`)
 * is constructed in exactly one place — `buildMeteringLogFields` in
 * `claude/stream.ts` — and every terminal log point spreads it.
 *
 * ## Motivation
 *
 * `metering_lost` answers "上游已扣费但网关没记账" and `kiro_metering` carries the
 * raw upstream Metering frame that makes such a sample auditable. They are only
 * useful together, and only if they read the *same* `eventCounts` snapshot:
 *
 *   - `metering_lost` alone flags that credit was lost but not which request lost
 *     how much — the sample cannot be reconciled against the upstream ledger.
 *   - `kiro_metering` alone cannot be grepped for the lost ones.
 *
 * The failure this guard exists to prevent already happened once. The six
 * terminal log points (claude/openai × streaming/non-streaming, plus the two
 * non-streaming mid-stream-error branches) each hand-wrote the fields, and the
 * "stay in sync" contract lived in prose — comments saying "与流式 handler 同名".
 * When `kiro_metering` was added to the non-streaming paths, the two mid-stream
 * error branches were missed: they kept `metering_lost` with no raw frame beside
 * it, and the comments claiming "四条终态路径都带" were simply wrong. Nothing
 * failed; the漏账 statistics just silently covered a subset.
 *
 * That is the shape of the bug this pins: a **silent** undercount, not a red
 * test. A seventh terminal log point that hand-writes `metering_lost:` would
 * reintroduce it with no other signal, which is why the check is textual rather
 * than behavioural — asserting it at runtime would pin today's call sites rather
 * than the "one constructor" property.
 *
 * Matches CLAUDE.md 日志规范「一个指标只有一个 owner」and mirrors
 * `log-capacity-reason.test.ts`. The plugin-side twin of the same predicate
 * (`kiro.meteringMissing`) is pinned by `usage-meta-contract.test.ts`; one
 * predicate with two outlets needs both nailed down.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { SRC_ROOT, stripComments, walkTsFiles } from '../helpers/static-scan.js';

/** The single file allowed to construct the pair, relative to `src/`. */
const OWNER = 'claude/stream.ts';

/**
 * Expected sites per field in the owner: one each, inside
 * `buildMeteringLogFields`. Raise this only alongside a deliberate decision —
 * a second construction site is exactly the drift described in the header.
 */
const OWNER_SITES_PER_FIELD = 1;

/** Count a field name used as an object key (not merely mentioned in prose). */
function countFieldSites(source: string, field: string): number {
  return (stripComments(source).match(new RegExp(`\\b${field}\\s*:`, 'g')) ?? []).length;
}

describe('static guard: metering log fields have one constructor', () => {
  const files = walkTsFiles(SRC_ROOT);

  for (const field of ['kiro_metering', 'metering_lost'] as const) {
    it(`only ${OWNER} writes \`${field}\` as a log field`, () => {
      expect(files.length).toBeGreaterThan(0);

      const owners = files
        .filter((f) => countFieldSites(fs.readFileSync(f, 'utf-8'), field) > 0)
        .map((f) => path.relative(SRC_ROOT, f));

      expect(
        owners,
        `${field} must only be constructed in ${OWNER} (buildMeteringLogFields). ` +
          'Terminal log points spread it: `...buildMeteringLogFields(metering, eventCounts)`. ' +
          "Hand-writing it at a new site is how the two error branches were missed — see this file's header.",
      ).toEqual([OWNER]);
    });
  }

  it('the constructor emits both fields exactly once, from one snapshot', () => {
    const source = fs.readFileSync(path.join(SRC_ROOT, OWNER), 'utf-8');
    expect(countFieldSites(source, 'kiro_metering')).toBe(OWNER_SITES_PER_FIELD);
    expect(countFieldSites(source, 'metering_lost')).toBe(OWNER_SITES_PER_FIELD);
  });

  it('every terminal log point spreads the constructor', () => {
    // The pair is useless unless the call sites actually exist — a guard that
    // only forbids hand-writing would also pass if the fields vanished entirely.
    const spreadSites = files.flatMap((f) => {
      const hits = (
        stripComments(fs.readFileSync(f, 'utf-8')).match(/\.\.\.buildMeteringLogFields\(/g) ?? []
      ).length;
      return hits > 0 ? [`${path.relative(SRC_ROOT, f)}:${hits}`] : [];
    });

    expect(spreadSites.sort()).toEqual([
      'claude/non-stream-handler.ts:2',
      'claude/stream-handler.ts:1',
      'openai/non-stream-transport.ts:2',
      'openai/stream-transport.ts:1',
    ]);
  });

  it('detects a regression in a synthetic sample', () => {
    // Scanner self-check: a vacuous regex would pass on code that must fail.
    const prose = '// metering_lost: only mentioned here, not logged\n';
    expect(countFieldSites(prose, 'metering_lost')).toBe(0);
    expect(countFieldSites("log.info({ msg: 'x', metering_lost: v });", 'metering_lost')).toBe(1);
  });
});
