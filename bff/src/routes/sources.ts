// Search across sources and add a new series to the library (queues its download). Backed by the source
// adapters + the downloader. The cover proxy lives under /img (cookie auth) so <img> tags can load it.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authenticate, userIdOf, roleOf } from '../lib/auth';
import { getSource, listSources, isSwAdapterId, SW_PREFIX } from '../lib/sources';
import type { SourceAdapter, SourceSeries } from '../lib/sources/types';
import { downloadChapter, sanitize } from '../lib/downloader';
import { persistScan, setBookDates } from '../lib/library';
import { fetchAniListArt, fetchTrendingManhwa, TrendingItem } from '../lib/anilist';
import { q, one } from '../lib/db';
import { healthAll, isDisabled, reportOk, reportFail, classify } from '../lib/sourceHealth';
import { logAudit } from '../lib/audit';
import { env } from '../env';
// The "already in library" annotation is deliberately library-wide: it answers "would adding this be a
// duplicate on this server", which is a property of the server, not of the person asking.
//
// Which SOURCES you may reach is the opposite: entirely about who is asking, which is what `viewCtxFor` and
// `sourceAllowedFor` answer.
import { visibleToAll, viewCtxFor, sourceAllowedFor, type ViewCtx } from '../lib/visibility';

interface Job { title: string; total: number; done: number; status: 'downloading' | 'done' | 'error'; reason?: string }
const jobs = new Map<string, Job>();

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
const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

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
async function latestPage(src: SourceAdapter, page: number): Promise<SourceSeries[]> {
  const key = `${src.id}:${page}`;
  const hit = latestCache.get(key);
  if (hit && Date.now() - hit.at < LATEST_TTL) return hit.items;
  const flying = latestInflight.get(key);
  if (flying) return flying;

  const run = async (): Promise<SourceSeries[]> => {
    try {
      const raw = await withTimeout(src.latest!(page), LATEST_TIMEOUT);
      const seen = new Set<string>();
      // dedupe by sourceId (duplicate ids collide on the React key -> wrong cover/title on a card)
      const items = raw.filter((r) => !!r.sourceId && !seen.has(r.sourceId) && (seen.add(r.sourceId), true)).slice(0, 24);
      latestCache.set(key, { at: Date.now(), items });
      void reportOk(src.id);
      return items;
    } catch (e) {
      // Nothing reported health from here, so a source that timed out on every single visit kept its `ok`
      // status forever and the client's ranking kept putting it first. Reporting is what earns it a cooldown.
      void reportFail(src.id, classify(e) ?? 'down', (e as Error)?.message || 'latest failed');
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

/** Exposed for tests: the cache is process-global and would otherwise leak between cases. */
export function clearLatestCache(): void {
  latestCache.clear();
  latestInflight.clear();
}

export interface AddResult {
  ok: boolean; status: number; error?: string; message?: string;
  title?: string; folder?: string; chapters?: number;
  existing?: { title: string; source: string }; blockStatus?: string;
}

/** Add one series from a source to the library (downloads chapter 1 synchronously, the rest in background).
 *  Shared by POST /api/sources/add and the bulk importer. Returns a result instead of touching the reply. */
export async function addSeriesFromSource(opts: {
  source?: string; sourceId?: string; force?: boolean; chapterCount?: number; autoUpdate?: boolean;
}): Promise<AddResult> {
  const { source, sourceId, force, chapterCount, autoUpdate } = opts;
  const src = source ? getSource(source) : null;
  if (!src || !sourceId) return { ok: false, status: 400, error: 'bad_request' };
  if (await isDisabled(source!)) return { ok: false, status: 403, error: 'disabled', message: `${src.name} is disabled by the admin.` };

  const series = await src.getSeries(sourceId).catch(() => null);
  const title = series?.title || 'Series';
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

  const chapters = await src.listChapters(sourceId).catch(() => []);
  if (!chapters.length) return { ok: false, status: 404, error: 'no_chapters', message: 'No readable chapters for this title on this source. Try a different source.' };
  const selected = chapterCount && chapterCount > 0 ? chapters.slice(0, chapterCount) : chapters;
  const meta = { series: title, summary: series?.summary, author: series?.author, genres: series?.genres, url: series?.url, status: series?.status };
  jobs.set(folder, { title, total: selected.length, done: 0, status: 'downloading' });

  let firstPages = 0; let blockReason: string | null = null;
  try { const r = await downloadChapter({ sourceId: source!, seriesFolder: folder, chapter: selected[0], meta }); firstPages = r.skipped ? 1 : r.pages; }
  catch (e: any) { blockReason = e?.blockStatus || null; }
  if (!firstPages) {
    jobs.delete(folder);
    if (blockReason) {
      const verb = blockReason === 'rate_limited' ? 'rate-limiting' : blockReason === 'blocked' ? 'blocking' : 'unreachable for';
      return { ok: false, status: 429, error: 'blocked', blockStatus: blockReason, message: `${src.name} is currently ${verb} downloads — wait a bit or pick another source.` };
    }
    return { ok: false, status: 422, error: 'undownloadable', message: 'No downloadable chapters here — this title may be licensed or hosted externally on this source. Try a different source.' };
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
    for (const ch of selected.slice(1)) {
      try { await downloadChapter({ sourceId: source!, seriesFolder: folder, chapter: ch, meta }); }
      catch (e: any) { if (e?.blockStatus) { const j = jobs.get(folder); if (j) { j.status = 'error'; j.reason = e.blockStatus; } break; } }
      const j = jobs.get(folder); if (j) { j.done++; if (j.done % 5 === 0) await persistScan().catch(() => {}); }
    }
    await persistScan().catch(() => {});
    await setBookDates(folder, selected).catch(() => {});
    const j = jobs.get(folder); if (j && j.status !== 'error') j.status = 'done';
  })();
  return { ok: true, status: 200, title, folder, chapters: selected.length };
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
    (req as any).viewCtx = await viewCtxFor(userIdOf(req), roleOf(req));
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
        return {
          id: s.id,
          name: s.name,
          // null means "declares no single language", which is not the same as "serves none": a source
          // like MangaDex belongs in every group rather than in an orphan bucket. An adapter may now declare
          // one itself, which is how MangaDex -- hardcoded to ask for English -- stops joining all thirty.
          lang: s.lang ?? (isSwAdapterId(s.id) ? (langs.get(s.id.slice(SW_PREFIX.length)) ?? null) : null),
          latest: typeof s.latest === 'function',
          // What the reader has actually used. Health-then-alphabetical put "18 Porn Comic" and "1Manga.co"
          // at the front of this install's English group while Aqua Manga -- 176 of its 214 series, answering
          // in 2.5s -- was never in the first six fetched.
          used: used.get(s.id) ?? 0,
          status: h?.disabled ? 'disabled' : blocked ? h!.status : 'ok',
          blockedUntil: blocked ? h!.blocked_until : null,
        };
      }),
    };
  });

  // full per-source health for the admin provider dashboard
  app.get('/api/sources/status', async () => ({ content: await healthAll() }));

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
    const results = await latestPage(src, p);
    const have = await inLibrary(results.map((r) => r.title));
    return { content: results.map((r) => ({ ...r, inLibrary: have.has(norm(r.title)) })) };
  });

  app.get('/api/sources/jobs', async () => ({ content: [...jobs.entries()].map(([folder, j]) => ({ folder, ...j })) }));

  // Globally trending manhwa you don't already have, for the Discover recommendations rail.
  app.get('/api/discover/trending', async (_req, reply) => {
    reply.header('cache-control', 'no-store'); // never let a stale/empty copy get pinned client-side
    if (!trendingCache || Date.now() - trendingCache.at > 6 * 3600_000) {
      try { trendingCache = { at: Date.now(), items: await fetchTrendingManhwa() }; } catch { if (!trendingCache) return { content: [] }; }
    }
    // No per-user filter here on purpose: `isAdult:false` is an argument to the AniList query, so adult
    // titles never arrive, and the cache is shared for six hours -- filtering it per viewer would pin one
    // capped account's view for everyone.
    const have = await inLibrary(trendingCache.items.map((t) => t.title));
    return { content: trendingCache.items.filter((t) => !have.has(norm(t.title))).slice(0, 24) };
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
    const [series, chapters] = await Promise.all([src.getSeries(sourceId).catch(() => null), src.listChapters(sourceId).catch(() => [])]);
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
    const r = await addSeriesFromSource({ source, sourceId, force, chapterCount, autoUpdate });
    if (!r.ok) return reply.code(r.status).send({ error: r.error, message: r.message, existing: r.existing, status: r.blockStatus });
    logAudit('download.add', { userId: (req as any).user?.sub, detail: { title: r.title, source, chapters: r.chapters }, req });
    return { ok: true, title: r.title, folder: r.folder, chapters: r.chapters };
  });
}
