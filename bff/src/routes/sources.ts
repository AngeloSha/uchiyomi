// Search across sources and add a new series to the library (queues its download). Backed by the source
// adapters + the downloader. The cover proxy lives under /img (cookie auth) so <img> tags can load it.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authenticate, userIdOf, roleOf } from '../lib/auth';
import { getSource, listSources, isSwAdapterId, SW_PREFIX, withTimeout } from '../lib/sources';
import type { SourceAdapter, SourceSeries, SourceChapter } from '../lib/sources/types';
import { downloadChapter, sanitize } from '../lib/downloader';
import { noteChapterFailure } from '../lib/chapterFailures';
import { persistScan, setBookDates } from '../lib/library';
import { fetchAniListArt, fetchTrendingManhwa, TrendingItem } from '../lib/anilist';
import { q, one } from '../lib/db';
import { healthAll, isDisabled, blockedNow, reportLatest, reportFail, reportSlow, classify } from '../lib/sourceHealth';
import { diagnose, EMPTY_SUSPECT } from '../lib/sourceDiagnosis';
import {
  gapsOf, assess, verdict, authorise, putPlan, getPlan, planKey, sweepPlans,
  MIN_HAVE, PLAN_TTL, type PlanCandidate, type Refusal,
} from '../lib/fill';

/**
 * The most chapters one confirmed fill may fetch.
 *
 * At the download gate's 1200ms minimum spacing plus fetch time, 300 chapters is several hours of background
 * work. A bound, not a policy: it exists so a mis-click cannot start something that runs all week.
 */
const FILL_MAX_CHAPTERS = 300;
import { logAudit } from '../lib/audit';
import { env } from '../env';
// The "already in library" annotation is deliberately library-wide: it answers "would adding this be a
// duplicate on this server", which is a property of the server, not of the person asking.
//
// Which SOURCES you may reach is the opposite: entirely about who is asking, which is what `viewCtxFor` and
// `sourceAllowedFor` answer.
import { visibleToAll, viewCtxFor, sourceAllowedFor, browsable, Params, type ViewCtx, hideAdult } from '../lib/visibility';

interface Job {
  title: string; total: number; done: number;
  status: 'downloading' | 'done' | 'error';
  reason?: string;
  /** When it stopped, so a finished one can age out. A FAILED one never does: it is the only record. */
  finishedAt?: number;
}
const jobs = new Map<string, Job>();

/** How long a completed download stays listed. `jobs.delete` had exactly one call site -- the chapter-1
 *  failure path -- so a successful job was never removed and the strip filled with green cards that only a
 *  restart cleared. Swept lazily on read rather than on a timer: the client polls this often enough. */
const DONE_TTL = 5 * 60_000;
function sweepJobs(now = Date.now()): void {
  for (const [folder, j] of jobs) {
    if (j.status === 'done' && j.finishedAt && now - j.finishedAt > DONE_TTL) jobs.delete(folder);
  }
}

// Trending recommendations are global + slow-moving; cache the AniList pull for a few hours.
let trendingCache: { at: number; items: TrendingItem[] } | null = null;
/** Canonical title key used for dedupe, grouping and "already in library" checks. */
export const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, '');

// Provider order for cross-source "find": by each source's declared preferredOrder (Aqua = 0), then
// registry/load order. Derived from the loaded sources so it works with whatever the user has installed.
function findOrder(): string[] {
  return listSources().slice().sort((a, b) => (a.preferredOrder ?? 999) - (b.preferredOrder ?? 999)).map((s) => s.id);
}
const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'to', 'in', 'is', 'no', 'my', 'i', 'on', 'with', 'for']);
// Best title-match for a provider, or null if it doesn't really carry the title. NEVER fall back to list[0]
// — a provider's first result for a title it lacks is an unrelated manga (the "wrong manga" bug).
function pickBest<T extends { title: string }>(list: T[], term: string): T | null {
  if (!list.length) return null;
  const n = norm(term);
  const exact = list.find((r) => norm(r.title) === n);
  if (exact) return exact;
  const sub = list.find((r) => { const t = norm(r.title); return t.length > 2 && (t.includes(n) || n.includes(t)); });
  if (sub) return sub;
  // token overlap: most meaningful query words must appear in the title
  const qw = term.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w));
  if (qw.length) {
    let best: T | null = null;
    let score = 0;
    for (const r of list) {
      const tw = new Set(r.title.toLowerCase().split(/[^a-z0-9]+/));
      const hit = qw.filter((w) => tw.has(w)).length / qw.length;
      if (hit > score) { score = hit; best = r; }
    }
    if (score >= 0.7) return best;
  }
  return null;
}

/**
 * Which of these titles the library already has.
 *
 * Was `SELECT s.title FROM lib_series` -- every row, every column value in memory, once per source per wall
 * paint, and again per page as you scroll. Six sources on a 214-series library is six full scans to answer a
 * question about twenty-four titles. The normalisation matches `norm()` and the duplicate check in
 * `addSeriesFromSource`, which has always compared this way.
 */
const NORM_SQL = "lower(regexp_replace(s.title, '[^a-zA-Z0-9]', '', 'g'))";
async function inLibrary(titles: Array<string | undefined>): Promise<Set<string>> {
  const keys = [...new Set(titles.map((t) => norm(t || '')).filter(Boolean))];
  if (!keys.length) return new Set();
  const rows = await q<{ k: string }>(
    `SELECT ${NORM_SQL} AS k FROM lib_series s WHERE ${visibleToAll('s')} AND ${NORM_SQL} = ANY($1)`,
    [keys],
  ).catch(() => []);
  return new Set(rows.map((r) => r.k));
}

/**
 * How long one source gets to answer "what is new".
 *
 * This handler was the only one of its siblings with no bound of its own: `search-all` caps the adapter at
 * 20s and `find` at 25s, while this called `src.latest()` bare and inherited whatever the adapter allowed
 * itself -- 30s for Suwayomi, 95s for a FlareSolverr-backed site. Production's worst measured call was 63.5s
 * for a single source, against a median of 355ms. Eight seconds is well past the p90 of 2.5s.
 */
const LATEST_TIMEOUT = env.SOURCE_LATEST_TIMEOUT_MS;
const LATEST_TTL = 10 * 60_000;
/** What the two lookups an add must do inline are allowed to take. Matches the /find handler's budget. */
const ADD_LOOKUP_TIMEOUT = 20_000;

/**
 * What `/api/sources/detail` just fetched, so an add does not fetch it all over again.
 *
 * The add dialog calls `detail` to show the cover, summary and chapter count, and `add` then made the exact
 * same two calls seconds later -- on a Cloudflare source that is two more challenge solves, and it was
 * measured at 22.8s of an add that had already moved its downloading to the background. Nobody presses Add
 * a minute after opening the dialog, so a short life is enough, and a short life is also what keeps a
 * chapter list from going stale.
 *
 * Keyed by source and series only: this is what the SITE said, identical for every viewer, exactly like
 * `latestCache` above.
 */
const DETAIL_TTL = 90_000;
const detailCache = new Map<string, { at: number; series: SourceSeries | null; chapters: SourceChapter[] }>();

async function seriesAndChapters(src: SourceAdapter, sourceId: string):
  Promise<{ series: SourceSeries | null; chapters: SourceChapter[] }> {
  const key = `${src.id}:${sourceId}`;
  const hit = detailCache.get(key);
  if (hit && Date.now() - hit.at < DETAIL_TTL) return { series: hit.series, chapters: hit.chapters };
  // In parallel. `add` ran these one after the other while `detail` had always run them together, so an add
  // paid the sum of two solves where the dialog beside it paid the larger of the two.
  //
  // `failed` is tracked separately from the empty value, because the two are indistinguishable otherwise:
  // both `getSeries` and `listChapters` answer a timeout or a throw with null/[], which is exactly what a
  // title with genuinely nothing on it looks like.
  let failed = false;
  const [series, chapters] = await Promise.all([
    withTimeout(src.getSeries(sourceId), ADD_LOOKUP_TIMEOUT).catch(() => { failed = true; return null; }),
    withTimeout(src.listChapters(sourceId), ADD_LOOKUP_TIMEOUT).catch(() => { failed = true; return [] as SourceChapter[]; }),
  ]);
  // Only a real answer is remembered. Caching the failure -- which this did when the cache was added -- turns
  // a hiccup into a confident "No readable chapters for this title on this source. Try a different source."
  // pinned for ninety seconds, so retrying inside the window returns the same wrong advice. Before the cache
  // existed the same catch was here, but a retry worked; the cache is what made it stick.
  if (!failed) detailCache.set(key, { at: Date.now(), series, chapters });
  return { series, chapters };
}

/** Exposed for tests: the cache is process-global and would otherwise leak between cases. */
export function clearDetailCache(): void { detailCache.clear(); }
const latestCache = new Map<string, { at: number; items: SourceSeries[] }>();
const latestInflight = new Map<string, Promise<SourceSeries[]>>();

/**
 * One source's newest page, cached and de-duplicated.
 *
 * Keyed by source and page and NOT by user, deliberately: a source's newest page is the same bytes for
 * everyone, and *which sources you may ask for* is decided before this is ever called. That separation is
 * also why the service worker must not cache this endpoint -- the Cache API keys by URL with no `Vary`, so
 * on a shared household device it would serve one account's wall to another.
 *
 * The in-flight map matters more than the TTL here: six chips, several tabs and a page refresh otherwise
 * become six identical outbound scrapes of the same site within a second of each other.
 */
export type ListMode = 'latest' | 'popular';

async function latestPage(src: SourceAdapter, page: number, mode: ListMode = 'latest'): Promise<SourceSeries[]> {
  // The mode belongs in the key. Without it the two listings share a cache entry and an in-flight promise,
  // so whichever is asked for first answers both -- Popular would serve Newest's results for ten minutes,
  // or the reverse, depending only on which the reader happened to open.
  const key = `${src.id}:${mode}:${page}`;
  const hit = latestCache.get(key);
  if (hit && Date.now() - hit.at < LATEST_TTL) return hit.items;
  const flying = latestInflight.get(key);
  if (flying) return flying;

  const run = async (): Promise<SourceSeries[]> => {
    try {
      const fetchList = mode === 'popular' ? src.popular! : src.latest!;
      const raw = await withTimeout(fetchList(page), LATEST_TIMEOUT);
      const seen = new Set<string>();
      // dedupe by sourceId (duplicate ids collide on the React key -> wrong cover/title on a card)
      const items = raw.filter((r) => !!r.sourceId && !seen.has(r.sourceId) && (seen.add(r.sourceId), true)).slice(0, 24);
      // An empty answer must not evict a good page. This ran unconditionally, and BEFORE the length check
      // below, so one transient empty reply both poisoned this source for the next ten minutes and could
      // overwrite a page that had real titles on it. Keep the older, better answer; leaving its timestamp
      // stale is deliberate, so the next visit retries instead of serving the empty one for ten minutes.
      if (items.length || !hit?.items.length) latestCache.set(key, { at: Date.now(), items });
      // Only a page with something on it counts as proof of life, and that has not changed: `reportLatest`
      // reports OK only when something came back. Several adapters answer a failed Cloudflare challenge with
      // an empty array rather than by throwing -- on this install Aqua Manga and Natomanga both do -- and
      // `reportOk` CLEARS `blocked_until` and resets the failure count, so browsing Discover would wipe a
      // cooldown the downloader had legitimately recorded.
      //
      // What HAS changed is that the empty case is no longer silent. It used to write nothing at all, which
      // meant a Cloudflare interstitial served as HTTP 200, and a site whose markup had drifted, were both
      // completely undetectable: "nothing new" and "I could not read the page" looked identical to the
      // server as well as to the reader. `reportLatest` records the empty streak and touches nothing else,
      // so the two can finally be told apart without a quiet source earning a cooldown for it. Page is
      // passed because only page 1 is evidence -- see the function.
      // Only the NEWEST listing is evidence about a source's health. An empty popular page much more often
      // means the source has no popularity listing worth the name than that its parser has drifted, and
      // feeding that into `empty_streak` would mark working sources as broken. Failures that throw still
      // report through the catch below, for either mode.
      if (mode === 'latest') void reportLatest(src.id, items.length, page);
      return items;
    } catch (e) {
      // Two different facts, recorded two different ways. A source that actually failed earns the escalating
      // cooldown, because asking a refusing site again soon is pure cost. A source that merely outran OUR
      // budget does not: it is counted, and at worst gets a short fixed breather. The escalating version
      // removed the very requests that would have shown it working, which is how a healthy source went
      // missing for a day while every diagnostic said it was fine.
      if ((e as { selfTimeout?: boolean })?.selfTimeout) {
        void reportSlow(src.id, (e as { ms?: number }).ms ?? LATEST_TIMEOUT);
      } else {
        // Nothing reported health from here, so a source that failed on every single visit kept its `ok`
        // status forever and the client's ranking kept putting it first. Reporting earns it a cooldown.
        void reportFail(src.id, classify(e) ?? 'down', (e as Error)?.message || `${mode} failed`);
      }
      // Stale beats empty: an old page is still this source's newest page, whereas an empty one reads as
      // "this source has nothing", which is a different and false statement. /api/discover/trending already
      // serves stale on failure for the same reason.
      return hit?.items ?? [];
    }
  };

  // Registered before anything can await, and removed only if it is still the entry we put there.
  const p = run();
  latestInflight.set(key, p);
  void p.finally(() => { if (latestInflight.get(key) === p) latestInflight.delete(key); });
  return p;
}

/** Whatever is on hand for this source and page, however old. Used when a source is in cooldown. */
const cachedLatest = (id: string, page: number, mode: ListMode = 'latest'): SourceSeries[] =>
  latestCache.get(`${id}:${mode}:${page}`)?.items ?? [];

/** Exposed for tests: the cache is process-global and would otherwise leak between cases. */
export function clearLatestCache(): void {
  latestCache.clear();
  latestInflight.clear();
}

export interface AddResult {
  ok: boolean; status: number; error?: string; message?: string;
  title?: string; folder?: string; chapters?: number;
  existing?: { title: string; source: string }; blockStatus?: string;
  /** The download was started rather than completed. Absent when the series was already in the library. */
  started?: boolean;
}

/** Add one series from a source to the library (downloads chapter 1 synchronously, the rest in background).
 *  Shared by POST /api/sources/add and the bulk importer. Returns a result instead of touching the reply. */
export async function addSeriesFromSource(opts: {
  source?: string; sourceId?: string; force?: boolean; chapterCount?: number; autoUpdate?: boolean;
  /**
   * Await the first chapter before returning.
   *
   * The bulk importer does, because it counts what actually landed and has its own progress surface. A
   * person pressing a button must not: that await is the whole of this request's cost -- measured at 15.5s,
   * 48.3s and 59.2s on one install -- and it held the button on "Working…" for all of it while the download
   * had in fact already started. Defaults to true so every existing caller is unchanged.
   */
  wait?: boolean;
}): Promise<AddResult> {
  const { source, sourceId, force, chapterCount, autoUpdate } = opts;
  const src = source ? getSource(source) : null;
  if (!src || !sourceId) return { ok: false, status: 400, error: 'bad_request' };
  if (await isDisabled(source!)) return { ok: false, status: 403, error: 'disabled', message: `${src.name} is disabled by the admin.` };

  // The only network work left inline. It decides what to TELL the caller -- does it exist, is it a
  // duplicate, has it any chapters -- so it cannot move behind the reply. Shared with `/api/sources/detail`,
  // which the add dialog calls seconds earlier for the very same two things: without that, opening the
  // dialog and pressing Add paid for four challenge solves to learn two facts.
  const { series, chapters } = await seriesAndChapters(src, sourceId);
  // No title, no add. This used to fall back to the literal string 'Series', which becomes the folder --
  // so a `getSeries` that timed out while `listChapters` succeeded filed the title under `<Source>/Series`,
  // and the NEXT one to do that was told "already in library" and quietly merged into the same shelf.
  // A network hiccup could therefore collapse unrelated titles into one, which is library corruption rather
  // than a failed add, and nothing anywhere would have said so.
  const title = series?.title?.trim();
  if (!title) {
    return {
      ok: false, status: 503, error: 'no_title',
      message: `${src.name} did not return this title just now. Try again in a moment.`,
    };
  }
  const folder = `${src.name}/${sanitize(title)}`;

  // A deleted series does not count as present: re-adding it is how you undo a delete from the app side.
  const existing = await one<{ id: string; deleted_at: string | null }>(
    'SELECT id, deleted_at FROM lib_series WHERE folder = $1', [folder]);
  if (existing?.deleted_at) {
    await q('UPDATE lib_series SET deleted_at = NULL WHERE id = $1', [existing.id]).catch(() => {});
  }
  if (existing && !existing.deleted_at) {
    return { ok: true, status: 200, title, folder, chapters: 0, message: 'already in library' };
  }
  if (!force) {
    const dup = await one<{ title: string; source: string }>(
      `SELECT title, source FROM lib_series
        WHERE lower(regexp_replace(title, '[^a-zA-Z0-9]', '', 'g')) = $1 AND folder <> $2
          AND ${visibleToAll('lib_series')} LIMIT 1`,
      [norm(title), folder]);
    if (dup) return { ok: false, status: 409, error: 'duplicate', existing: dup, message: `You already have "${dup.title}" from ${dup.source}. Add this copy anyway?` };
  }

  if (!chapters.length) return { ok: false, status: 404, error: 'no_chapters', message: 'No readable chapters for this title on this source. Try a different source.' };
  const selected = chapterCount && chapterCount > 0 ? chapters.slice(0, chapterCount) : chapters;
  const meta = { series: title, summary: series?.summary, author: series?.author, genres: series?.genres, url: series?.url, status: series?.status };
  jobs.set(folder, { title, total: selected.length, done: 0, status: 'downloading' });

  /**
   * Everything from here is the WORK, as opposed to the decision.
   *
   * It used to run before the reply, which is why the button sat on "Working…" for up to a minute: the
   * first chapter is fetched a page at a time, up to 45s each, behind a queue with no bound, and on a
   * Cloudflare source every step is a real challenge solve. The job row already existed by this point, so
   * the Discover strip knew the download had started while the caller was still waiting to be told.
   */
  const run = async (): Promise<AddResult> => {
    let firstPages = 0; let blockReason: string | null = null; let diskFull: string | null = null;
    try { const r = await downloadChapter({ sourceId: source!, seriesFolder: folder, chapter: selected[0], meta }); firstPages = r.skipped ? 1 : r.pages; }
    catch (e: any) { blockReason = e?.blockStatus || null; diskFull = e?.diskFull ? String(e.message) : null; }
    if (!firstPages) {
      // A full disk used to read as "this title may be licensed", which sends a person off to try another
      // source for a problem no source can fix.
      const why = diskFull
        ? `Not enough free space to download: ${diskFull}.`
        : blockReason
        ? `${src.name} is currently ${blockReason === 'rate_limited' ? 'rate-limiting' : blockReason === 'blocked' ? 'blocking' : 'unreachable for'} downloads.`
        : 'No downloadable chapters here — this title may be licensed or hosted externally on this source.';
      if (opts.wait === false) {
        // Detached: the caller has already been told the download started, so this card IS the failure
        // report. It is deliberately not swept -- see sweepJobs -- and is dismissed by hand.
        const j = jobs.get(folder); if (j) { j.status = 'error'; j.reason = why; j.finishedAt = Date.now(); }
      } else {
        // Awaited: the caller gets a real HTTP answer and has its own reporting, so leaving a card behind
        // would just be noise -- the bulk importer would strand one per failed title.
        jobs.delete(folder);
      }
      if (diskFull) return { ok: false, status: 507, error: 'disk_full', message: why };
      if (blockReason) {
        return { ok: false, status: 429, error: 'blocked', blockStatus: blockReason, message: `${why} Wait a bit or pick another source.` };
      }
      return { ok: false, status: 422, error: 'undownloadable', message: `${why} Try a different source.` };
    }
    const j0 = jobs.get(folder); if (j0) j0.done = 1;
    await persistScan().catch(() => {});
    await setBookDates(folder, selected).catch(() => {});
    await q('UPDATE lib_series SET auto_update = $1, source_id = $2, source_series_id = $3 WHERE folder = $4',
      [autoUpdate !== false, source, sourceId, folder]).catch(() => {});
    if (series?.coverUrl) {
      await q(`INSERT INTO series_art (series_id, cover) SELECT id, $1 FROM lib_series WHERE folder = $2
        ON CONFLICT (series_id) DO UPDATE SET cover = COALESCE(series_art.cover, EXCLUDED.cover)`, [series.coverUrl, folder]).catch(() => {});
    }
    fetchAniListArt(title)
      .then((a) => q(`INSERT INTO series_art (series_id, banner, cover) SELECT id, $1, $2 FROM lib_series WHERE folder = $3
        ON CONFLICT (series_id) DO UPDATE SET banner = COALESCE(series_art.banner, EXCLUDED.banner), cover = COALESCE(series_art.cover, EXCLUDED.cover)`, [a.banner, a.cover, folder]))
      .catch(() => {});
    void (async () => {
      let failures = 0;
      for (const ch of selected.slice(1)) {
        try {
          await downloadChapter({ sourceId: source!, seriesFolder: folder, chapter: ch, meta });
        } catch (e: any) {
          const j = jobs.get(folder);
          if (e?.blockStatus) {
            if (j) {
              j.status = 'error';
              j.reason = `${src.name} stopped part-way: it is ${e.blockStatus === 'rate_limited' ? 'rate-limiting' : e.blockStatus === 'blocked' ? 'blocking' : 'unreachable for'} downloads. ${j.done} of ${j.total} chapters saved.`;
              j.finishedAt = Date.now();
            }
            break;
          }
          // ANY other failure -- a full disk, a permission error, a chapter with no readable pages -- used
          // to be swallowed whole, and the counter below still advanced. The bar filled to 100%, the tick
          // went green, and nothing had landed. On a host whose disk is nearly full that is the likeliest
          // failure there is, and it was the one that said nothing.
          failures++;
          if (j) j.reason = `${failures} chapter${failures === 1 ? '' : 's'} could not be saved: ${String(e?.message || e).slice(0, 120)}`;
          continue; // do NOT count a chapter that was not written
        }
        const j = jobs.get(folder); if (j) { j.done++; if (j.done % 5 === 0) await persistScan().catch(() => {}); }
      }
      await persistScan().catch(() => {});
      await setBookDates(folder, selected).catch(() => {});
      const j = jobs.get(folder);
      if (j && j.status !== 'error') {
        // "Done" has to mean everything landed. A run that lost chapters ends as an error carrying the
        // count, because a green tick over a short library is worse than no tick at all: it tells you to
        // stop looking.
        j.status = failures ? 'error' : 'done';
        j.finishedAt = Date.now();
      }
    })();
    return { ok: true, status: 200, title, folder, chapters: selected.length };
  };

  if (opts.wait !== false) return run();
  // Detached. `started` is what lets the caller say "downloading now" rather than guessing from
  // `chapters === 0`, which is the only signal an already-in-library answer has ever had.
  void run().catch(() => {});
  return { ok: true, status: 200, title, folder, chapters: selected.length, started: true };
}

/** Best single cross-source match for a title (searches sources in preferred order, returns the first real hit). */
export async function findBestMatch(term: string): Promise<{ source: string; sourceId: string; title: string } | null> {
  for (const id of findOrder()) {
    const src = getSource(id);
    if (!src) continue;
    if (await isDisabled(id).catch(() => false)) continue;
    try {
      const best = pickBest(await withTimeout(src.search(term), 20000), term);
      if (best?.sourceId) return { source: id, sourceId: best.sourceId, title: best.title };
    } catch { /* try next source */ }
  }
  return null;
}

export default async function sourceRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  /**
   * Every route in this file is "add something to the library", or a step towards it.
   *
   * `canDownload: false` was enforced in exactly one place in the entire server -- the final POST -- so a
   * denied account could still list every source, search them, browse their newest pages and read full
   * series detail. It only met a wall on the last button. One hook removes the whole surface, and folds in
   * the copy of this check that used to live inside `add`.
   *
   * Semantics are otherwise unchanged: only the literal `false` denies, an absent permission is allowed, and
   * admins are exempt. The one deliberate change is denying when the user row cannot be read, where the old
   * check fell through to allowed -- a database blip should not open the one route that writes to disk.
   */
  app.addHook('preHandler', async (req, reply) => {
    const me = await one<{ role: string; perms: { canDownload?: boolean } | null }>(
      'SELECT role, perms FROM users WHERE id = $1', [userIdOf(req)]).catch(() => null);
    if (!me) return reply.code(403).send({ error: 'forbidden', message: 'Could not check your permissions.' });
    if (me.role !== 'admin' && me.perms?.canDownload === false) {
      return reply.code(403).send({ error: 'forbidden', message: "You don't have permission to add series." });
    }
    // Resolved once per request, as in catalog.ts. Only `maxAgeRating` is read here, but taking the whole
    // context means this file cannot drift from everyone else's idea of who the viewer is.
    (req as any).viewCtx = await viewCtxFor(userIdOf(req), roleOf(req), { hideAdult: hideAdult(req) });
  });

  const vc = (req: FastifyRequest): ViewCtx => (req as any).viewCtx as ViewCtx;
  /** Same shape for every by-id rejection, and it does not say what is being withheld. */
  const denySource = (reply: FastifyReply) =>
    reply.code(403).send({ error: 'forbidden', message: 'That source is not available on this account.' });
  /** The sources this viewer may reach, in registry order. */
  const reachable = (req: FastifyRequest): SourceAdapter[] =>
    listSources().filter((s) => sourceAllowedFor(s, vc(req).maxAgeRating));

  app.get('/api/sources', async (req) => {
    const health = new Map((await healthAll()).map((h) => [h.source_id, h]));
    // Which language a source serves is an operator's choice recorded per source, not a property of the
    // adapter (adapters are code), so it lives only in suwayomi_sources. Discover groups by it: forty-five
    // sources across thirty languages is a list nobody can use, and most of them are the same site repeated.
    // A 45-row read on a route the client already polls.
    const langs = new Map(
      (await q<{ source_id: string; lang: string | null }>(
        'SELECT source_id, lang FROM suwayomi_sources WHERE enabled = true',
      ).catch(() => [])).map((r) => [r.source_id, r.lang]),
    );
    // How many series the library actually holds from each source, keyed on the ADAPTER ID rather than the
    // display name. `lib_series.source` is the folder's parent, which is the name the source had when the
    // series was added, so renaming a source orphans its history: on this install the same adapter reads as
    // 13 under "Aqua Manga" and 176 under "Aqua Manga (EN)", when it is one source with 189. `source_id` is
    // written by addSeriesFromSource and is the id the ranking is applied to. NULL means "not from a
    // source" -- filed by hand, or imported -- which is not a vote for anything.
    const used = new Map(
      (await q<{ source_id: string; n: string }>(
        `SELECT source_id, count(*)::text AS n FROM lib_series s
          WHERE ${visibleToAll('s')} AND s.source_id IS NOT NULL GROUP BY source_id`,
      ).catch(() => [])).map((r) => [r.source_id, Number(r.n)]),
    );
    const now = Date.now();
    return {
      // An adult source is not merely hidden from the wall: it never appears in the list the client fans out
      // over, so a capped account cannot learn its id here and then ask for it directly.
      content: reachable(req).map((s) => {
        const h = health.get(s.id);
        const blocked = !!(h?.blocked_until && new Date(h.blocked_until).getTime() > now);
        const suspect = (h?.empty_streak ?? 0) >= EMPTY_SUSPECT || (h?.slow_streak ?? 0) >= EMPTY_SUSPECT;
        const d = (blocked || suspect) && h
          ? diagnose({
              status: h.status, lastError: h.last_error, consecutive: h.consecutive,
              lastOkAt: h.last_ok_at, emptyStreak: h.empty_streak ?? 0,
              blockedUntil: h.blocked_until, disabled: !!h.disabled,
              slowStreak: h.slow_streak ?? 0, budgetMs: LATEST_TIMEOUT,
            })
          : null;
        return {
          id: s.id,
          name: s.name,
          // null means "declares no single language", which is not the same as "serves none": a source
          // like MangaDex belongs in every group rather than in an orphan bucket. An adapter may now declare
          // one itself, which is how MangaDex -- hardcoded to ask for English -- stops joining all thirty.
          lang: s.lang ?? (isSwAdapterId(s.id) ? (langs.get(s.id.slice(SW_PREFIX.length)) ?? null) : null),
          latest: typeof s.latest === 'function',
          // Reported from the method's presence, exactly as `latest` is. A source without it simply
          // drops out of the wall while Popular is selected, the same way one without `latest` does.
          popular: typeof s.popular === 'function',
          // What the reader has actually used. Health-then-alphabetical put "18 Porn Comic" and "1Manga.co"
          // at the front of this install's English group while Aqua Manga -- 176 of its 214 series, answering
          // in 2.5s -- was never in the first six fetched.
          used: used.get(s.id) ?? 0,
          // `quiet` is new, and it is the one state that used to be unrepresentable. A source whose listing
          // has drifted answers 200 with an empty page and throws nothing, so it never earned a cooldown and
          // `status` stayed 'ok' forever while the wall kept fetching it first. `budgetFor` sorts on
          // `status !== 'ok'`, so naming it is all it takes to stop ranking it above sources that work.
          status: h?.disabled ? 'disabled' : blocked ? h!.status : suspect ? 'quiet' : 'ok',
          blockedUntil: blocked ? h!.blocked_until : null,
          // The PUBLIC sentence only, and only when something is actually wrong. Never `fix`, which names
          // containers and config files, and never `last_error`, which carries internal hostnames and ports.
          // This route is cached client-side under one query key that does not vary by account, so there is
          // deliberately no admin branch here: two shapes for one cache key leak on a shared device.
          note: d ? d.reason : null,
        };
      }),
    };
  });

  // GET /api/sources/status was here, and is deliberately gone. It answered any AUTHENTICATED caller (this
  // file's preHandler is `authenticate`, not `requireAdmin`) with the raw source_health row, `last_error`
  // included -- the very field the comment fifteen lines above forbids exposing, because it carries internal
  // hostnames and ports. Its own comment said "for the admin provider dashboard", and the admin dashboard
  // has always called the properly gated twin at GET /api/admin/sources (routes/admin.ts). Nothing else ever
  // called this one. Deleted rather than gated, because a second door to the same room is what went wrong.

  app.get('/api/sources/search', async (req, reply) => {
    const { source, q: query } = req.query as { source?: string; q?: string };
    const src = source ? getSource(source) : null;
    if (!src || !query?.trim()) return { content: [] };
    if (!sourceAllowedFor(src, vc(req).maxAgeRating)) return denySource(reply);
    const raw = await src.search(query.trim()).catch(() => []);
    // dedupe by sourceId (duplicate ids collide on the React key → wrong cover/title on a card)
    const seen = new Set<string>();
    const results = raw.filter((r) => !!r.sourceId && !seen.has(r.sourceId) && (seen.add(r.sourceId), true)).slice(0, 24);
    // flag titles already in the library so the UI can mark them instead of offering a duplicate add
    const have = await inLibrary(results.map((r) => r.title));
    return { content: results.map((r) => ({ ...r, inLibrary: have.has(norm(r.title)) })) };
  });

  // Search a title across ALL enabled providers at once, grouped so one card carries every source that
  // has it — the UI then lets you choose which source to add from (like the trending flow).
  /**
   * What is missing from a series, and who could supply it.
   *
   * Read-only. Answers with a plan id; the chapter URLs stay on this side of the wire and the fill below
   * quotes the id back. The client therefore names a chapter NUMBER and nothing else, so no request can
   * point the downloader at content a person was never shown.
   *
   * POST rather than GET because it fans out across every reachable source, and a GET would be prefetchable
   * and service-worker-cacheable -- the same reasoning as `latestPage` above.
   */
  app.post('/api/sources/fill/scan', async (req, reply) => {
    const { seriesId, altTitle } = (req.body ?? {}) as { seriesId?: string; altTitle?: string };
    if (!seriesId) return reply.code(400).send({ error: 'bad_request' });

    // Browsable by THIS viewer, not merely present: otherwise a capped member could learn about, and write
    // into, a series they are walled off from. Fails closed, as the permission hook above does.
    // One lookup, through browsable(): it carries the deleted/merged rule, the per-library grant and the age
    // cap together, so this route cannot drift from the others by hand-writing part of it. Fails closed --
    // a database blip must not make a series someone cannot see fillable.
    const p = new Params();
    const rows = await q<any>(
      `SELECT s.id, s.title, s.folder, s.source_id, s.source_series_id, s.summary, s.author, s.genres, s.web, s.status
         FROM lib_series s WHERE s.id = ${p.add(seriesId)} AND ${browsable('s', vc(req), p)}`, p.values,
    ).then((r) => r, () => null);
    if (rows === null) return reply.code(503).send({ error: 'unavailable' });
    const s = rows[0];
    if (!s) return reply.code(404).send({ error: 'not_found' });

    const have = (await q<{ number: number }>('SELECT number FROM lib_books WHERE series_id = $1', [seriesId]))
      .map((r: { number: number }) => Number(r.number)).filter((n: number) => Number.isFinite(n));
    // Coverage measured against two chapters proves nothing at all: any long series covers them.
    if (have.length < MIN_HAVE) {
      return { seriesId, title: s.title, have: { count: have.length }, gaps: [], candidates: [],
        refusal: { code: 'too_few_chapters', message: 'Too few chapters here to match against another source.' } };
    }
    const gaps = gapsOf(have);

    // Candidates: the series' own source first (no cross-source guessing at all -- it is where the series
    // already comes from), then one best match per other reachable source.
    const terms = [...new Set([s.title, (altTitle || '').trim()].filter(Boolean))] as string[];
    const allowed = new Set(reachable(req).map((x) => x.id));
    const found: { source: string; name: string; sourceId: string; title: string; coverUrl?: string; pinned: boolean }[] = [];
    if (s.source_id && s.source_series_id && allowed.has(s.source_id)) {
      const own = getSource(s.source_id);
      if (own) found.push({ source: own.id, name: own.name, sourceId: s.source_series_id, title: s.title, pinned: true });
    }
    // Sources that could not be asked at all, so the dialog can say so rather than imply they lack the title.
    const unreachable: { source: string; name: string }[] = [];
    await Promise.all(findOrder().filter((id) => allowed.has(id)).map(async (id) => {
      if (found.some((f) => f.source === id && f.pinned)) return;
      const src = getSource(id);
      if (!src || await isDisabled(id).catch(() => false)) return;
      let failed = false;
      for (const term of terms) {
        try {
          // 45s, not 20s: solves are now queued behind SOLVER_CONCURRENCY, so waiting a turn is expected
          // rather than a fault. The old budget timed out the queued sources and then hid them.
          const hit = pickBest(await withTimeout(src.search(term), 45000), term);
          if (hit?.sourceId) {
            found.push({ source: src.id, name: src.name, sourceId: hit.sourceId, title: hit.title, coverUrl: hit.coverUrl, pinned: false });
            return;
          }
        } catch { failed = true; /* one source failing is not the scan failing -- but it must not be silent */ }
      }
      if (failed) unreachable.push({ source: src.id, name: src.name });
    }));

    // Only now, and only for sources that produced a match, do we pay for a chapter list. Routed through the
    // shared lookup so it reuses whatever the add dialog already fetched.
    const chapters = new Map<string, SourceChapter[]>();
    const candidates: PlanCandidate[] = [];
    // One read for every source, rather than one blockedNow() per candidate: the same row answers "is it
    // in a cooldown" and "what is its record", and the record is what the dialog was never told.
    const health = new Map((await healthAll().catch(() => [])).map((h) => [h.source_id, h]));
    await Promise.all(found.map(async (f) => {
      const src = getSource(f.source);
      if (!src) return;
      let list: SourceChapter[] = [];
      let why: Refusal = 'ok';
      const h = health.get(f.source);
      if (h?.blocked_until && new Date(h.blocked_until).getTime() > Date.now()) why = 'blocked';
      else {
        try { list = (await seriesAndChapters(src, f.sourceId)).chapters; }
        catch { why = 'no_chapters'; }
      }
      const nums = list.map((c) => c.number);
      const a = assess(have, nums);
      chapters.set(planKey(f.source, f.sourceId), list);
      candidates.push({
        source: f.source, name: f.name, sourceSeriesId: f.sourceId, title: f.title, coverUrl: f.coverUrl,
        count: list.length, first: nums.length ? Math.min(...nums) : null, last: nums.length ? Math.max(...nums) : null,
        coverage: Math.round(a.coverage * 100) / 100, matched: a.matched,
        fillable: a.fillable, newer: a.newer,
        why: why === 'ok' ? verdict(a, list.length) : why,
        pinned: f.pinned,
        health: h && (h.status !== 'ok' || h.consecutive > 0)
          ? { status: h.status, consecutive: h.consecutive, lastFailAt: h.last_fail_at, lastOkAt: h.last_ok_at }
          : null,
      });
    }));

    for (const u of unreachable) {
      candidates.push({
        source: u.source, name: u.name, sourceSeriesId: '', title: '',
        count: 0, first: null, last: null, coverage: 0, matched: 0,
        fillable: [], newer: [], why: 'unreachable', pinned: false,
      });
    }

    // Usable first, the series' own source ahead of the rest, then by how much each would repair.
    candidates.sort((x, y) =>
      Number(y.why === 'ok') - Number(x.why === 'ok') ||
      Number(y.pinned) - Number(x.pinned) ||
      y.fillable.length - x.fillable.length);

    const plan = putPlan({ seriesId, folder: s.folder, chapters, candidates });
    return {
      seriesId, title: s.title, folder: s.folder,
      have: { count: have.length, first: Math.min(...have), last: Math.max(...have) },
      gaps, candidates, planId: plan.id, expiresIn: PLAN_TTL,
      refusal: gaps.length || candidates.some((c) => c.newer.length) ? null
        : { code: 'no_gaps', message: 'Nothing is missing between the chapters you already have.' },
    };
  });

  /** Fetch the chapters a person picked, from the source they picked, and nothing else. */
  app.post('/api/sources/fill', async (req, reply) => {
    const { planId, source, sourceSeriesId, numbers } = (req.body ?? {}) as
      { planId?: string; source?: string; sourceSeriesId?: string; numbers?: number[] };
    if (!planId || !source || !sourceSeriesId || !Array.isArray(numbers)) {
      return reply.code(400).send({ error: 'bad_request' });
    }
    const plan = getPlan(planId);
    if (!plan) return reply.code(409).send({ error: 'plan_stale', message: 'That list has moved on. Scan again.' });

    const auth = authorise(plan, source, sourceSeriesId, numbers.map(Number), FILL_MAX_CHAPTERS);
    if (!auth.ok) return reply.code(400).send({ error: auth.error, message: auth.message });

    const src = getSource(source);
    if (!src) return reply.code(400).send({ error: 'bad_request' });
    if (!sourceAllowedFor(src, vc(req).maxAgeRating)) return denySource(reply);
    if (await isDisabled(source).catch(() => false)) return reply.code(409).send({ error: 'disabled' });
    if (await blockedNow(source).catch(() => false)) return reply.code(429).send({ error: 'blocked' });

    const s = await one<any>(
      `SELECT id, title, folder, summary, author, genres, web, status FROM lib_series WHERE id = $1`, [plan.seriesId]);
    if (!s) return reply.code(404).send({ error: 'not_found' });

    const running = jobs.get(s.folder);
    if (running && running.status === 'downloading') return reply.code(409).send({ error: 'busy' });

    const picked = auth.chapters;
    jobs.set(s.folder, { title: s.title, total: picked.length, done: 0, status: 'downloading' });
    await logAudit('series.fill', {
      userId: userIdOf(req),
      detail: { seriesId: plan.seriesId, title: s.title, source, sourceSeriesId, numbers: picked.map((c) => c.number) },
      req,
    });

    void (async () => {
      let failures = 0;
      for (const ch of picked) {
        try {
          /**
           * `meta` comes from OUR series row, never from the candidate.
           *
           * `downloadChapter` writes meta.series into the CBZ's ComicInfo <Series>, and every persistScan
           * re-reads the FIRST chapter's ComicInfo and overwrites the series row's title, summary, author,
           * status, genres and web from it (lib/library.ts, ON CONFLICT DO UPDATE). Filling a gap at the
           * START of a series writes the new first chapter -- so passing the candidate's title here would
           * silently rename the series, for everyone, on the next scan. It fires even when the match is
           * RIGHT, because a right match is often under a different English title.
           */
          const res = await downloadChapter({
            sourceId: source, seriesFolder: s.folder, chapter: ch,
            meta: { series: s.title, summary: s.summary, author: s.author, genres: s.genres, url: s.web, status: s.status },
          });
          const j = jobs.get(s.folder);
          if (j && !res.skipped) { j.done++; if (j.done % 5 === 0) await persistScan().catch(() => {}); }
        } catch (e: any) {
          const j = jobs.get(s.folder);
          if (e?.diskFull) {
            if (j) { j.status = 'error'; j.reason = `Not enough free space: ${String(e.message)}. ${j.done} of ${j.total} chapters saved.`; j.finishedAt = Date.now(); }
            break;
          }
          failures++;
          await noteChapterFailure({ seriesId: plan.seriesId, title: s.title, number: ch.number, sourceId: source, err: e });
          if (e?.blockStatus) {
            if (j) {
              j.status = 'error';
              j.reason = `${src.name} stopped part-way. ${j.done} of ${j.total} chapters saved.`;
              j.finishedAt = Date.now();
            }
            break;
          }
          if (j) j.reason = `${failures} chapter${failures === 1 ? '' : 's'} could not be saved: ${String(e?.message || e).slice(0, 120)}`;
          // NOT counted: a chapter that was not written must never advance the bar.
        }
      }
      await persistScan().catch(() => {});
      await setBookDates(s.folder, picked).catch(() => {});
      const j = jobs.get(s.folder);
      if (j && j.status !== 'error') { j.status = failures ? 'error' : 'done'; j.finishedAt = Date.now(); }
    })();

    return { ok: true, started: true, folder: s.folder, total: picked.length };
  });

  app.get('/api/sources/search-all', async (req) => {
    const term = ((req.query as { q?: string }).q || '').trim();
    if (!term) return { content: [] };
    // Filtered rather than rejected: a fan-out has no single source to refuse, and a capped account asking
    // for a title that only exists on adult sources should get "nobody has it", not a partial denial.
    const allowed = new Set(reachable(req).map((x) => x.id));
    const per = await Promise.all(findOrder().filter((id) => allowed.has(id)).map(async (id) => {
      const src = getSource(id);
      if (!src) return [];
      if (await isDisabled(id).catch(() => false)) return [];
      try { return (await withTimeout(src.search(term), 20000)).slice(0, 12).map((r) => ({ ...r, name: src.name })); }
      catch { return []; }
    }));
    // group by normalized title → one card that carries every provider offering it (preferred order preserved)
    const groups = new Map<string, { title: string; coverUrl?: string; updatedAt?: string; providers: { source: string; name: string; sourceId: string; coverUrl?: string; title: string }[] }>();
    for (const list of per) for (const r of list) {
      if (!r.sourceId || !r.title) continue;
      const key = norm(r.title);
      if (!key) continue;
      let g = groups.get(key);
      if (!g) { g = { title: r.title, coverUrl: r.coverUrl, updatedAt: r.updatedAt, providers: [] }; groups.set(key, g); }
      if (!g.coverUrl && r.coverUrl) g.coverUrl = r.coverUrl;
      if (!g.updatedAt && r.updatedAt) g.updatedAt = r.updatedAt;
      if (!g.providers.some((p) => p.source === r.source)) {
        g.providers.push({ source: r.source, name: r.name, sourceId: r.sourceId, coverUrl: r.coverUrl, title: r.title });
      }
    }
    const have = await inLibrary([...groups.values()].map((g) => g.title));
    const out = [...groups.values()]
      .map((g) => ({ ...g, inLibrary: have.has(norm(g.title)) }))
      .sort((a, b) => b.providers.length - a.providers.length)
      .slice(0, 30);
    return { content: out };
  });

  // Browse a source's newest / recently-updated series (no query). Same card shape as search.
  app.get('/api/sources/latest', async (req, reply) => {
    const { source, page } = req.query as { source?: string; page?: string };
    const src = source ? getSource(source) : null;
    if (!src || typeof src.latest !== 'function') return { content: [] };
    // Refused by id, not merely hidden in the list. The web app is a static export, so a UI-only filter
    // would leave this returning twenty-four adult covers as JSON to a capped account holding the id.
    if (!sourceAllowedFor(src, vc(req).maxAgeRating)) return denySource(reply);
    if (await isDisabled(source!).catch(() => false)) return { content: [] };
    const p = Math.max(1, parseInt(page || '1', 10) || 1);
    // A source serving out a cooldown is not asked again -- that is what the cooldown is FOR. Reporting
    // health from here was only affecting the client's ordering, so a source that had already proved it
    // cannot answer still cost the full timeout on every single visit: on this install two of them burned
    // 8s each, every time, for nothing. Whatever was last cached is still served, because an old page is
    // better than a blank one. blocked_until expires on its own, so the source heals without intervention.
    if (await blockedNow(source!).catch(() => null)) {
      const stale = cachedLatest(src.id, p);
      const had = await inLibrary(stale.map((r) => r.title));
      return { content: stale.map((r) => ({ ...r, inLibrary: had.has(norm(r.title)) })) };
    }
    const results = await latestPage(src, p);
    const have = await inLibrary(results.map((r) => r.title));
    return { content: results.map((r) => ({ ...r, inLibrary: have.has(norm(r.title)) })) };
  });

  /**
   * Browse what a source itself considers popular.
   *
   * Every guard the newest listing has applies identically -- the adult refusal by id, the disabled check,
   * the cooldown short-circuit -- so this is deliberately the same handler shape rather than a clever
   * shared one: the two differ only in which adapter method runs, and a wrapper that hid that would make
   * the access checks harder to see rather than easier.
   */
  app.get('/api/sources/popular', async (req, reply) => {
    const { source, page } = req.query as { source?: string; page?: string };
    const src = source ? getSource(source) : null;
    if (!src || typeof src.popular !== 'function') return { content: [] };
    if (!sourceAllowedFor(src, vc(req).maxAgeRating)) return denySource(reply);
    if (await isDisabled(source!).catch(() => false)) return { content: [] };
    const p = Math.max(1, parseInt(page || '1', 10) || 1);
    if (await blockedNow(source!).catch(() => null)) {
      const stale = cachedLatest(src.id, p, 'popular');
      const had = await inLibrary(stale.map((r) => r.title));
      return { content: stale.map((r) => ({ ...r, inLibrary: had.has(norm(r.title)) })) };
    }
    const results = await latestPage(src, p, 'popular');
    const have = await inLibrary(results.map((r) => r.title));
    return { content: results.map((r) => ({ ...r, inLibrary: have.has(norm(r.title)) })) };
  });

  app.get('/api/sources/jobs', async (req) => {
    sweepJobs();
    const all = [...jobs.entries()].map(([folder, j]) => ({ folder, ...j }));
    if (!vc(req).hideAdultLibraries) return { content: all };
    // A download job carries the series title, so the strip on Discover is a listing like any other. Jobs
    // are keyed by folder, which is exactly what lib_series.folder holds, so the filter is one lookup. A
    // job for a series not yet scanned in has no row and stays visible: it cannot be in a library yet.
    const p = new Params();
    const arr = p.add(all.map((j) => j.folder));
    const hidden = new Set((await q<{ folder: string }>(
      `SELECT s.folder FROM lib_series s WHERE s.folder = ANY(${arr}) AND NOT (${browsable('s', vc(req), p)})`,
      p.values as any[],
    ).catch(() => [])).map((r) => r.folder));
    return { content: all.filter((j) => !hidden.has(j.folder)) };
  });

  /**
   * Dismiss a finished or failed download.
   *
   * A failed one is never swept, because it is the only record that the download did not work -- an add now
   * answers before the download starts, so this card is where a blocked source or an unreadable chapter
   * actually surfaces. It therefore has to be dismissible, or it would sit there for good.
   */
  app.delete('/api/sources/jobs/:folder', async (req, reply) => {
    const { folder } = req.params as { folder: string };
    const j = jobs.get(folder);
    if (!j) return reply.code(404).send({ error: 'not_found' });
    // Only something that has stopped. Dropping a running job would orphan a download that is still going
    // and leave no way to see it again.
    if (j.status === 'downloading') return reply.code(409).send({ error: 'running' });
    jobs.delete(folder);
    return { ok: true };
  });

  // How many trending titles reach the client. The hero takes the first ten and the rail shows the rest, so
  // this is both budgets at once. AniList returns 40 in the one query already, so raising it costs nothing.
  const TREND_KEEP = 36;

  // Globally trending manhwa you don't already have, for the Discover recommendations rail.
  app.get('/api/discover/trending', async (_req, reply) => {
    reply.header('cache-control', 'no-store'); // never let a stale/empty copy get pinned client-side
    if (!trendingCache || Date.now() - trendingCache.at > 6 * 3600_000) {
      try {
        let items = await fetchTrendingManhwa();
        // A second page, only when the first cannot fill the wall. On a large library most of page 1 is
        // already owned: measured on a 215-series install, 40 fetched became 28 after the library filter,
        // and only 7 of those carried the wide art the hero prefers. The common case still costs one
        // request per six-hour cache miss, and the page argument has been there unused since this shipped.
        if (items.length < TREND_KEEP + 8) {
          const more = await fetchTrendingManhwa(2).catch(() => [] as typeof items);
          const seen = new Set(items.map((t) => norm(t.title)));
          items = items.concat(more.filter((t) => !seen.has(norm(t.title))));
        }
        trendingCache = { at: Date.now(), items };
      } catch { if (!trendingCache) return { content: [] }; }
    }
    // No per-user filter here on purpose: `isAdult:false` is an argument to the AniList query, so adult
    // titles never arrive, and the cache is shared for six hours -- filtering it per viewer would pin one
    // capped account's view for everyone.
    const have = await inLibrary(trendingCache.items.map((t) => t.title));
    // Deduped by normalised title, not raw: the hero and its dots are keyed by title, so two spellings of
    // the same series would collide on a React key and swap art under the reader. Rare on one page, less so
    // across two.
    const seen = new Set<string>();
    const out = trendingCache.items.filter((t) => {
      const k = norm(t.title);
      return !have.has(k) && !seen.has(k) && (seen.add(k), true);
    });
    return { content: out.slice(0, TREND_KEEP) };
  });

  // Find a title across all providers (Aqua first) → the best match per provider that carries it.
  app.get('/api/sources/find', async (req) => {
    const { q: raw, sources } = req.query as { q?: string; sources?: string };
    const term = (raw || '').trim();
    if (!term) return { content: [] };
    // Scoped, because unscoped this is one outbound request per registered source: forty-five sites hit for
    // one tap. The client already knows which sources the reader is browsing and passes them.
    const wanted = sources ? new Set(sources.split(',').map((x) => x.trim()).filter(Boolean)) : null;
    const allowed = new Set(reachable(req).map((x) => x.id));
    const found = await Promise.all(
      findOrder().filter((id) => allowed.has(id) && (!wanted || wanted.has(id))).map(async (id) => {
        const src = getSource(id);
        if (!src) return null;
        // search-all and latest both skip disabled sources and this did not, so it offered a provider an
        // admin had switched off and the add then failed with "disabled by the admin".
        if (await isDisabled(id).catch(() => false)) return null;
        try {
          const best = pickBest(await withTimeout(src.search(term), 25000), term);
          return best ? { source: id, name: src.name, sourceId: best.sourceId, title: best.title, coverUrl: best.coverUrl } : null;
        } catch { return null; }
      }),
    );
    return { content: found.filter(Boolean) };
  });

  // Detail for one provider's match: description + chapter count/range (drives the add dialog).
  app.get('/api/sources/detail', async (req, reply) => {
    const { source, sourceId } = req.query as { source?: string; sourceId?: string };
    const src = source ? getSource(source) : null;
    if (!src || !sourceId) return reply.code(400).send({ error: 'bad_request' });
    if (!sourceAllowedFor(src, vc(req).maxAgeRating)) return denySource(reply);
    // Through the shared lookup so the add that usually follows this reuses it rather than re-solving.
    const { series, chapters } = await seriesAndChapters(src, sourceId);
    const nums = chapters.map((c) => c.number);
    return {
      source, sourceId,
      title: series?.title || '', summary: series?.summary || '', coverUrl: series?.coverUrl || null,
      genres: series?.genres || [], status: series?.status || '',
      count: chapters.length, first: nums.length ? Math.min(...nums) : null, last: nums.length ? Math.max(...nums) : null,
    };
  });

  app.post('/api/sources/add', async (req, reply) => {
    const { source, sourceId, force, chapterCount, autoUpdate } = (req.body ?? {}) as
      { source?: string; sourceId?: string; force?: boolean; chapterCount?: number; autoUpdate?: boolean };
    if (!source || !sourceId) return reply.code(400).send({ error: 'bad_request' });
    // canDownload is now checked for the whole plugin in the preHandler above, including this route.
    if (!sourceAllowedFor(getSource(source), vc(req).maxAgeRating)) return denySource(reply);
    // `wait: false` -- answer once the decision is made and download afterwards. Everything that decides
    // what to tell the caller (disabled, already present, duplicate, no chapters) still happens inline and
    // still gets its proper status code; only the fetching moves behind the reply.
    const r = await addSeriesFromSource({ source, sourceId, force, chapterCount, autoUpdate, wait: false });
    if (!r.ok) return reply.code(r.status).send({ error: r.error, message: r.message, existing: r.existing, status: r.blockStatus });
    // Audited here rather than after the download, so a slow or failing download does not delay the record
    // of who asked for it. What actually landed is the job's business.
    logAudit('download.add', { userId: (req as any).user?.sub, detail: { title: r.title, source, chapters: r.chapters }, req });
    return { ok: true, title: r.title, folder: r.folder, chapters: r.chapters, started: !!r.started };
  });
}
