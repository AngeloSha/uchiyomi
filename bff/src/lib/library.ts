// Owned library scanner: reads the CBZ folder Suwayomi writes (replacing Komga's library role).
// Layout: <root>/<source>/<series title>/<chapter>.cbz ; each cbz carries ComicInfo.xml + page images.
import { readdir, stat, readFile } from 'fs/promises';
import { join } from 'path';
import sharp from 'sharp';
import { q, one, tx } from './db';
import { newSeriesId, newBookId } from './ids';
import { env } from '../env';
import { fingerprintChapter } from './fingerprint';
import { findRematch, applyRematch, logRematch, MIN_BOOKS } from './rematch';
import { numFromName, naturalCmp } from './naming';
import { parseComicInfoAgeRating } from './ageRating';

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

function field(xml: string, tag: string): string | null {
  // allow an optional XML namespace prefix, e.g. <ty:PublishingStatusTachiyomi>
  const m = xml.match(new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${tag}>`, 'i'));
  return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : null;
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

/** Chapter entries in a series folder: cbz/cbr/zip/rar/pdf files, image EPUBs, + subfolders of images. */
export async function listChapters(folderAbs: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(folderAbs, { withFileTypes: true }).catch(() => [])) {
    if (e.isFile() && /\.(cbz|cbr|zip|rar|pdf)$/i.test(e.name)) out.push(e.name);
    // An EPUB counts only if it actually holds pages. A reflowable novel has none, so it is skipped here
    // rather than becoming a chapter that opens to nothing -- which is what "skips ebooks" really meant.
    else if (e.isFile() && /\.epub$/i.test(e.name)) {
      if ((await epubPages(join(folderAbs, e.name))).length) out.push(e.name);
    }
    else if (e.isDirectory() && (await readdir(join(folderAbs, e.name)).catch(() => [])).some((n) => IMG.test(n))) out.push(e.name);
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
const MAX_DIRS = 200_000; // a pathological mount stops the scan rather than the process

// Never library content. @eaDir is the one that matters: Synology fills it with generated thumbnails, and
// listChapters() already counts it as a chapter folder, so today every series on a Synology has a phantom
// "@eaDir" chapter. Recursing would promote that from one bad chapter to one bad series.
const SKIP_DIR = /^(?:\.|@eaDir$|#recycle$|lost\+found$|__MACOSX$|\$RECYCLE\.BIN$|System Volume Information$)/i;

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
 */
async function findSeriesDirs(root: string): Promise<FoundSeries[]> {
  const out: FoundSeries[] = [];
  const seenInode = new Set<string>(); // symlink loop guard: `ln -s .. current` is not hypothetical on a NAS
  let visited = 0;

  const walk = async (abs: string, rel: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || visited >= MAX_DIRS) return;
    visited++;

    // stat, not lstat: a symlinked library directory should still work. We follow it once, then decline.
    const st = await stat(abs).catch(() => null);
    if (!st) return;
    const key = `${st.dev}:${st.ino}`;
    if (seenInode.has(key)) return;
    seenInode.add(key);

    const chapters = await listChapters(abs);
    if (chapters.length) {
      // Chapters win: this directory is a series, and we do not descend. Its chapter subfolders are
      // chapters, not series.
      if (rel) out.push({ folderRel: rel, folderAbs: abs, source: rel.split('/').slice(-2, -1)[0] || 'Library', chapters });
      return;
    }

    for (const e of await readdir(abs, { withFileTypes: true }).catch(() => [])) {
      if (!e.isDirectory() || SKIP_DIR.test(e.name)) continue;
      await walk(join(abs, e.name), rel ? `${rel}/${e.name}` : e.name, depth + 1);
    }
  };

  await walk(root, '', 0);
  return out;
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

/** Every series folder that exists under either root right now, at any depth. */
async function foldersOnDisk(): Promise<string[]> {
  const out: string[] = [];
  for (const root of [LIBRARY_ROOT, DL_ROOT]) {
    for (const f of await findSeriesDirs(root)) out.push(f.folderRel);
  }
  return out;
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

export async function persistScan(): Promise<{ series: number; books: number; ms: number }> {
  const t0 = Date.now();
  let nBooks = 0;
  // folderRel -> series id, so the second root reuses the row the first root created. The same relative
  // folder legitimately exists under both roots (a series part-fetched by the engine, part downloaded here),
  // and merging them into one series is deliberate.
  const seenFolders = new Map<string, string>();
  // Every folder that exists on disk this pass. A series still sitting at its own path has not moved, so it
  // must never be offered as the answer for a different folder.
  const onDisk = await foldersOnDisk();
  // Loaded once per scan. Longest prefix wins, so a declared subdirectory beats library zero.
  const libs = await q<LibraryRow>('SELECT id, path FROM libraries ORDER BY length(path) DESC');
  for (const root of [LIBRARY_ROOT, DL_ROOT]) {
    for (const found of await findSeriesDirs(root)) {
      const { folderRel, folderAbs, source: srcName, chapters: files } = found;

        // One folder per transaction: a half-applied folder is a corrupt library, not a stale one.
        // A folder can already be spoken for in ways the scanner must respect, or delete and merge both
        // undo themselves on the next pass: this runs on every add, every updater sweep and every manual scan.
        const known = await one<{ id: string; deleted_at: string | null; merged_into: string | null; library_id: string }>(
          `SELECT id, deleted_at, merged_into, library_id FROM lib_series WHERE folder = $1`,
          [folderRel],
        );
        // Deleted: leave it alone entirely. Reviving it would mint a new id and strand everything attached
        // to the old one -- favourites, ratings, notes, reading history.
        if (known?.deleted_at) continue;
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
              `INSERT INTO lib_series (id, source, title, summary, author, status, genres, web, folder, books_count, library_id, age_rating, scanned_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
               ON CONFLICT (library_id, folder) DO UPDATE SET source=EXCLUDED.source, title=EXCLUDED.title, summary=EXCLUDED.summary,
                 author=EXCLUDED.author, status=EXCLUDED.status, genres=EXCLUDED.genres, web=EXCLUDED.web,
                 -- Never overwrite a rating we have with one we do not: a chapter whose ComicInfo omits
                 -- AgeRating must not silently un-rate a series a previous scan or an admin rated.
                 age_rating=COALESCE(EXCLUDED.age_rating, lib_series.age_rating),
                 scanned_at=now()
               RETURNING id`,
              [
                newSeriesId(), srcName, field(firstXml, 'Series') || folderRel.split('/').pop()!, cleanSummary(field(firstXml, 'Summary')),
                field(firstXml, 'Writer'), cleanStatus(field(firstXml, 'PublishingStatusTachiyomi') || field(firstXml, 'PublishingStatus')),
                (field(firstXml, 'Genre') || '').split(',').map((s) => s.trim()).filter(Boolean),
                field(firstXml, 'Web'), folderRel, files.length,
                known?.library_id ?? libraryIdFor(folderRel, libs),
                parseComicInfoAgeRating(field(firstXml, 'AgeRating')),
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
          await qq(
            `INSERT INTO lib_books (id, series_id, source, file, number, title, mtime, root) VALUES ${tuples.join(',')}
             ON CONFLICT (root, file) DO UPDATE SET series_id=EXCLUDED.series_id, number=EXCLUDED.number,
               title=EXCLUDED.title, mtime=EXCLUDED.mtime, updated_at=now()`,
            params,
          );

          // Set the cover AFTER the books exist. It used to be computed by hashing the first chapter's path,
          // which only worked while ids were a pure function of the path -- now it would dangle, and a
          // dangling cover_book_id takes out every cover and backdrop in the product.
          await qq(
            `UPDATE lib_series SET cover_book_id = (
               SELECT id FROM lib_books WHERE series_id = $1 ORDER BY number ASC, file ASC LIMIT 1
             ) WHERE id = $1`,
            [id],
          );
          return id;
        });
        void seriesId;
    }
  }
  await q(`UPDATE lib_series s SET books_count = c.n, latest_mtime = COALESCE(c.mt, 0)
           FROM (SELECT series_id, count(*) AS n, max(mtime) AS mt FROM lib_books GROUP BY series_id) c WHERE c.series_id = s.id`);
  // A chapter that has landed is no longer a failure. Cheap: the ledger only ever holds what is still missing.
  await q(`DELETE FROM chapter_failures f USING lib_books b WHERE b.series_id = f.series_id AND b.number = f.number`).catch(() => {});
  return { series: seenFolders.size, books: nBooks, ms: Date.now() - t0 };
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

