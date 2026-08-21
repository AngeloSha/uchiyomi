// Search across sources and add a new series to the library (queues its download). Backed by the source
// adapters + the downloader. The cover proxy lives under /img (cookie auth) so <img> tags can load it.
import type { FastifyInstance } from 'fastify';
import { authenticate } from '../lib/auth';
import { getSource, listSources } from '../lib/sources';
import { downloadChapter, sanitize } from '../lib/downloader';
import { persistScan, setBookDates } from '../lib/library';
import { fetchAniListArt, fetchTrendingManhwa, TrendingItem } from '../lib/anilist';
import { q, one } from '../lib/db';
import { healthAll, isDisabled } from '../lib/sourceHealth';
import { logAudit } from '../lib/audit';

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
          AND deleted_at IS NULL AND merged_into IS NULL LIMIT 1`,
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

  app.get('/api/sources', async () => {
    const health = new Map((await healthAll()).map((h) => [h.source_id, h]));
    const now = Date.now();
    return {
      content: listSources().map((s) => {
        const h = health.get(s.id);
        const blocked = !!(h?.blocked_until && new Date(h.blocked_until).getTime() > now);
        return { id: s.id, name: s.name, latest: typeof s.latest === 'function', status: h?.disabled ? 'disabled' : blocked ? h!.status : 'ok', blockedUntil: blocked ? h!.blocked_until : null };
      }),
    };
  });

  // full per-source health for the admin provider dashboard
  app.get('/api/sources/status', async () => ({ content: await healthAll() }));

  app.get('/api/sources/search', async (req) => {
    const { source, q: query } = req.query as { source?: string; q?: string };
    const src = source ? getSource(source) : null;
    if (!src || !query?.trim()) return { content: [] };
    const raw = await src.search(query.trim()).catch(() => []);
    // dedupe by sourceId (duplicate ids collide on the React key → wrong cover/title on a card)
    const seen = new Set<string>();
    const results = raw.filter((r) => !!r.sourceId && !seen.has(r.sourceId) && (seen.add(r.sourceId), true)).slice(0, 24);
    // flag titles already in the library so the UI can mark them instead of offering a duplicate add
    const have = new Set((await q<{ title: string }>('SELECT title FROM lib_series WHERE deleted_at IS NULL AND merged_into IS NULL')).map((r) => norm(r.title)));
    return { content: results.map((r) => ({ ...r, inLibrary: have.has(norm(r.title)) })) };
  });

  // Search a title across ALL enabled providers at once, grouped so one card carries every source that
  // has it — the UI then lets you choose which source to add from (like the trending flow).
  app.get('/api/sources/search-all', async (req) => {
    const term = ((req.query as { q?: string }).q || '').trim();
    if (!term) return { content: [] };
    const per = await Promise.all(findOrder().map(async (id) => {
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
    const have = new Set((await q<{ title: string }>('SELECT title FROM lib_series WHERE deleted_at IS NULL AND merged_into IS NULL')).map((x) => norm(x.title)));
    const out = [...groups.values()]
      .map((g) => ({ ...g, inLibrary: have.has(norm(g.title)) }))
      .sort((a, b) => b.providers.length - a.providers.length)
      .slice(0, 30);
    return { content: out };
  });

  // Browse a source's newest / recently-updated series (no query). Same card shape as search.
  app.get('/api/sources/latest', async (req) => {
    const { source, page } = req.query as { source?: string; page?: string };
    const src = source ? getSource(source) : null;
    if (!src || typeof src.latest !== 'function') return { content: [] };
    if (await isDisabled(source!).catch(() => false)) return { content: [] };
    const p = Math.max(1, parseInt(page || '1', 10) || 1);
    const raw = await src.latest(p).catch(() => []);
    const seen = new Set<string>();
    const results = raw.filter((r) => !!r.sourceId && !seen.has(r.sourceId) && (seen.add(r.sourceId), true)).slice(0, 24);
    const have = new Set((await q<{ title: string }>('SELECT title FROM lib_series WHERE deleted_at IS NULL AND merged_into IS NULL')).map((r) => norm(r.title)));
    return { content: results.map((r) => ({ ...r, inLibrary: have.has(norm(r.title)) })) };
  });

  app.get('/api/sources/jobs', async () => ({ content: [...jobs.entries()].map(([folder, j]) => ({ folder, ...j })) }));

  // Globally trending manhwa you don't already have, for the Discover recommendations rail.
  app.get('/api/discover/trending', async (_req, reply) => {
    reply.header('cache-control', 'no-store'); // never let a stale/empty copy get pinned client-side
    if (!trendingCache || Date.now() - trendingCache.at > 6 * 3600_000) {
      try { trendingCache = { at: Date.now(), items: await fetchTrendingManhwa() }; } catch { if (!trendingCache) return { content: [] }; }
    }
    const have = new Set((await q<{ title: string }>('SELECT title FROM lib_series WHERE deleted_at IS NULL AND merged_into IS NULL')).map((r) => norm(r.title)));
    return { content: trendingCache.items.filter((t) => !have.has(norm(t.title))).slice(0, 24) };
  });

  // Find a title across all providers (Aqua first) → the best match per provider that carries it.
  app.get('/api/sources/find', async (req) => {
    const term = ((req.query as { q?: string }).q || '').trim();
    if (!term) return { content: [] };
    const found = await Promise.all(
      findOrder().map(async (id) => {
        const src = getSource(id);
        if (!src) return null;
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
    // permission: non-admins can be denied the ability to add/download series
    const me = await one<{ role: string; perms: { canDownload?: boolean } }>('SELECT role, perms FROM users WHERE id = $1', [(req as any).user?.sub]);
    if (me && me.role !== 'admin' && me.perms?.canDownload === false) return reply.code(403).send({ error: 'forbidden', message: "You don't have permission to add series." });
    const r = await addSeriesFromSource({ source, sourceId, force, chapterCount, autoUpdate });
    if (!r.ok) return reply.code(r.status).send({ error: r.error, message: r.message, existing: r.existing, status: r.blockStatus });
    logAudit('download.add', { userId: (req as any).user?.sub, detail: { title: r.title, source, chapters: r.chapters }, req });
    return { ok: true, title: r.title, folder: r.folder, chapters: r.chapters };
  });
}
