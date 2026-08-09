import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { q, one } from '../lib/db';
// backend-agnostic content client: the owned library in owned mode, Komga otherwise. The old direct
// `lib/komga` import silently nulled every series lookup here after the owned-library cutover.
import { content as komga } from '../lib/backend';
import { authenticate, userIdOf, issueOpdsToken } from '../lib/auth';
import { env } from '../env';
import { pushEnabled, vapidPublicKey, saveSubscription, removeSubscription } from '../lib/push';

function computeStreaks(days: string[]): { current: number; longest: number } {
  if (!days.length) return { current: 0, longest: 0 };
  const set = new Set(days);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  let current = 0;
  const cur = new Date();
  if (!set.has(fmt(cur))) cur.setDate(cur.getDate() - 1); // allow today or yesterday to anchor
  while (set.has(fmt(cur))) { current++; cur.setDate(cur.getDate() - 1); }
  let longest = 0, run = 0;
  let prev: Date | null = null;
  for (const ds of [...days].sort()) {
    const d = new Date(ds + 'T00:00:00Z');
    run = prev && Math.round((d.getTime() - prev.getTime()) / 86400000) === 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = d;
  }
  return { current, longest };
}

export default async function personalRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  // issue/rotate the caller's OPDS token (shown once); used as the HTTP Basic password in an external reader
  app.post('/api/opds/token', async (req) => {
    const token = await issueOpdsToken(userIdOf(req));
    return { token, url: `${env.PUBLIC_ORIGIN.replace(/\/$/, '')}/opds` };
  });

  // ---- web push: new-chapter notifications ----
  app.get('/api/push/key', async () => ({ enabled: pushEnabled(), key: vapidPublicKey() }));
  app.post('/api/push/subscribe', async (req, reply) => {
    const b = z.object({ endpoint: z.string().url(), keys: z.object({ p256dh: z.string(), auth: z.string() }), deviceId: z.string().optional() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    await saveSubscription(userIdOf(req), { endpoint: b.data.endpoint, keys: b.data.keys }, b.data.deviceId);
    return { ok: true };
  });
  app.post('/api/push/unsubscribe', async (req, reply) => {
    const b = z.object({ endpoint: z.string() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    await removeSubscription(userIdOf(req), b.data.endpoint);
    return { ok: true };
  });

  // ---- favorites ----
  app.get('/api/favorites', async (req) => {
    const uid = userIdOf(req);
    const ids = (
      await q<{ series_id: string }>(
        'SELECT series_id FROM favorites WHERE user_id = $1 ORDER BY created_at DESC',
        [uid],
      )
    ).map((r) => r.series_id);
    const series = (await Promise.all(ids.map((id) => komga.series(id).catch(() => null)))).filter(Boolean);
    return { content: series };
  });

  app.post('/api/favorites', async (req, reply) => {
    const uid = userIdOf(req);
    const { seriesId } = z.object({ seriesId: z.string().min(1) }).parse(req.body);
    await q('INSERT INTO favorites (user_id, series_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [uid, seriesId]);
    // baseline the updates feed at the current chapter count so old chapters don't show as "new"
    const s = await komga.series(seriesId).catch(() => null);
    if (s) {
      await q(
        `INSERT INTO series_seen (user_id, series_id, seen_books_count) VALUES ($1, $2, $3) ON CONFLICT (user_id, series_id) DO NOTHING`,
        [uid, seriesId, (s as any).booksCount ?? 0],
      );
    }
    return reply.send({ ok: true, favorite: true });
  });

  app.delete('/api/favorites/:seriesId', async (req) => {
    const uid = userIdOf(req);
    const { seriesId } = req.params as { seriesId: string };
    await q('DELETE FROM favorites WHERE user_id = $1 AND series_id = $2', [uid, seriesId]);
    return { ok: true, favorite: false };
  });

  // ---- collections ----
  app.get('/api/collections', async (req) => {
    const uid = userIdOf(req);
    return {
      content: await q(
        `SELECT c.id, c.name, c.accent, c.sort_order,
                (SELECT count(*) FROM collection_items ci WHERE ci.collection_id = c.id) AS item_count
         FROM collections c WHERE c.user_id = $1 ORDER BY c.sort_order, c.created_at`,
        [uid],
      ),
    };
  });

  app.post('/api/collections', async (req) => {
    const uid = userIdOf(req);
    const { name, accent } = z.object({ name: z.string().min(1).max(120), accent: z.string().max(32).optional() }).parse(req.body);
    return one('INSERT INTO collections (user_id, name, accent) VALUES ($1, $2, $3) RETURNING id, name, accent, sort_order', [uid, name, accent ?? null]);
  });

  app.patch('/api/collections/:id', async (req) => {
    const uid = userIdOf(req);
    const { id } = req.params as { id: string };
    const body = z.object({ name: z.string().min(1).max(120).optional(), accent: z.string().max(32).nullable().optional(), sortOrder: z.number().int().optional() }).parse(req.body);
    return one(
      `UPDATE collections SET
         name = COALESCE($3, name),
         accent = COALESCE($4, accent),
         sort_order = COALESCE($5, sort_order)
       WHERE id = $1 AND user_id = $2 RETURNING id, name, accent, sort_order`,
      [id, uid, body.name ?? null, body.accent ?? null, body.sortOrder ?? null],
    );
  });

  app.delete('/api/collections/:id', async (req) => {
    const uid = userIdOf(req);
    const { id } = req.params as { id: string };
    await q('DELETE FROM collections WHERE id = $1 AND user_id = $2', [id, uid]);
    return { ok: true };
  });

  app.get('/api/collections/:id', async (req, reply) => {
    const uid = userIdOf(req);
    const { id } = req.params as { id: string };
    const col = await one('SELECT id, name, accent, sort_order FROM collections WHERE id = $1 AND user_id = $2', [id, uid]);
    if (!col) return reply.code(404).send({ error: 'not_found' });
    const ids = (
      await q<{ series_id: string }>('SELECT series_id FROM collection_items WHERE collection_id = $1 ORDER BY position', [id])
    ).map((r) => r.series_id);
    const series = (await Promise.all(ids.map((sid) => komga.series(sid).catch(() => null)))).filter(Boolean);
    return { ...col, items: series };
  });

  app.post('/api/collections/:id/items', async (req) => {
    const uid = userIdOf(req);
    const { id } = req.params as { id: string };
    const { seriesId } = z.object({ seriesId: z.string().min(1) }).parse(req.body);
    const owns = await one('SELECT id FROM collections WHERE id = $1 AND user_id = $2', [id, uid]);
    if (!owns) return { ok: false };
    await q('INSERT INTO collection_items (collection_id, series_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, seriesId]);
    return { ok: true };
  });

  app.delete('/api/collections/:id/items/:seriesId', async (req) => {
    const uid = userIdOf(req);
    const { id, seriesId } = req.params as { id: string; seriesId: string };
    const owns = await one('SELECT id FROM collections WHERE id = $1 AND user_id = $2', [id, uid]);
    if (!owns) return { ok: false };
    await q('DELETE FROM collection_items WHERE collection_id = $1 AND series_id = $2', [id, seriesId]);
    return { ok: true };
  });

  // Reorder a collection: the full series-id list in its new order rewrites the positions.
  app.put('/api/collections/:id/items', async (req) => {
    const uid = userIdOf(req);
    const { id } = req.params as { id: string };
    const { seriesIds } = z.object({ seriesIds: z.array(z.string().min(1)).max(500) }).parse(req.body);
    const owns = await one('SELECT id FROM collections WHERE id = $1 AND user_id = $2', [id, uid]);
    if (!owns) return { ok: false };
    for (let i = 0; i < seriesIds.length; i++)
      await q('UPDATE collection_items SET position = $3 WHERE collection_id = $1 AND series_id = $2', [id, seriesIds[i], i]);
    return { ok: true };
  });

  // ---- ratings ----
  app.put('/api/ratings/:seriesId', async (req) => {
    const uid = userIdOf(req);
    const { seriesId } = req.params as { seriesId: string };
    const { stars } = z.object({ stars: z.number().int().min(1).max(5) }).parse(req.body);
    await q(
      `INSERT INTO ratings (user_id, series_id, stars) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, series_id) DO UPDATE SET stars = EXCLUDED.stars, updated_at = now()`,
      [uid, seriesId, stars],
    );
    return { ok: true, stars };
  });

  app.delete('/api/ratings/:seriesId', async (req) => {
    const uid = userIdOf(req);
    const { seriesId } = req.params as { seriesId: string };
    await q('DELETE FROM ratings WHERE user_id = $1 AND series_id = $2', [uid, seriesId]);
    return { ok: true };
  });

  // ---- notes ----
  app.get('/api/notes/:seriesId', async (req) => {
    const uid = userIdOf(req);
    const { seriesId } = req.params as { seriesId: string };
    return { content: await q('SELECT id, series_id, book_id, body, updated_at FROM notes WHERE user_id = $1 AND series_id = $2 ORDER BY updated_at DESC', [uid, seriesId]) };
  });

  app.post('/api/notes', async (req) => {
    const uid = userIdOf(req);
    const { seriesId, bookId, body } = z.object({ seriesId: z.string().min(1), bookId: z.string().optional(), body: z.string().min(1) }).parse(req.body);
    return one('INSERT INTO notes (user_id, series_id, book_id, body) VALUES ($1, $2, $3, $4) RETURNING id, series_id, book_id, body, updated_at', [uid, seriesId, bookId ?? null, body]);
  });

  app.patch('/api/notes/:id', async (req) => {
    const uid = userIdOf(req);
    const { id } = req.params as { id: string };
    const { body } = z.object({ body: z.string().min(1) }).parse(req.body);
    return one('UPDATE notes SET body = $3, updated_at = now() WHERE id = $1 AND user_id = $2 RETURNING id, body, updated_at', [id, uid, body]);
  });

  app.delete('/api/notes/:id', async (req) => {
    const uid = userIdOf(req);
    const { id } = req.params as { id: string };
    await q('DELETE FROM notes WHERE id = $1 AND user_id = $2', [id, uid]);
    return { ok: true };
  });

  // ---- history & stats ----
  app.get('/api/history', async (req) => {
    const uid = userIdOf(req);
    const limit = Math.min(Number((req.query as Record<string, string>).limit) || 50, 200);
    // most-recent event per book, newest first, with display titles for the history timeline
    return {
      content: await q(
        `SELECT e.book_id, e.series_id, e.page, e.completed, e.created_at,
                COALESCE(b.title, '') AS book_title, COALESCE(s.title, '') AS series_title
         FROM (
           SELECT DISTINCT ON (book_id) book_id, series_id, page, completed, created_at
           FROM reading_events WHERE user_id = $1
           ORDER BY book_id, created_at DESC
         ) e
         LEFT JOIN lib_books b ON b.id = e.book_id
         LEFT JOIN lib_series s ON s.id = e.series_id
         ORDER BY e.created_at DESC
         LIMIT $2`,
        [uid, limit],
      ),
    };
  });

  app.get('/api/stats', async (req) => {
    const uid = userIdOf(req);
    const summary = (await one('SELECT chapters_completed, series_touched, total_events, last_read_at FROM reading_stats WHERE user_id = $1', [uid])) ?? {
      chapters_completed: 0,
      series_touched: 0,
      total_events: 0,
      last_read_at: null,
    };
    const byDay = await q(
      `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, count(*) FILTER (WHERE completed) AS chapters
       FROM reading_events WHERE user_id = $1 AND created_at > now() - interval '90 days'
       GROUP BY 1 ORDER BY 1`,
      [uid],
    );
    const days = (
      await q<{ d: string }>(
        `SELECT DISTINCT to_char(date_trunc('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS d FROM reading_events WHERE user_id = $1 AND completed = true`,
        [uid],
      )
    ).map((r) => r.d);
    const streaks = computeStreaks(days);
    const weekChapters = (await one<{ c: number }>(`SELECT count(*)::int AS c FROM reading_events WHERE user_id = $1 AND completed = true AND created_at > now() - interval '7 days'`, [uid]))?.c ?? 0;
    const settings = ((await one<{ data: any }>('SELECT data FROM app_settings WHERE user_id = $1', [uid]))?.data) ?? {};
    return { ...summary, byDay, currentStreak: streaks.current, longestStreak: streaks.longest, weekChapters, weeklyGoal: settings.weeklyGoal ?? 0 };
  });

  app.get('/api/wrapped', async (req) => {
    const uid = userIdOf(req);
    const year = Number((req.query as Record<string, string>).year) || new Date().getFullYear();
    const rows = await q<{ series_id: string; created_at: string }>(
      `SELECT series_id, created_at FROM reading_events WHERE user_id = $1 AND completed = true AND extract(year from created_at) = $2`,
      [uid, year],
    );
    const seriesCounts: Record<string, number> = {};
    const byMonth = Array(12).fill(0);
    const dow = Array(7).fill(0);
    for (const r of rows) {
      seriesCounts[r.series_id] = (seriesCounts[r.series_id] ?? 0) + 1;
      const d = new Date(r.created_at);
      byMonth[d.getMonth()]++;
      dow[d.getDay()]++;
    }
    const topIds = Object.entries(seriesCounts).sort((a, b) => b[1] - a[1]).slice(0, 5).map((e) => e[0]);
    const topSeries = (
      await Promise.all(
        topIds.map(async (id) => {
          const s = await komga.series(id).catch(() => null);
          return s ? { id, title: (s as any).metadata?.title || (s as any).name, count: seriesCounts[id], genres: (s as any).metadata?.genres ?? [] } : null;
        }),
      )
    ).filter(Boolean) as { id: string; title: string; count: number; genres: string[] }[];
    const genreCounts: Record<string, number> = {};
    for (const s of topSeries) for (const g of s.genres) genreCounts[g] = (genreCounts[g] ?? 0) + 1;
    const topGenres = Object.entries(genreCounts).sort((a, b) => b[1] - a[1]).slice(0, 5).map((e) => e[0]);
    return {
      year,
      chapters: rows.length,
      series: Object.keys(seriesCounts).length,
      topSeries: topSeries.map((s) => ({ id: s.id, title: s.title, count: s.count })),
      topGenres,
      byMonth,
      busiestDow: dow.indexOf(Math.max(...dow)),
    };
  });

  // ---- settings ----
  app.get('/api/settings', async (req) => {
    const uid = userIdOf(req);
    const row = await one<{ data: unknown }>('SELECT data FROM app_settings WHERE user_id = $1', [uid]);
    return row?.data ?? {};
  });

  app.put('/api/settings', async (req) => {
    const uid = userIdOf(req);
    const data = z.record(z.any()).parse(req.body ?? {});
    await q(
      `INSERT INTO app_settings (user_id, data) VALUES ($1, $2::jsonb)
       ON CONFLICT (user_id) DO UPDATE SET data = app_settings.data || EXCLUDED.data`,
      [uid, JSON.stringify(data)],
    );
    // avatar is identity shown to other household members -> mirror onto the users row
    if (data.avatar && typeof data.avatar === 'object') {
      await q('UPDATE users SET avatar = $2 WHERE id = $1', [uid, JSON.stringify(data.avatar)]);
    }
    const row = await one<{ data: unknown }>('SELECT data FROM app_settings WHERE user_id = $1', [uid]);
    return row?.data ?? {};
  });
}
