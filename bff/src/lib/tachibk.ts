// Reader for Mihon / Tachiyomi library backups (.tachibk, formerly .proto.gz) — gzipped protobuf.
//
// Read the manga title, Mihon's source id, its on-site URL, supported tracker identity/progress/privacy, and the
// numbers of the chapters marked read (#433). Uchiyomi resolves chapters against its own configured sources, so of a
// chapter only its read flag and number are kept; chapter history and categories are skipped. The
// source id is read too (not just skipped) so a title that came from an extension the user has installed
// can be matched against that SAME source first, instead of blind title search across everything — see
// `resolveCandidate` in routes/sources.ts. That lets us walk the wire format directly instead of taking a
// protobuf dependency, and makes the parser immune to schema changes — unknown fields are skipped
// generically by wire type.
//
// Schema (Tachiyomi/Mihon Backup; Suwayomi writes the same):
//   Backup.backupManga = 1 (repeated BackupManga)
//   BackupManga: source = 1 (int64/fixed64 varint-encoded), url = 2, title = 3, ..., chapters = 16, tracking = 18,
//                favorite = 100, history = 104
//   BackupChapter: url = 1, name = 2, read = 4 (bool), lastPageRead = 6, chapterNumber = 9 (float)
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
  if (wire === WIRE_I64 || wire === WIRE_I32) {
    const end = pos + (wire === WIRE_I64 ? 8 : 4);
    if (end > buf.length) throw new Error('truncated field');
    return end;
  }
  if (wire === WIRE_LEN) {
    const [len, p] = readVarint(buf, pos);
    if (!Number.isSafeInteger(len) || p + len > buf.length) throw new Error('truncated field');
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
  /**
   * The manga's extension-relative url in Mihon. Never a routable `source_series_id` here, but source id +
   * url IS Mihon's identity for a manga: `resolveCandidate` (routes/sources.ts) compares it, as a
   * normalised path, against each Suwayomi search hit's `path` to prove the same catalogue entry after a
   * retitle -- the `same_source` tier rests on this field and on nothing else.
   */
  url?: string;
  trackerLinks?: BackupTracker[];
  /**
   * The numbers of the chapters Mihon has marked read (#433), ascending, each once, at most READ_NUMBERS_MAX. As the
   * float32 the file holds (12.1 reads 12.100000381469727): the database compares them as `real`, the type every
   * chapter number here has, so they meet the listing's numbers exactly. Absent when none is.
   */
  readNumbers?: number[];
}

/** Most read chapters one entry keeps (#433): far past any series, and a bound on what one row can ask to mark. */
export const READ_NUMBERS_MAX = 5000;

export interface BackupTracker {
  provider: 'myanimelist' | 'anilist' | 'kitsu' | 'mangaupdates';
  externalId: string;
  title: string;
  progress: number;
  private: boolean;
}
const TRACKERS: Record<number, BackupTracker['provider']> = { 1: 'myanimelist', 2: 'anilist', 3: 'kitsu', 7: 'mangaupdates' };

/** Official BackupTracking schema. libraryId is account-specific and NEVER a manga identity. */
function trackingOf(sub: Buffer): BackupTracker | null {
  let pos = 0, sync = 0, legacy = 0n, modern = 0n, progress = 0, title = '', privateEntry = false;
  while (pos < sub.length) {
    const [key, at] = readVarint(sub, pos), field = key >>> 3, wire = key & 7;
    const end = skip(sub, at, wire);
    if (wire === WIRE_VARINT) {
      if (field === 1) sync = readVarint(sub, at)[0];
      else if (field === 3) legacy = readVarintBig(sub, at)[0];
      else if (field === 100) modern = readVarintBig(sub, at)[0];
      else if (field === 12) privateEntry = readVarint(sub, at)[0] !== 0;
    } else if (field === 5 && wire === WIRE_LEN) {
      const [len, start] = readVarint(sub, at);
      if (len > 4096) throw new Error('tracking title too long');
      title = sub.subarray(start, end).toString('utf8').trim().slice(0, 300);
    } else if (field === 6 && wire === WIRE_I32) progress = sub.readFloatLE(at);
    pos = end;
  }
  const id = legacy || modern; // same precedence as Mihon's getTrackImpl
  const provider = TRACKERS[sync];
  if (!provider || id <= 0n || id > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return { provider, externalId: id.toString(), title,
    progress: Number.isFinite(progress) ? Math.max(0, Math.min(2_147_483_647, Math.floor(progress))) : 0, private: privateEntry };
}

/**
 * One BackupChapter's number when Mihon has it marked read (#433), else null. Mihon writes no field that holds its
 * default, so a missing `read` (4) is unread and a missing `chapterNumber` (9) is chapter 0. A negative number is
 * Mihon's "not recognised" (-1), no chapter anything here can match. `lastPageRead` (6) is left alone: two sources'
 * copies of one chapter are paged differently, so a page there is no page here.
 */
function readNumberOf(sub: Buffer): number | null {
  let pos = 0, read = false, number = 0;
  while (pos < sub.length) {
    const [key, at] = readVarint(sub, pos), field = key >>> 3, wire = key & 7;
    const end = skip(sub, at, wire);
    if (field === 4 && wire === WIRE_VARINT) read = readVarint(sub, at)[0] !== 0;
    else if (field === 9 && wire === WIRE_I32) number = sub.readFloatLE(at);
    pos = end;
  }
  return read && Number.isFinite(number) && number >= 0 ? number : null;
}

/** Two entries' read numbers as one, in the order readNumbers promises. */
const readUnion = (a: number[] | undefined, b: number[]): number[] =>
  [...new Set([...(a ?? []), ...b])].slice(0, READ_NUMBERS_MAX).sort((x, y) => x - y);

/** Pull `source` (1), `url` (2), `title` (3), the read chapters (16) and the tracking (18) out of one serialized BackupManga message. */
function entryOfManga(sub: Buffer): BackupEntry | null {
  let pos = 0;
  let title: string | null = null;
  let url: string | undefined;
  let sourceIdUnsigned: string | undefined;
  let sourceIdSigned: string | undefined;
  const trackerLinks: BackupTracker[] = [];
  const readNumbers = new Set<number>();
  while (pos < sub.length) {
    const [key, p1] = readVarint(sub, pos);
    const field = key >>> 3;
    const wire = key & 7;
    const end = skip(sub, p1, wire);
    if (field === 1 && wire === WIRE_VARINT) {
      const [big, p2] = readVarintBig(sub, p1);
      sourceIdUnsigned = big.toString();
      sourceIdSigned = BigInt.asIntN(64, big).toString();
      pos = p2;
      continue;
    }
    if (field === 2 && wire === WIRE_LEN) {
      const [len, p2] = readVarint(sub, p1);
      if (len > 16384) throw new Error('url too long');
      url = sub.subarray(p2, p2 + len).toString('utf8');
      pos = p2 + len;
      continue;
    }
    if (field === 3 && wire === WIRE_LEN) {
      const [len, p2] = readVarint(sub, p1);
      if (len > 4096) throw new Error('title too long');
      title = sub.subarray(p2, p2 + len).toString('utf8');
      pos = p2 + len;
      continue;
    }
    if (field === 16 && wire === WIRE_LEN) {
      // Past the cap the rest are skipped, not refused: a long series must not fail the whole file.
      const [, start] = readVarint(sub, p1);
      const read = readNumberOf(sub.subarray(start, end));
      if (read !== null && readNumbers.size < READ_NUMBERS_MAX) readNumbers.add(read);
    }
    if (field === 18 && wire === WIRE_LEN) {
      const [, start] = readVarint(sub, p1);
      const tracker = trackingOf(sub.subarray(start, end));
      if (tracker && !trackerLinks.some(t => t.provider === tracker.provider && t.externalId === tracker.externalId)) {
        if (trackerLinks.length >= 16) throw new Error('too many trackers');
        trackerLinks.push(tracker);
      }
    }
    pos = end;
  }
  if (!title) return null;
  return { title, sourceIdUnsigned, sourceIdSigned, url, ...(trackerLinks.length ? { trackerLinks } : {}),
    ...(readNumbers.size ? { readNumbers: [...readNumbers].sort((a, b) => a - b) } : {}) };
}

/**
 * How far a gzipped upload may inflate before it is refused. A real Mihon backup is tens of MB raw (a
 * few thousand manga with their chapter lists and history); 256 MB is an order of magnitude above the
 * biggest seen. Without a cap the 12 MB body limit on the upload routes was no limit at all: gzip packs
 * runs of zeros ~1000:1, so a 9 MB body could ask for 9 GB of heap before the parser saw a byte. Admin-only
 * routes, so the uploader is the admin bombing their own server -- still one option to rule it out.
 */
export const MAX_INFLATED_BYTES = 256 * 1024 * 1024;

/**
 * Extract library entries (title + Mihon source id + url, trackers and read chapters) from a .tachibk / .proto.gz buffer
 * (plain protobuf also accepted). Titles are trimmed and de-duplicated case-insensitively, first occurrence wins (its
 * trackers and read chapters take in the later ones'), backup order preserved. Throws if the buffer isn't parseable as a backup, or inflates past
 * `maxInflatedBytes` (a parameter only so a test can prove the cap without a 256 MB fixture).
 */
export function entriesFromBackup(file: Buffer, maxInflatedBytes = MAX_INFLATED_BYTES): BackupEntry[] {
  // gzip magic — Mihon always gzips, but accept a raw protobuf too
  let buf = file;
  if (file.length > 2 && file[0] === 0x1f && file[1] === 0x8b) {
    try {
      buf = gunzipSync(file, { maxOutputLength: maxInflatedBytes });
    } catch (e) {
      // zlib's RangeError reads "Cannot create a Buffer larger than N bytes" -- a sentence about a Buffer,
      // shown to the admin as the parse failure. Say what was actually wrong with the file instead.
      if ((e as NodeJS.ErrnoException)?.code === 'ERR_BUFFER_TOO_LARGE') {
        throw new Error(`this file inflates to more than ${Math.round(maxInflatedBytes / (1024 * 1024))} MB, which no Mihon/Tachiyomi backup does`);
      }
      throw e;
    }
  }

  const entries: BackupEntry[] = [];
  const seen = new Map<string, number>();
  try {
    let pos = 0;
    while (pos < buf.length) {
      const [key, p1] = readVarint(buf, pos);
      const field = key >>> 3;
      const wire = key & 7;
      const end = skip(buf, p1, wire);
      if (field === 1 && wire === WIRE_LEN) {
        const [len, p2] = readVarint(buf, p1);
        const entry = entryOfManga(buf.subarray(p2, p2 + len));
        const clean = entry?.title?.trim();
        if (entry && clean) {
          const k = clean.toLowerCase();
          const previous = seen.get(k);
          if (previous === undefined) { seen.set(k, entries.length); entries.push({ ...entry, title: clean }); }
          else {
            if (entry.trackerLinks?.length) {
              const links = entries[previous].trackerLinks ?? [];
              for (const link of entry.trackerLinks) {
                const same = links.find(v => v.provider === link.provider && v.externalId === link.externalId);
                if (same) { same.progress = Math.max(same.progress, link.progress); same.private ||= link.private; }
                else { if (links.length >= 16) throw new Error('too many trackers'); links.push(link); }
              }
              entries[previous].trackerLinks = links;
            }
            // The same title twice -- a manga Mihon holds from two sources -- is one row here, and a chapter read on
            // either copy was read.
            if (entry.readNumbers?.length) entries[previous].readNumbers = readUnion(entries[previous].readNumbers, entry.readNumbers);
          }
        }
        pos = end;
      } else {
        pos = end;
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
