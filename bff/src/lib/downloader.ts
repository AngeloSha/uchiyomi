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
import { withGate } from './gate';
import { imageExt } from './imageExt';

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

// Politeness limits, applied per source. Adding a series and importing hundreds both fan out through here,
// so this is the one place that decides how hard we ever hit a site.
const DL_CONCURRENCY = Number(process.env.DOWNLOAD_CONCURRENCY || 2);
const DL_MIN_GAP_MS = Number(process.env.DOWNLOAD_MIN_GAP_MS || 1200);
/**
 * Space between PAGE requests inside one chapter.
 *
 * The gate above spaces CHAPTERS, and for a long time nothing spaced the images inside one. A chapter here
 * is 110-130 images fetched back to back, two chapters at a time: a burst of several requests a second
 * sustained for minutes. That burst is what earned the 429s on mangakakalot and natomanga, not anything the
 * sites changed -- measured at ~1.9 pages/second right up to the refusal. A quarter-second between pages
 * costs about 30s on a 120-page chapter, against a 75-minute cooldown for going too fast.
 */
const DL_PAGE_GAP_MS = Number(process.env.DOWNLOAD_PAGE_GAP_MS || 250);
/** Ceiling for the adaptive slow-down after a 429, so a resume cannot crawl indefinitely. */
const MAX_PAGE_GAP_MS = 2000;
/** How many times a chapter may wait out a 429 and resume before we accept the source is refusing. */
const MAX_RESUMES = 3;

/** Download one chapter into <LIBRARY_ROOT>/<seriesFolder>/Chapter <n>.cbz. Skips if already present. */
/**
 * How complete a chapter has to be for the shortfall to be the chapter's fault rather than the source's.
 *
 * 0.95 sits between the two things that must stay distinguishable: 17 of 20 pages (0.85) is a source that
 * has stopped serving and must still be caught, while 109 of 110 (0.99) and 98 of 101 (0.97) are the flaky
 * CDN reads that were putting whole sources into a day-long cooldown.
 */
const NEAR_COMPLETE = 0.95;

export async function downloadChapter(input: DownloadInput): Promise<{ file: string; pages: number; skipped?: boolean }> {
  const src = getSource(input.sourceId);
  if (!src) throw new Error(`unknown source ${input.sourceId}`);

  const rel = join(input.seriesFolder, `Chapter ${input.chapter.number}.cbz`);
  const abs = join(DL_ROOT, rel);
  // the already-downloaded check is free, so do it before queueing for a slot
  if (await stat(abs).then(() => true).catch(() => false)) return { file: rel, pages: 0, skipped: true };

  return withGate(input.sourceId, () => fetchChapter(src, input, rel), { concurrency: DL_CONCURRENCY, minGapMs: DL_MIN_GAP_MS });
}

async function fetchChapter(
  src: NonNullable<ReturnType<typeof getSource>>,
  input: DownloadInput,
  rel: string,
): Promise<{ file: string; pages: number; skipped?: boolean }> {
  const abs = join(DL_ROOT, rel);
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
  let worst = 0; // worst HTTP status (or 1 for network/timeout) seen on a failed page

  // Held by position rather than appended as they arrive, so a page fetched on the RETRY below still lands
  // in reading order. The buffers were already all resident before (AdmZip holds what you add), so this
  // costs no memory that was not already spent.
  const page: (Buffer | null)[] = new Array(urls.length).fill(null);
  const ext: string[] = new Array(urls.length).fill('jpg');
  let retryAfterMs = 0; // set when the source answers 429; how long it asked us to wait

  const fetchPage = async (u: string, i: number): Promise<void> => {
    const headers: Record<string, string> = {
      referer,
      accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      'user-agent': cf?.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    };
    if (cf?.cookie) headers.cookie = cf.cookie;
    // Source-declared extra headers (e.g. auth for a source that proxies its own images). Declared as a
    // capability rather than keyed off the adapter id, so the core never special-cases a particular source.
    Object.assign(headers, typeof src.imageHeaders === 'function' ? src.imageHeaders(u) : src.imageHeaders ?? {});
    try {
      const r = await fetch(u, { headers, signal: AbortSignal.timeout(45000) });
      if (!r.ok) {
        if (r.status >= 400) worst = Math.max(worst, r.status);
        // A 429 is the site asking for room, and the rest of this chapter is another hundred requests it did
        // not ask for. Note it (and any Retry-After it sent) so the burst can stop instead of finishing the
        // loop and collecting a hundred more of them, which is how 12 of 108 pages arrived.
        if (r.status === 429) {
          const ra = Number(r.headers.get('retry-after'));
          retryAfterMs = Math.max(retryAfterMs, Number.isFinite(ra) && ra > 0 ? Math.min(ra, 120) * 1000 : 5000);
        }
        return;
      }
      const ct = (r.headers.get('content-type') || '').toLowerCase();
      if (/^text\/|html|json/.test(ct)) { worst = Math.max(worst, 415); return; } // hotlink/error page, not an image
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 256) return; // blocked/empty
      // Content-Type first: some sources (and any source proxied through an extension server) serve pages
      // from extension-less URLs, and a wrong extension makes the chapter read as zero pages.
      page[i] = buf;
      ext[i] = imageExt(u, ct);
    } catch {
      if (!worst) worst = 1; // network/timeout
    }
  };

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let gap = DL_PAGE_GAP_MS;

  for (let i = 0; i < urls.length; i++) {
    if (i && gap) await sleep(gap);
    await fetchPage(urls[i], i);
    // Stop the moment the site says slow down. Carrying on collects ninety more refusals, turns a pause into
    // a "12 of 108 pages" failure, and earns a cooldown for behaviour that was ours.
    if (retryAfterMs) break;
  }

  /**
   * Wait out a rate limit and pick up where we stopped, a bounded number of times.
   *
   * Almost every shortfall seen on this install is one or two pages out of a hundred, on a CDN that answers
   * again immediately, so the first pass here is the plain retry it has always been.
   *
   * What it did NOT do is survive a 429 on the FIRST page. `gaps.length < urls.length` is false when
   * nothing has arrived, so the whole block was skipped -- INCLUDING the sleep. The site had said "wait
   * five seconds"; instead the chapter was reported as "0/115 pages downloaded (HTTP 429)" 1.28 seconds
   * after a single request, which put the source in a cooldown and abandoned the other 58 chapters of the
   * run. Every "I tried a different source and it still failed" on this install is that line.
   *
   * Nothing arriving IS a refusal and hammering it earns a real block -- but a 429 is the one refusal that
   * comes with the remedy attached, and discarding that instruction is not politeness, it is deafness.
   */
  for (let round = 0; round < MAX_RESUMES; round++) {
    const gaps = page.map((b, i) => (b ? -1 : i)).filter((i) => i >= 0);
    if (!gaps.length) break;
    if (gaps.length === urls.length && !retryAfterMs) break; // a silent refusal: do not ask twice
    if (retryAfterMs) {
      await sleep(retryAfterMs);
      retryAfterMs = 0;
      // Resume slower than the burst that caused this, or the wait only buys one more page.
      gap = gap ? Math.min(gap * 2, MAX_PAGE_GAP_MS) : 0;
    } else if (round) {
      break; // a stable shortfall with no 429: the pages are not there, and one retry was enough to know
    }
    for (const i of gaps) {
      if (gap) await sleep(gap);
      await fetchPage(urls[i], i);
      if (retryAfterMs) break;
    }
  }

  let n = 0;
  for (let i = 0; i < urls.length; i++) {
    if (page[i]) zip.addFile(`${String(++n).padStart(4, '0')}.${ext[i]}`, page[i]!);
  }
  if (!n) {
    const status: SourceStatus = worst === 1 ? 'down' : classify(null, worst >= 400 ? worst : undefined) || 'blocked';
    await reportFail(input.sourceId, status, `0/${urls.length} pages downloaded (HTTP ${worst || 'error'})`);
    throw Object.assign(new Error('no images downloaded (blocked?)'), { blockStatus: status });
  }
  // A PARTIAL chapter must not be written as a complete one.
  //
  // `worst` was only consulted when every single page failed, so seventeen of twenty pages was packed,
  // returned as success, and -- because an existing file is skipped on sight (see the stat check above) --
  // never fetched again. The reader would simply stop three pages early, for good, with nothing anywhere
  // recording that it had happened.
  //
  // `expected` prefers what the SOURCE said the chapter contains, which MangaDex supplies, and falls back
  // to the number of page URLs we were given. Both are the source's own account of the chapter.
  const expected = input.chapter.pages && input.chapter.pages > 0 ? input.chapter.pages : urls.length;
  if (n < expected) {
    /**
     * The chapter is still refused. What changed is who gets BLAMED for it.
     *
     * The first version of this called reportFail unconditionally, which put the whole source into an
     * escalating cooldown. That is right for a source that is refusing us and badly wrong for a CDN that
     * dropped one image: on this install it blocked mangakakalot over 98 of 101 pages and natomanga over
     * 109 of 110, and a 92-chapter fill stopped after three because every caller breaks on `blockStatus`.
     * The comment below already said an incomplete chapter is "not necessarily a reason to declare the
     * whole source blocked", and the line above it did exactly that anyway.
     *
     * So: near-complete after a retry is a bad chapter, recorded against the chapter. A large shortfall, or
     * an outright refusal status, is a bad SOURCE and still earns the cooldown.
     */
    const ratio = n / expected;
    const refusing = worst === 403 || worst === 429; // the source saying no, whatever the page count
    const blip = ratio >= NEAR_COMPLETE && !refusing;
    const status: SourceStatus = worst === 1 ? 'down' : classify(null, worst >= 400 ? worst : undefined) || 'blocked';
    if (!blip) {
      await reportFail(input.sourceId, status, `${n}/${expected} pages downloaded (HTTP ${worst || 'error'})`);
    }
    throw Object.assign(
      new Error(`incomplete chapter: ${n} of ${expected} pages`),
      // `blockStatus` ends the CALLER'S whole run, so it is now reserved for the source actually refusing,
      // or for the network being gone underneath a large shortfall. One flaky page must cost one chapter.
      refusing || (worst === 1 && !blip) ? { blockStatus: status } : {},
    );
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
