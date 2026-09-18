// Reader for Mihon / Tachiyomi library backups (.tachibk, formerly .proto.gz) — gzipped protobuf.
//
// We only need the manga title, Mihon's source id and its on-site url: Uchiyomi re-resolves each title
// against the user's own configured sources, so chapters, tracking and categories never matter here. The
// source id is read too (not just skipped) so a title that came from an extension the user has installed
// can be matched against that SAME source first, instead of blind title search across everything — see
// `resolveCandidate` in routes/sources.ts. That lets us walk the wire format directly instead of taking a
// protobuf dependency, and makes the parser immune to schema changes — unknown fields are skipped
// generically by wire type.
//
// Schema (Tachiyomi/Mihon Backup):
//   Backup.backupManga = 1 (repeated BackupManga)
//   BackupManga: source = 1 (int64/fixed64 varint-encoded), url = 2, title = 3, ..., favorite = 100
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

/**
 * Read a base-128 varint as a BigInt, exact to 64 bits. Mihon's source ids are the low bits of a hash and
 * routinely exceed 2^53, where `readVarint`'s float math silently loses precision — which would make a
 * source-id lookup match the wrong (or no) installed extension. Only used for BackupManga.source (field 1);
 * everything else still uses the cheaper float reader.
 */
function readVarintBig(buf: Buffer, pos: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  let byte: number;
  do {
    if (pos >= buf.length) throw new Error('truncated varint');
    byte = buf[pos++];
    result += BigInt(byte & 0x7f) << shift;
    shift += 7n;
    if (shift > 70n) throw new Error('varint too long');
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

/** One manga entry out of a Mihon/Tachiyomi backup, as much as Uchiyomi can use. */
export interface BackupEntry {
  title: string;
  /**
   * Mihon's 64-bit source id, decimal string. Two forms because a varint of an int64 (not sint64) carries the
   * raw two's-complement bit pattern, and whether the id prints as signed or unsigned depends on how the
   * source plugin computed its hash — callers should check a source registry against both.
   */
  sourceIdUnsigned?: string;
  sourceIdSigned?: string;
  /** The manga's on-site url in Mihon. Display/dedupe only — never a usable `source_series_id` here. */
  url?: string;
}

/** Pull `source` (1), `url` (2) and `title` (3) out of one serialized BackupManga message. */
function entryOfManga(sub: Buffer): BackupEntry | null {
  let pos = 0;
  let title: string | null = null;
  let url: string | undefined;
  let sourceIdUnsigned: string | undefined;
  let sourceIdSigned: string | undefined;
  while (pos < sub.length) {
    const [key, p1] = readVarint(sub, pos);
    const field = key >>> 3;
    const wire = key & 7;
    if (field === 1 && wire === WIRE_VARINT) {
      const [big, p2] = readVarintBig(sub, p1);
      sourceIdUnsigned = big.toString();
      sourceIdSigned = BigInt.asIntN(64, big).toString();
      pos = p2;
      continue;
    }
    if (field === 2 && wire === WIRE_LEN) {
      const [len, p2] = readVarint(sub, p1);
      url = sub.subarray(p2, p2 + len).toString('utf8');
      pos = p2 + len;
      continue;
    }
    if (field === 3 && wire === WIRE_LEN) {
      const [len, p2] = readVarint(sub, p1);
      title = sub.subarray(p2, p2 + len).toString('utf8');
      pos = p2 + len;
      continue;
    }
    pos = skip(sub, p1, wire);
  }
  if (!title) return null;
  return { title, sourceIdUnsigned, sourceIdSigned, url };
}

/**
 * Extract library entries (title + Mihon source id + url) from a .tachibk / .proto.gz buffer (plain
 * protobuf also accepted). Titles are trimmed and de-duplicated case-insensitively, first occurrence wins,
 * backup order preserved. Throws if the buffer isn't parseable as a backup.
 */
export function entriesFromBackup(file: Buffer): BackupEntry[] {
  // gzip magic — Mihon always gzips, but accept a raw protobuf too
  const buf = file.length > 2 && file[0] === 0x1f && file[1] === 0x8b ? gunzipSync(file) : file;

  const entries: BackupEntry[] = [];
  const seen = new Set<string>();
  try {
    let pos = 0;
    while (pos < buf.length) {
      const [key, p1] = readVarint(buf, pos);
      const field = key >>> 3;
      const wire = key & 7;
      if (field === 1 && wire === WIRE_LEN) {
        const [len, p2] = readVarint(buf, p1);
        const entry = entryOfManga(buf.subarray(p2, p2 + len));
        const clean = entry?.title?.trim();
        if (entry && clean) {
          const k = clean.toLowerCase();
          if (!seen.has(k)) { seen.add(k); entries.push({ ...entry, title: clean }); }
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
  if (!entries.length) throw new Error('no manga entries found — is this a Mihon/Tachiyomi backup?');
  return entries;
}

/** Titles only, for callers that never cared about the source id (kept for compatibility). */
export function titlesFromBackup(file: Buffer): string[] {
  return entriesFromBackup(file).map((e) => e.title);
}
