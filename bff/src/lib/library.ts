// Owned library scanner: reads the CBZ folder Suwayomi writes (replacing Komga's library role).
// Layout: <root>/<source>/<series title>/<chapter>.cbz ; each cbz carries ComicInfo.xml + page images.
import { readdir, stat, readFile } from 'fs/promises';
import { join } from 'path';
import { createHash } from 'crypto';
import sharp from 'sharp';
import { q } from './db';

// node-stream-zip reads the central directory only (cheap) and can stream a single entry.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const StreamZip = require('node-stream-zip');
// node-unrar-js: pure-wasm RAR reader (no native build) for .cbr comic archives.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createExtractorFromData } = require('node-unrar-js');

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

function sid(rel: string): string {
  return 's_' + createHash('sha1').update(rel).digest('hex').slice(0, 20);
}
function bid(rel: string): string {
  return 'b_' + createHash('sha1').update(rel).digest('hex').slice(0, 20);
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
function numFromName(name: string): number {
  const m = name.match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : 0;
}
function naturalCmp(a: string, b: string): number {
  return numFromName(a) - numFromName(b) || a.localeCompare(b);
}

// A "chapter" can be a CBZ (zip), a CBR (rar), or a loose folder of images. These helpers read all three so
// the scanner + page server are format-agnostic. (The downloader still WRITES CBZ; this is read-side only.)
type ChapterKind = 'zip' | 'rar' | 'dir';
function chapterKind(path: string): ChapterKind {
  if (/\.(cbz|zip)$/i.test(path)) return 'zip';
  if (/\.(cbr|rar)$/i.test(path)) return 'rar';
  return 'dir';
}

/** Chapter entries inside a series folder: .cbz/.cbr/.zip/.rar files + subfolders that contain images. */
export async function listChapters(folderAbs: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(folderAbs, { withFileTypes: true }).catch(() => [])) {
    if (e.isFile() && /\.(cbz|cbr|zip|rar)$/i.test(e.name)) out.push(e.name);
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
  if (k === 'dir') return readFile(join(path, name));
  if (k === 'rar') return rarExtract(await rarExtractor(path), name);
  const zip = new StreamZip.async({ file: path });
  try {
    return await zip.entryData(name);
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
  if (chapterKind(path) === 'zip') {
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
export async function persistScan(): Promise<{ series: number; books: number; ms: number }> {
  const t0 = Date.now();
  let nBooks = 0;
  const seenSeries = new Set<string>();
  for (const root of [LIBRARY_ROOT, DL_ROOT]) {
    const sources = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const src of sources) {
      if (!src.isDirectory()) continue;
      const seriesDirs = await readdir(join(root, src.name), { withFileTypes: true }).catch(() => []);
      for (const sd of seriesDirs) {
        if (!sd.isDirectory()) continue;
        const folderRel = `${src.name}/${sd.name}`;
        const folderAbs = join(root, src.name, sd.name);
        const files = await listChapters(folderAbs); // .cbz/.cbr files + loose image folders
        if (!files.length) continue;
        const seriesId = sid(folderRel);

        if (!seenSeries.has(seriesId)) {
          seenSeries.add(seriesId);
          const firstXml = (await readArchive(join(folderAbs, files[0])).catch(() => ({ xml: '', pages: 0 }))).xml;
          await q(
            `INSERT INTO lib_series (id, source, title, summary, author, status, genres, web, folder, books_count, cover_book_id, scanned_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
             ON CONFLICT (id) DO UPDATE SET source=EXCLUDED.source, title=EXCLUDED.title, summary=EXCLUDED.summary,
               author=EXCLUDED.author, status=EXCLUDED.status, genres=EXCLUDED.genres, web=EXCLUDED.web,
               cover_book_id=EXCLUDED.cover_book_id, scanned_at=now()`,
            [
              seriesId, src.name, field(firstXml, 'Series') || sd.name, cleanSummary(field(firstXml, 'Summary')),
              field(firstXml, 'Writer'), cleanStatus(field(firstXml, 'PublishingStatusTachiyomi') || field(firstXml, 'PublishingStatus')),
              (field(firstXml, 'Genre') || '').split(',').map((s) => s.trim()).filter(Boolean),
              field(firstXml, 'Web'), folderRel, files.length, bid(`${folderRel}/${files[0]}`),
            ],
          );
        }

        const params: any[] = [];
        const tuples: string[] = [];
        for (const f of files) {
          const rel = `${folderRel}/${f}`;
          const st = await stat(join(folderAbs, f)).catch(() => null);
          const b = params.length;
          tuples.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8})`);
          params.push(bid(rel), seriesId, src.name, rel, numFromName(f), f.replace(/\.(cbz|cbr|zip|rar)$/i, ''), st ? Math.floor(st.mtimeMs) : 0, root);
          nBooks++;
        }
        await q(
          `INSERT INTO lib_books (id, series_id, source, file, number, title, mtime, root) VALUES ${tuples.join(',')}
           ON CONFLICT (id) DO UPDATE SET number=EXCLUDED.number, title=EXCLUDED.title, mtime=EXCLUDED.mtime, root=EXCLUDED.root, updated_at=now()`,
          params,
        );
      }
    }
  }
  await q(`UPDATE lib_series s SET books_count = c.n, latest_mtime = COALESCE(c.mt, 0)
           FROM (SELECT series_id, count(*) AS n, max(mtime) AS mt FROM lib_books GROUP BY series_id) c WHERE c.series_id = s.id`);
  return { series: seenSeries.size, books: nBooks, ms: Date.now() - t0 };
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
  await q(
    `UPDATE lib_books b SET published_at = v.p
     FROM (VALUES ${values.join(',')}) AS v(n, p), lib_series s
     WHERE s.folder = $1 AND b.series_id = s.id AND b.number = v.n AND b.published_at IS DISTINCT FROM v.p`,
    params,
  );
}

/** Walk the library and return the full series/book tree with metadata + page counts. */
export async function scanLibrary(
  root: string = LIBRARY_ROOT,
  opts: { maxSeries?: number } = {},
): Promise<ScanSeries[]> {
  const out: ScanSeries[] = [];
  const sources = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const src of sources) {
    if (!src.isDirectory()) continue;
    const seriesDirs = await readdir(join(root, src.name), { withFileTypes: true }).catch(() => []);
    for (const sd of seriesDirs) {
      if (!sd.isDirectory()) continue;
      if (opts.maxSeries && out.length >= opts.maxSeries) return out;
      const folderRel = `${src.name}/${sd.name}`;
      const folderAbs = join(root, src.name, sd.name);
      const files = (await readdir(folderAbs).catch(() => []))
        .filter((f) => f.toLowerCase().endsWith('.cbz'))
        .sort(naturalCmp);
      if (!files.length) continue;

      const firstXml = (await readArchive(join(folderAbs, files[0])).catch(() => ({ xml: '', pages: 0 }))).xml;
      const series: ScanSeries = {
        id: sid(folderRel),
        source: src.name,
        title: field(firstXml, 'Series') || sd.name,
        summary: cleanSummary(field(firstXml, 'Summary')),
        author: field(firstXml, 'Writer'),
        status: cleanStatus(field(firstXml, 'PublishingStatusTachiyomi') || field(firstXml, 'PublishingStatus')),
        genres: (field(firstXml, 'Genre') || '').split(',').map((s) => s.trim()).filter(Boolean),
        web: field(firstXml, 'Web'),
        folder: folderRel,
        books: [],
      };
      for (const f of files) {
        const info = await readArchive(join(folderAbs, f)).catch(() => ({ xml: '', pages: 0 }));
        series.books.push({
          id: bid(`${folderRel}/${f}`),
          seriesId: series.id,
          file: `${folderRel}/${f}`,
          number: parseFloat(field(info.xml, 'Number') || '') || numFromName(f),
          title: field(info.xml, 'Title') || f.replace(/\.cbz$/i, ''),
          pages: info.pages,
        });
      }
      out.push(series);
    }
  }
  return out;
}
