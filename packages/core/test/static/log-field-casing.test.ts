/**
 * Static guard: forbid camelCase keys in structured logger calls.
 *
 * ## Motivation
 *
 * Production log pipelines (pino → stdout → Loki/Datadog/OpenSearch) treat
 * logger fields as first-class indexed columns. Mixing `inputTokens` and
 * `input_tokens` across the codebase means operators have to query both
 * spellings to find the same metric, and rewriting dashboards whenever a
 * new file drifts. The project convention is **snake_case for every
 * business-custom field**.
 *
 * The only exceptions are framework-internal keys (pino / Fastify) that
 * were never under our control:
 *
 *   msg        — pino message key
 *   err        — pino error serializer trigger
 *   level      — pino level key
 *   time       — pino timestamp key
 *   reqId      — pino child logger convention
 *   statusCode — Fastify `reply.statusCode`
 *
 * These live in `ALLOWED_KEYS` below.
 *
 * ## What's forbidden
 *
 * Any top-level key inside a `(getLogger()|logger).(info|warn|error|debug|
 * fatal|trace)({...})` object literal whose name contains an uppercase
 * letter (i.e. any camelCase identifier) that is not in `ALLOWED_KEYS`.
 *
 * ## Implementation
 *
 * The scanner is deliberately simple: it walks each source file line by
 * line, tracks when it's inside a logger call's `{...}`, and reports any
 * `^\s*(\w+)\s*:` that matches a camelCase pattern. Brace counting is
 * done via `countBraces()` so nested objects are still scanned — that's
 * a feature, not a bug, because nested keys land in the logged JSON too.
 *
 * If a genuine need arises to log a third-party identifier that must
 * stay camelCase (e.g. an AWS SDK response field), add it to
 * `ALLOWED_KEYS` with a short rationale comment.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SRC_ROOT = path.resolve(__dirname, '../../src');

/**
 * Keys that are allowed to remain camelCase because they are framework-
 * owned, not business data.
 */
const ALLOWED_KEYS = new Set<string>([
  'msg', // pino message
  'err', // pino error serializer trigger
  'level', // pino level
  'time', // pino timestamp
  'reqId', // pino child logger convention
  'statusCode', // Fastify reply.statusCode
]);

/**
 * Logger call start pattern. Matches `logger.info({`, `getLogger().warn({`, etc.
 * We don't try to be clever about string literals on the same line — the
 * codebase doesn't use string keys in logger objects.
 */
const LOGGER_CALL_START =
  /(?:\bgetLogger\s*\(\s*\)|\blogger|\blog)\.(?:info|warn|error|debug|fatal|trace)\s*\(\s*\{/;

/**
 * Single-line logger call pattern: `logger.info({ msg: 'x', err })`.
 * These are extracted separately because the multi-line scanner only
 * tracks brace depth across line breaks.
 */
const LOGGER_CALL_INLINE =
  /(?:\bgetLogger\s*\(\s*\)|\blogger|\blog)\.(?:info|warn|error|debug|fatal|trace)\s*\(\s*\{([^}]*)\}/g;

/** Count un-escaped `{` and `}` in a line, ignoring string literals. */
function countBraces(line: string): { open: number; close: number } {
  let open = 0;
  let close = 0;
  let inString: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inString) {
      if (ch === '\\') {
        i++; // skip next char
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
      continue;
    }
    if (ch === '/' && line[i + 1] === '/') break; // line comment
    if (ch === '{') open++;
    else if (ch === '}') close++;
  }
  return { open, close };
}

type Violation = {
  file: string;
  line: number;
  key: string;
};

/** Does this key need to be rewritten? */
function isCamelCaseKey(key: string): boolean {
  if (ALLOWED_KEYS.has(key)) return false;
  return /[A-Z]/.test(key);
}

/** Extract candidate keys from a single-line fragment like `{ foo: 1, bar: 2 }`. */
function extractKeysFromFragment(fragment: string): string[] {
  const keys: string[] = [];
  // Match `word:` at the start of a segment (after `{`, `,`, or line start).
  // Accepts shorthand `{ foo,` by also matching `word,`.
  const re = /(?:^|[{,])\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*[:,}]/g;
  let m = re.exec(fragment);
  while (m !== null) {
    keys.push(m[1]);
    m = re.exec(fragment);
  }
  return keys;
}

function scanFile(absolutePath: string): Violation[] {
  const source = fs.readFileSync(absolutePath, 'utf-8');
  const lines = source.split('\n');
  const relative = path.relative(SRC_ROOT, absolutePath).replaceAll(path.sep, '/');
  const violations: Violation[] = [];

  // Multi-line scan: track when we're inside a logger call's object literal.
  let inLogger = false;
  let depth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Step 1: inline match first — `logger.info({ msg, err })` in a single line.
    // We run this match independently of the multi-line state because inline
    // calls don't affect `depth`.
    if (!inLogger) {
      LOGGER_CALL_INLINE.lastIndex = 0;
      let m: RegExpExecArray | null = LOGGER_CALL_INLINE.exec(line);
      while (m !== null) {
        const fragment = `{${m[1]}}`;
        for (const key of extractKeysFromFragment(fragment)) {
          if (isCamelCaseKey(key)) {
            violations.push({ file: relative, line: i + 1, key });
          }
        }
        m = LOGGER_CALL_INLINE.exec(line);
      }
    }

    // Step 2: multi-line tracking.
    if (!inLogger) {
      const startMatch = LOGGER_CALL_START.test(line);
      if (!startMatch) continue;
      // Don't double-report: if the whole call also fits on this line
      // the inline scan above already handled it. Check brace closure.
      const { open, close } = countBraces(line);
      // The logger call contributes one `{`; if close >= open, the inline
      // scanner already saw everything we need.
      if (close >= open) continue;
      inLogger = true;
      depth = open - close;
      continue;
    }

    // We're inside a logger object literal on a continuation line.
    // Scan the line for top-level keys (any `word:` that looks like an
    // object key — we're generous because nested object keys should also
    // be snake_case anyway).
    const keyMatch = line.match(/^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:/);
    if (keyMatch) {
      const key = keyMatch[1];
      if (isCamelCaseKey(key)) {
        violations.push({ file: relative, line: i + 1, key });
      }
    }
    // Also catch shorthand properties `^\s*word,` inside the object.
    const shorthandMatch = line.match(/^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*,\s*$/);
    if (shorthandMatch) {
      const key = shorthandMatch[1];
      if (isCamelCaseKey(key)) {
        violations.push({ file: relative, line: i + 1, key });
      }
    }

    const { open, close } = countBraces(line);
    depth += open - close;
    if (depth <= 0) {
      inLogger = false;
      depth = 0;
    }
  }

  return violations;
}

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

describe('static guard: logger field casing', () => {
  it('test_no_camelcase_keys_in_logger_calls', () => {
    const files = walkTsFiles(SRC_ROOT);
    expect(files.length).toBeGreaterThan(0);

    const allViolations: Violation[] = [];
    for (const f of files) {
      allViolations.push(...scanFile(f));
    }

    if (allViolations.length > 0) {
      const lines = allViolations.map(
        (v) => `  ${v.file}:${v.line}  key="${v.key}"  → use snake_case`,
      );
      const msg = [
        'camelCase keys are forbidden inside logger calls in src/.',
        '',
        'Offending sites:',
        ...lines,
        '',
        'Why: production log pipelines index logger fields as first-class',
        'columns; mixing camelCase and snake_case forces operators to query',
        'both spellings for the same metric. The project convention is',
        'snake_case for every business-custom field.',
        '',
        'Exceptions: framework-internal keys (pino / Fastify) listed in',
        'ALLOWED_KEYS inside this test file (msg, err, level, time, reqId,',
        'statusCode).',
        '',
        'See test/static/log-field-casing.test.ts for details.',
      ].join('\n');
      throw new Error(msg);
    }

    expect(allViolations).toEqual([]);
  });

  it('detects camelcase violation in a synthetic sample', () => {
    // Inline sanity check for the scanner itself. If someone breaks the
    // scanner, the main guard could start silently passing. This synthetic
    // test pins that an intentionally-bad logger call is still caught.
    const sampleCode = [
      "import { getLogger } from '../shared/logger.js';",
      '',
      "getLogger().info({ msg: 'test', someKey: 42 });",
      '',
      'getLogger().warn({',
      "  msg: 'multiline',",
      '  anotherKey: true,',
      '});',
    ].join('\n');

    // Write to a temp file so scanFile() can read it like a real source file.
    const tmpDir = fs.mkdtempSync(path.join(path.resolve(__dirname, '..'), '.tmp-log-casing-'));
    const tmpFile = path.join(tmpDir, 'sample.ts');
    try {
      fs.writeFileSync(tmpFile, sampleCode);
      // Point SRC_ROOT resolution: we can't mutate SRC_ROOT, so we call
      // scanFile directly with the absolute path — the violation `file`
      // field will contain an odd relative path but the `key` assertions
      // still work.
      const violations = scanFile(tmpFile);
      const keys = violations.map((v) => v.key).sort();
      expect(keys).toEqual(['anotherKey', 'someKey']);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
