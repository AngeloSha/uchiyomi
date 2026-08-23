// A cheap, content-derived identity for a chapter file, so a chapter can be recognised after it moves.
//
// Reading whole archives is not an option: a real library here is 40,000 books, which at typical sizes is
// most of a terabyte of I/O. Instead this reads only the archive's CENTRAL DIRECTORY -- the index at the end
// of a zip listing every entry's name, CRC-32 and uncompressed size. That costs one open and a small read,
// and the scanner already opens the first archive of every series anyway.
//
// The property that makes a CRC-based fingerprint worth having: **CRC-32 in a zip is computed over the
// UNCOMPRESSED bytes.** So the fingerprint survives the file being recompressed at a different level, or
// repacked by a different tool, and changes if any page's content changes or a page is added, removed or
// renamed. That is exactly the sensitivity "is this the same chapter" wants.
//
// Deliberately NOT a hash of the first N bytes: same cost, but the head of a CBZ is one local header plus
// the start of page one, so two chapters sharing a cover page would collide. The central directory sees
// every page.
import { readdir, stat, readFile } from 'fs/promises';
import { join } from 'path';
import { createHash } from 'crypto';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const StreamZip = require('node-stream-zip');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createExtractorFromFile } = require('node-unrar-js');

const IMG = /\.(jpe?g|png|webp|gif|avif)$/i;

export type FpKind = 'zip' | 'rar' | 'dir' | 'error';

export interface ChapterFingerprint {
  /** null whenever the file could not be read. NULL never equal-joins, so it can never match anything. */
  fingerprint: string | null;
  kind: FpKind;
  /** Bytes on disk, or the sum for a loose-image folder. A free pre-filter and a health signal. */
  size: number | null;
}

/** One entry's contribution. The NUL separators stop `a` + `bc` colliding with `ab` + `c`. */
const line = (name: string, crc: number, size: number) => `${name}\0${crc >>> 0}\0${size}`;

function digest(lines: string[]): string | null {
  if (!lines.length) return null; // an archive with no entries identifies nothing
  const h = createHash('sha1');
  // sorted, so entry order in the container cannot change the answer
  for (const l of lines.sort()) h.update(l + '\n');
  return h.digest('hex');
}

function kindOf(path: string): 'zip' | 'rar' | 'dir' | 'pdf' {
  // An EPUB is a zip, and its entry table fingerprints exactly as well as a CBZ's does.
  if (/\.(cbz|zip|epub)$/i.test(path)) return 'zip';
  if (/\.(cbr|rar)$/i.test(path)) return 'rar';
  // A PDF has no entry table to hash, so it is identified by its own bytes instead.
  if (/\.pdf$/i.test(path)) return 'pdf';
  return 'dir';
}

async function zipLines(abs: string): Promise<string[]> {
  const zip = new StreamZip.async({ file: abs });
  try {
    const entries = await zip.entries();
    const out: string[] = [];
    for (const name of Object.keys(entries)) {
      const e = entries[name];
      if (e.isDirectory) continue;
      out.push(line(e.name, Number(e.crc ?? 0), Number(e.size ?? 0)));
    }
    return out;
  } finally {
    await zip.close().catch(() => {});
  }
}

async function rarLines(abs: string): Promise<string[]> {
  // createExtractorFromFile seeks rather than loading the whole archive, unlike the reader path elsewhere.
  const ex = await createExtractorFromFile({ filepath: abs });
  const out: string[] = [];
  for (const h of ex.getFileList().fileHeaders) {
    if (h.flags?.directory) continue;
    out.push(line(h.name, Number(h.crc ?? 0), Number(h.unpSize ?? 0)));
  }
  return out;
}

async function dirLines(abs: string): Promise<{ lines: string[]; size: number }> {
  // No CRCs available for loose images, so this is (name, size) only — weaker, and knowingly so.
  const names = (await readdir(abs)).filter((n) => IMG.test(n));
  const lines: string[] = [];
  let size = 0;
  for (const n of names) {
    const st = await stat(join(abs, n)).catch(() => null);
    if (!st) continue;
    size += st.size;
    lines.push(line(n, 0, st.size));
  }
  return { lines, size };
}

/**
 * Fingerprint one chapter. Never throws: an unreadable or corrupt file returns a null fingerprint with kind
 * 'error', because the caller records the attempt either way and a file it cannot read must not stop a scan.
 */
export async function fingerprintChapter(abs: string): Promise<ChapterFingerprint> {
  const kind = kindOf(abs);
  try {
    if (kind === 'dir') {
      const { lines, size } = await dirLines(abs);
      const fp = digest(lines);
      return fp ? { fingerprint: fp, kind, size } : { fingerprint: null, kind: 'error', size };
    }
    const size = await stat(abs).then((s) => s.size).catch(() => null);
    if (kind === 'pdf') {
      // Whole-file hash. Stronger than the entry-list digest, not weaker: two PDFs collide only if they are
      // byte-identical, which is exactly what a duplicate chapter is.
      const fp = createHash('sha1').update(await readFile(abs)).digest('hex');
      return { fingerprint: fp, kind: 'zip', size };
    }
    const lines = kind === 'zip' ? await zipLines(abs) : await rarLines(abs);
    const fp = digest(lines);
    return fp ? { fingerprint: fp, kind, size } : { fingerprint: null, kind: 'error', size };
  } catch {
    const size = await stat(abs).then((s) => s.size).catch(() => null);
    return { fingerprint: null, kind: 'error', size };
  }
}
