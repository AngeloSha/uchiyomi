import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { q, one } from '../lib/db';
import { junkPagesFor, setPageOverride } from '../lib/junkPages';
import { komgaImage } from '../lib/komga';
import { content as komga, NATIVE_PROGRESS } from '../lib/backend';
import { UnsupportedFilter } from '../lib/ownedCatalog';
import { cleanDescription } from '../lib/htmlText';
import { viewCtxFor, SYSTEM_CTX, type ViewCtx, hideAdult, browsableIds, browsable, Params } from '../lib/visibility';

/** The viewer attached by the preHandler above. */
const vc = (req: FastifyRequest): ViewCtx => (req as any).viewCtx as ViewCtx;
import { dominantHex } from '../lib/color';
import { runtime } from '../lib/runtime';
import { authenticate, roleOf, userIdOf } from '../lib/auth';
import { warmHeroBackdrops } from './images';
import { writeProgress, reachedEnd } from '../lib/progress';
import { enrichSeries, seriesSeen } from '../lib/enrich';
import { seriesSourcesFor } from '../lib/seriesSources';
import { readSeriesPrefs, effectivePrefsFor } from '../lib/scanlatorPrefs';
import { listingFor, type ListingCopy } from '../lib/seriesListing';
import { groupStats, type StatCopy } from '../lib/groupStats';
import { groupsOf, normGroup } from '../lib/releases';
import { getSource } from '../lib/sources';



// Per-user tracking: the admin reads native Komga progress (so nothing resets and it stays in sync
// with other Komga clients); sub-accounts get fully independent progress from read_progress.
async function userProgress(userId: string, bookIds: string[]): Promise<Map<string, { page: number; completed: boolean }>> {
  if (!bookIds.length) return new Map();
  const rows = await q<{ book_id: string; page: number; completed: boolean }>(
    'SELECT book_id, page, completed FROM read_progress WHERE user_id = $1 AND book_id = ANY($2)',
    [userId, bookIds],
  );
  return new Map(rows.map((r) => [r.book_id, { page: r.page, completed: r.completed }]));
}

function overlay(books: any[], map: Map<string, { page: number; completed: boolean }>): any[] {
  return books.map((b) => {
    const p = map.get(b.id);
    return { ...b, readProgress: p ? { page: p.page, completed: p.completed } : null };
  });
}

/** Apply this user's reading state to a set of Komga books (no-op for admin = native Komga state). */
async function booksForUser(req: FastifyRequest, books: any[]): Promise<any[]> {
  if ((NATIVE_PROGRESS && roleOf(req) === 'admin') || !books.length) return books;
  return overlay(books, await userProgress(userIdOf(req), books.map((b) => b.id)));
}



const searchBody = z.object({
  query: z.string().optional(),
  sort: z.string().optional(),
  page: z.coerce.number().int().min(0).default(0),
  size: z.coerce.number().int().min(1).max(100).default(40),
  condition: z.any().optional(),
});

const progressBody = z.object({
  page: z.coerce.number().int().min(0),
  completed: z.boolean().default(false),
  seriesId: z.string().optional(),
  deviceId: z.string().max(128).optional(),
  // manual mark-as-read: update read_progress but skip the reading_events append, so bulk-marking a
  // backlog doesn't inflate the weekly leaderboard / stats (events = chapters actually read in the app)
  silent: z.boolean().default(false),
  // When the event actually happened, in client ms. The offline outbox replays events minutes or days after
  // the fact, and without this the server cannot tell a queued page-12 from a live one and lets it overwrite
  // a position the reader has since moved well past. Absent means "now", which is every live ping.
  at: z.coerce.number().int().positive().optional(),
});

const forYouCache = new Map<string, { ts: number; pool: any[] }>();

/** Raw recommendation pool from the genres of what the user favorites + finishes (cached 10m). */
async function tasteRecs(req: FastifyRequest): Promise<any[]> {
  const uid = userIdOf(req);
  // Keyed by the reveal state as well as the user: the pool is built from filtered queries, so a pool built
  // while 18+ was revealed would otherwise be handed straight back after it was hidden again.
  const key = `${uid}:${vc(req).hideAdultLibraries ? 'safe' : 'all'}`;
  const cached = forYouCache.get(key);
  if (cached && Date.now() - cached.ts < 10 * 60 * 1000) return cached.pool;
  const favIds = (await q<{ series_id: string }>('SELECT series_id FROM favorites WHERE user_id = $1', [uid])).map((r) => r.series_id);
  const doneIds = (await q<{ series_id: string }>('SELECT DISTINCT series_id FROM read_progress WHERE user_id = $1 AND completed = true', [uid])).map((r) => r.series_id);
  const sourceIds = Array.from(new Set([...favIds, ...doneIds])).slice(0, 30);
  const sources = (await Promise.all(sourceIds.map((id) => komga.series(vc(req), id).catch(() => null)))).filter(Boolean) as any[];
  const counts = new Map<string, number>();
  for (const s of sources) for (const g of s.metadata?.genres ?? []) counts.set(g, (counts.get(g) ?? 0) + 1);
  const topGenres = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map((e) => e[0]);
  let pool: any[];
  if (topGenres.length) {
    const res = await komga.searchSeries(vc(req), { condition: { anyOf: topGenres.map((g) => ({ genre: { operator: 'is', value: g } })) } }, 0, 60);
    pool = res.content;
  } else {
    pool = (((await komga.seriesUpdated(vc(req), 0, 40).catch(() => ({ content: [] }))) as any).content) ?? [];
  }
  const exclude = new Set([...favIds, ...doneIds]);
  pool = pool.filter((s) => !exclude.has(s.id));
  forYouCache.set(key, { ts: Date.now(), pool });
  return pool;
}

// How many series the Continue Reading rail carries. 20 hid 33 of the heaviest user's 53 in progress.
const ON_DECK_LIMIT = 60;

export default async function catalogRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);
  // Resolve the viewer once per request. Everything below reads it rather than deriving its own, so there
  // is one decision about what this person may see instead of a predicate each handler has to remember.
  app.addHook('preHandler', async (req) => {
    (req as any).viewCtx = await viewCtxFor(userIdOf(req), roleOf(req), { hideAdult: hideAdult(req) });
  });

  app.get('/api/libraries', async (req) => komga.libraries(vc(req)));

  // No re-sort. SQL already ordered these by the database collation; sorting again in JS is byte order, so
  // every lowercase genre jumped to the end of the grid after every uppercase one.
  app.get('/api/genres', async (req) => ({ content: await komga.genres(vc(req)) }));

  // The same list, with the numbers and the cover ids the browse page needs to be worth looking at.
  //
  // Deliberately not cached. The obvious cache key is the user id, which is what the recommendation pool
  // above uses -- but this result depends on the whole ViewCtx (which libraries they hold, what age cap
  // they carry), so a key that omits those serves one member's genre list to another the moment either
  // changes. It is a single aggregate over lib_series that never touches lib_books, so the query is cheap
  // enough that the correct cache is no cache.
  app.get('/api/genres/overview', async (req) => {
    const n = Math.max(1, Math.min(8, Number((req.query as { covers?: string }).covers) || 4));
    return { content: await komga.genreOverview(vc(req), n) };
  });

  // What everyone in the household is reading (cross-user, last 14 days).
  app.get('/api/trending', async (req) => {
    // Over-fetch, then filter, then take twelve. The LIMIT used to run BEFORE the per-id visibility check,
    // so the rail quietly came back short for anyone who could not see one of the twelve -- and now also for
    // anyone hiding 18+.
    const rows = await q<{ series_id: string }>(
      `SELECT series_id FROM reading_events WHERE created_at > now() - interval '14 days'
       GROUP BY series_id ORDER BY count(*) DESC LIMIT 60`,
    );
    const ok = await browsableIds(rows.map((r) => r.series_id), vc(req));
    const ids = rows.map((r) => r.series_id).filter((id) => ok.has(id)).slice(0, 12);
    const series = (await Promise.all(ids.map((id) => komga.series(vc(req), id).catch(() => null)))).filter(Boolean) as any[];
    return { content: await enrichSeries(req, series) };
  });

  // Weekly reading leaderboard across accounts.
  app.get('/api/leaderboard', async () => {
    const rows = await q(
      `SELECT u.id, u.display_name, u.username, u.avatar,
              count(DISTINCT e.book_id) FILTER (WHERE e.completed AND e.created_at > now() - interval '7 days')::int AS week,
              count(DISTINCT e.book_id) FILTER (WHERE e.completed)::int AS total
       FROM users u LEFT JOIN reading_events e ON e.user_id = u.id
       GROUP BY u.id ORDER BY week DESC, total DESC`,
    );
    return { content: rows };
  });

  // Random series (Surprise me).
  app.get('/api/random', async (req) => {
    const first = await komga.searchSeries(vc(req), {}, 0, 1);
    const total = first.totalElements ?? 0;
    if (!total) return { seriesId: null };
    const idx = Math.floor(Math.random() * total);
    const page = await komga.searchSeries(vc(req), {}, idx, 1);
    return { seriesId: page.content?.[0]?.id ?? null };
  });

  // Taste-based recommendations rail.
  app.get('/api/foryou', async (req) => {
    const pool = [...(await tasteRecs(req))];
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    return { content: await enrichSeries(req, pool.slice(0, 20)) };
  });

  // Daily recommendation set for the home hero (taste + fresh, stable through the day).
  app.get('/api/featured', async (req) => {
    const today = new Date().toISOString().slice(0, 10);
    const [taste, updated] = await Promise.all([
      tasteRecs(req),
      komga.seriesUpdated(vc(req), 0, 20).catch(() => ({ content: [] as any[] })),
    ]);
    const seen = new Set<string>();
    const merged: any[] = [];
    for (const s of [...taste, ...((updated as any).content ?? [])]) if (s && !seen.has(s.id)) { seen.add(s.id); merged.push(s); }
    const h = (str: string) => { let x = 0; for (let i = 0; i < str.length; i++) x = (x * 131 + str.charCodeAt(i)) >>> 0; return x; };
    merged.sort((a, b) => h(a.id + today) - h(b.id + today));
    const picks = merged.slice(0, 7);
    // pre-generate both hero frames for today's picks so the carousel never waits on sharp/remote fetches
    void warmHeroBackdrops(picks.map((s) => s.id));
    return { content: await enrichSeries(req, picks) };
  });

  app.post('/api/refresh', async () => {
    const now = Date.now();
    if (now - runtime.lastScan < 60_000) return { scanned: false, reason: 'rate_limited' };
    runtime.lastScan = now;
    // A rescan walks the disk on everyone's behalf, so it is deliberately not a per-viewer read.
    const libs = await komga.libraries(SYSTEM_CTX).catch(() => [] as any[]);
    await Promise.all(libs.map((l: any) => komga.scanLibrary(SYSTEM_CTX, l.id).catch(() => {})));
    return { scanned: true, libraries: libs.length };
  });

  app.get('/api/home', async (req) => {
    const uid = userIdOf(req);
    const admin = NATIVE_PROGRESS && roleOf(req) === 'admin';

    let onDeckP: Promise<any[]>;
    if (admin) {
      onDeckP = komga.booksOnDeck(vc(req), 0, 20).then((r: any) => r.content).catch(() => []);
    } else {
      onDeckP = (async () => {
        // One row per series you have been reading lately: the chapter you are part-way through, or -- if you
        // finished it -- the next one you have not read.
        //
        // It used to be only `completed = false`, so finishing a chapter dropped the series out of Continue
        // Reading entirely and nothing put the next one in front of you. You had to remember what you were
        // reading and go find it, which is precisely the job this rail exists to do.
        //
        // Scoped to series touched in the last 90 days so the list stays short, ordered by when you last read.
        // The 18+ filter is applied HERE rather than after the fact, for the same reason the LIMIT is: this
        // resolves each pick through komga.book(), which is a by-id read and deliberately does not filter,
        // so a series hidden from browsing would otherwise stay in Continue Reading. Params is used rather
        // than hand-written $1/$2 because `browsable()` pushes its own for a restricted viewer.
        const p = new Params();
        const uidP = p.add(uid);
        const rows = await q<{ book_id: string }>(
          `WITH recent AS (
             SELECT series_id, max(updated_at) AS last_read
               FROM read_progress rp
              WHERE rp.user_id = ${uidP} AND rp.updated_at > now() - interval '90 days'
                AND EXISTS (SELECT 1 FROM lib_series s WHERE s.id = rp.series_id AND ${browsable('s', vc(req), p)})
              GROUP BY series_id
           ),
           pick AS (
             SELECT r.series_id, r.last_read,
                    COALESCE(
                      -- the chapter you are part-way through wins
                      (SELECT p.book_id FROM read_progress p
                         WHERE p.user_id = ${uidP} AND p.series_id = r.series_id AND p.completed = false
                         ORDER BY p.updated_at DESC LIMIT 1),
                      -- otherwise the lowest-numbered chapter you have not finished
                      (SELECT b.id FROM lib_books b
                         LEFT JOIN book_overrides bo ON bo.book_id = b.id
                         WHERE b.series_id = r.series_id
                           -- never offer a chapter whose pages were deleted (a tombstone, lib/chapterCleanup.ts)
                           AND b.pruned_at IS NULL
                           AND NOT EXISTS (
                             SELECT 1 FROM read_progress p2
                              WHERE p2.user_id = ${uidP} AND p2.book_id = b.id AND p2.completed
                           )
                         ORDER BY COALESCE(bo.number, b.number) ASC, b.file ASC LIMIT 1)
                    ) AS book_id
               FROM recent r
           )
           SELECT book_id FROM pick
            WHERE book_id IS NOT NULL      -- a series you have finished entirely drops out, correctly
            ORDER BY last_read DESC
            LIMIT ${p.add(ON_DECK_LIMIT)}`,
          p.values as any[],
        );
        // The part-way-through pick above is a read_progress row, which survives a prune by design, so the
        // resolved book is checked as well: Continue Reading must never hand someone a chapter with no pages.
        const books = (await Promise.all(rows.map((r) => komga.book(vc(req), r.book_id).catch(() => null))))
          .filter((b) => b && !b.pruned) as any[];
        return overlay(books, await userProgress(uid, books.map((b) => b.id)));
      })();
    }

    const [onDeck, updated, fresh] = await Promise.all([
      onDeckP,
      komga.seriesUpdated(vc(req), 0, 20).catch(() => ({ content: [] })),
      komga.seriesNew(vc(req), 0, 20).catch(() => ({ content: [] })),
    ]);

    // Which device each in-progress book was last read on. Reading progress is already shared across devices;
    // this just says where you left it, so picking up on another screen doesn't feel like guesswork.
    // The client hides it when the device is the one you're already holding.
    if (onDeck.length) {
      const ids = onDeck.map((b: any) => b.id);
      const seen = await q<{ book_id: string; device_id: string | null; created_at: string; device_name: string | null }>(
        `SELECT DISTINCT ON (e.book_id) e.book_id, e.device_id, e.created_at,
                (SELECT rt.device_name FROM refresh_tokens rt
                  WHERE rt.user_id = e.user_id AND rt.device_id = e.device_id AND rt.device_name IS NOT NULL
                  ORDER BY rt.last_seen DESC LIMIT 1) AS device_name
           FROM reading_events e
          WHERE e.user_id = $1 AND e.book_id = ANY($2) AND e.device_id IS NOT NULL
          ORDER BY e.book_id, e.created_at DESC`,
        [uid, ids],
      ).catch(() => []);
      const byBook = new Map(seen.map((r) => [r.book_id, r]));
      for (const b of onDeck as any[]) {
        const r = byBook.get(b.id);
        if (r?.device_id) b.lastDevice = { id: r.device_id, name: r.device_name || null, at: new Date(r.created_at).toISOString() };
      }
    }

    // Home's own favourites rail. Ids from another table again, so it inherits nothing and needs the same
    // filter as every other id-gathering surface -- and the same over-fetch, because the LIMIT ran first.
    const favAll = (
      await q<{ series_id: string }>('SELECT series_id FROM favorites WHERE user_id = $1 ORDER BY created_at DESC LIMIT 60', [uid])
    ).map((r) => r.series_id);
    const favShown = await browsableIds(favAll, vc(req));
    const favIds = favAll.filter((id) => favShown.has(id)).slice(0, 20);
    const favorites = ((await Promise.all(favIds.map((id) => komga.series(vc(req), id).catch(() => null)))).filter(Boolean)) as any[];

    // updates badge: favorites with new chapters since last seen (self-heal missing baselines)
    const seenMap = await seriesSeen(uid, favorites.map((s) => s.id));
    let updatesCount = 0;
    for (const s of favorites) {
      if (seenMap.has(s.id)) {
        if ((s.booksCount ?? 0) > (seenMap.get(s.id) ?? 0)) updatesCount++;
      } else {
        await q(`INSERT INTO series_seen (user_id, series_id, seen_books_count) VALUES ($1, $2, $3) ON CONFLICT (user_id, series_id) DO NOTHING`, [uid, s.id, s.booksCount ?? 0]);
      }
    }

    return {
      onDeck,
      updated: await enrichSeries(req, (updated as any).content ?? []),
      new: await enrichSeries(req, (fresh as any).content ?? []),
      favorites: await enrichSeries(req, favorites),
      updatesCount,
    };
  });

  app.post('/api/series/search', async (req, reply) => {
    const { query, sort, page, size, condition } = searchBody.parse(req.body ?? {});
    const body: { condition?: unknown; fullTextSearch?: string } = {};
    if (condition) body.condition = condition;
    if (query) body.fullTextSearch = query;
    try {
      // The user context enables the read-status filter and the real unread sort. Both have to be answered
      // in SQL: enrichSeries runs after LIMIT/OFFSET, so filtering there would return short pages and a
      // totalElements that disagrees with them.
      const res = await komga.searchSeries(vc(req), body, page, size, sort);
      return { ...res, content: await enrichSeries(req, res.content) };
    } catch (e) {
      // A filter the query cannot express used to silently widen to the whole library. Say so instead.
      if (e instanceof UnsupportedFilter) return reply.code(400).send({ error: 'unsupported_filter', predicate: e.predicate });
      throw e;
    }
  });

  app.get('/api/series/:id', async (req) => {
    const { id } = req.params as { id: string };
    const series = await komga.series(vc(req), id);
    // opening a series marks its new chapters as seen
    await q(
      `INSERT INTO series_seen (user_id, series_id, seen_books_count) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, series_id) DO UPDATE SET seen_books_count = EXCLUDED.seen_books_count, seen_at = now()`,
      [userIdOf(req), id, series.booksCount ?? 0],
    );
    const out: any = (await enrichSeries(req, [series]))[0];
    // apply admin metadata overrides (title/summary shown here; cover/banner are handled by the image server)
    const ov = await one<{ title: string | null; summary: string | null; cover: string | null; banner: string | null;
                          author: string | null; status: string | null; genres: string[] | null;
                          age_rating: number | null; v: string }>(
      `SELECT title, summary, cover, banner, author, status, genres, age_rating,
              EXTRACT(EPOCH FROM updated_at) * 1000 AS v FROM series_overrides WHERE series_id = $1`,
      [id],
    );
    if (ov) {
      if (ov.title) { out.name = ov.title; if (out.metadata) out.metadata.title = ov.title; }
      // Through the same strip seriesDto applies to a stored summary: this assignment runs AFTER the DTO was
      // built, so an override pasted with Markdown (a MangaDex blurb copied into Edit details) reached the
      // page raw while the un-overridden summary next to it was clean. The editor still seeds from
      // `out.overrides` below, which keeps the text as typed. Reintroduce by assigning `ov.summary` here:
      // "an overridden summary is stripped like a stored one" reads the asterisks back.
      if (ov.summary != null) { const clean = cleanDescription(ov.summary); if (out.metadata) out.metadata.summary = clean; if (out.booksMetadata) out.booksMetadata.summary = clean; }
      out.artVersion = Math.floor(Number(ov.v)) || 0;
      // the edit modal seeds from these, so every overridable field has to come back or a save would
      // write back a blank and clear the very override the user opened the modal to keep
      out.overrides = { title: ov.title, summary: ov.summary, cover: ov.cover, banner: ov.banner,
                        author: ov.author, status: ov.status, genres: ov.genres, ageRating: ov.age_rating };
      // The edit modal seeds from the override where one exists, so the effective rating has to reflect it
      // or reopening the modal would show the scanned value and saving would undo the correction.
      if (ov.age_rating != null && out.metadata) out.metadata.ageRating = ov.age_rating;
    }
    // Where the chapters come from: the primary source first, then any followed ones. Every viewer gets
    // this -- it is what the "Sources" line under the title shows, and nothing in it names the host.
    out.sources = await seriesSourcesFor(id).catch(() => []);
    // Admins get the on-disk folder, because the rename control needs something to seed from and to show
    // what is about to move. Members do not: it is the one field here that describes the host filesystem.
    // The series' own release preferences ride along for the same audience: the editor seeds from them, and
    // null (rather than absent) says "none of its own, the global ones apply".
    if (roleOf(req) === 'admin') {
      const f = await one<{ folder: string }>('SELECT folder FROM lib_series WHERE id = $1', [id]);
      if (f) out.folder = f.folder;
      out.scanlatorPrefs = await readSeriesPrefs(id).catch(() => null);
    }
    return out;
  });

  // Updates feed: favorited series that gained chapters since you last opened them.
  app.get('/api/updates', async (req) => {
    const uid = userIdOf(req);
    const favRows = (await q<{ series_id: string }>('SELECT series_id FROM favorites WHERE user_id = $1', [uid])).map((r) => r.series_id);
    // Favourites are ids from another table, so they inherit nothing: filter them before resolving.
    const shown = await browsableIds(favRows, vc(req));
    const favIds = favRows.filter((id) => shown.has(id));
    const favSeries = ((await Promise.all(favIds.map((id) => komga.series(vc(req), id).catch(() => null)))).filter(Boolean)) as any[];
    const seenMap = await seriesSeen(uid, favSeries.map((s) => s.id));
    const out: { series: any; newCount: number }[] = [];
    for (const s of favSeries) {
      if (!seenMap.has(s.id)) {
        await q(`INSERT INTO series_seen (user_id, series_id, seen_books_count) VALUES ($1, $2, $3) ON CONFLICT (user_id, series_id) DO NOTHING`, [uid, s.id, s.booksCount ?? 0]);
        continue;
      }
      const newCount = Math.max(0, (s.booksCount ?? 0) - (seenMap.get(s.id) ?? 0));
      if (newCount > 0) out.push({ series: (await enrichSeries(req, [s]))[0], newCount });
    }
    // newest chapter date per series: source release date when stamped, else the file's mtime
    if (out.length) {
      const latest = await q<{ series_id: string; latest: string }>(
        `SELECT series_id, max(COALESCE(published_at, to_timestamp(mtime / 1000.0))) AS latest
         FROM lib_books WHERE series_id = ANY($1) GROUP BY series_id`,
        [out.map((o) => o.series.id)],
      );
      const byId = new Map(latest.map((r) => [r.series_id, r.latest]));
      for (const o of out as any[]) o.latestAt = byId.get(o.series.id) || null;
    }
    out.sort((a: any, b: any) => (Date.parse(b.latestAt || 0) || 0) - (Date.parse(a.latestAt || 0) || 0) || b.newCount - a.newCount);
    return { content: out };
  });

  app.post('/api/updates/seen', async (req) => {
    const uid = userIdOf(req);
    const favIds = (await q<{ series_id: string }>('SELECT series_id FROM favorites WHERE user_id = $1', [uid])).map((r) => r.series_id);
    const favSeries = ((await Promise.all(favIds.map((id) => komga.series(vc(req), id).catch(() => null)))).filter(Boolean)) as any[];
    for (const s of favSeries) {
      await q(
        `INSERT INTO series_seen (user_id, series_id, seen_books_count) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, series_id) DO UPDATE SET seen_books_count = EXCLUDED.seen_books_count, seen_at = now()`,
        [uid, s.id, s.booksCount ?? 0],
      );
    }
    return { ok: true };
  });

  // Ambient cover color (computed + cached on demand).
  app.get('/api/series/:id/color', async (req) => {
    const { id } = req.params as { id: string };
    const row = await one<{ color: string }>('SELECT color FROM series_colors WHERE series_id = $1', [id]);
    if (row?.color) return { color: row.color };
    if (NATIVE_PROGRESS) try {
      const res = await komgaImage(komga.seriesThumbPath!(id));
      if (res.statusCode < 400) {
        const buf = Buffer.from(await res.body.arrayBuffer());
        const hex = await dominantHex(buf);
        await q(
          `INSERT INTO series_colors (series_id, color) VALUES ($1, $2)
           ON CONFLICT (series_id) DO UPDATE SET color = EXCLUDED.color, updated_at = now()`,
          [id, hex],
        );
        return { color: hex };
      }
    } catch {}
    return { color: null };
  });

  // "More like this" — series sharing genres with this one.
  app.get('/api/series/:id/similar', async (req) => {
    const { id } = req.params as { id: string };
    const s = (await komga.series(vc(req), id).catch(() => null)) as any;
    const genres = (s?.metadata?.genres ?? []).slice(0, 3);
    if (!genres.length) return { content: [] };
    const res = await komga.searchSeries(vc(req), { condition: { anyOf: genres.map((g: string) => ({ genre: { operator: 'is', value: g } })) } }, 0, 24);
    const content = res.content.filter((x: any) => x.id !== id).slice(0, 18);
    return { content: await enrichSeries(req, content) };
  });

  app.get('/api/series/:id/books', async (req) => {
    const { id } = req.params as { id: string };
    const { page = '0', size = '200', sort } = req.query as Record<string, string>;
    const res = await komga.seriesBooks(vc(req), id, Number(page), Number(size), sort || undefined);
    return { ...res, content: await booksForUser(req, res.content) };
  });

  /**
   * The chapters the sources list that this server does not hold, with the reason each is absent -- the
   * ghost rows on the series page. Read from the listing the updater persisted at the last check, never
   * from the sources themselves: a page open is not a reason to hit a site, and "as of the last check" is
   * the truthful answer anyway (lib/seriesListing.ts).
   *
   * Resolved through the same visibility gate as the series itself: `komga.series` throws 404 for anything
   * this viewer cannot open, so a capped member cannot learn what a walled-off series is missing. The
   * downloader's error text names hosts and paths, so `reason` goes to admins only.
   */
  app.get('/api/series/:id/listing', async (req) => {
    const { id } = req.params as { id: string };
    await komga.series(vc(req), id);
    const f = await one<{ chapter_floor: number | null }>('SELECT chapter_floor FROM lib_series WHERE id = $1', [id]);
    const floor = f?.chapter_floor == null ? null : Number(f.chapter_floor);
    return listingFor(id, { floor, admin: roleOf(req) === 'admin' });
  });

  /** When the series' sources were last listed, as the listing routes report it. */
  const checkedAtOf = async (id: string): Promise<string | null> => {
    const s = await one<{ source_checked_at: Date | null }>('SELECT source_checked_at FROM lib_series WHERE id = $1', [id]);
    const v = s?.source_checked_at ?? null;
    return v == null ? null : v instanceof Date ? v.toISOString() : new Date(v).toISOString();
  };

  /**
   * Who scanlates this series: one entry per group with how much it released, which chapters, when the
   * last was, its rhythm and whether it has gone quiet, and how many of its chapters are on this server.
   *
   * From the persisted listing's copies plus the group stamps on the files -- never from the sources on a
   * page open, for the reason the ghost list gives. Same visibility gate as the series: `komga.series`
   * throws 404 for anything this viewer cannot open, so a walled-off member cannot learn who releases a
   * series they cannot see. Any viewer who can open the series may read it; ranking and blocking the
   * groups is the admin route (GET /api/admin/series/:id/scanlators), which carries these same figures.
   */
  app.get('/api/series/:id/groups', async (req) => {
    const { id } = req.params as { id: string };
    await komga.series(vc(req), id);
    const rows = await q<{ number: number; copies: ListingCopy[] }>('SELECT number, copies FROM series_listing WHERE series_id = $1', [id]);
    const copies: StatCopy[] = [];
    for (const r of rows) for (const c of r.copies ?? []) copies.push({ ...c, number: Number(r.number) });
    // Live rows only: a tombstone's group is a file that is no longer here, and "3 on this server" has to
    // count what a reader can open.
    const onDisk = await q<{ number: number; scanlator: string | null }>(
      'SELECT number, scanlator FROM lib_books WHERE series_id = $1 AND pruned_at IS NULL AND scanlator IS NOT NULL', [id]);
    return { checkedAt: await checkedAtOf(id), content: groupStats(copies, onDisk.map((b) => ({ number: Number(b.number), scanlator: b.scanlator }))) };
  });

  /**
   * Every version of every listed chapter: per number, each copy the sources list with its group, language,
   * page count and date, flagged `chosen` (the copy the release rules picked), `blocked` (every group on it
   * is blocked by the effective preferences -- shown so a person can pick it anyway) and `onDisk` (this
   * copy is the one on this server, as far as the file's stamps can tell).
   *
   * `onDisk` is best effort by construction. A file is stamped with the source it came from and the group
   * string it was released under, not with a chapter id, so a copy is "on disk" when a live row for the
   * number came from the same source and its group stamp splits to the same set of groups; a row with no
   * group stamp at all (a file the scanner found, or one from before v0.31.0) can only be matched to the
   * chosen copy, which is the one the sweep would have taken -- and such a row usually has no source stamp
   * either (setBookMeta writes both columns together, and nothing else writes them), so an unknown
   * provenance matches the chosen copy from any source rather than none. A number listed before v0.33.0
   * has an empty `copies` until its next check, and the client hides the versions pill for it.
   *
   * `chosen` is what the rules would take, so a `blocked` number -- every copy dropped, the first kept in
   * `chosen` only for display (lib/seriesListing.ts) -- has no chosen copy at all: the rules took nothing.
   */
  app.get('/api/series/:id/versions', async (req) => {
    const { id } = req.params as { id: string };
    await komga.series(vc(req), id);
    const rows = await q<{ number: number; source_id: string; status: string; chosen: { sourceId?: string } | null; copies: ListingCopy[] }>(
      'SELECT number, source_id, status, chosen, copies FROM series_listing WHERE series_id = $1 ORDER BY number', [id]);
    const books = await q<{ number: number; source_id: string | null; scanlator: string | null }>(
      'SELECT number, source_id, scanlator FROM lib_books WHERE series_id = $1 AND pruned_at IS NULL', [id]);
    const booksOf = new Map<number, typeof books>();
    for (const b of books) {
      const n = Number(b.number);
      const list = booksOf.get(n);
      if (list) list.push(b); else booksOf.set(n, [b]);
    }
    const prefs = await effectivePrefsFor(await readSeriesPrefs(id));
    const blockedKeys = new Set(prefs.blocked.map(normGroup).filter(Boolean));
    const keysOf = (groups: string[]) => groups.map(normGroup).filter(Boolean).sort().join('\n');
    const names = new Map<string, string>();
    const sourceName = (sid: string) => {
      let n = names.get(sid);
      if (n === undefined) { n = getSource(sid)?.name ?? sid; names.set(sid, n); }
      return n;
    };
    return {
      checkedAt: await checkedAtOf(id),
      content: rows.map((r) => {
        const number = Number(r.number);
        const here = booksOf.get(number) ?? [];
        return {
          number,
          copies: (r.copies ?? []).map((c) => {
            // Reintroduce by dropping the status check: chapter 5 in groupsAndVersions.int.test.ts reads
            // chosen AND blocked on one copy, and the page shows both pills on a version nobody chose.
            const chosen = r.status !== 'blocked' && c.source === r.source_id && c.sourceId === r.chosen?.sourceId;
            const keys = keysOf(c.groups ?? []);
            return {
              key: `${c.source}:${c.sourceId}`,
              source: c.source,
              sourceName: sourceName(c.source),
              groups: c.groups ?? [],
              scanlator: c.scanlator ?? null,
              lang: c.lang ?? null,
              pages: c.pages ?? null,
              publishedAt: c.publishedAt ?? null,
              chosen,
              // A copy with no groups is never blocked: the blocklist names groups, and there is none to name.
              blocked: (c.groups ?? []).length > 0 && (c.groups ?? []).every((g) => blockedKeys.has(normGroup(g))),
              // A stamped file must match on source AND groups; an unstamped one is the chosen copy whatever
              // its source column says, NULL included -- on an install older than v0.31.0 most files are
              // NULL there, and requiring the source first left every one of them "not on disk".
              // Reintroduce by requiring `b.source_id === c.source` ahead of the stamp check: chapter 7 in
              // groupsAndVersions.int.test.ts reads [false].
              onDisk: here.some((b) => b.scanlator
                ? b.source_id === c.source && keysOf(groupsOf({ scanlator: b.scanlator })) === keys
                : (b.source_id == null || b.source_id === c.source) && chosen),
            };
          }),
        };
      }),
    };
  });

  app.get('/api/books/:id', async (req) => {
    const { id } = req.params as { id: string };
    const b = await komga.book(vc(req), id);
    return (await booksForUser(req, [b]))[0];
  });

  app.get('/api/books/:id/pages', async (req) => {
    const { id } = req.params as { id: string };
    const pages = await komga.bookPages(vc(req), id);
    // `junk` rides along on the page list rather than being its own request, so the reader and the offline
    // download manifest -- which both read this route -- get it without either knowing the feature exists.
    // A chapter whose pages have not been hashed yet simply comes back with nothing flagged.
    const junk = await junkPagesFor(id).catch(() => new Set<number>());
    if (!junk.size) return pages;
    return Array.isArray(pages)
      ? pages.map((p: any) => (junk.has(p.number) ? { ...p, junk: true } : p))
      : pages;
  });

  // Mark or un-mark one page by hand. A person's call outranks the heuristic in both directions.
  app.put('/api/books/:id/pages/:n/junk', async (req, reply) => {
    const { id, n } = req.params as { id: string; n: string };
    const page = Number(n);
    const body = (req.body ?? {}) as { junk?: boolean | null };
    // ⚠️ Resolved through the SAME visibility gate as reading the page list, and for a stronger reason than
    // the read side has: this flag is not personal. It changes what every account sees. Writing straight
    // from the params would let a member hide pages in a library they cannot even open, in a chapter nobody
    // with access ever looked at. `bookPages` returns nothing for a book the caller cannot see, which makes
    // "did that resolve?" the whole check -- and it bounds the page number as a side effect.
    // Reintroduce by writing setPageOverride directly from :id and :n: a member with no grant on a library
    // can then flag pages in it, and the flag sticks for the admin too.
    const pages = await komga.bookPages(vc(req), id);
    if (!Array.isArray(pages) || !pages.length) return reply.code(404).send({ error: 'not_found' });
    if (!Number.isInteger(page) || page < 1 || page > pages.length) {
      return reply.code(400).send({ error: 'bad_page' });
    }
    const v = body.junk === null || body.junk === undefined ? null : !!body.junk;
    await setPageOverride(id, page, v);
    return { ok: true };
  });

  // Smart-offline plan: the next N unread chapters of each favorite the user should keep offline.
  app.get('/api/offline/plan', async (req) => {
    const uid = userIdOf(req);
    const n = Math.min(10, Math.max(1, Number((req.query as Record<string, string>).perSeries) || 3));
    const favAll = (await q<{ series_id: string }>('SELECT series_id FROM favorites WHERE user_id = $1', [uid])).map((r) => r.series_id);
    // Filtered too: while 18+ is hidden, the smart-offline planner should not be quietly pulling adult
    // chapters onto the device and parking them in Downloads.
    const planShown = await browsableIds(favAll, vc(req));
    const favIds = favAll.filter((id) => planShown.has(id));
    const out: { bookId: string; seriesId: string }[] = [];
    for (const sid of favIds) {
      const raw = await komga.seriesBooks(vc(req), sid, 0, 1000, 'metadata.numberSort,asc').catch(() => null);
      if (!raw) continue;
      const books = await booksForUser(req, raw.content);
      // A pruned chapter has no pages to download; planning it would queue a manifest that answers 410.
      const unread = books.filter((b: any) => !b.readProgress?.completed && !b.pruned).slice(0, n);
      for (const b of unread) out.push({ bookId: b.id, seriesId: sid });
    }
    return { content: out };
  });

  app.get('/api/books/:id/next', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await komga.bookNext(vc(req), id);
    } catch {
      return reply.code(404).send({ error: 'no_next' });
    }
  });

  // Write progress: always to this user's read_progress + history; admin also mirrors to Komga.
  app.put('/api/books/:id/progress', async (req, reply) => {
    const uid = userIdOf(req);
    const { id } = req.params as { id: string };
    const { page, completed, seriesId, deviceId, silent, at } = progressBody.parse(req.body ?? {});

    let sid: string | undefined;
    let done = completed;
    let unavailable = false;
    // Always resolve the book, and take the series from IT. Which series a chapter belongs to is the server's
    // fact, not the client's, and this lookup used to be skipped exactly when the body carried both a
    // seriesId and completed:true -- the completion ping, and every replay the offline outbox sends. A phone
    // that was offline while an admin merged duplicates then filed finished chapters under the merged-away
    // id: `seriesProgress` (lib/enrich.ts) groups by series_id so they never counted toward the survivor, and the Continue
    // Reading query excludes it via `merged_into IS NULL`, so the series simply vanished from the rail and
    // read as permanently unread. Nothing repaired it afterwards, because the merge's fix-up had already run.
    try {
      const b = await komga.book(vc(req), id);
      sid = b?.seriesId;
      // Safety net for any client: reaching the last page IS completion, even if the client never sends the
      // explicit completed ping (fast scroll-past starved streaks/leaderboard).
      if (!done && reachedEnd(page, b?.media?.pagesCount ?? 0)) done = true;
    } catch (e: any) {
      // A 404 means the chapter is genuinely gone, hidden, or was never this account's to see, and the outbox
      // should drop it. Anything else is the database having a moment -- and since the outbox treats 4xx as
      // permanent, answering that with 404 would make the client throw away a chapter somebody really read.
      if (e?.statusCode !== 404) unavailable = true;
    }
    if (unavailable) return reply.code(503).send({ error: 'unavailable' });

    // No series means the chapter is gone, hidden, or was never visible to this account. That used to fall
    // back to seriesId 'unknown', which migration 0004 made impossible to store: read_progress now has a
    // foreign key to lib_series, and no row has that id, so every such write became a 500. The client that
    // actually hits this is the offline outbox replaying a queued page for a series deleted or merged since
    // -- and a 500 is a retry forever, where a 404 lets it drop the entry.
    if (!sid) return reply.code(404).send({ error: 'not_found' });

    await writeProgress({ userId: uid, bookId: id, seriesId: sid, page, completed: done, silent, deviceId, at });

    if (NATIVE_PROGRESS && roleOf(req) === 'admin') komga.setReadProgress(vc(req), id, page, done).catch(() => {});
    return reply.send({ ok: true });
  });
}
