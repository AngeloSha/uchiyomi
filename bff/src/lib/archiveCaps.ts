// How much one file in the library may make the server hold in memory, and how a chapter folder's pages are read.
//
// The readers used to inflate a whole archive entry with node-stream-zip's entryData(), which pushes every chunk to
// an array and checks the size only after the last one. A 1.4 MB CBZ whose one entry inflates ~1,000x was therefore
// read whole and the process was OOM-killed -- and the page-hash backfill opens every unmarked chapter five minutes
// after each boot, so one planted file was a crash loop. Every entry is now streamed with a byte count and refused
// past a cap before the buffer exists.
//
// Loose-image chapter folders were listed with a bare readdir and read with readFile, both of which follow a
// symlink: an entry named 002.jpg pointing outside the library was served as a page. Only regular files count now,
// as the scan already counts them (library.ts listDir).
import { lstat, open, readdir } from 'fs/promises';
import { constants } from 'fs';
import { join } from 'path';

/**
 * The largest page an archive entry or a chapter folder may hold, decoded. Far above a real page -- a very long
 * webtoon strip is a few tens of MB -- and far below what it takes to exhaust a small host.
 */
export const MAX_PAGE_BYTES = 64 * 1024 * 1024;
/** ComicInfo.xml, an EPUB's container, package and chapter documents, a partial chapter's manifest. */
export const MAX_META_BYTES = 4 * 1024 * 1024;

/** An entry or file over its cap. Callers treat it like a broken page: refused, never partly served. */
export class EntryTooLarge extends Error {
  constructor(public entry: string) {
    super(`archive entry too large: ${entry}`);
  }
}

/**
 * One zip entry, inflated, refused as soon as it passes `cap`. The declared size is checked first (cheap, and the
 * common case for a bomb), and the stream is counted as it inflates because the declared size is the archive's own
 * claim. Reintroduce by going back to zip.entryData(): archiveCaps.test.ts reads the 150 MiB entry whole.
 */
export async function zipEntryCapped(zip: any, name: string, cap = MAX_PAGE_BYTES): Promise<Buffer> {
  const entry = await zip.entry(name);
  if (!entry) throw new Error(`zip entry not found: ${name}`);
  if (Number(entry.size) > cap) throw new EntryTooLarge(name);
  const stream: NodeJS.ReadableStream & { destroy?: () => void } = await zip.stream(name);
  const chunks: Buffer[] = [];
  let n = 0;
  try {
    for await (const c of stream as AsyncIterable<Buffer>) {
      n += c.length;
      if (n > cap) throw new EntryTooLarge(name);
      chunks.push(c);
    }
  } finally {
    stream.destroy?.();
  }
  return Buffer.concat(chunks, n);
}

/**
 * The names of the regular files in a chapter folder that pass `keep`, sorted by `cmp`. A symlink, a directory or
 * anything else is not a page, whatever its name.
 */
export async function regularFiles(dir: string, keep: (name: string) => boolean, cmp?: (a: string, b: string) => number): Promise<string[]> {
  const ents = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return ents.filter((e) => e.isFile() && keep(e.name)).map((e) => e.name).sort(cmp);
}

/** O_NOFOLLOW where the platform has it (not Windows): the final component may not be a symlink at open time. */
const NOFOLLOW = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;

/**
 * A file inside a chapter folder, read only if it is a regular file (not a symlink) within `cap`. Checked with lstat
 * and opened without following a final symlink, so a page name cannot read anything outside the folder.
 */
export async function readRegularFile(dir: string, name: string, cap = MAX_PAGE_BYTES): Promise<Buffer> {
  if (!name || name.includes('/') || name.includes('\\') || name === '.' || name === '..') throw new Error(`not a page name: ${name}`);
  const path = join(dir, name);
  const st = await lstat(path);
  if (!st.isFile()) throw new Error(`not a regular file: ${name}`);
  if (st.size > cap) throw new EntryTooLarge(name);
  const fh = await open(path, constants.O_RDONLY | NOFOLLOW);
  try {
    const again = await fh.stat();
    if (!again.isFile() || again.size > cap) throw new EntryTooLarge(name);
    const buf = Buffer.alloc(again.size);
    let off = 0;
    while (off < buf.length) {
      const { bytesRead } = await fh.read(buf, off, buf.length - off, off);
      if (!bytesRead) break;
      off += bytesRead;
    }
    return off === buf.length ? buf : buf.subarray(0, off);
  } finally {
    await fh.close();
  }
}

/** The most bytes the RAR reader will extract for one entry, judged on the header before anything is extracted. */
export function rarEntryAllowed(header: { unpSize?: number | bigint } | undefined, cap = MAX_PAGE_BYTES): boolean {
  const n = Number(header?.unpSize ?? 0);
  return Number.isFinite(n) && n >= 0 && n <= cap;
}
