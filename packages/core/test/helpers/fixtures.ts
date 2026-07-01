/**
 * In-place test fixture generators.
 *
 * Per project convention we GENERATE binary / large fixtures in code rather than
 * checking them in or hunting for sample files — it keeps the repo light and the
 * inputs deterministic. Used by the converter unit tests (Claude→Kiro content
 * handling) and the live e2e suite (real upstream).
 */

/**
 * A minimal but structurally valid PDF (~a few hundred bytes).
 *
 * Enough to stand in for "Claude Code read a PDF and handed us a document block"
 * without shipping a binary fixture. The byte offsets in the xref table are not
 * exact — real readers tolerate this for a single-page stub, and our converter
 * never parses it (a `document` block has no upstream channel and is dropped).
 */
export function generateMinimalPdfBytes(): Buffer {
  const pdf = [
    '%PDF-1.4',
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj',
    'xref',
    '0 4',
    '0000000000 65535 f ',
    '0000000009 00000 n ',
    '0000000058 00000 n ',
    '0000000115 00000 n ',
    'trailer<</Size 4/Root 1 0 R>>',
    'startxref',
    '190',
    '%%EOF',
  ].join('\n');
  return Buffer.from(pdf, 'latin1');
}

/**
 * A large buffer of deterministic filler bytes (0x41 = 'A'), for "big file"
 * assertions — e.g. a large text file read via the Read tool that must flow
 * through the converter without truncation.
 */
export function generateLargeBuffer(sizeBytes: number): Buffer {
  return Buffer.alloc(sizeBytes, 0x41);
}
