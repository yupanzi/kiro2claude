/**
 * Static guard: forbid all local-timezone Date APIs across the codebase.
 *
 * ## Motivation
 *
 * This project is a region-agnostic API proxy: every timestamp on the wire
 * must render identically regardless of where the server runs. JavaScript's
 * `Date` object quietly pulls in the host's local timezone whenever you
 * call certain accessors or formatters — creating a silent, region-dependent
 * divergence that is invisible during development but corrupts the wire
 * format in production.
 *
 * We hit exactly this bug in `claude/websearch.ts`, where a plain
 * `toLocaleDateString('en-US', ...)` call without `timeZone: 'UTC'` made web
 * search results render with a 1-day offset on US-region servers. The fix
 * was trivial (one option), but the failure mode was invisible on the
 * developer's machine because their timezone happened to match UTC modulo
 * the date boundary.
 *
 * This test is a **permanent filesystem-level guard** that fails the build
 * any time a new local-timezone Date API call sneaks into `src/`. It runs
 * as part of `pnpm test` and takes milliseconds.
 *
 * ## What's forbidden
 *
 * Any call to a `Date` API that implicitly uses the host's local timezone:
 *
 * - `.getDate()`, `.getMonth()`, `.getFullYear()`, `.getDay()`
 *   → use `.getUTCDate()`, `.getUTCMonth()`, `.getUTCFullYear()`, `.getUTCDay()`
 * - `.getHours()`, `.getMinutes()`, `.getSeconds()`, `.getMilliseconds()`
 *   → use `.getUTCHours()`, etc.
 * - `.setDate()`, `.setMonth()`, `.setFullYear()`, `.setHours()`,
 *   `.setMinutes()`, `.setSeconds()`, `.setMilliseconds()`
 *   → use the `setUTC*` counterparts, or construct with `Date.UTC()`
 * - `.toLocaleDateString(...)`, `.toLocaleString(...)`, `.toLocaleTimeString(...)`
 *   → use `.toISOString()` for machine-readable output, or pass
 *     `timeZone: 'UTC'` explicitly (only allowed in `ALLOWED_FILES`)
 * - `.toDateString()`, `.toTimeString()`
 *   → these format with the host's local timezone; use `.toISOString()`
 *
 * ## What's allowed (not forbidden)
 *
 * - `Date.now()` — returns UTC epoch ms, no timezone involved
 * - `new Date()`, `new Date(ms)`, `new Date(isoString)` — internal storage
 *   is UTC epoch; only output methods are timezone-sensitive
 * - `.getTime()`, `.valueOf()` — UTC epoch ms
 * - `.getTimezoneOffset()` — explicit timezone query, fine if the caller
 *   knows what they're doing
 * - `.toISOString()`, `.toJSON()` — always UTC (`Z` suffix)
 * - `Date.UTC(y, m, d, ...)` — explicit UTC constructor
 * - `.getUTC*()`, `.setUTC*()` — explicit UTC accessors
 *
 * ## Escape hatch
 *
 * If you genuinely need to call `toLocaleDateString` etc. with an explicit
 * `timeZone: 'UTC'` option for human-readable UTC formatting, add the file
 * path to `ALLOWED_FILES` below and document the reason in the target file.
 *
 * **Never add an escape for local-timezone usage.** If you think you need
 * local time, you probably need UTC with display-layer conversion — this
 * project is a region-agnostic API proxy and all timestamps on the wire
 * must be region-independent.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SRC_ROOT = path.resolve(__dirname, '../../src');

/**
 * Files that are explicitly allowed to call one specific banned API because
 * they render human-readable UTC strings (and have been reviewed to pass
 * `timeZone: 'UTC'` unconditionally).
 *
 * Format: `{ file: 'relative/path.ts', allow: Set<BannedApi> }`
 *
 * Do NOT add a file here without:
 *   1. A doc comment at the call site explaining why local-time behavior
 *      is not a risk.
 *   2. A unit test that exercises the call under multiple TZ overrides and
 *      asserts the output is region-independent.
 */
const ALLOWED_FILES: Array<{ file: string; allow: Set<string> }> = [
  {
    // formatPageAgeUTC in websearch.ts formats human-readable UTC strings
    // with explicit `timeZone: 'UTC'`. Has a unit test that pins
    // TZ=America/Los_Angeles and asserts region-independent output.
    file: 'claude/websearch.ts',
    allow: new Set(['toLocaleDateString']),
  },
];

/**
 * Local-timezone Date APIs. Each entry is a regex that must match an
 * actual call site (method-call syntax or member access).
 *
 * Patterns are anchored to require a leading dot (method call) to avoid
 * false positives on unrelated identifiers (e.g. "getDate" inside a URL
 * or a string literal). A trailing `\(` confirms it's a function invocation.
 */
const BANNED_APIS: Array<{ name: string; pattern: RegExp; suggestion: string }> = [
  // Local-time getters
  { name: 'getDate', pattern: /\.getDate\s*\(/g, suggestion: 'use .getUTCDate()' },
  { name: 'getMonth', pattern: /\.getMonth\s*\(/g, suggestion: 'use .getUTCMonth()' },
  { name: 'getFullYear', pattern: /\.getFullYear\s*\(/g, suggestion: 'use .getUTCFullYear()' },
  { name: 'getDay', pattern: /\.getDay\s*\(/g, suggestion: 'use .getUTCDay()' },
  { name: 'getHours', pattern: /\.getHours\s*\(/g, suggestion: 'use .getUTCHours()' },
  { name: 'getMinutes', pattern: /\.getMinutes\s*\(/g, suggestion: 'use .getUTCMinutes()' },
  { name: 'getSeconds', pattern: /\.getSeconds\s*\(/g, suggestion: 'use .getUTCSeconds()' },
  {
    name: 'getMilliseconds',
    pattern: /\.getMilliseconds\s*\(/g,
    suggestion: 'use .getUTCMilliseconds()',
  },

  // Local-time setters
  { name: 'setDate', pattern: /\.setDate\s*\(/g, suggestion: 'use .setUTCDate()' },
  { name: 'setMonth', pattern: /\.setMonth\s*\(/g, suggestion: 'use .setUTCMonth()' },
  { name: 'setFullYear', pattern: /\.setFullYear\s*\(/g, suggestion: 'use .setUTCFullYear()' },
  { name: 'setHours', pattern: /\.setHours\s*\(/g, suggestion: 'use .setUTCHours()' },
  { name: 'setMinutes', pattern: /\.setMinutes\s*\(/g, suggestion: 'use .setUTCMinutes()' },
  { name: 'setSeconds', pattern: /\.setSeconds\s*\(/g, suggestion: 'use .setUTCSeconds()' },
  {
    name: 'setMilliseconds',
    pattern: /\.setMilliseconds\s*\(/g,
    suggestion: 'use .setUTCMilliseconds()',
  },

  // Local-time formatters (the bug that started this test)
  {
    name: 'toLocaleDateString',
    pattern: /\.toLocaleDateString\s*\(/g,
    suggestion: "use .toISOString(), or pass { timeZone: 'UTC' } and add the file to ALLOWED_FILES",
  },
  {
    name: 'toLocaleTimeString',
    pattern: /\.toLocaleTimeString\s*\(/g,
    suggestion: "use .toISOString(), or pass { timeZone: 'UTC' }",
  },
  // Note: toLocaleString is skipped because Number / Array / etc. also define
  // it, and forbidding it would cause false positives on non-Date usage.
  // The other Date formatters above are Date-exclusive.

  {
    name: 'toDateString',
    pattern: /\.toDateString\s*\(/g,
    suggestion: 'use .toISOString() — toDateString renders in local timezone',
  },
  {
    name: 'toTimeString',
    pattern: /\.toTimeString\s*\(/g,
    suggestion: 'use .toISOString() — toTimeString renders in local timezone',
  },
];

/** Recursively list all .ts files under a directory. */
function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkTsFiles(p));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Strip single-line and block comments from a TypeScript source string so
 * that our regex scan only sees code. We keep string literals intact — a
 * match inside a string literal is still a risk because it may be used as
 * a dynamic method name.
 */
function stripComments(source: string): string {
  // Remove /* ... */ (including multi-line) first.
  let out = source.replace(/\/\*[\s\S]*?\*\//g, '');
  // Remove // ... (but not inside strings — we accept slight false negatives
  // on code like `const s = "//"` followed by a banned API on the same line,
  // which is vanishingly rare in practice).
  out = out.replace(/\/\/[^\n]*/g, '');
  return out;
}

type Violation = {
  file: string;
  api: string;
  count: number;
  suggestion: string;
};

function scanFile(absolutePath: string): Violation[] {
  const source = fs.readFileSync(absolutePath, 'utf-8');
  const code = stripComments(source);
  const relative = path.relative(SRC_ROOT, absolutePath).replaceAll(path.sep, '/');
  const allowedForFile = ALLOWED_FILES.find((e) => e.file === relative)?.allow ?? new Set<string>();

  const violations: Violation[] = [];
  for (const api of BANNED_APIS) {
    if (allowedForFile.has(api.name)) continue;
    const matches = code.match(api.pattern);
    if (matches && matches.length > 0) {
      violations.push({
        file: relative,
        api: api.name,
        count: matches.length,
        suggestion: api.suggestion,
      });
    }
  }
  return violations;
}

describe('static guard: no local-timezone Date APIs', () => {
  it('test_no_local_date_apis_in_src', () => {
    const files = walkTsFiles(SRC_ROOT);
    expect(files.length).toBeGreaterThan(0); // sanity: we did scan something

    const allViolations: Violation[] = [];
    for (const f of files) {
      allViolations.push(...scanFile(f));
    }

    if (allViolations.length > 0) {
      const lines = allViolations.map(
        (v) => `  ${v.file}: .${v.api}() x${v.count} — ${v.suggestion}`,
      );
      const msg = [
        'Local-timezone Date APIs are forbidden in src/.',
        '',
        'Offending files:',
        ...lines,
        '',
        'Why: this codebase is a region-agnostic API proxy. All timestamps',
        'on the wire must render identically regardless of where the server',
        'runs. JavaScript Date defaults to the host timezone for many',
        'accessors and formatters, which silently corrupts the wire format',
        'in a cross-region deployment.',
        '',
        'Fix: use the UTC counterpart (.getUTC*() / .setUTC*()) or',
        '.toISOString(). If you genuinely need human-readable UTC',
        'formatting with an explicit `timeZone: "UTC"` option, add the file',
        'to ALLOWED_FILES in this test after reviewing that the call site',
        'cannot fall back to local time.',
        '',
        'See test/static/no-local-date-apis.test.ts for details.',
      ].join('\n');
      throw new Error(msg);
    }

    expect(allViolations).toEqual([]);
  });

  it('test_allowed_files_still_exist', () => {
    // Defensive: if someone renames or deletes an allowed file, the
    // allowlist stops making sense — fail loudly rather than silently
    // expanding the blast radius.
    for (const entry of ALLOWED_FILES) {
      const abs = path.join(SRC_ROOT, entry.file);
      expect(
        fs.existsSync(abs),
        `ALLOWED_FILES entry "${entry.file}" no longer exists. Update or remove it.`,
      ).toBe(true);
    }
  });
});
