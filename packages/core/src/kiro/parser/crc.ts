/**
 * CRC32 checksum implementation.
 *
 * AWS Event Stream uses CRC32 (ISO-HDLC / Ethernet / ZIP standard).
 * We use the `crc-32` npm package which implements the same polynomial (0xEDB88320).
 */

import CRC32 from 'crc-32';

/**
 * Compute CRC32 checksum (ISO-HDLC standard).
 *
 * @param data - The data to checksum
 * @returns Unsigned 32-bit CRC32 value
 */
export function crc32(data: Buffer | Uint8Array): number {
  // CRC32.buf() returns a signed 32-bit integer; convert to unsigned with >>> 0
  return CRC32.buf(data as Uint8Array) >>> 0;
}
