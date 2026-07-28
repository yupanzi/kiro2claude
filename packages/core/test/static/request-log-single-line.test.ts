/**
 * Static guard: one log line per HTTP request, and it must carry method + url.
 *
 * ## Motivation
 *
 * `Fastify({ loggerInstance })` turns on Fastify's own request logging, which
 * emits **two** lines per request (`incoming request` + `request completed`).
 * The app also registers its own `onResponse` hook logging `request completed`
 * — richer than Fastify's (it carries `reqId` from the AsyncLocalStorage
 * context and `duration_ms`). With both enabled every request costs three
 * lines, two of which say the same thing.
 *
 * That is not merely cosmetic. Health checks poll every 30s, so the duplicate
 * line is a standing tax on log volume — and worse, any analysis that pairs
 * `incoming request` with `request completed` is skewed by the extra line.
 *
 * So: Fastify's built-in request logging stays off, and the custom hook must
 * carry `method`/`url` — the two fields that would otherwise be lost with
 * `incoming request` gone. Dropping them would trade log volume for blindness
 * about which route was hit.
 *
 * This guard is textual on purpose: `src/index.ts` builds the app inside
 * `main()` against real credentials/SQLite and exports nothing, so there is no
 * seam to assert against at runtime without restructuring the entrypoint.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const INDEX_TS = path.resolve(__dirname, '../../src/index.ts');

/** Strip `//` line comments and `/* *\/` block comments so prose can't satisfy a check. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('static guard: single request log line', () => {
  const code = stripComments(fs.readFileSync(INDEX_TS, 'utf-8'));

  it('Fastify built-in request logging is disabled', () => {
    // Only meaningful while we hand Fastify our own pino instance; if that ever
    // goes away this guard should be revisited rather than silently kept.
    expect(code).toMatch(/loggerInstance\s*:/);
    expect(code).toMatch(/disableRequestLogging\s*:\s*true/);
  });

  it('the custom onResponse log carries method and url', () => {
    const hookStart = code.indexOf("addHook('onResponse'");
    expect(hookStart).toBeGreaterThan(-1);
    // Bound the slice to the hook body; 800 chars comfortably covers it and
    // keeps an unrelated `method:` elsewhere in the file from passing this.
    const hookBody = code.slice(hookStart, hookStart + 800);
    expect(hookBody).toMatch(/msg:\s*'request completed'/);
    expect(hookBody).toMatch(/method\s*:\s*request\.method/);
    expect(hookBody).toMatch(/url\s*:\s*request\.url/);
  });

  it('detects a regression in a synthetic sample', () => {
    // Scanner self-check: if the assertions above were vacuous (e.g. a bad
    // regex matching anything) this would pass on code that must fail.
    const bad = stripComments(
      [
        'const app = Fastify({',
        '  loggerInstance: logger,',
        '});',
        "app.addHook('onResponse', (_request, reply, done) => {",
        "  getLogger().info({ msg: 'request completed', statusCode: reply.statusCode });",
        '  done();',
        '});',
      ].join('\n'),
    );
    expect(bad).not.toMatch(/disableRequestLogging\s*:\s*true/);
    const hookBody = bad.slice(bad.indexOf("addHook('onResponse'"));
    expect(hookBody).not.toMatch(/method\s*:\s*request\.method/);
  });
});
