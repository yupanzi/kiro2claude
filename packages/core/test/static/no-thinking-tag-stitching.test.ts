/**
 * Static guard: the converter never stitches history thinking into `<thinking>` text.
 *
 * ## Motivation
 *
 * The wire has a native slot for a client's previous-turn thinking —
 * `assistantResponseMessage.reasoningContent = {reasoningText:{text,signature}} |
 * {redactedContent}` — and upstream validates the signature (missing / corrupted →
 * 400 THINKING_SIGNATURE_INVALID). Tag-stitched `<thinking>…</thinking>` text is just
 * prose to the model and diverges from the real client's shape, so it must not exist
 * even as a "fallback" for unsigned blocks: those are dropped (see
 * `convertAssistantMessage`).
 *
 * ## What this guard sees
 *
 * Textual and cheap: any `<thinking>` open/close tag in converter *code* (comments
 * stripped). The converter also emits no thinking-control prefix (non-native
 * models get upstream defaults), so both tag families are pinned absent. Behavioral pins live in
 * `converter-reasoning-content.test.ts` and `conversation-content-integrity.test.ts`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SRC_ROOT, stripComments, walkTsFiles } from '../helpers/static-scan.js';

/** converter.ts 及其拆分目录:assistant 消息转换将来搬进 `claude/converter/` 也在扫描范围内。 */
const converterFiles = [
  path.join(SRC_ROOT, 'claude/converter.ts'),
  ...walkTsFiles(path.join(SRC_ROOT, 'claude/converter')),
];
const converterCode = () =>
  converterFiles.map((f) => stripComments(fs.readFileSync(f, 'utf-8'))).join('\n');

describe('static: converter does not stitch thinking into <thinking> text', () => {
  it('converter code contains no `<thinking>` open/close tag literal', () => {
    const hits = converterCode().match(/<\/?thinking>/g) ?? [];
    expect(hits, `found ${hits.length} <thinking> tag literal(s) in converter code`).toEqual([]);
  });

  it('converter code emits no <thinking_mode> control prefix either', () => {
    const code = converterCode();
    expect(code).not.toContain('<thinking_mode>');
    expect(code).not.toContain('<max_thinking_length>');
  });

  it('the scanner is not vacuous: the native reasoningContent slot is assigned in converter code', () => {
    // 正向断言:机制真的还在这里。若 assistant 转换搬到别处而漏掉本守卫的扫描范围,这条先红。
    expect(converterCode()).toMatch(/\.reasoningContent = reasoningContent/);
  });
});
