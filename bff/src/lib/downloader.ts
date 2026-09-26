// Chapter downloader: source adapter -> fetch page images -> package as CBZ + ComicInfo.xml into the
// owned library, mirroring Suwayomi's layout so the scanner picks it up. Cloudflare sites reuse FlareSolverr
// session cookies for the binary image fetches (FlareSolverr itself can't return binaries).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const AdmZip = require('adm-zip');
import { mkdir, stat, statfs } from 'fs/promises';
import { join, dirname, posix } from 'path';
import sharp from 'sharp';
import { getSource, SourceAdapter, SourceChapter, SourceSeries } from './sources';
import { cfSession } from './sources/flaresolverr';
import { DL_ROOT, XML_FORBIDDEN } from './library';
import { beginDownload, startedDownload, endDownload, holdPartial } from './downloadActivity';
import { classify, reportOk, reportFail, SourceStatus } from './sourceHealth';
import { withGate } from './gate';
import { imageExt } from './imageExt';
import { writeAtomic } from './fsAtomic';
import { paceFor, paceLevel, noteRateLimited, MAX_PAGE_GAP_MS } from './pace';
import { pageName, placeholderPng, PARTIAL_MANIFEST, type PartialManifest } from './partial';

export function sanitize(s: string, platform: NodeJS.Platform = process.platform): string {
  const name = (s || '').replace(/[\/\\:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 150) || 'untitled';
  return platform === 'win32' ? winSafe(name) : name;
}

/**
 * The names Windows cannot hold, made holdable. Windows only: on Linux every one of these is a legal name
 * and the server's folders must keep the exact spelling they already have on disk.
 *
 * ⚠️ Node reaches these through the `\\?\` long-path prefix, which CREATES them literally -- and then
 * Explorer can neither open nor delete a folder called `CON`, `Title.` or `Title ` (it strips the trailing
 * dot or space and finds nothing). Control characters are illegal in a Windows name outright. Tabs and
 * newlines have already become spaces above, so what is left to strip is the rest of 0x00-0x1F.
 * Reintroduce by returning `name` unchanged: relPath.test.ts "sanitize on win32" finds `CON` and `Title.`.
 */
function winSafe(name: string): string {
  const out = name
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f]+/g, '')
    .replace(/[. ]+$/, '')
    // CON, PRN, AUX, NUL, COM0-9, LPT0-9 (and the superscript digits Windows also reserves), with or
    // without an extension: `nul.txt` is the device too.
    .replace(/^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(?=$|[. ])/i, '$1_');
  return out || 'untitled';
}

function comicInfo(d: { series: string; number: number; title?: string; summary?: string; author?: string; genres?: string[]; web?: string; status?: string; scanlator?: string }): string {
  // XML_FORBIDDEN out first: a source's text is copied in verbatim, and a NUL in a description made a file
  // no XML reader should accept and one the scan could not index (#109, lib/library.ts).
  const esc = (x: any = '') => String(x ?? '').replace(XML_FORBIDDEN, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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

/** One page that did not arrive: what the site answered, so the ledger can say more than "N-1 of N". */
export interface PageFailure {
  index: number; // 0-based
  status: number; // the HTTP status, or 0 when the request threw
  type?: string; // content-type when the body was the problem (an error page, a body too small to be an image)
  bytes?: number; // body length when it was read and rejected
  error?: string; // why the request threw
}

/**
 * A chapter that arrived nearly whole, held in memory until the caller decides whether to keep it.
 *
 * `downloadChapter` alone never writes a truncated file (partialChapter.test.ts pins that). Writing one is
 * a second, explicit act: the fallback chain calls `write()` once every other source has also failed, and
 * the buffers live on the error until that catch ends. `write()` runs once; a second call returns the
 * first result.
 */
export interface PartialHold {
  missing: number[]; // 0-based indices that will be placeholders
  expected: number; // pages the file will contain, placeholders included
  pages: number; // real pages held
  write(): Promise<{ file: string; pages: number; missing: number[] }>;
}

/** What `downloadChapter` throws when pages are missing. `blockStatus` only when the SOURCE is at fault. */
export interface ChapterShortfall extends Error {
  pages: number;
  expected: number;
  status: SourceStatus;
  worst: number;
  blockStatus?: SourceStatus;
  failedPages: PageFailure[];
  partial?: PartialHold;
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
/** How many times a chapter may wait out a 429 and resume before we accept the source is refusing. */
const MAX_RESUMES = 3;
/**
 * How long a resume waits after a 429, per round, on top of whatever Retry-After the site sent.
 *
 * Retry-After is honoured as a floor and was the only wait there was, and a site that sends none was waited
 * out for the 5-second default, three times, then given up on. A site that has just refused a burst is not
 * ready 5 seconds later; growing waits give the limit time to lift. Tests set `0,0,0`.
 */
const RESUME_WAIT_MS = (process.env.DOWNLOAD_RESUME_WAIT_MS || '5000,10000,20000')
  .split(',').map((s) => Math.max(0, Number(s) || 0));
/**
 * How complete a chapter has to be for the shortfall to be the chapter's fault rather than the source's.
 *
 * 0.95 sits between the two things that must stay distinguishable: 17 of 20 pages (0.85) is a source that
 * has stopped serving and must still be caught, while 109 of 110 (0.99) and 98 of 101 (0.97) are the flaky
 * CDN reads that were putting whole sources into a day-long cooldown.
 */
const NEAR_COMPLETE = 0.95;
/**
 * How complete a chapter has to be to be offered as a PARTIAL: written with placeholders at the missing
 * indices and filled in by later sweeps (lib/partial.ts). 0 disables the hold entirely.
 *
 * Four pages in five is the owner's line: "149 of 155" is a chapter a person wants to read tonight with a
 * note about the one page, and 80 of 155 is not a chapter at all. The hold is never offered on a refusal
 * (403/429): the site said no, and the cooldown is the answer to that, not a file with holes in it.
 */
const PARTIAL_CHAPTER_FLOOR = process.env.PARTIAL_CHAPTER_FLOOR === undefined ? 0.8 : Math.max(0, Math.min(1, Number(process.env.PARTIAL_CHAPTER_FLOOR) || 0));
/**
 * Sentinels for `worst` below the HTTP range. `worst` is "the worst thing that happened to any page": a real
 * HTTP status when one was received, else one of these. NET_ERROR outranks EMPTY_BODY because a request that
 * never completed says more about the connection than one that completed with nothing in it.
 */
const EMPTY_BODY = 1; // HTTP 200 with no image behind it (under 256 bytes and not decodable)
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
 * Is this small body an image at all?
 *
 * The 256-byte floor below was the leading cause of the "N-1 of N pages" ledger rows: long-strip sources
 * slice a webtoon into fixed-height WebPs and the last remainder slice is often blank -- an all-white WebP
 * is 88-130 bytes, under the floor, so the chapter's last page was refused every night as an empty body.
 * A body that sharp can decode to a width and a height IS a page, however small; the floor now only
 * catches what it was for, the error pages and empty bodies a CDN hands out with a 200.
 */
async function isImage(buf: Buffer): Promise<boolean> {
  try {
    const m = await sharp(buf).metadata();
    return (m.width ?? 0) >= 1 && (m.height ?? 0) >= 1;
  } catch {
    return false;
  }
}

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
 *
 * ⚠️ `posix.join`, never `join`: this string is compared with what the database stores (`/`, see
 * lib/relPath.ts) by the nightly repair, the Health "Fix" chip and "Fetch again", and on Windows `join`
 * answers with `\` so none of the three ever matched. Identical on Linux, which is why only a static check
 * can catch a regression (desktopSwitchHygiene.test.ts).
 */
export const chapterFileRel = (seriesFolder: string, number: number): string => posix.join(seriesFolder, `Chapter ${number}.cbz`);

/**
 * The per-source chapter gate every download path runs under: at most DL_CONCURRENCY chapters at once and
 * a gap between their starts that doubles per pace level (1200 → 2400 → 4800 ms), so a source that has
 * answered 429 sees fewer chapters as well as slower pages until it has been quiet for a while.
 */
export const underGate = <T>(sourceId: string, fn: () => Promise<T>): Promise<T> =>
  withGate(sourceId, fn, { concurrency: DL_CONCURRENCY, minGapMs: DL_MIN_GAP_MS * 2 ** paceLevel(sourceId) });

/**
 * Download one chapter into <DL_ROOT>/<seriesFolder>/Chapter <n>.cbz.
 *
 * Resolves null when the file is already there (a download somebody else did), unless `replace` is set,
 * which the completion pass and the admin refetch use to write over a file they know to be partial or
 * stale. Throws a ChapterShortfall when pages are missing, `{ diskFull }` when the library disk is at its
 * floor, and whatever getPageUrls threw.
 */
export async function downloadChapter(input: DownloadInput, opts: { replace?: boolean } = {}): Promise<{ file: string; pages: number } | null> {
  const src = getSource(input.sourceId);
  if (!src) throw new Error(`unknown source ${input.sourceId}`);

  const rel = chapterFileRel(input.seriesFolder, input.chapter.number);
  const abs = join(DL_ROOT, rel);
  // A PATH check under DL_ROOT, and nothing more: is the file this very call would write already there.
  // It is free, so it runs before queueing for a slot, and it catches the same chapter twice in one run.
  //
  // ⚠️ It is not, and cannot be, the library's have-set. It sees one root and one filename convention, so
  // a chapter the scanner indexed under the READ-ONLY library root, or under any other name, is invisible
  // to it -- which is how a re-add used to re-download a series the library already held in full and then
  // file every chapter twice (#65). Deciding what a download RUN should fetch is the add path's job, from
  // `lib_books` across both roots: see the have-set in routes/sources.ts (addSeriesFromSource). Leaving
  // this here is deliberate; `replace` is what the admin refetch and the completion pass (lib/partial.ts)
  // use to write over a file they know to be stale or partial, and those paths never consult the have-set.
  if (!opts.replace && await stat(abs).then(() => true).catch(() => false)) return null;
  await assertFreeSpace();

  // Recorded HERE, the one function every download path ends in, so the downloads view sees all of them --
  // an add, a Fetch, a followed source's check, the nightly sweep, the repair (lib/downloadActivity.ts).
  const act = beginDownload({
    folder: input.seriesFolder, title: input.meta?.series || input.seriesFolder.split('/').pop() || input.seriesFolder,
    number: input.chapter.number, source: input.sourceId,
  });
  try {
    const r = await underGate(input.sourceId, () => { startedDownload(act); return fetchChapter(src, input, rel); });
    endDownload(act, { status: 'done', pages: r.pages });
    return r;
  } catch (e) {
    const hold = (e as Partial<ChapterShortfall>)?.partial;
    if (hold) holdPartial(act, hold);
    else endDownload(act, { status: 'failed', reason: String((e as Error)?.message || e).slice(0, 160) });
    throw e;
  }
}

export interface PageCtx {
  /** The chapter's id on the source: what the referer is derived from when the adapter declares none. */
  chapterSourceId: string;
  /** Starting gap and pool width. Default: `paceFor(src)`, which is the adapter's declaration at pace level 0. */
  gap?: number;
  workers?: number;
  /**
   * false = ask each index once and report; no resume pass. The completion pass uses it: a partial
   * chapter's missing page is asked for once a night, so the source sees exactly as many requests as there
   * are holes, and a 429 is still noted for the pace. Default true: the resume loop below.
   */
  retry?: boolean;
}

export interface PagesResult {
  /** By index over `urls`; only the indices asked for are ever filled. */
  page: (Buffer | null)[];
  ext: string[];
  /** The worst thing that happened to any page: an HTTP status, or a sentinel below 400. 0 = nothing failed. */
  worst: number;
  /** One entry per index still missing, with what the site answered. A later success removes the entry. */
  failed: Map<number, PageFailure>;
  /** Non-zero when the last round still ended in a 429: the source is refusing as this returns. */
  retryAfterMs: number;
  /** Any explicit refusal seen on any page, kept independently from the numerically largest HTTP status. */
  refusal?: Extract<SourceStatus, 'blocked' | 'rate_limited'>;
}

/**
 * Fetch the pages at `indices` from `urls`: the paced worker pool, then the bounded resume loop.
 *
 * Lifted out of fetchChapter so the completion pass (lib/partial.ts) can ask a source for exactly the
 * pages a partial chapter lacks; fetchChapter calls it with every index. Everything about politeness lives
 * here: the gap and pool width start from the source's pace level, a 429 stops every worker, and each
 * resume raises that level for the chapters that follow (lib/pace.ts).
 */
export async function fetchPages(src: SourceAdapter, urls: string[], indices: number[], ctx: PageCtx): Promise<PagesResult> {
  // Cloudflare-hosted images need FlareSolverr session cookies — the source declares this via requiresCloudflare.
  const cf = src.requiresCloudflare ? await cfSession(urls[0]).catch(() => null) : null;
  // Referer: the source's declared imageReferer (static or per-chapter), else the chapter url's own origin.
  const referer = typeof src.imageReferer === 'function'
    ? src.imageReferer(ctx.chapterSourceId)
    : src.imageReferer
      ?? (/^https?:/.test(ctx.chapterSourceId) ? `${new URL(ctx.chapterSourceId).origin}/` : '');
  let worst = 0; // worst HTTP status seen on a failed page, or a sentinel below 400 (EMPTY_BODY, NET_ERROR)

  // Held by position rather than appended as they arrive, so a page fetched on the RETRY below still lands
  // in reading order. The buffers were already all resident before (AdmZip holds what you add), so this
  // costs no memory that was not already spent.
  const page: (Buffer | null)[] = new Array(urls.length).fill(null);
  const ext: string[] = new Array(urls.length).fill('jpg');
  // What happened to each page that is still missing. Before this only the scalar `worst` survived, so a
  // ledger row read "109 of 110 pages" and nothing anywhere said which page, or whether it was a 404, an
  // 88-byte body or a timeout -- the three have three different fixes.
  const failed = new Map<number, PageFailure>();
  let retryAfterMs = 0; // set when the source answers 429; how long it asked us to wait
  // `worst` is useful evidence, but numeric ordering is not policy: a 500 beside a 429 must not hide that
  // the source explicitly asked us to stop. Keep refusal as its own fact for the chapter decision below.
  let refusal: Extract<SourceStatus, 'blocked' | 'rate_limited'> | undefined;

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
        failed.set(i, { index: i, status: r.status });
        if (r.status === 403) refusal = 'blocked';
        else if (r.status === 429 && refusal !== 'blocked') refusal = 'rate_limited';
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
      const type = ct.split(';')[0].trim();
      if (/^text\/|html|json/.test(ct)) { worst = Math.max(worst, 415); failed.set(i, { index: i, status: r.status, type }); return; } // hotlink/error page, not an image
      const buf = Buffer.from(await r.arrayBuffer());
      // 200 with nothing behind it -- unless the little that is there decodes as an image (see isImage).
      if (buf.length < 256 && !(await isImage(buf))) { worst = Math.max(worst, EMPTY_BODY); failed.set(i, { index: i, status: r.status, type, bytes: buf.length }); return; }
      // Content-Type first: some sources (and any source proxied through an extension server) serve pages
      // from extension-less URLs, and a wrong extension makes the chapter read as zero pages.
      page[i] = buf;
      ext[i] = imageExt(u, ct);
      failed.delete(i);
    } catch (e) {
      worst = Math.max(worst, NET_ERROR); // network/timeout; never outranks a real HTTP status
      const err = e as { name?: string; message?: string } | null;
      failed.set(i, { index: i, status: 0, error: err?.name === 'TimeoutError' ? 'timeout' : String(err?.message || 'fetch failed').slice(0, 40) });
    }
  };

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // The gap and the pool width start from the source's pace level (lib/pace.ts): the adapter's own
  // declaration at level 0, and one worker at a doubled gap for a source that answered 429 recently. The
  // clamping of a declared width lives in paceFor: a compiled plugin that declares nonsense gets one worker,
  // not zero -- `Math.max(1, NaN)` is NaN, and an Array.from of NaN workers fetches nothing and reports a
  // 0-page chapter as the site's fault.
  const pace = paceFor(src, { gapMs: DL_PAGE_GAP_MS });
  let gap = ctx.gap ?? pace.gap;
  let workers = ctx.workers ?? pace.workers;
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
  const run = async (idx: number[]): Promise<void> => {
    let next = 0;
    const worker = async () => {
      while (!retryAfterMs && next < idx.length) {
        const i = idx[next++];
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
    await Promise.all(Array.from({ length: Math.min(workers, idx.length) }, worker));
  };

  await run(indices);

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
  for (let round = 0; ctx.retry !== false && round < MAX_RESUMES; round++) {
    const gaps = indices.filter((i) => !page[i]);
    if (!gaps.length) break;
    if (gaps.length === indices.length && !retryAfterMs) break; // a silent refusal: do not ask twice
    if (retryAfterMs) {
      // The slow-down has to outlive this chapter: the next one on this source starts from a higher pace
      // level (one worker, a doubled gap, a longer chapter gate) instead of at full speed against a site
      // that just said no. Noted BEFORE the wait, so a chapter queued behind this one on the gate already
      // sees it. ⚠️ Delete this and pacePersists.test.ts fails: chapter 2 runs four wide again.
      noteRateLimited(src.id);
      // Retry-After is a floor, not the whole wait: a site that has just refused a burst is not ready one
      // second later, whatever the header said, and each further round waits longer.
      await sleep(Math.max(retryAfterMs, RESUME_WAIT_MS[round] ?? 0));
      retryAfterMs = 0;
      // Resume slower than the burst that caused this, or the wait only buys one more page. The burst is
      // what was refused, so a widened pool narrows to one here too: an engine that said 429 to four
      // overlapping requests is not going to like four more. A declared gap of 0 stays 0 inside this
      // chapter (the engine paces the site); the NEXT chapter gets the server default doubled (paceFor).
      gap = gap ? Math.min(gap * 2, MAX_PAGE_GAP_MS) : 0;
      workers = 1;
    } else if (round) {
      break; // a stable shortfall with no 429: the pages are not there, and one retry was enough to know
    }
    await run(gaps);
  }
  // A 429 in the final round was never noted by the loop above; it counts the same.
  if (retryAfterMs) noteRateLimited(src.id);

  return { page, ext, worst, failed, retryAfterMs, refusal };
}

/** The evidence a thrown shortfall carries: the first ten missing pages, in reading order. */
const evidenceOf = (failed: Map<number, PageFailure>): PageFailure[] =>
  [...failed.values()].sort((a, b) => a.index - b.index).slice(0, 10);

async function fetchChapter(
  src: SourceAdapter,
  input: DownloadInput,
  rel: string,
): Promise<{ file: string; pages: number }> {
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

  const pace = paceFor(src, { gapMs: DL_PAGE_GAP_MS });
  const { page, ext, worst, failed, refusal } = await fetchPages(src, urls, urls.map((_, i) => i), {
    chapterSourceId: input.chapter.sourceId, gap: pace.gap, workers: pace.workers,
  });

  const zip = new AdmZip();
  let n = 0;
  for (let i = 0; i < urls.length; i++) {
    // Named by INDEX (lib/partial.ts pageName): identical to the running count for a complete chapter, and
    // the slot a placeholder keeps for a page that is fetched later.
    if (page[i]) { zip.addFile(pageName(i, ext[i]), page[i]!); n++; }
  }
  const failedPages = evidenceOf(failed);
  if (!n) {
    const status = refusal ?? blameFor(worst);
    await reportFail(input.sourceId, status, `0/${urls.length} pages downloaded (HTTP ${worstLabel(worst)})`);
    throw Object.assign(new Error('no images downloaded (blocked?)'), { blockStatus: status, status, pages: 0, expected: urls.length, worst, failedPages });
  }
  // A PARTIAL chapter must not be written as a complete one.
  //
  // `worst` was only consulted when every single page failed, so seventeen of twenty pages was packed,
  // returned as success, and -- because an existing file is skipped on sight (see the stat check above) --
  // never fetched again. The reader would simply stop three pages early, for good, with nothing anywhere
  // recording that it had happened.
  //
  // Both values are the source's own account. A declared count larger than the URL list catches a short
  // listing; a URL list larger than a stale declared count still means every returned URL is a real slot.
  // Taking the maximum prevents one failed extra URL from being silently packed as a complete chapter.
  const declared = Number(input.chapter.pages);
  const expected = Math.max(urls.length, Number.isFinite(declared) && declared > 0 ? declared : 0);
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
    const refusing = refusal !== undefined; // the source saying no, whatever other page statuses occurred
    // Only empty bodies, or a source that listed more pages than it served: nothing was refused and nothing
    // timed out, so the softer bar applies. See EMPTY_TOLERANCE for the night this cost.
    const soft = worst < 400 && worst !== NET_ERROR;
    const blip = !refusing && ratio >= (soft ? EMPTY_TOLERANCE : NEAR_COMPLETE);
    const status = refusal ?? blameFor(worst);
    if (!blip) {
      await reportFail(input.sourceId, status, `${n}/${expected} pages downloaded (HTTP ${worstLabel(worst)})`);
    }
    // The hold: enough of the chapter to be worth keeping with placeholders, and the site did not say no.
    // Offered, not written -- see PartialHold. ⚠️ `!refusing` is the whole point of the second clause:
    // a 429 at 109 of 110 is still a refusal, and a file written on a refusal is a chapter the site will
    // never be asked to finish.
    const total = Math.max(urls.length, expected);
    const partial = !refusing && PARTIAL_CHAPTER_FLOOR > 0 && ratio >= PARTIAL_CHAPTER_FLOOR
      ? holdFor(src, input, rel, page, ext, total, n)
      : undefined;
    throw Object.assign(
      new Error(`incomplete chapter: ${n} of ${expected} pages`),
      // Carried so the caller can say which chapter, how short, and who was blamed -- see chapterFailures.ts.
      { pages: n, expected, status, worst, failedPages },
      // `blockStatus` ends the CALLER'S whole run, so it is reserved for the source actually refusing, or for
      // the connection being gone (or the CDN serving nothing) underneath a LARGE shortfall. One flaky page
      // must cost one chapter.
      refusing || (worst < 400 && !blip) ? { blockStatus: status } : {},
      partial ? { partial } : {},
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

/**
 * The partial hold for a chapter that arrived at or above PARTIAL_CHAPTER_FLOOR: the fetched pages by
 * index, a flat placeholder at every missing index, the manifest naming those indices, and the ComicInfo.
 *
 * Each placeholder takes the size of the NEAREST real page, so a long strip keeps its width and the
 * vertical reader's layout does not jump; 800×1200 when no page could be measured. Written atomically,
 * once, only when the caller asks.
 */
function holdFor(
  src: SourceAdapter, input: DownloadInput, rel: string,
  page: (Buffer | null)[], ext: string[], total: number, held: number,
): PartialHold {
  const missing: number[] = [];
  for (let i = 0; i < total; i++) if (!page[i]) missing.push(i);
  let written: Promise<{ file: string; pages: number; missing: number[] }> | null = null;
  const abs = join(DL_ROOT, rel);
  const dimsCache = new Map<number, { width: number; height: number }>();
  const dimsOf = async (i: number): Promise<{ width: number; height: number }> => {
    const hit = dimsCache.get(i);
    if (hit) return hit;
    const m = await sharp(page[i]!).metadata().catch(() => null);
    const d = { width: m?.width || 800, height: m?.height || 1200 };
    dimsCache.set(i, d);
    return d;
  };
  const nearestPresent = (i: number): number => {
    for (let d = 1; d < total; d++) {
      if (page[i - d]) return i - d;
      if (page[i + d]) return i + d;
    }
    return -1;
  };
  return {
    missing, expected: total, pages: held,
    write: () => written ??= (async () => {
      const zip = new AdmZip();
      let first: { width: number; height: number } | null = null;
      for (let i = 0; i < total; i++) {
        if (page[i]) { zip.addFile(pageName(i, ext[i]), page[i]!); continue; }
        const near = nearestPresent(i);
        const dims = near >= 0 ? await dimsOf(near) : { width: 800, height: 1200 };
        first ??= dims;
        zip.addFile(pageName(i, 'png'), await placeholderPng(dims.width, dims.height));
      }
      const manifest: PartialManifest = {
        version: 1, source: src.id, chapterSourceId: input.chapter.sourceId, expected: total, missing,
        placeholder: first ?? { width: 800, height: 1200 }, writtenAt: new Date().toISOString(),
      };
      zip.addFile(PARTIAL_MANIFEST, Buffer.from(JSON.stringify(manifest, null, 2)));
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
      await writeAtomic(abs, zip.toBuffer());
      return { file: rel, pages: total, missing };
    })(),
  };
}
