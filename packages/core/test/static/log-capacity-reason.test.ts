/**
 * Static guard: `capacity_reason` is logged in exactly one place, and covers
 * every capacity wire shape the executor can see (the 429 body and the 5xx
 * body; the mid-stream `ThrottlingException` frame never reaches the executor,
 * so it carries no `capacity_reason` — see `MODEL_CAPACITY_REASONS`).
 *
 * ## Motivation
 *
 * 踩坑「跨模型对照」 exists because attributing an upstream model-capacity shortage used
 * to require substring-matching formatted `error` prose. `capacity_reason` is
 * the structured field that replaced that, so "count the capacity events today"
 * must be a single query over a single dimension.
 *
 * Two ways to break that, both of which happened during development:
 *
 *   1. **Double-count.** `retry-executor` logs the field when it classifies the
 *      body; `claude/error-mapper` then has `err.kind.reason` in hand for free
 *      and it is tempting to log it again. That makes one 5xx capacity event
 *      emit two lines carrying the field while a 429 one emits a single line —
 *      so the 5xx shape silently gets double the weight of the 429 shape.
 *   2. **Undercount.** The upstream reports the *same* condition as a 429
 *      (`INSUFFICIENT_MODEL_CAPACITY`) and as a 5xx
 *      (`MODEL_TEMPORARILY_UNAVAILABLE`). Only the 5xx form is re-classified as
 *      `overloaded`, so it is easy to log the field only on that branch — and
 *      429 is the *more* common shape, so omitting it hides most of the event.
 *
 * The invariant that rules both out: the executor — the only layer holding both
 * the response body and the headers, and therefore the only one that can see a
 * 429 capacity body at all — is the sole owner of the field, and it logs it on
 * both branches.
 *
 * Textual on purpose: asserting this at runtime would mean driving two upstream
 * failure shapes through the executor with a logger spy, which pins the current
 * call sites rather than the "exactly one owner" property.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { SRC_ROOT, stripComments, walkTsFiles } from '../helpers/static-scan.js';

/** The single file allowed to log `capacity_reason`, relative to `src/`. */
const OWNER = 'kiro/retry-executor.ts';

/**
 * Expected number of logging sites in the owner: the 429 branch and the
 * 408/5xx branch. Raise this deliberately — a new site means a new way for the
 * dimension to be counted, so it needs the same "is this double-counting?"
 * reasoning the header describes.
 */
const OWNER_SITES = 2;

/** Count `capacity_reason:` used as an object key (not mentioned in prose). */
function countFieldSites(source: string): number {
  return (stripComments(source).match(/\bcapacity_reason\s*:/g) ?? []).length;
}

describe('static guard: capacity_reason has one owner', () => {
  const files = walkTsFiles(SRC_ROOT);

  it('only the retry executor logs the field', () => {
    expect(files.length).toBeGreaterThan(0);

    const owners = files
      .filter((f) => countFieldSites(fs.readFileSync(f, 'utf-8')) > 0)
      .map((f) => path.relative(SRC_ROOT, f));

    expect(
      owners,
      `capacity_reason must be logged only in ${OWNER}. A second site double-counts ` +
        "that shape against the others — see this file's header before adding one.",
    ).toEqual([OWNER]);
  });

  it('covers both the 429 and the 408/5xx branch', () => {
    const source = fs.readFileSync(path.join(SRC_ROOT, OWNER), 'utf-8');
    expect(
      countFieldSites(source),
      'Upstream reports capacity shortage as both 429 and 5xx; dropping either ' +
        'site undercounts the event (429 is the more common shape).',
    ).toBe(OWNER_SITES);
  });

  it('detects a regression in a synthetic sample', () => {
    // Scanner self-check: a vacuous regex would pass on code that must fail.
    const prose = '// capacity_reason: is only mentioned here, not logged\n';
    expect(countFieldSites(prose)).toBe(0);
    expect(countFieldSites("log.error({ msg: 'x', capacity_reason: r });")).toBe(1);
  });
});
