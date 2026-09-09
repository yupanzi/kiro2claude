/**
 * Self-contained deterministic OCR fixture: six digits in a large 5×7 bitmap font,
 * 720×200 RGB PNG. Shared by the live image probes (`opus5-effort-matrix.mjs`,
 * `multi-image-attribution-probe.mjs`) so every probe reads the same glyphs.
 */
import { deflateSync } from 'node:zlib';

export function markerPng(marker) {
  const glyphs = [
    '01110100011001110101110011000101110',
    '00100011000010000100001000010001110',
    '01110100010000100010001000100011111',
    '11110000010000101110000010000111110',
    '00010001100101010010111110001000010',
    '11111100001000011110000010000111110',
    '01110100001000011110100011000101110',
    '11111000010001000100010000100001000',
    '01110100011000101110100011000101110',
    '01110100011000101111000010000101110',
  ];
  const scale = 18,
    width = 720,
    height = 200;
  const raw = Buffer.alloc((width * 3 + 1) * height, 255);
  for (let y = 0; y < height; y++) raw[y * (width * 3 + 1)] = 0;
  for (let d = 0; d < marker.length; d++)
    for (let gy = 0; gy < 7; gy++)
      for (let gx = 0; gx < 5; gx++)
        if (glyphs[Number(marker[d])][gy * 5 + gx] === '1') {
          for (let yy = 0; yy < scale; yy++)
            for (let xx = 0; xx < scale; xx++) {
              const at =
                (35 + gy * scale + yy) * (width * 3 + 1) +
                1 +
                (45 + d * 6 * scale + gx * scale + xx) * 3;
              raw.fill(0, at, at + 3);
            }
        }
  function chunk(type, data) {
    const label = Buffer.from(type),
      joined = Buffer.concat([label, data]);
    let crc = 0xffffffff;
    for (const byte of joined) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    const out = Buffer.alloc(data.length + 12);
    out.writeUInt32BE(data.length);
    label.copy(out, 4);
    data.copy(out, 8);
    out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4);
    return out;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
