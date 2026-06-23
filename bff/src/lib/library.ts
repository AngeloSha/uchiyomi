// Owned library scanner: reads the CBZ folder Suwayomi writes (replacing Komga's library role).
// Layout: <root>/<source>/<series title>/<chapter>.cbz ; each cbz carries ComicInfo.xml + page images.
import { readdir, stat } from 'fs/promises';
import { join } from 'path';
import { createHash } from 'crypto';
import sharp from 'sharp';
import { q } from './db';

// node-stream-zip reads the central directory only (cheap) and can stream a single entry.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const StreamZip = require('node-stream-zip');

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

/** Open one CBZ; return its ComicInfo.xml (if any) and image page count. */
async function readCbz(path: string): Promise<{ xml: string; pages: number }> {
  const zip = new StreamZip.async({ file: path });
  try {
    const entries = await zip.entries();
    let pages = 0;
    let xml = '';
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

/** Sorted list of image entry names inside a CBZ (used by the page server). */
export async function cbzPages(path: string): Promise<string[]> {
  const zip = new StreamZip.async({ file: path });
  try {
    const entries = await zip.entries();
    return Object.keys(entries)
      .filter((n) => !entries[n].isDirectory && IMG.test(n))
      .sort(naturalCmp);
  } finally {
    await zip.close();
  }
}

/** Raw bytes of a single entry inside a CBZ (used by the page server). */
export async function cbzEntry(path: string, name: string): Promise<Buffer> {
  const zip = new StreamZip.async({ file: path });
  try {
    return await zip.entryData(name);
  } finally {
    await zip.close();
  }
}

/** Real pixel dimensions of every page (opens the cbz once). The reader needs these to reserve the right
 *  height per page — without them, tall webtoon pages overlap. Cached in lib_books.page_dims after first read. */
export async function cbzPageDims(path: string): Promise<Array<{ name: string; width: number | null; height: number | null }>> {
  const zip = new StreamZip.async({ file: path });
  try {
    const entries = await zip.entries();
    const names = Object.keys(entries).filter((n) => !entries[n].isDirectory && IMG.test(n)).sort(naturalCmp);
    const out: Array<{ name: string; width: number | null; height: number | null }> = [];
    for (const name of names) {
      try {
        const m = await sharp(await zip.entryData(name)).metadata();
        out.push({ name, width: m.width ?? null, height: m.height ?? null });
      } catch {
        out.push({ name, width: null, height: null });
      }
    }
    return out;
  } finally {
    await zip.close();
  }
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
        const files = (await readdir(folderAbs).catch(() => [])).filter((f) => f.toLowerCase().endsWith('.cbz')).sort(naturalCmp);
        if (!files.length) continue;
        const seriesId = sid(folderRel);

        if (!seenSeries.has(seriesId)) {
          seenSeries.add(seriesId);
          const firstXml = (await readCbz(join(folderAbs, files[0])).catch(() => ({ xml: '', pages: 0 }))).xml;
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
          params.push(bid(rel), seriesId, src.name, rel, numFromName(f), f.replace(/\.cbz$/i, ''), st ? Math.floor(st.mtimeMs) : 0, root);
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

      const firstXml = (await readCbz(join(folderAbs, files[0])).catch(() => ({ xml: '', pages: 0 }))).xml;
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
        const info = await readCbz(join(folderAbs, f)).catch(() => ({ xml: '', pages: 0 }));
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
