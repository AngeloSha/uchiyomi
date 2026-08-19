import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { q, one } from '../lib/db';
import { komgaImage } from '../lib/komga';
import { content as komga, NATIVE_PROGRESS } from '../lib/backend';
import { dominantHex } from '../lib/color';
import { runtime } from '../lib/runtime';
import { authenticate, roleOf, userIdOf } from '../lib/auth';
import { warmHeroBackdrops } from './images';
import { writeProgress, reachedEnd } from '../lib/progress';

async function seriesColors(ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await q<{ series_id: string; color: string }>(
    'SELECT series_id, color FROM series_colors WHERE series_id = ANY($1)',
    [ids],
  );
  return new Map(rows.map((r) => [r.series_id, r.color]));
}

async function seriesSeen(userId: string, ids: string[]): Promise<Map<string, number>> {
  if (!ids.length) return new Map();
  const rows = await q<{ series_id: string; seen_books_count: number }>(
    'SELECT series_id, seen_books_count FROM series_seen WHERE user_id = $1 AND series_id = ANY($2)',
    [userId, ids],
  );
  return new Map(rows.map((r) => [r.series_id, r.seen_books_count]));
}

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

async function seriesCompleted(userId: string, seriesIds: string[]): Promise<Map<string, number>> {
  if (!seriesIds.length) return new Map();
  const rows = await q<{ series_id: string; c: number }>(
    `SELECT series_id, count(*)::int AS c FROM read_progress WHERE user_id = $1 AND completed = true AND series_id = ANY($2) GROUP BY series_id`,
    [userId, seriesIds],
  );
  return new Map(rows.map((r) => [r.series_id, r.c]));
}

async function enrichSeries(req: FastifyRequest, list: any[]): Promise<any[]> {
  if (!list?.length) return list ?? [];
  const userId = userIdOf(req);
  const admin = NATIVE_PROGRESS && roleOf(req) === 'admin';
  const favs = new Set(
    (await q<{ series_id: string }>('SELECT series_id FROM favorites WHERE user_id = $1', [userId])).map((r) => r.series_id),
  );
  const ratings = new Map(
    (await q<{ series_id: string; stars: number }>('SELECT series_id, stars FROM ratings WHERE user_id = $1', [userId])).map(
      (r) => [r.series_id, r.stars],
    ),
  );
  const completed = admin ? null : await seriesCompleted(userId, list.map((s) => s.id));
  const colors = await seriesColors(list.map((s) => s.id));
  const seen = await seriesSeen(userId, list.map((s) => s.id));
  return list.map((s) => ({
    ...s,
    color: colors.get(s.id) ?? null,
    yomi: {
      favorite: favs.has(s.id),
      rating: ratings.get(s.id) ?? null,
      unread: admin ? (s.booksUnreadCount ?? 0) : Math.max(0, (s.booksCount ?? 0) - (completed!.get(s.id) ?? 0)),
      newCount: seen.has(s.id) ? Math.max(0, (s.booksCount ?? 0) - (seen.get(s.id) ?? 0)) : 0,
    },
  }));
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
});

const forYouCache = new Map<string, { ts: number; pool: any[] }>();

/** Raw recommendation pool from the genres of what the user favorites + finishes (cached 10m). */
async function tasteRecs(req: FastifyRequest): Promise<any[]> {
  const uid = userIdOf(req);
  const cached = forYouCache.get(uid);
  if (cached && Date.now() - cached.ts < 10 * 60 * 1000) return cached.pool;
  const favIds = (await q<{ series_id: string }>('SELECT series_id FROM favorites WHERE user_id = $1', [uid])).map((r) => r.series_id);
  const doneIds = (await q<{ series_id: string }>('SELECT DISTINCT series_id FROM read_progress WHERE user_id = $1 AND completed = true', [uid])).map((r) => r.series_id);
  const sourceIds = Array.from(new Set([...favIds, ...doneIds])).slice(0, 30);
  const sources = (await Promise.all(sourceIds.map((id) => komga.series(id).catch(() => null)))).filter(Boolean) as any[];
  const counts = new Map<string, number>();
  for (const s of sources) for (const g of s.metadata?.genres ?? []) counts.set(g, (counts.get(g) ?? 0) + 1);
  const topGenres = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map((e) => e[0]);
  let pool: any[];
  if (topGenres.length) {
    const res = await komga.searchSeries({ condition: { anyOf: topGenres.map((g) => ({ genre: { operator: 'is', value: g } })) } }, 0, 60);
    pool = res.content;
  } else {
    pool = (((await komga.seriesUpdated(0, 40).catch(() => ({ content: [] }))) as any).content) ?? [];
  }
  const exclude = new Set([...favIds, ...doneIds]);
  pool = pool.filter((s) => !exclude.has(s.id));
  forYouCache.set(uid, { ts: Date.now(), pool });
  return pool;
}

export default async function catalogRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  app.get('/api/libraries', async () => komga.libraries());

  app.get('/api/genres', async () => ({ content: (await komga.genres()).sort() }));

  // What everyone in the household is reading (cross-user, last 14 days).
  app.get('/api/trending', async (req) => {
    const rows = await q<{ series_id: string }>(
      `SELECT series_id FROM reading_events WHERE created_at > now() - interval '14 days'
       GROUP BY series_id ORDER BY count(*) DESC LIMIT 12`,
    );
    const series = (await Promise.all(rows.map((r) => komga.series(r.series_id).catch(() => null)))).filter(Boolean) as any[];
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
  app.get('/api/random', async () => {
    const first = await komga.searchSeries({}, 0, 1);
    const total = first.totalElements ?? 0;
    if (!total) return { seriesId: null };
    const idx = Math.floor(Math.random() * total);
    const page = await komga.searchSeries({}, idx, 1);
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
      komga.seriesUpdated(0, 20).catch(() => ({ content: [] as any[] })),
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
    const libs = await komga.libraries().catch(() => [] as any[]);
    await Promise.all(libs.map((l: any) => komga.scanLibrary(l.id).catch(() => {})));
    return { scanned: true, libraries: libs.length };
  });

  app.get('/api/home', async (req) => {
    const uid = userIdOf(req);
    const admin = NATIVE_PROGRESS && roleOf(req) === 'admin';

    let onDeckP: Promise<any[]>;
    if (admin) {
      onDeckP = komga.booksOnDeck(0, 20).then((r: any) => r.content).catch(() => []);
    } else {
      onDeckP = (async () => {
        const rows = await q<{ book_id: string }>(
          'SELECT book_id FROM read_progress WHERE user_id = $1 AND completed = false ORDER BY updated_at DESC LIMIT 20',
          [uid],
        );
        const books = (await Promise.all(rows.map((r) => komga.book(r.book_id).catch(() => null)))).filter(Boolean) as any[];
        return overlay(books, await userProgress(uid, books.map((b) => b.id)));
      })();
    }

    const [onDeck, updated, fresh] = await Promise.all([
      onDeckP,
      komga.seriesUpdated(0, 20).catch(() => ({ content: [] })),
      komga.seriesNew(0, 20).catch(() => ({ content: [] })),
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

    const favIds = (
      await q<{ series_id: string }>('SELECT series_id FROM favorites WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20', [uid])
    ).map((r) => r.series_id);
    const favorites = ((await Promise.all(favIds.map((id) => komga.series(id).catch(() => null)))).filter(Boolean)) as any[];

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

  app.post('/api/series/search', async (req) => {
    const { query, sort, page, size, condition } = searchBody.parse(req.body ?? {});
    const body: { condition?: unknown; fullTextSearch?: string } = {};
    if (condition) body.condition = condition;
    if (query) body.fullTextSearch = query;
    const res = await komga.searchSeries(body, page, size, sort);
    return { ...res, content: await enrichSeries(req, res.content) };
  });

  app.get('/api/series/:id', async (req) => {
    const { id } = req.params as { id: string };
    const series = await komga.series(id);
    // opening a series marks its new chapters as seen
    await q(
      `INSERT INTO series_seen (user_id, series_id, seen_books_count) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, series_id) DO UPDATE SET seen_books_count = EXCLUDED.seen_books_count, seen_at = now()`,
      [userIdOf(req), id, series.booksCount ?? 0],
    );
    const out: any = (await enrichSeries(req, [series]))[0];
    // apply admin metadata overrides (title/summary shown here; cover/banner are handled by the image server)
    const ov = await one<{ title: string | null; summary: string | null; cover: string | null; banner: string | null; v: string }>(
      'SELECT title, summary, cover, banner, EXTRACT(EPOCH FROM updated_at) * 1000 AS v FROM series_overrides WHERE series_id = $1',
      [id],
    );
    if (ov) {
      if (ov.title) { out.name = ov.title; if (out.metadata) out.metadata.title = ov.title; }
      if (ov.summary != null) { if (out.metadata) out.metadata.summary = ov.summary; if (out.booksMetadata) out.booksMetadata.summary = ov.summary; }
      out.artVersion = Math.floor(Number(ov.v)) || 0;
      out.overrides = { title: ov.title, summary: ov.summary, cover: ov.cover, banner: ov.banner };
    }
    return out;
  });

  // Updates feed: favorited series that gained chapters since you last opened them.
  app.get('/api/updates', async (req) => {
    const uid = userIdOf(req);
    const favIds = (await q<{ series_id: string }>('SELECT series_id FROM favorites WHERE user_id = $1', [uid])).map((r) => r.series_id);
    const favSeries = ((await Promise.all(favIds.map((id) => komga.series(id).catch(() => null)))).filter(Boolean)) as any[];
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
    const favSeries = ((await Promise.all(favIds.map((id) => komga.series(id).catch(() => null)))).filter(Boolean)) as any[];
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
      const res = await komgaImage(komga.seriesThumbPath(id));
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
    const s = (await komga.series(id).catch(() => null)) as any;
    const genres = (s?.metadata?.genres ?? []).slice(0, 3);
    if (!genres.length) return { content: [] };
    const res = await komga.searchSeries({ condition: { anyOf: genres.map((g: string) => ({ genre: { operator: 'is', value: g } })) } }, 0, 24);
    const content = res.content.filter((x: any) => x.id !== id).slice(0, 18);
    return { content: await enrichSeries(req, content) };
  });

  app.get('/api/series/:id/books', async (req) => {
    const { id } = req.params as { id: string };
    const { page = '0', size = '200', sort } = req.query as Record<string, string>;
    const res = await komga.seriesBooks(id, Number(page), Number(size), sort || undefined);
    return { ...res, content: await booksForUser(req, res.content) };
  });

  app.get('/api/books/:id', async (req) => {
    const { id } = req.params as { id: string };
    const b = await komga.book(id);
    return (await booksForUser(req, [b]))[0];
  });

  app.get('/api/books/:id/pages', async (req) => {
    const { id } = req.params as { id: string };
    return komga.bookPages(id);
  });

  // Smart-offline plan: the next N unread chapters of each favorite the user should keep offline.
  app.get('/api/offline/plan', async (req) => {
    const uid = userIdOf(req);
    const n = Math.min(10, Math.max(1, Number((req.query as Record<string, string>).perSeries) || 3));
    const favIds = (await q<{ series_id: string }>('SELECT series_id FROM favorites WHERE user_id = $1', [uid])).map((r) => r.series_id);
    const out: { bookId: string; seriesId: string }[] = [];
    for (const sid of favIds) {
      const raw = await komga.seriesBooks(sid, 0, 1000, 'metadata.numberSort,asc').catch(() => null);
      if (!raw) continue;
      const books = await booksForUser(req, raw.content);
      const unread = books.filter((b: any) => !b.readProgress?.completed).slice(0, n);
      for (const b of unread) out.push({ bookId: b.id, seriesId: sid });
    }
    return { content: out };
  });

  app.get('/api/books/:id/next', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await komga.bookNext(id);
    } catch {
      return reply.code(404).send({ error: 'no_next' });
    }
  });

  // Write progress: always to this user's read_progress + history; admin also mirrors to Komga.
  app.put('/api/books/:id/progress', async (req, reply) => {
    const uid = userIdOf(req);
    const { id } = req.params as { id: string };
    const { page, completed, seriesId, deviceId, silent } = progressBody.parse(req.body ?? {});

    let sid = seriesId;
    let done = completed;
    // Safety net for any client: reaching the last page IS completion, even if the client never sends the
    // explicit completed ping (fast scroll-past starved streaks/leaderboard).
    if (!sid || !done) {
      try {
        const b = await komga.book(id);
        if (!sid) sid = b.seriesId;
        if (!done && reachedEnd(page, b?.media?.pagesCount ?? 0)) done = true;
      } catch { if (!sid) sid = 'unknown'; }
    }

    await writeProgress({ userId: uid, bookId: id, seriesId: sid!, page, completed: done, silent, deviceId });

    if (NATIVE_PROGRESS && roleOf(req) === 'admin') komga.setReadProgress(id, page, done).catch(() => {});
    return reply.send({ ok: true });
  });
}
