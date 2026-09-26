// Owned library scanner: reads the CBZ folder Suwayomi writes (replacing Komga's library role).
// Layout: <root>/<source>/<series title>/<chapter>.cbz ; each cbz carries ComicInfo.xml + page images.
import { readdir, stat, lstat, readFile, realpath } from 'fs/promises';
import { join } from 'path';
import sharp from 'sharp';
import { q, one, tx } from './db';
import { newSeriesId, newBookId } from './ids';
import { env } from '../env';
import { fingerprintChapter } from './fingerprint';
import { findRematch, applyRematch, logRematch, MIN_BOOKS } from './rematch';
import { numFromName, naturalCmp } from './naming';
import { parseComicInfoAgeRating } from './ageRating';
import { directionFromComicInfo } from './directionSignals';
import { reconcileListingProgress } from './listingProgress';

// node-stream-zip reads the central directory only (cheap) and can stream a single entry.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const StreamZip = require('node-stream-zip');
// node-unrar-js: pure-wasm RAR reader (no native build) for .cbr comic archives.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createExtractorFromData } = require('node-unrar-js');
// PDF and image-EPUB chapters. Both live in their own modules: EPUB is a zip and reuses this file's zip
// reader, needing only its own page ORDER, while PDF is genuinely different and reads nothing from here.
import { pdfPages, pdfPageBytes, pdfPageCount, pdfPageDims, pdfPageIndex, pdfPageName } from './readers/pdf';
import { epubPages } from './readers/epub';

export const LIBRARY_ROOT = process.env.LIBRARY_ROOT || '/library';
const IMG = /\.(jpe?g|png|webp|gif|avif)$/i;

export interface ScanBook {
  id: string;
  seriesId: string;
  file: string; // path relative to LIBRARY_ROOT
  number: number;
  title: string;
  pages: number;
}
export interface ScanSeries {
  id: string;
  source: string;
  title: string;
  summary: string | null;
  author: string | null;
  status: string | null;
  genres: string[];
  web: string | null;
  folder: string; // relative
  books: ScanBook[];
}

/**
 * The C0 control characters XML 1.0 forbids (everything below 0x20 but tab, newline and return).
 *
 * ⚠️ NUL is the one that matters: Postgres refuses it in any text value, so a ComicInfo field carrying one
 * made the scan's INSERT throw -- and before the scan isolated its folders (#109) that one throw ended the
 * whole pass, silently, leaving every folder after it unindexed. A source whose description held a `\u0000`
 * was enough, because the downloader copied it into the file (`comicInfo` in downloader.ts strips them too).
 */
// eslint-disable-next-line no-control-regex
export const XML_FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

function field(xml: string, tag: string): string | null {
  // allow an optional XML namespace prefix, e.g. <ty:PublishingStatusTachiyomi>
  const m = xml.match(new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${tag}>`, 'i'));
  return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, '').replace(XML_FORBIDDEN, '').trim() : null;
}
// Some source pages leak an inline <style>/<script> block into the summary. Detect CSS/JS so a garbage
// ComicInfo can never become a series description (a lone stray brace in real prose is fine).
export function looksLikeCss(s: string): boolean {
  return s.length > 2500 || /<\/?(?:style|script)\b|\.[a-z][\w-]*\s*[{,]|@import|gtag\(|wp-manga|woocommerce|settings-page|datalayer|sourceurl/i.test(s);
}
function cleanSummary(s: string | null): string | null {
  return s && !looksLikeCss(s) ? s : null;
}
function cleanStatus(s: string | null): string | null {
  return s && !looksLikeCss(s) && s.length < 60 ? s : null; // a real status is one short word
}
// numFromName / naturalCmp live in ./naming (dependency-free so they're unit-testable)

// A "chapter" can be a CBZ (zip), a CBR (rar), or a loose folder of images. These helpers read all three so
// the scanner + page server are format-agnostic. (The downloader still WRITES CBZ; this is read-side only.)
type ChapterKind = 'zip' | 'rar' | 'dir' | 'pdf' | 'epub';
function chapterKind(path: string): ChapterKind {
  if (/\.(cbz|zip)$/i.test(path)) return 'zip';
  if (/\.(cbr|rar)$/i.test(path)) return 'rar';
  if (/\.pdf$/i.test(path)) return 'pdf';
  // An EPUB is a zip, but its pages come in spine order rather than filename order, so it is its own kind.
  if (/\.epub$/i.test(path)) return 'epub';
  return 'dir';
}

const ARCHIVE = /\.(cbz|cbr|zip|rar|pdf|epub)$/i;

/**
 * The filesystem calls the scan makes, as a parameter.
 *
 * The failures #109 turned on happen on Unraid's user shares, network mounts and FUSE layers, and cannot be
 * made on a test machine's own disk: two different folders reporting one disk id, a listing that fails because
 * one entry in it cannot be checked. The tests hand in a filesystem that does exactly that.
 */
export interface WalkFs {
  /** Exact ids: `{ bigint: true }`. A JavaScript number rounds an id above 2^53 onto its neighbours. */
  stat(p: string): Promise<{ dev: bigint | number; ino: bigint | number }>;
  readdirTyped(p: string): Promise<Array<{ name: string; isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }>>;
  readdirNames(p: string): Promise<string[]>;
  lstat(p: string): Promise<{ isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }>;
}
export const nodeFs: WalkFs = {
  stat: (p) => stat(p, { bigint: true }),
  readdirTyped: (p) => readdir(p, { withFileTypes: true }),
  readdirNames: (p) => readdir(p),
  lstat: (p) => lstat(p),
};

export type EntryKind = 'file' | 'dir' | 'link' | 'other';
export interface Listing {
  entries: Array<{ name: string; kind: EntryKind }>;
  /** The folder itself could not be read (an errno code), so it lists nothing. */
  error?: string;
  /** Listed, but the entry could not be checked, so nobody can say whether it is a chapter or a series. */
  unchecked?: string[];
}
const kindOf = (e: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): EntryKind =>
  e.isFile() ? 'file' : e.isDirectory() ? 'dir' : e.isSymbolicLink() ? 'link' : 'other';
export const errCode = (e: unknown): string =>
  (e as NodeJS.ErrnoException)?.code || String((e as Error)?.message || e).slice(0, 160);

/**
 * One folder's entries, and never all-or-nothing (#109).
 *
 * ⚠️ `readdir(..., { withFileTypes: true })` is all-or-nothing on a filesystem that does not report entry types
 * (many FUSE and network mounts): Node then `lstat`s every entry itself, and the FIRST one that fails rejects
 * the whole listing -- a name that is not valid UTF-8 (Node can never open it), a file renamed away mid-scan.
 * Every caller caught that as "empty", so one bad entry hid every series in its folder, on every scan, and
 * nothing said so. Here a failed typed listing falls back to the names and checks each entry on its own: one
 * bad entry costs itself, and is named. An entry that vanished (ENOENT, with a readable name) was a temporary
 * file being renamed into place, and is not a finding.
 * Reintroduce by returning `[]` from the catch: "a listing that fails on one entry still lists the rest" in
 * scanWalk.test.ts finds the series missing.
 */
export async function listDir(abs: string, fsx: WalkFs = nodeFs): Promise<Listing> {
  try {
    return { entries: (await fsx.readdirTyped(abs)).map((e) => ({ name: e.name, kind: kindOf(e) })) };
  } catch {
    // fall through: the folder may be unreadable, or one entry may be
  }
  let names: string[];
  try {
    names = await fsx.readdirNames(abs);
  } catch (e) {
    return { entries: [], error: errCode(e) };
  }
  const entries: Listing['entries'] = [];
  const unchecked: string[] = [];
  for (const name of names) {
    try {
      entries.push({ name, kind: kindOf(await fsx.lstat(join(abs, name))) });
    } catch (e) {
      if (errCode(e) === 'ENOENT' && !name.includes('�')) continue;
      unchecked.push(name);
    }
  }
  return unchecked.length ? { entries, unchecked } : { entries };
}

/**
 * Is this subfolder a chapter made of loose images -- as opposed to a SERIES that happens to hold a cover?
 *
 * ⚠️ "CONTAINS AN IMAGE" IS NOT ENOUGH, AND THAT ONE TEST EMPTIED WHOLE LIBRARIES. Tranga, Komga, Kavita and
 * Mihon's local source all write a `cover.jpg` (or a thumbnail named after the series) INTO each series
 * folder, next to its chapters. Judged by "has an image", every one of those series folders reads as a
 * chapter of its parent -- so the library root looked like a series with 38 chapters, `findSeriesDirs`
 * declined to descend into it, and a scan of 5,536 chapters reported `{series: 0}` in four seconds with no
 * error anywhere. Reported with the diagnosis in #34 by @ThomasRunting.
 *
 * A folder that holds archives, or holds image-bearing subfolders, is a series: its chapters are INSIDE it.
 * Only a folder whose images are the whole of its contents is itself a chapter. The one layout this changes
 * is a chapter folder with a nested image subfolder (`Ch 1/extras/`), which now reads as a tiny series with
 * one chapter instead of a chapter that silently ignores its extras -- a rarer shape, and the new reading
 * at least shows everything.
 * Reintroduce by going back to `.some((n) => IMG.test(n))`: the Tranga fixture in scanLayouts.int.test.ts
 * scans to zero series again.
 */
async function isImageChapterDir(abs: string, fsx: WalkFs = nodeFs): Promise<boolean> {
  const { entries } = await listDir(abs, fsx);
  let images = 0;
  for (const e of entries) {
    if (e.kind === 'file') {
      if (ARCHIVE.test(e.name)) return false;
      if (IMG.test(e.name)) images++;
    } else if (e.kind === 'dir' && !SKIP_DIR.test(e.name)) {
      const inner = await fsx.readdirNames(join(abs, e.name)).catch(() => [] as string[]);
      if (inner.some((n) => IMG.test(n) || ARCHIVE.test(n))) return false;
    }
  }
  return images > 0;
}

/** Chapter entries in a series folder: cbz/cbr/zip/rar/pdf files, image EPUBs, + subfolders of images. */
export async function listChapters(folderAbs: string, opts: {
  fsx?: WalkFs;
  /** The folder's listing, when the caller has already read it. */
  listing?: Listing;
} = {}): Promise<string[]> {
  const fsx = opts.fsx ?? nodeFs;
  const out: string[] = [];
  for (const e of (opts.listing ?? await listDir(folderAbs, fsx)).entries) {
    if (e.kind === 'file' && /\.(cbz|cbr|zip|rar|pdf)$/i.test(e.name)) out.push(e.name);
    // An EPUB counts only if it actually holds pages. A reflowable novel has none, so it is skipped here
    // rather than becoming a chapter that opens to nothing -- which is what "skips ebooks" really meant.
    // (A damaged one reads as none too: epubPages catches its own errors.)
    else if (e.kind === 'file' && /\.epub$/i.test(e.name)) {
      if ((await epubPages(join(folderAbs, e.name))).length) out.push(e.name);
    }
    else if (e.kind === 'dir' && !SKIP_DIR.test(e.name) && (await isImageChapterDir(join(folderAbs, e.name), fsx))) out.push(e.name);
  }
  return out.sort(naturalCmp);
}

// ---- RAR (.cbr) via node-unrar-js (wasm; reads a whole archive from memory) ----
async function rarExtractor(path: string): Promise<any> {
  const buf = await readFile(path);
  const data = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return createExtractorFromData({ data });
}
async function rarHeaders(ex: any): Promise<any[]> {
  return [...ex.getFileList().fileHeaders].filter((h: any) => !h.flags?.directory);
}
async function rarExtract(ex: any, name: string): Promise<Buffer> {
  const files = [...ex.extract({ files: [name] }).files];
  const f = files.find((x: any) => x.fileHeader?.name === name) || files[0];
  if (!f?.extraction) throw new Error('rar entry not found');
  return Buffer.from(f.extraction);
}

/** Open one chapter (CBZ/CBR/folder); return its ComicInfo.xml (if any) + image page count. */
async function readArchive(path: string): Promise<{ xml: string; pages: number }> {
  const k = chapterKind(path);
  // Neither format carries ComicInfo.xml; an EPUB has its own metadata and a PDF has none worth trusting.
  if (k === 'pdf') return { xml: '', pages: await pdfPageCount(path) };
  if (k === 'epub') return { xml: '', pages: (await epubPages(path)).length };
  if (k === 'dir') {
    const names = await readdir(path).catch(() => []);
    const xmlName = names.find((n) => /comicinfo\.xml$/i.test(n));
    const xml = xmlName ? await readFile(join(path, xmlName), 'utf8').catch(() => '') : '';
    return { xml, pages: names.filter((n) => IMG.test(n)).length };
  }
  if (k === 'rar') {
    const ex = await rarExtractor(path);
    const headers = await rarHeaders(ex);
    const xmlH = headers.find((h) => /comicinfo\.xml$/i.test(h.name));
    let xml = '';
    if (xmlH) { try { xml = (await rarExtract(ex, xmlH.name)).toString('utf8'); } catch {} }
    return { xml, pages: headers.filter((h) => IMG.test(h.name)).length };
  }
  const zip = new StreamZip.async({ file: path });
  try {
    const entries = await zip.entries();
    let pages = 0, xml = '';
    for (const name of Object.keys(entries)) {
      if (entries[name].isDirectory) continue;
      if (IMG.test(name)) pages++;
      else if (/comicinfo\.xml$/i.test(name)) xml = (await zip.entryData(name)).toString('utf8');
    }
    return { xml, pages };
  } finally {
    await zip.close();
  }
}

/** Sorted image page names inside a chapter (CBZ/CBR/folder) — used by the page server. */
export async function cbzPages(path: string): Promise<string[]> {
  const k = chapterKind(path);
  if (k === 'pdf') return pdfPages(path);
  if (k === 'epub') return epubPages(path);   // already in spine order; do NOT re-sort
  if (k === 'dir') return (await readdir(path).catch(() => [])).filter((n) => IMG.test(n)).sort(naturalCmp);
  if (k === 'rar') return (await rarHeaders(await rarExtractor(path))).map((h) => h.name).filter((n) => IMG.test(n)).sort(naturalCmp);
  const zip = new StreamZip.async({ file: path });
  try {
    const entries = await zip.entries();
    return Object.keys(entries).filter((n) => !entries[n].isDirectory && IMG.test(n)).sort(naturalCmp);
  } finally {
    await zip.close();
  }
}

/** Raw bytes of a single page (CBZ/CBR/folder) — used by the page server. */
export async function cbzEntry(path: string, name: string): Promise<Buffer> {
  const k = chapterKind(path);
  if (k === 'pdf') return pdfPageBytes(path, pdfPageIndex(name));
  if (k === 'dir') return readFile(join(path, name));
  if (k === 'rar') return rarExtract(await rarExtractor(path), name);
  const zip = new StreamZip.async({ file: path });
  try {
    return await zip.entryData(name);
  } finally {
    await zip.close();
  }
}

/**
 * One page, by index, opening the archive exactly once.
 *
 * Every caller wanted a page AND the page count, and got them by calling cbzPages() then cbzEntry() -- two
 * independent opens of the same file. On the chapter-thumbnail route that is two opens per tile, and a series
 * page fires hundreds of those at a library that mostly lives on a spinning disk.
 *
 * Returns null when the index is out of range, so callers keep their own 404 wording.
 */
export async function cbzPageAt(
  path: string,
  index: number,
): Promise<{ name: string; bytes: Buffer; total: number } | null> {
  const k = chapterKind(path);
  if (k === 'pdf') {
    const total = await pdfPageCount(path);
    if (index < 0 || index >= total) return null;
    return { name: pdfPageName(index), bytes: await pdfPageBytes(path, index), total };
  }
  if (k === 'epub') {
    // Spine order, so this cannot go through the zip branch below and its filename sort.
    const names = await epubPages(path);
    const name = names[index];
    if (!name) return null;
    const zip = new StreamZip.async({ file: path });
    try { return { name, bytes: await zip.entryData(name), total: names.length }; }
    finally { await zip.close(); }
  }
  if (k === 'dir') {
    const names = (await readdir(path).catch(() => [])).filter((n) => IMG.test(n)).sort(naturalCmp);
    const name = names[index];
    return name ? { name, bytes: await readFile(join(path, name)), total: names.length } : null;
  }
  if (k === 'rar') {
    const ex = await rarExtractor(path); // one extractor for both the listing and the read
    const names = (await rarHeaders(ex)).map((h) => h.name).filter((n) => IMG.test(n)).sort(naturalCmp);
    const name = names[index];
    return name ? { name, bytes: await rarExtract(ex, name), total: names.length } : null;
  }
  const zip = new StreamZip.async({ file: path });
  try {
    const entries = await zip.entries();
    const names = Object.keys(entries).filter((n) => !entries[n].isDirectory && IMG.test(n)).sort(naturalCmp);
    const name = names[index];
    return name ? { name, bytes: await zip.entryData(name), total: names.length } : null;
  } finally {
    await zip.close();
  }
}

/** Real pixel dimensions of every page (CBZ/CBR/folder). The reader needs these to reserve the right height
 *  per page — without them, tall webtoon pages overlap. Cached in lib_books.page_dims after first read. */
export async function cbzPageDims(path: string): Promise<Array<{ name: string; width: number | null; height: number | null }>> {
  const out: Array<{ name: string; width: number | null; height: number | null }> = [];
  const dim = async (name: string, bytes: Buffer) => {
    try { const m = await sharp(bytes).metadata(); out.push({ name, width: m.width ?? null, height: m.height ?? null }); }
    catch { out.push({ name, width: null, height: null }); }
  };
  const kind = chapterKind(path);
  // Measured from the page box rather than by rendering: this runs over every page of a chapter, and
  // rasterising a whole volume to find out how tall it is would be absurd.
  if (kind === 'pdf') return pdfPageDims(path);
  if (kind === 'zip') {
    // CBZ fast path: open the archive once for all pages
    const zip = new StreamZip.async({ file: path });
    try {
      const entries = await zip.entries();
      for (const name of Object.keys(entries).filter((n) => !entries[n].isDirectory && IMG.test(n)).sort(naturalCmp)) await dim(name, await zip.entryData(name));
    } finally { await zip.close(); }
    return out;
  }
  for (const name of await cbzPages(path)) await dim(name, await cbzEntry(path, name));
  return out;
}

// Owned download dir (writable; separate from Suwayomi's read library so permissions stay clean).
export const DL_ROOT = process.env.DL_ROOT || '/library-dl';

/**
 * Scan all library roots (Suwayomi's existing dir + the owned download dir) and upsert into lib_series/
 * lib_books. Each book records the root it lives in so the image server can resolve it. Page counts fill
 * lazily on first read. books_count + latest_mtime are recomputed across roots at the end.
 */
// How deep below a root we walk. Two levels is what shipped, and is what every existing lib_series.folder
// was minted from, so the walk has to reach at least that far. Six covers the layouts people actually have
// (Comics/Manga/Author/Series is four) without turning a LIBRARY_PATH accidentally pointed at / into an
// all-night crawl. Set LIBRARY_MAX_DEPTH=2 to reproduce the old behaviour exactly.
const MAX_DEPTH = Number(process.env.LIBRARY_MAX_DEPTH) || 6;
/** For the downloads census (lib/downloadCensus.ts): a folder deeper than this is one the scan never looks in. */
export const SCAN_MAX_DEPTH = MAX_DEPTH;
const MAX_DIRS = 200_000; // a pathological mount stops the scan rather than the process

// Never library content. @eaDir is the one that matters: Synology fills it with generated thumbnails, and
// listChapters() already counts it as a chapter folder, so today every series on a Synology has a phantom
// "@eaDir" chapter. Recursing would promote that from one bad chapter to one bad series.
export const SKIP_DIR = /^(?:\.|@eaDir$|#recycle$|lost\+found$|__MACOSX$|\$RECYCLE\.BIN$|System Volume Information$)/i;

export interface FoundSeries {
  /** posix, relative to the root, no leading or trailing slash */
  folderRel: string;
  folderAbs: string;
  /** the segment directly ABOVE the series folder; 'Library' when the series sits at the root */
  source: string;
  /** basenames, exactly what listChapters returned */
  chapters: string[];
}

/**
 * The loop guard's name for a directory: the same directory gets the same key however it was reached.
 *
 * ⚠️ Not dev:ino on Windows. NTFS file ids are 64-bit and lose precision in a JavaScript number, so two
 * different folders can share a key; FAT and exFAT drives (most USB sticks and SD cards) have no stable id at
 * all. The real path, case-folded because NTFS is case-insensitive, names a folder exactly once there. POSIX
 * keeps dev:ino, read EXACTLY (`nodeFs.stat` asks for bigints). `platform` and `real` are parameters for the
 * test. Reintroduce by returning dev:ino on every platform: relPath.test.ts "the loop guard on Windows" finds
 * two folders under one key.
 *
 * ⚠️ A shared key is NOT proof of one directory, even exact (#109). Unraid's user shares are one FUSE mount
 * over several disks and report each disk's own inode numbers, so a folder on the cache pool and one on an
 * array disk can report the same dev:ino; network and union mounts can too. `findSeriesDirs` therefore
 * refuses a folder only when it repeats one of its own ancestors, with the same entries.
 */
export async function dirKey(
  abs: string,
  st: { dev: number | bigint; ino: number | bigint },
  platform: NodeJS.Platform = process.platform,
  real: (p: string) => Promise<string> = realpath,
): Promise<string> {
  return platform === 'win32' ? (await real(abs).catch(() => abs)).toLowerCase() : `${st.dev}:${st.ino}`;
}

/** Why the walk left a folder out, or looked no further. Every one of these used to be silent (#109). */
export type WalkReason = 'loop' | 'unreadable' | 'unchecked' | 'stat' | 'depth' | 'limit';
export interface WalkIssue {
  /** Relative to the root; '' is the root itself, or the walk as a whole for `depth` and `limit`. */
  folder: string;
  reason: WalkReason;
  detail: string;
}
export interface WalkResult {
  found: FoundSeries[];
  issues: WalkIssue[];
  /**
   * Folders that reported a disk id another folder had already reported, and were scanned all the same. Up to
   * v0.48.1 each of them was skipped with its whole subtree, silently: the count is what lets a Health
   * screenshot say whether that is what an install was hitting.
   */
  sharedIds: number;
}

/**
 * Every directory under `root` that IS a series.
 *
 * A directory is a series when it DIRECTLY contains chapters. Depth is irrelevant, which is the whole point:
 * Comics/Manga/Author/Series/ch1.cbz works, and so does the Series/ch1.cbz layout the docs described for two
 * releases while the scanner silently required a grouping level above it.
 *
 * Two invariants keep this byte-compatible with the two-level walk it replaces. `folder` is the natural key
 * a series id hangs off, so breaking either would re-mint every id on every install and strand everyone's
 * reading progress on rows nothing points at:
 *
 *   1. folderRel is the path relative to the root, '/'-joined. At depth 2 that is character for character
 *      the old two-level `<level 1>/<level 2>`.
 *   2. source is the segment directly above the series folder, which at depth 2 IS the level-1 directory,
 *      i.e. exactly the level-1 directory the old walk used as `source`.
 *
 * A directory already claimed as a chapter is never descended into: an "extras" folder nested inside a
 * loose-image chapter would otherwise become a series and count those pages twice.
 *
 * Nothing is left out silently any more (#109): a folder that cannot be read, entries that cannot be checked,
 * a loop, and the depth and folder caps all come back in `issues`, which the scan report and Admin → Health →
 * Library scan carry. `fsx` and `platform` are parameters for the test.
 */
export async function findSeriesDirs(root: string, fsx: WalkFs = nodeFs, platform: NodeJS.Platform = process.platform): Promise<WalkResult> {
  const found: FoundSeries[] = [];
  const issues: WalkIssue[] = [];
  const reported = new Set<string>();
  let sharedIds = 0;
  let visited = 0;
  let tooDeep = 0;
  let capped = false;

  const walk = async (abs: string, rel: string, depth: number, chain: Array<{ key: string; rel: string; names: string }>): Promise<void> => {
    if (depth > MAX_DEPTH) { tooDeep++; return; }
    if (visited >= MAX_DIRS) { capped = true; return; }
    visited++;

    // Gone since its parent was listed (moved, or a Remove deleting it) is not a finding.
    const st = await fsx.stat(abs).catch((e) => {
      if (errCode(e) !== 'ENOENT') issues.push({ folder: rel, reason: 'stat', detail: errCode(e) });
      return null;
    });
    if (!st) return;
    const key = await dirKey(abs, st, platform);
    const listing = await listDir(abs, fsx);
    const names = () => listing.entries.map((e) => e.name).sort().join('\n');

    /**
     * ⚠️ THE LOOP GUARD, AND WHY IT IS NARROW (#109). It used to be one set of every dev:ino seen in the root,
     * and a folder whose id was already in it was dropped, with everything under it, without a word. It never
     * met a real loop -- the walk does not follow symlinks (their entries are `link`, not `dir`) -- but it met
     * Unraid: a user share is one FUSE mount over several disks and reports each disk's own inode numbers, so
     * two unrelated series folders could share an id, and one of them never reached the library. Moving it
     * into /library "fixed" it (another walk, new ids), a rescan never did, and the Health page said all was
     * well. And the id was a JavaScript number, so above 2^53 neighbouring ids rounded onto one another.
     *
     * A walk that cannot follow a symlink can only loop through a bind mount of an ancestor, and that is the
     * same directory: an ancestor's id AND its entries. Anything less is two folders, and both are scanned.
     * Reintroduce by refusing every repeated id: "two folders that report one disk id are both scanned" in
     * scanWalk.test.ts finds one of them missing.
     */
    const ancestor = chain.find((a) => a.key === key);
    if (ancestor && ancestor.names === names()) {
      issues.push({ folder: rel, reason: 'loop', detail: `the same folder as ${ancestor.rel ? `"${ancestor.rel}"` : 'the root'}, reached again through a mount` });
      return;
    }
    if (reported.has(key)) sharedIds++;
    else reported.add(key);

    if (listing.error) {
      if (listing.error !== 'ENOENT') issues.push({ folder: rel, reason: 'unreadable', detail: listing.error });
      return;
    }
    if (listing.unchecked?.length) {
      const n = listing.unchecked.length;
      issues.push({
        folder: rel, reason: 'unchecked',
        detail: `${n} entr${n === 1 ? 'y' : 'ies'} could not be checked: ${listing.unchecked.slice(0, 3).map((x) => `"${x}"`).join(', ')}${n > 3 ? ', …' : ''}`,
      });
    }

    const chapters = await listChapters(abs, { fsx, listing });
    // Chapters win: this directory is a series, and we do not descend. Its chapter subfolders are
    // chapters, not series.
    //
    // ⚠️ `&& rel`: the ROOT is never a series, so the root having chapters must not END the walk. It used
    // to -- `if (rel) push; return;` pushed nothing at the root and returned without descending, so any
    // root that looked chapter-ish scanned to zero. isImageChapterDir now stops a series folder from looking
    // chapter-ish in the first place; this is the second lock on the same door, and it is the one-line fix
    // @ThomasRunting proposed in #34.
    if (chapters.length && rel) {
      found.push({ folderRel: rel, folderAbs: abs, source: rel.split('/').slice(-2, -1)[0] || 'Library', chapters });
      return;
    }

    const below = [...chain, { key, rel, names: names() }];
    for (const e of listing.entries) {
      if (e.kind !== 'dir' || SKIP_DIR.test(e.name)) continue;
      await walk(join(abs, e.name), rel ? `${rel}/${e.name}` : e.name, depth + 1, below);
    }
  };

  await walk(root, '', 0, []);
  if (tooDeep) {
    issues.push({ folder: '', reason: 'depth', detail: `${tooDeep} folder${tooDeep === 1 ? ' is' : 's are'} more than ${MAX_DEPTH} levels deep and ${tooDeep === 1 ? 'was' : 'were'} not looked into (LIBRARY_MAX_DEPTH)` });
  }
  if (capped) issues.push({ folder: '', reason: 'limit', detail: `the walk stopped after ${MAX_DIRS.toLocaleString('en-US')} folders; the rest were not looked into` });
  return { found, issues, sharedIds };
}

export interface LibraryRow { id: string; path: string }

/**
 * Which declared library owns this folder, by longest path prefix.
 *
 * Membership is a property of folderRel, never of which root the file happens to sit under. That is what
 * keeps DL_ROOT a writable OVERLAY of the same namespace rather than a library of its own: persistScan
 * merges identical folderRel across both roots on purpose, so a series part-fetched by the engine and
 * part-downloaded here is one shelf, and both copies land in the same library by construction.
 *
 * Library zero has path '' and therefore prefixes everything, which is why an install that has never
 * declared a library behaves exactly as it did before this existed.
 *
 * Longest path wins, which is also what makes NESTING unambiguous: a series under `Manga/Seinen` belongs to
 * that library rather than to `Manga`, and deleting the inner one returns it to `Manga` rather than to the
 * default. Nested libraries used to be refused out of caution even though this rule already handled them.
 *
 * Only consulted for a folder the scanner has not seen before: an existing row keeps the library it is in,
 * so an admin's hand-move is never recomputed away.
 */
export function libraryIdFor(folderRel: string, libs: LibraryRow[]): string {
  let best: LibraryRow | null = null;
  for (const l of libs) {
    if (l.path && !(folderRel === l.path || folderRel.startsWith(l.path + '/'))) continue;
    if (!best || l.path.length > best.path.length) best = l;
  }
  return best?.id ?? 'lib';
}

/**
 * Decide whether this unknown folder is an existing series that moved. Returns the series to reuse, or null
 * to fall through to creating a new one — which is exactly what happens today.
 */
async function tryRematch(
  folderRel: string,
  folderAbs: string,
  files: string[],
  root: string,
  onDisk: string[],
  libraryId: string,
): Promise<{ id: string; oldFolder: string } | null> {
  if (files.length < MIN_BOOKS) return null;

  // Fingerprint this folder's chapters. Only happens for folders we have never seen, so it is not on the
  // common path of a rescan.
  const fps = await Promise.all(
    files.map(async (f) => ({
      rel: `${folderRel}/${f}`,
      root,
      fingerprint: (await fingerprintChapter(join(folderAbs, f))).fingerprint,
    })),
  );
  const list = fps.map((f) => f.fingerprint).filter((x): x is string => !!x);

  const { match, reason, candidates } = await findRematch(list, onDisk, libraryId);
  if (!match) {
    if (candidates.length) {
      await logRematch(env.LIBRARY_REMATCH === 'apply' ? 'apply' : 'report', {
        folder: folderRel, matched: false, reason,
        candidates: candidates.map((c) => ({ title: c.title, folder: c.oldFolder, overlap: Number(c.overlap.toFixed(2)) })),
      });
    }
    return null;
  }

  const detail = {
    folder: folderRel, matched: true, series: match.title, from: match.oldFolder,
    seriesId: match.seriesId, shared: match.shared, overlap: Number(match.overlap.toFixed(2)),
  };

  if (env.LIBRARY_REMATCH === 'report') {
    await logRematch('report', { ...detail, applied: false });
    return null; // report mode changes nothing
  }

  const moved = await tx((qq) => applyRematch(qq, match.seriesId, match.oldFolder, folderRel, fps));
  await logRematch('apply', { ...detail, applied: true, booksRepointed: moved.moved });
  return { id: match.seriesId, oldFolder: match.oldFolder };
}

/** A folder the last scan could not index, and why (#109). */
export interface ScanSkip { root: 'library' | 'downloads'; folder: string; error: string }
/** Something the walk left out or looked no further into, and why (#109). */
export interface ScanWalkIssue extends WalkIssue { root: 'library' | 'downloads' }
export interface ScanReport {
  /** When the scan finished, and when it began: a file newer than `startedAt` may simply not be scanned yet. */
  at: string;
  startedAt: string;
  series: number;
  books: number;
  ms: number;
  skipped: ScanSkip[];
  skippedTotal: number;
  /** What the walk left out, before any folder reached the database: problems first, then what is only noted. */
  walk: ScanWalkIssue[];
  walkTotal: number;
  /** Of `walkTotal`, the ones that leave chapters out: everything but a refused loop and the depth note. */
  walkProblems: number;
  /** Folders that shared a disk id with another folder and were scanned all the same (see `findSeriesDirs`). */
  sharedIds: number;
  /** Folders passed over because their series was removed: on purpose, and put back under Admin → Removed. */
  removed: number;
}
/** Walk findings that leave nothing out: a loop refused is the guard working, and the depth cap is a setting. */
export const QUIET_WALK: ReadonlySet<WalkReason> = new Set<WalkReason>(['loop', 'depth']);
/** How many skipped folders, and walk findings, a report names. The totals are always counted. */
const SKIPS_KEPT = 50;
let lastScan: ScanReport | null = null;
/**
 * The last completed scan, for the Health page: a folder the scanner cannot index is otherwise invisible --
 * its chapters are on disk, the series page says they are missing, and a Fetch finds the file there and does
 * nothing. Null until the first scan since the server started.
 */
export const lastScanReport = (): ScanReport | null => lastScan;

export type ScanResult = { series: number; books: number; ms: number; skipped: number };
let scanning: Promise<ScanResult> | null = null;
let again: Promise<ScanResult> | null = null;
let scansStarted = 0;
/** How many scans this process has started: for the tests, which count them. */
export const scanCount = (): number => scansStarted;
/**
 * Scan every root into lib_series/lib_books. One scan at a time.
 *
 * ⚠️ A caller that arrives while a scan is running waits for ONE more scan after it, never for the running
 * one: that scan may already have walked past the caller's folder before its chapter landed, and answering
 * with it would say "scanned" about a file it never saw. Every caller that arrives meanwhile shares the same
 * follow-up. Scans used to overlap freely -- `/api/refresh` alone started one per library, all at once -- and
 * two scans racing one folder is how a series gets minted twice.
 * Reintroduce by returning `scanOnce()` every time: "requests during a scan share one follow-up" in
 * scanResilience.int.test.ts finds three scans and a follow-up that is not the same promise.
 */
export function persistScan(): Promise<ScanResult> {
  if (!scanning) {
    scanning = scanOnce().finally(() => { scanning = null; });
    return scanning;
  }
  // `scanning ??`: by the time this runs the scan it waited for has ended, so a scan running NOW was started
  // after every caller sharing this follow-up made its call -- a caller that asked again the moment its own scan
  // ended starts one before this line runs, and chaining another behind that would be a third scan for nothing.
  again ??= scanning.catch(() => undefined).then(() => {
    again = null;
    return scanning ?? persistScan();
  });
  return again;
}

async function scanOnce(): Promise<ScanResult> {
  scansStarted++;
  const t0 = Date.now();
  let nBooks = 0;
  const skipped: ScanSkip[] = [];
  let skippedTotal = 0;
  let removed = 0;
  // folderRel -> series id, so the second root reuses the row the first root created. The same relative
  // folder legitimately exists under both roots (a series part-fetched by the engine, part downloaded here),
  // and merging them into one series is deliberate.
  const seenFolders = new Map<string, string>();
  // Both roots are walked once, up front (the rematch needs every folder on disk before the first is indexed).
  // The walk reports rather than throws; the catch is the last word: a walk that fails outright costs its root,
  // named, never the scan.
  const walks: Array<{ root: string; label: 'library' | 'downloads' } & WalkResult> = [];
  for (const root of [LIBRARY_ROOT, DL_ROOT]) {
    const label = root === DL_ROOT ? 'downloads' as const : 'library' as const;
    walks.push({
      root, label,
      ...(await findSeriesDirs(root).catch((e): WalkResult => ({
        found: [], sharedIds: 0, issues: [{ folder: '', reason: 'unreadable', detail: `the walk failed: ${errCode(e)}` }],
      }))),
    });
  }
  const walkIssues: ScanWalkIssue[] = walks.flatMap((w) => w.issues.map((i) => ({ ...i, root: w.label })));
  // Every folder that exists on disk this pass. A series still sitting at its own path has not moved, so it
  // must never be offered as the answer for a different folder.
  const onDisk = walks.flatMap((w) => w.found.map((f) => f.folderRel));
  // Loaded once per scan. Longest prefix wins, so a declared subdirectory beats library zero.
  const libs = await q<LibraryRow>('SELECT id, path FROM libraries ORDER BY length(path) DESC');
  for (const { root, found: foundInRoot } of walks) {
    for (const found of foundInRoot) {
      const { folderRel, folderAbs, source: srcName, chapters: files } = found;
      // ⚠️ ONE FOLDER, NOT THE SCAN (#109). A folder the scanner cannot index -- a ComicInfo field Postgres
      // refuses, a constraint, anything -- used to throw out of the whole pass, and every caller swallowed it
      // (`persistScan().catch(() => {})`). The scan simply stopped there, on every run, and everything after
      // that folder -- the downloads root is walked second, so every chapter this server fetched -- stayed
      // unindexed with nothing in the log: files on disk, "missing" on the series page, and a Fetch that found
      // the file already there and did nothing. Its own transaction rolls back; the rest of the library goes on.
      // Reintroduce by removing the catch: "one folder that cannot be indexed does not stop the scan" in
      // scanResilience.int.test.ts finds the folders after it missing.
      try {

        // One folder per transaction: a half-applied folder is a corrupt library, not a stale one.
        // A folder can already be spoken for in ways the scanner must respect, or delete and merge both
        // undo themselves on the next pass: this runs on every add, every updater sweep and every manual scan.
        // A folder is unique per LIBRARY, not overall, so it can have a deleted twin beside a live row (a series
        // deleted in one library and the folder later assigned to another). The live one is the one its files
        // belong to: unordered, the deleted twin could come back first and the `continue` below skipped the
        // folder for good. Reintroduce by dropping the ORDER BY: "a deleted twin does not hide the live row"
        // in scanResilience.int.test.ts finds its books missing.
        const known = await one<{ id: string; deleted_at: string | null; merged_into: string | null; library_id: string }>(
          `SELECT id, deleted_at, merged_into, library_id FROM lib_series WHERE folder = $1
            ORDER BY (deleted_at IS NOT NULL), (merged_into IS NOT NULL), created_at LIMIT 1`,
          [folderRel],
        );
        // Deleted: leave it alone entirely. Reviving it would mint a new id and strand everything attached
        // to the old one -- favourites, ratings, notes, reading history.
        if (known?.deleted_at) { removed++; continue; }
        // Merged away: its files belong to the survivor now. Without this the books get pulled back out by
        // `ON CONFLICT (root, file) DO UPDATE SET series_id = EXCLUDED.series_id` and the merge silently undoes.
        const mergeTarget = known?.merged_into || null;

        // Only a folder with no row of its own can be a move. Anything already known is the normal path.
        let rematched: { id: string; oldFolder: string } | null = null;
        if (env.LIBRARY_REMATCH !== 'off' && !seenFolders.has(folderRel)) {
          rematched = await tryRematch(folderRel, folderAbs, files, root, onDisk, libraryIdFor(folderRel, libs));
        }

        const seriesId = await tx(async (qq) => {
          let id = seenFolders.get(folderRel) || mergeTarget || undefined;
          if (mergeTarget) seenFolders.set(folderRel, mergeTarget);
          if (!id && rematched) {
            id = rematched.id;
            seenFolders.set(folderRel, id);
          }
          if (!id) {
            const firstXml = (await readArchive(join(folderAbs, files[0])).catch(() => ({ xml: '', pages: 0 }))).xml;
            // Conflict on FOLDER, not id: the row keeps whatever id it already had, so ids survive a rescan
            // without being derived from the path. A brand-new folder mints one.
            const rows = await qq<{ id: string }>(
              // An EXISTING folder keeps the library it is already in: only a brand-new folder is assigned
              // one. Recomputing on every scan would mean that declaring a library, before its series were
              // reassigned, made the conflict target miss and mint a second row with a new id -- which is
              // the one thing that strands everyone's reading progress. Reassignment is a deliberate UPDATE.
              `INSERT INTO lib_series (id, source, title, summary, author, status, genres, web, folder, books_count, library_id, age_rating,
                                       reading_direction, reading_direction_from, scanned_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now())
               ON CONFLICT (library_id, folder) DO UPDATE SET source=EXCLUDED.source, title=EXCLUDED.title, summary=EXCLUDED.summary,
                 author=EXCLUDED.author, status=EXCLUDED.status, genres=EXCLUDED.genres, web=EXCLUDED.web,
                 -- Never overwrite a rating we have with one we do not: a chapter whose ComicInfo omits
                 -- AgeRating must not silently un-rate a series a previous scan or an admin rated.
                 age_rating=COALESCE(EXCLUDED.age_rating, lib_series.age_rating),
                 -- The same for the reading direction (lib/readingDirection.ts), and more so: a file that says
                 -- nothing must not erase what MangaDex or AniList said. When it DOES say, it is the most
                 -- trusted evidence there is and replaces theirs, provenance and all.
                 reading_direction=COALESCE(EXCLUDED.reading_direction, lib_series.reading_direction),
                 reading_direction_from=CASE WHEN EXCLUDED.reading_direction IS NOT NULL
                   THEN EXCLUDED.reading_direction_from ELSE lib_series.reading_direction_from END,
                 scanned_at=now()
               RETURNING id`,
              [
                newSeriesId(), srcName, field(firstXml, 'Series') || folderRel.split('/').pop()!, cleanSummary(field(firstXml, 'Summary')),
                field(firstXml, 'Writer'), cleanStatus(field(firstXml, 'PublishingStatusTachiyomi') || field(firstXml, 'PublishingStatus')),
                (field(firstXml, 'Genre') || '').split(',').map((s) => s.trim()).filter(Boolean),
                field(firstXml, 'Web'), folderRel, files.length,
                known?.library_id ?? libraryIdFor(folderRel, libs),
                parseComicInfoAgeRating(field(firstXml, 'AgeRating')),
                directionFromComicInfo(field(firstXml, 'Manga')),
                directionFromComicInfo(field(firstXml, 'Manga')) ? 'comicinfo' : null,
              ],
            );
            id = rows[0].id;
            seenFolders.set(folderRel, id);
          }

          const params: any[] = [];
          const tuples: string[] = [];
          for (const f of files) {
            const rel = `${folderRel}/${f}`;
            const st = await stat(join(folderAbs, f)).catch(() => null);
            const b = params.length;
            tuples.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8})`);
            params.push(newBookId(), id, srcName, rel, numFromName(f), f.replace(/\.(cbz|cbr|zip|rar|pdf|epub)$/i, ''), st ? Math.floor(st.mtimeMs) : 0, root);
            nBooks++;
          }
          // Conflict on (root, file) for the same reason: an existing book keeps its id, and the same
          // relative path under a different root is a different book rather than a collision.
          //
          // pruned_at is cleared here because this loop only ever runs for a file that IS on disk. The
          // read-chapter cleanup marks a row to say "the bytes are gone and we are not fetching them
          // again" (lib/chapterCleanup.ts); a file back under that path -- re-copied by hand, restored from
          // a backup, pulled down again -- makes that claim false, and a stale mark would leave the chapter
          // showing as removed while it sits there readable.
          //
          // short_confirmed_at survives a rescan that found the SAME file and is cleared when the mtime
          // moved. The stamp means "this one-or-two-page chapter has been proven to be what the sources
          // hold" (lib/repair.ts, and the column note in lib/migrate.ts), and a scan is the one thing that
          // runs over every chapter every time: clearing it unconditionally would un-confirm the whole
          // library on the next scan and hand the Health page back its fourteen findings. A file whose
          // mtime changed is a different file, though -- a refetch, a hand-copied replacement -- and the
          // proof was about the bytes that are no longer there.
          // Reintroduce by dropping the CASE (always NULL): "a scan that finds the same file leaves a
          // confirmed-short chapter confirmed" in repair.int.test.ts reads null.
          await qq(
            `INSERT INTO lib_books (id, series_id, source, file, number, title, mtime, root) VALUES ${tuples.join(',')}
             ON CONFLICT (root, file) DO UPDATE SET series_id=EXCLUDED.series_id, number=EXCLUDED.number,
               title=EXCLUDED.title, mtime=EXCLUDED.mtime, updated_at=now(), pruned_at=NULL,
               short_confirmed_at = CASE WHEN lib_books.mtime <> EXCLUDED.mtime THEN NULL ELSE lib_books.short_confirmed_at END`,
            params,
          );

          // Set the cover AFTER the books exist. It used to be computed by hashing the first chapter's path,
          // which only worked while ids were a pure function of the path -- now it would dangle, and a
          // dangling cover_book_id takes out every cover and backdrop in the product.
          //
          // The lowest LIVE chapter, not the lowest row: every thumbnail falls back to the cover chapter's
          // first page, and a tombstone (lib/chapterCleanup.ts) has no first page. The cleanup itself vetoes
          // the cover chapter, but an admin's manual delete does not, and mergeSeries picks the same way.
          await qq(
            `UPDATE lib_series SET cover_book_id = (
               SELECT id FROM lib_books WHERE series_id = $1 ORDER BY (pruned_at IS NOT NULL), number ASC, file ASC LIMIT 1
             ) WHERE id = $1`,
            [id],
          );
          return id;
        });
        void seriesId;
      } catch (e) {
        skippedTotal++;
        const error = String((e as Error)?.message || e).slice(0, 300);
        if (skipped.length < SKIPS_KEPT) skipped.push({ root: root === DL_ROOT ? 'downloads' : 'library', folder: folderRel, error });
        console.warn(`[scan] skipped ${root}/${folderRel}: ${error}`);
      }
    }
  }
  // Best effort, like everything after the folders: every folder is already committed, and one series row this
  // UPDATE cannot write (a lock, a constraint) must not throw the whole scan away at its last step -- the report
  // below would never be written, and the Health page would go on describing the scan before.
  await q(`UPDATE lib_series s SET books_count = c.n, latest_mtime = COALESCE(c.mt, 0)
           FROM (SELECT series_id, count(*) AS n, max(mtime) AS mt FROM lib_books GROUP BY series_id) c WHERE c.series_id = s.id`)
    .catch((e) => console.warn(`[scan] chapter counts not refreshed: ${(e as Error)?.message || e}`));
  // A chapter that has landed is no longer a failure. Cheap: the ledger only ever holds what is still missing.
  await q(`DELETE FROM chapter_failures f USING lib_books b WHERE b.series_id = f.series_id AND b.number = f.number`).catch(() => {});
  // The same "a chapter has landed" moment for a reader's marks (#69): a number somebody ticked read while
  // this server did not hold it becomes ordinary progress on the row that now exists, then the mark goes.
  // Here because this is the only place a lib_books row is ever minted, so the only place a number stops
  // being a ghost. ⚠️ lib/listingProgress stamps it strictly before the file's mtime -- now() would make the
  // read-chapter cleanup delete what the sweep just fetched. Best effort, like the ledger above: a scan must
  // never fail over it, and the marks keep until the next scan.
  await reconcileListingProgress().catch((e) => console.warn('[scan] listing marks not reconciled:', (e as Error).message));
  const ms = Date.now() - t0;
  const loud = walkIssues.filter((i) => !QUIET_WALK.has(i.reason));
  lastScan = {
    at: new Date().toISOString(), startedAt: new Date(t0).toISOString(), series: seenFolders.size, books: nBooks, ms, skipped, skippedTotal,
    walk: [...loud, ...walkIssues.filter((i) => QUIET_WALK.has(i.reason))].slice(0, SKIPS_KEPT),
    walkTotal: walkIssues.length, walkProblems: loud.length,
    sharedIds: walks.reduce((n, w) => n + w.sharedIds, 0), removed,
  };
  if (loud.length) console.warn(`[scan] ${loud.length} folder(s) or file(s) were left out by the walk; Admin → Health → Library scan lists them`);
  if (skippedTotal) console.warn(`[scan] ${skippedTotal} folder(s) could not be indexed; Admin → Health → Library scan lists them`);
  return { series: seenFolders.size, books: nBooks, ms, skipped: skippedTotal };
}

/**
 * Stamp source release dates onto a series' books (matched by chapter number). Called after persistScan by the
 * add flow and the updater — the scanner itself never touches published_at, so stamps survive rescans.
 */
export async function setBookDates(folder: string, chapters: { number: number; publishedAt?: string }[]): Promise<void> {
  const dated = chapters.filter((c) => c.publishedAt && Number.isFinite(c.number));
  if (!dated.length) return;
  const values: string[] = [];
  const params: any[] = [folder];
  for (const c of dated) {
    params.push(c.number, c.publishedAt);
    values.push(`($${params.length - 1}::real, $${params.length}::timestamptz)`);
  }
  // Matches the RAW lib_books.number on purpose, never the override. These numbers came from the source's
  // own chapter list and line up with what was parsed out of the filename it gave us. A manual correction
  // is about how a chapter is presented to the reader, not about which remote chapter this file is, so
  // honouring it here would stop release dates matching at all.
  await q(
    `UPDATE lib_books b SET published_at = v.p
     FROM (VALUES ${values.join(',')}) AS v(n, p), lib_series s
     WHERE s.folder = $1 AND b.series_id = s.id AND b.number = v.n AND b.published_at IS DISTINCT FROM v.p`,
    params,
  );
}

// A volume marker in front of the chapter: "Vol.3", "Volume 3 -", "Tome 3,".
const VOLUME = String.raw`(?:(?:vol(?:ume)?|tome|band|том)\.?\s*\d+(?:\.\d+)?\s*[,:.\-–—]?\s*)?`;
// The word a source puts before the number, in the languages sources are written in.
const CHAPTER_WORD = String.raw`(?:(?:ch(?:apter|ap)?|episode|ep|capítulo|capitulo|cap|chapitre|kapitel|глава|розділ|chương|bölüm|bab|rozdział)\.?\s*)?`;
// After the number, the separators between it and a real name.
const SEPARATOR = String.raw`\s*(?:[:.\-–—|~]+\s*)?`;

/**
 * The chapter's own name, when the source gave one: what is left once the volume, the chapter word and the
 * number are taken off the front. Null when nothing is left -- the title only said the number again.
 *
 * A downloaded file is named from its number alone (lib/downloader.ts explains why), so the scanner's title
 * is the number twice. Sources usually know better, and the downloader writes it into the CBZ's ComicInfo,
 * but nothing read it back. Most sources also just say "Chapter 12", in several languages and often behind a
 * volume ("Vol.3 Chapter 12", "Capítulo 12", "第12話"): each of those is the number again, and "Vol.3 Chapter
 * 12: The Return" is named "The Return".
 */
export function chapterName(title: string | undefined | null, number: number): string | null {
  const t = (title ?? '').trim();
  if (!t) return null;
  const n = String(number).replace('.', '\\.');
  // `(?!\.?\d)`: 12 must not match the front of 120 or 12.5.
  const re = new RegExp(`^${VOLUME}${CHAPTER_WORD}(?:第\\s*)?0*${n}(?!\\.?\\d)(?:\\s*(?:話|话|章|回|화|편))?${SEPARATOR}`, 'iu');
  const m = re.exec(t);
  if (!m) return t;
  const rest = t.slice(m[0].length).trim();
  return rest || null;
}

/**
 * Stamp which group released the file on disk, and which adapter it came from, onto a series' books.
 *
 * Takes only the chapters that LANDED in this run, never the whole listing. The listing's chosen copy for
 * a number can change from one sweep to the next (a preferred group catches up, a block is added), and
 * stamping every listed number would relabel a file already on disk from group A as group B the moment
 * the choice moved -- while the file itself stayed A's. Same RAW-number match as setBookDates, for the
 * same reason: these numbers are the source's, not the override's.
 *
 * `missing` is the 1-based list of placeholder pages when the chapter was saved partial (lib/partial.ts),
 * and its absence writes NULL: a complete copy landing over a partial one -- a refetch, the completion
 * pass falling through to another source -- clears the mark in the same stamp that records who wrote it.
 *
 * `title` is what the source called the chapter. Its name (chapterName, above) goes to `chapter_name` -- never
 * to `title`, which is the filename's -- and only when there is one, so a copy whose source says only "Chapter
 * 12" never replaces a name an earlier copy supplied.
 */
export async function setBookMeta(folder: string, landed: Array<{ number: number; scanlator?: string; source?: string; missing?: number[]; title?: string }>): Promise<void> {
  const rows = landed.filter((c) => Number.isFinite(c.number));
  if (!rows.length) return;
  const values: string[] = [];
  const params: any[] = [folder];
  for (const c of rows) {
    params.push(c.number, c.scanlator ?? null, c.source ?? null, c.missing?.length ? c.missing : null, chapterName(c.title, c.number));
    values.push(`($${params.length - 4}::real, $${params.length - 3}::text, $${params.length - 2}::text, $${params.length - 1}::int[], $${params.length}::text)`);
  }
  await q(
    // An own name replaces a borrowed one (lib/borrowNames.ts), and takes its donor mark with it.
    `UPDATE lib_books b SET scanlator = v.grp, source_id = v.src, missing_pages = v.miss,
            chapter_name = COALESCE(v.name, b.chapter_name),
            chapter_name_source = CASE WHEN v.name IS NOT NULL THEN NULL ELSE b.chapter_name_source END
     FROM (VALUES ${values.join(',')}) AS v(n, grp, src, miss, name), lib_series s
     WHERE s.folder = $1 AND b.series_id = s.id AND b.number = v.n
       AND (b.scanlator IS DISTINCT FROM v.grp OR b.source_id IS DISTINCT FROM v.src
            OR b.missing_pages IS DISTINCT FROM v.miss
            OR (v.name IS NOT NULL AND b.chapter_name IS DISTINCT FROM v.name))`,
    params,
  );
}

