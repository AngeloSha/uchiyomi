// Chapter downloader: source adapter -> fetch page images -> package as CBZ + ComicInfo.xml into the
// owned library, mirroring Suwayomi's layout so the scanner picks it up. Cloudflare sites reuse FlareSolverr
// session cookies for the binary image fetches (FlareSolverr itself can't return binaries).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const AdmZip = require('adm-zip');
import { mkdir, writeFile, stat } from 'fs/promises';
import { join, dirname } from 'path';
import { getSource, SourceChapter, SourceSeries } from './sources';
import { cfSession } from './sources/flaresolverr';
import { DL_ROOT } from './library';
import { classify, reportOk, reportFail, SourceStatus } from './sourceHealth';

export function sanitize(s: string): string {
  return (s || '').replace(/[\/\\:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 150) || 'untitled';
}

function comicInfo(d: { series: string; number: number; title?: string; summary?: string; author?: string; genres?: string[]; web?: string; status?: string }): string {
  const esc = (x: any = '') => String(x ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<ComicInfo>',
    `  <Title>${esc(d.title || `Chapter ${d.number}`)}</Title>`,
    `  <Series>${esc(d.series)}</Series>`,
    `  <Number>${d.number}</Number>`,
    `  <Summary>${esc(d.summary)}</Summary>`,
    `  <Writer>${esc(d.author)}</Writer>`,
    `  <Genre>${esc((d.genres || []).join(', '))}</Genre>`,
    `  <Web>${esc(d.web)}</Web>`,
    `  <ty:PublishingStatusTachiyomi xmlns:ty="http://www.w3.org/2001/XMLSchema">${esc(d.status)}</ty:PublishingStatusTachiyomi>`,
    '</ComicInfo>',
  ].join('\n');
}

export interface DownloadInput {
  sourceId: string; // adapter id
  seriesFolder: string; // relative "<source>/<title>" (existing lib_series.folder, or new)
  chapter: SourceChapter;
  meta?: Partial<SourceSeries> & { series?: string };
}

/** Download one chapter into <LIBRARY_ROOT>/<seriesFolder>/Chapter <n>.cbz. Skips if already present. */
export async function downloadChapter(input: DownloadInput): Promise<{ file: string; pages: number; skipped?: boolean }> {
  const src = getSource(input.sourceId);
  if (!src) throw new Error(`unknown source ${input.sourceId}`);

  const rel = join(input.seriesFolder, `Chapter ${input.chapter.number}.cbz`);
  const abs = join(DL_ROOT, rel);
  if (await stat(abs).then(() => true).catch(() => false)) return { file: rel, pages: 0, skipped: true };

  let urls: string[];
  try {
    urls = await src.getPageUrls(input.chapter.sourceId);
  } catch (e) {
    const s = classify(e);
    if (s) await reportFail(input.sourceId, s, (e as Error)?.message || 'getPageUrls failed');
    throw e;
  }
  if (!urls.length) throw new Error('no page urls');

  // Cloudflare-hosted images need FlareSolverr session cookies — the source declares this via requiresCloudflare.
  const cf = src.requiresCloudflare ? await cfSession(urls[0]).catch(() => null) : null;
  // Referer: the source's declared imageReferer (static or per-chapter), else the chapter url's own origin.
  const referer = typeof src.imageReferer === 'function'
    ? src.imageReferer(input.chapter.sourceId)
    : src.imageReferer
      ?? (/^https?:/.test(input.chapter.sourceId) ? `${new URL(input.chapter.sourceId).origin}/` : '');
  const zip = new AdmZip();
  let n = 0;
  let worst = 0; // worst HTTP status (or 1 for network/timeout) seen on a failed page
  for (const u of urls) {
    const headers: Record<string, string> = {
      referer,
      accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      'user-agent': cf?.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    };
    if (cf?.cookie) headers.cookie = cf.cookie;
    try {
      const r = await fetch(u, { headers, signal: AbortSignal.timeout(45000) });
      if (!r.ok) { if (r.status >= 400) worst = Math.max(worst, r.status); continue; }
      const ct = (r.headers.get('content-type') || '').toLowerCase();
      if (/^text\/|html|json/.test(ct)) { worst = Math.max(worst, 415); continue; } // hotlink/error page, not an image — don't pack garbage
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 256) continue; // skip blocked/empty
      const ext = ((u.split('?')[0].split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg').slice(0, 4);
      zip.addFile(`${String(++n).padStart(4, '0')}.${ext}`, buf);
    } catch {
      if (!worst) worst = 1; // network/timeout
    }
  }
  if (!n) {
    const status: SourceStatus = worst === 1 ? 'down' : classify(null, worst >= 400 ? worst : undefined) || 'blocked';
    await reportFail(input.sourceId, status, `0/${urls.length} pages downloaded (HTTP ${worst || 'error'})`);
    throw Object.assign(new Error('no images downloaded (blocked?)'), { blockStatus: status });
  }
  await reportOk(input.sourceId); // a successful download clears any prior block

  zip.addFile('ComicInfo.xml', Buffer.from(comicInfo({
    series: input.meta?.series || input.meta?.title || '',
    number: input.chapter.number,
    title: input.chapter.title,
    summary: input.meta?.summary,
    author: input.meta?.author,
    genres: input.meta?.genres,
    web: input.meta?.url || input.chapter.sourceId,
    status: input.meta?.status,
  })));

  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, zip.toBuffer());
  return { file: rel, pages: n };
}
