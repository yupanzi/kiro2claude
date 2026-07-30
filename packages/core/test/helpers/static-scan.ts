/**
 * Shared scaffolding for `test/static/` guards that scan the source tree
 * textually. Extracted so a fix to comment-stripping or the file walk lands in
 * one place instead of the per-guard copies. Other static guards still inline
 * their own copies — migrate them here opportunistically.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to `packages/core/src`. */
export const SRC_ROOT = path.resolve(__dirname, '../../src');

/** Every `.ts` file under `dir`, recursively. */
export function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTsFiles(p));
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** Strip `//` line comments and block comments so prose can't trip a scan. */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
