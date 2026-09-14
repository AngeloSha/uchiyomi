// Chapter downloader: source adapter -> fetch page images -> package as CBZ + ComicInfo.xml into the
// owned library, mirroring Suwayomi's layout so the scanner picks it up. Cloudflare sites reuse FlareSolverr
// session cookies for the binary image fetches (FlareSolverr itself can't return binaries).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const AdmZip = require('adm-zip');
import { mkdir, stat, statfs } from 'fs/promises';
import { join, dirname } from 'path';
import { getSource, SourceChapter, SourceSeries } from './sources';
import { cfSession } from './sources/flaresolverr';
import { DL_ROOT } from './library';
import { classify, reportOk, reportFail, SourceStatus } from './sourceHealth';
import { withGate } from './gate';
import { imageExt } from './imageExt';
import { writeAtomic } from './fsAtomic';

export function sanitize(s: string): string {
  return (s || '').replace(/[\/\\:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 150) || 'untitled';
}

function comicInfo(d: { series: string; number: number; title?: string; summary?: string; author?: string; genres?: string[]; web?: string; status?: string; scanlator?: string }): string {
  const esc = (x: any = '') => String(x ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<ComicInfo>',
    `  <Title>${esc(d.title || `Chapter ${d.number}`)}</Title>`,
    `  <Series>${esc(d.series)}</Series>`,
    `  <Number>${d.number}</Number>`,
    `  <Summary>${esc(d.summary)}</Summary>`,
    `  <Writer>${esc(d.author)}</Writer>`,
    // The group that released this copy, in the ComicInfo v2.1 tag Mihon and Suwayomi write and Komga and
    // Kavita read -- so the file carries its provenance into any reader, not only into lib_books. Omitted
    // rather than written empty when the source named nobody, since an empty tag reads as "no translator".
    ...(d.scanlator ? [`  <Translator>${esc(d.scanlator)}</Translator>`] : []),
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
 * Pause between one page request and the next inside one chapter, for sources that do not declare their own.
 *
 * The gate above spaces CHAPTERS, and for a long time nothing spaced the images inside one. A chapter here
 * is 110-130 images fetched back to back, two chapters at a time: a burst of several requests a second
 * sustained for minutes. That burst is what earned the 429s on mangakakalot and natomanga, not anything the
 * sites changed -- measured at ~1.9 pages/second right up to the refusal. A quarter-second between pages
 * costs about 30s on a 120-page chapter, against a 75-minute cooldown for going too fast.
 *
 * That quarter second is the right answer for a site we scrape ourselves and the wrong one for a source
 * that only proxies through the extension engine, which has its own client and its own limits towards the
 * site (issue #37: extension downloads ran at the scraped-site pace for no reason). So pacing is now the
 * adapter's to declare -- `pageGapMs` overrides this value and `pageConcurrency` widens the pool past one
 * -- and this stays the default for every adapter that says nothing, which is every engine and pack site.
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
/**
 * Sentinels for `worst` below the HTTP range. `worst` is "the worst thing that happened to any page": a real
 * HTTP status when one was received, else one of these. NET_ERROR outranks EMPTY_BODY because a request that
 * never completed says more about the connection than one that completed with nothing in it.
 */
const EMPTY_BODY = 1; // HTTP 200 with no image behind it (under 256 bytes)
const NET_ERROR = 2;  // fetch threw: timeout, reset, DNS
/**
 * A softer completeness bar when the only failures were empty bodies.
 *
 * NEAR_COMPLETE is right for HTTP errors and network failures. It was wrong for a CDN that answers 200 with
 * nothing in it. Live, 151 of 176 pages arrived that way: 0.858 fell under the bar, and because an empty body
 * set no `worst` at all the status fell through classify() to the harshest 'blocked' tier. One chapter put
 * aqua -- 192 of 226 series -- into a 30-minute cooldown, the sweep skipped the other 164 for the night, and
 * nothing logged it. Half the chapter arriving as real images proves the CDN is up and the holes are
 * per-image; under half is an outage, and is treated as one.
 */
const EMPTY_TOLERANCE = 0.5;

/** Whose fault a shortfall is. Values below 400 are sentinels, not statuses, and none of them is a refusal. */
function blameFor(worst: number): SourceStatus {
  if (worst < 400) return 'down';
  return classify(null, worst) || 'blocked';
}
const worstLabel = (worst: number) => (worst >= 400 ? String(worst) : worst === EMPTY_BODY ? 'empty body' : 'error');

/**
 * Refuse to start a download when the library disk is nearly full.
 *
 * Nothing consulted free space before. The first sign would have been ENOSPC part-way through a chapter, on
 * a filesystem that was already at 87% and holds the library, every download and the only backup. Fails
 * OPEN when statfs is unavailable: a guard that cannot measure must not stop everything.
 */
const MIN_FREE_GB = process.env.MIN_FREE_GB === undefined ? 10 : Number(process.env.MIN_FREE_GB) || 0;
async function assertFreeSpace(): Promise<void> {
  if (!(MIN_FREE_GB > 0)) return;
  const free = await statfs(DL_ROOT).then((f) => Number(f.bavail) * Number(f.bsize)).catch(() => null);
  if (free === null || free >= MIN_FREE_GB * 2 ** 30) return;
  throw Object.assign(
    new Error(`${(free / 2 ** 30).toFixed(1)} GiB free under ${DL_ROOT}, floor is ${MIN_FREE_GB} GiB`),
    { diskFull: true },
  );
}

/**
 * Where a downloaded chapter lands, relative to DL_ROOT: named from the NUMBER alone, never the title or
 * the group. That is what makes a re-download of the same number land on the same lib_books row (the
 * scanner conflicts on (root, file)), which is what keeps reading progress attached across a refetch --
 * and it is why the refetch route in routes/admin.ts only ever offers a file at exactly this path.
 */
export const chapterFileRel = (seriesFolder: string, number: number): string => join(seriesFolder, `Chapter ${number}.cbz`);

export async function downloadChapter(input: DownloadInput): Promise<{ file: string; pages: number; skipped?: boolean }> {
  const src = getSource(input.sourceId);
  if (!src) throw new Error(`unknown source ${input.sourceId}`);

  const rel = chapterFileRel(input.seriesFolder, input.chapter.number);
  const abs = join(DL_ROOT, rel);
  // the already-downloaded check is free, so do it before queueing for a slot
  if (await stat(abs).then(() => true).catch(() => false)) return { file: rel, pages: 0, skipped: true };
  await assertFreeSpace();

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
  let worst = 0; // worst HTTP status seen on a failed page, or a sentinel below 400 (EMPTY_BODY, NET_ERROR)

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
      if (buf.length < 256) { worst = Math.max(worst, EMPTY_BODY); return; } // 200 with nothing behind it
      // Content-Type first: some sources (and any source proxied through an extension server) serve pages
      // from extension-less URLs, and a wrong extension makes the chapter read as zero pages.
      page[i] = buf;
      ext[i] = imageExt(u, ct);
    } catch {
      worst = Math.max(worst, NET_ERROR); // network/timeout; never outranks a real HTTP status
    }
  };

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let gap = src.pageGapMs ?? DL_PAGE_GAP_MS;
  // Pool width is the adapter's call (see pageConcurrency in sources/types.ts). One for everything that does
  // not say otherwise, which reproduces the sequential loop this used to be exactly: no sleep before the
  // first page, `gap` between starts.
  // Clamped, and NaN-proof: a compiled plugin that declares nonsense gets one worker, not zero -- `Math.max(1,
  // NaN)` is NaN, and an Array.from of NaN workers fetches nothing and reports a 0-page chapter as the site's
  // fault. The ceiling is the same one the env knob has.
  const declared = Number(src.pageConcurrency);
  let workers = Number.isFinite(declared) ? Math.min(8, Math.max(1, Math.floor(declared))) : 1;
  let lastStart = -Infinity;
  let lastDone = -Infinity;

  /**
   * Fetch `indices` through up to `workers` loops that each pull the next index off a shared cursor.
   *
   * The gap is a floor between page requests across the whole pool, not per worker: each loop reserves its
   * start slot synchronously (no await between reading the clocks and advancing `lastStart`) and only then
   * sleeps until that slot comes round, so the request rate towards the source is the same however wide
   * the pool. The slot is measured from the later of the previous START and the previous COMPLETION. The
   * completion matters: the sequential loop this replaces slept `gap` AFTER each page, so a slow site got
   * `rtt + gap` between requests -- measuring from starts alone would have handed a 500ms site the exact
   * 1.9 pages/second that earned the 429s, with every pacing test still green. Results land by position
   * (`page[i]`), so reading order does not depend on arrival order.
   *
   * The loop condition, not a break, checks `retryAfterMs`: the first 429 stops EVERY worker from starting
   * another page while the ones in flight finish. Carrying on collects ninety more refusals, turns a pause
   * into a "12 of 108 pages" failure, and earns a cooldown for behaviour that was ours. Re-checked after the
   * sleep too, since a slot reserved before the 429 landed is exactly the request the site asked us not to
   * make.
   */
  const run = async (indices: number[]): Promise<void> => {
    let next = 0;
    const worker = async () => {
      while (!retryAfterMs && next < indices.length) {
        const i = indices[next++];
        const at = Math.max(Date.now(), lastStart + gap, lastDone + gap);
        lastStart = at;
        const wait = at - Date.now();
        if (wait > 0) {
          await sleep(wait);
          if (retryAfterMs) return;
        }
        await fetchPage(urls[i], i);
        lastDone = Date.now();
      }
    };
    await Promise.all(Array.from({ length: Math.min(workers, indices.length) }, worker));
  };

  await run(urls.map((_, i) => i));

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
      // Resume slower than the burst that caused this, or the wait only buys one more page. The burst is
      // what was refused, so a widened pool narrows to one here too: an engine that said 429 to four
      // overlapping requests is not going to like four more.
      gap = gap ? Math.min(gap * 2, MAX_PAGE_GAP_MS) : 0;
      workers = 1;
    } else if (round) {
      break; // a stable shortfall with no 429: the pages are not there, and one retry was enough to know
    }
    await run(gaps);
  }

  let n = 0;
  for (let i = 0; i < urls.length; i++) {
    if (page[i]) zip.addFile(`${String(++n).padStart(4, '0')}.${ext[i]}`, page[i]!);
  }
  if (!n) {
    const status = blameFor(worst);
    await reportFail(input.sourceId, status, `0/${urls.length} pages downloaded (HTTP ${worstLabel(worst)})`);
    throw Object.assign(new Error('no images downloaded (blocked?)'), { blockStatus: status, status, pages: 0, expected: urls.length, worst });
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
    // Only empty bodies, or a source that listed more pages than it served: nothing was refused and nothing
    // timed out, so the softer bar applies. See EMPTY_TOLERANCE for the night this cost.
    const soft = worst < 400 && worst !== NET_ERROR;
    const blip = !refusing && ratio >= (soft ? EMPTY_TOLERANCE : NEAR_COMPLETE);
    const status = blameFor(worst);
    if (!blip) {
      await reportFail(input.sourceId, status, `${n}/${expected} pages downloaded (HTTP ${worstLabel(worst)})`);
    }
    throw Object.assign(
      new Error(`incomplete chapter: ${n} of ${expected} pages`),
      // Carried so the caller can say which chapter, how short, and who was blamed -- see chapterFailures.ts.
      { pages: n, expected, status, worst },
      // `blockStatus` ends the CALLER'S whole run, so it is reserved for the source actually refusing, or for
      // the connection being gone (or the CDN serving nothing) underneath a LARGE shortfall. One flaky page
      // must cost one chapter.
      refusing || (worst < 400 && !blip) ? { blockStatus: status } : {},
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
    scanlator: input.chapter.scanlator,
  })));

  await mkdir(dirname(abs), { recursive: true });
  // Atomic, because the skip check at the top of downloadChapter is a bare stat(): a chapter half-written
  // when the container went down would otherwise be honoured as complete on every later sweep, forever.
  await writeAtomic(abs, zip.toBuffer());
  return { file: rel, pages: n };
}
