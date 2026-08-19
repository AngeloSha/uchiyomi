// Reader for Mihon / Tachiyomi library backups (.tachibk, formerly .proto.gz) — gzipped protobuf.
//
// We only need the manga titles: Uchiyomi re-resolves each title against the user's own configured sources,
// so none of Mihon's source ids, chapters, tracking or categories matter here. That lets us walk the wire
// format directly instead of taking a protobuf dependency, and makes the parser immune to schema changes —
// unknown fields are skipped generically by wire type.
//
// Schema (Tachiyomi/Mihon Backup):
//   Backup.backupManga = 1 (repeated BackupManga)
//   BackupManga: source = 1, url = 2, title = 3, ..., favorite = 100
import { gunzipSync } from 'zlib';

const WIRE_VARINT = 0;
const WIRE_I64 = 1;
const WIRE_LEN = 2;
const WIRE_I32 = 5;

/** Read a base-128 varint. Uses float math for the high bits: we never need exact 64-bit values here. */
function readVarint(buf: Buffer, pos: number): [number, number] {
  let result = 0;
  let shift = 0;
  let byte: number;
  do {
    if (pos >= buf.length) throw new Error('truncated varint');
    byte = buf[pos++];
    result += (byte & 0x7f) * Math.pow(2, shift);
    shift += 7;
    if (shift > 70) throw new Error('varint too long');
  } while (byte & 0x80);
  return [result, pos];
}

/** Advance past one field's payload, given its wire type. Returns the new position. */
function skip(buf: Buffer, pos: number, wire: number): number {
  if (wire === WIRE_VARINT) return readVarint(buf, pos)[1];
  if (wire === WIRE_I64) return pos + 8;
  if (wire === WIRE_I32) return pos + 4;
  if (wire === WIRE_LEN) {
    const [len, p] = readVarint(buf, pos);
    return p + len;
  }
  throw new Error(`unsupported wire type ${wire}`);
}

/** Pull the `title` (field 3) out of one serialized BackupManga message. */
function titleOfManga(sub: Buffer): string | null {
  let pos = 0;
  while (pos < sub.length) {
    const [key, p1] = readVarint(sub, pos);
    const field = key >>> 3;
    const wire = key & 7;
    if (field === 3 && wire === WIRE_LEN) {
      const [len, p2] = readVarint(sub, p1);
      return sub.subarray(p2, p2 + len).toString('utf8');
    }
    pos = skip(sub, p1, wire);
  }
  return null;
}

/**
 * Extract the library's manga titles from a .tachibk / .proto.gz buffer (plain protobuf also accepted).
 * Titles are trimmed, de-duplicated case-insensitively, and returned in backup order.
 * Throws if the buffer isn't parseable as a backup.
 */
export function titlesFromBackup(file: Buffer): string[] {
  // gzip magic — Mihon always gzips, but accept a raw protobuf too
  const buf = file.length > 2 && file[0] === 0x1f && file[1] === 0x8b ? gunzipSync(file) : file;

  const titles: string[] = [];
  const seen = new Set<string>();
  try {
    let pos = 0;
    while (pos < buf.length) {
      const [key, p1] = readVarint(buf, pos);
      const field = key >>> 3;
      const wire = key & 7;
      if (field === 1 && wire === WIRE_LEN) {
        const [len, p2] = readVarint(buf, p1);
        const title = titleOfManga(buf.subarray(p2, p2 + len));
        const clean = title?.trim();
        if (clean) {
          const k = clean.toLowerCase();
          if (!seen.has(k)) { seen.add(k); titles.push(clean); }
        }
        pos = p2 + len;
      } else {
        pos = skip(buf, p1, wire);
      }
    }
  } catch {
    // malformed wire data — report it the same way as an empty/foreign file rather than leaking internals
    throw new Error('could not read this file as a Mihon/Tachiyomi backup');
  }
  if (!titles.length) throw new Error('no manga entries found — is this a Mihon/Tachiyomi backup?');
  return titles;
}
