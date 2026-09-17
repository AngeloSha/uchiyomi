import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { q, one } from '../lib/db';
// backend-agnostic content client: the owned library in owned mode, Komga otherwise. The old direct
// `lib/komga` import silently nulled every series lookup here after the owned-library cutover.
import { content as komga } from '../lib/backend';
import { viewCtxFor, visible, browsable, browsableIds, Params, type ViewCtx, hideAdult } from '../lib/visibility';
import { updateSeries } from '../lib/updater';
import { persistScan, setBookDates, setBookMeta } from '../lib/library';
import { authenticate, userIdOf, roleOf, issueOpdsToken, issueApiToken, listApiTokens, revokeApiToken, API_SCOPES, revokeOpdsToken, opdsTokenStatus, setOpdsShowAdult, OPDS_TOKEN_DAYS } from '../lib/auth';
import { enrichSeries } from '../lib/enrich';
import { env } from '../env';
import { pushEnabled, vapidPublicKey, saveSubscription, removeSubscription } from '../lib/push';
import { statusFor, saveConnection, disconnect, whoAmI, pushSeriesProgress, pushSeriesProgressAsync, clearTrackerFloor } from '../lib/trackers';
import { ADAPTERS, isProvider, type Provider } from '../lib/trackerProviders';
import { logAudit } from '../lib/audit';

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
  app.addHook('preHandler', async (req) => {
    (req as any).viewCtx = await viewCtxFor(userIdOf(req), roleOf(req), { hideAdult: hideAdult(req) });
  });
  /** The viewer attached above. */
  const vc = (req: any): ViewCtx => req.viewCtx as ViewCtx;

  // issue/rotate the caller's OPDS token (shown once); used as the HTTP Basic password in an external reader
  app.post('/api/opds/token', async (req) => {
    const token = await issueOpdsToken(userIdOf(req));
    return { token, url: `${env.PUBLIC_ORIGIN.replace(/\/$/, '')}/opds`, expiresInDays: OPDS_TOKEN_DAYS };
  });

  // Whether a token exists, when it expires, and when a reader last used it. The last-used date is the
  // useful one: it is how someone notices a token they forgot about is still being used by something.
  app.get('/api/opds/token', async (req) => opdsTokenStatus(userIdOf(req)));

  app.delete('/api/opds/token', async (req) => {
    await revokeOpdsToken(userIdOf(req));
    return { ok: true };
  });

  // Whether the reader behind this token may list 18+ libraries. Lives on the token because an OPDS client
  // cannot press the web app's reveal button, and because the phone and the e-reader are different
  // audiences for the same account. The age cap is a permission and is not touched by this.
  app.patch('/api/opds/token', async (req, reply) => {
    const b = z.object({ showAdult: z.boolean() }).parse(req.body);
    if (!(await setOpdsShowAdult(userIdOf(req), b.showAdult))) return reply.code(404).send({ error: 'no_token' });
    return opdsTokenStatus(userIdOf(req));
  });

  // ---- personal API tokens ----
  // Deliberately mirrors the sessions panel: list, create once, revoke. The raw token is returned by the
  // create call and never again, because only its hash is stored.
  app.get('/api/tokens', async (req) => ({ content: await listApiTokens(userIdOf(req)) }));

  app.post('/api/tokens', async (req, reply) => {
    const b = z
      .object({
        name: z.string().trim().min(1).max(60),
        scopes: z.array(z.enum(API_SCOPES)).min(1),
        expiresInDays: z.number().int().min(1).max(3650).nullable().optional(),
      })
      .safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request', message: 'Give the token a name and at least one scope.' });

    // Only an admin may mint an admin-scoped token; otherwise any user could self-promote their automation.
    const scopes = b.data.scopes;
    if (scopes.includes('admin') && roleOf(req) !== 'admin') {
      return reply.code(403).send({ error: 'forbidden', message: 'Only an admin can create an admin token.' });
    }
    // 'write' and 'admin' both imply being able to read
    if (!scopes.includes('read')) scopes.push('read');

    const expires = b.data.expiresInDays ? new Date(Date.now() + b.data.expiresInDays * 86400000) : null;
    const { id, token } = await issueApiToken(userIdOf(req), b.data.name, scopes, expires);
    await logAudit('token.create', { userId: userIdOf(req), detail: { id, name: b.data.name, scopes }, req });
    return { id, token };
  });

  app.delete('/api/tokens/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await revokeApiToken(userIdOf(req), id))) return reply.code(404).send({ error: 'not_found' });
    await logAudit('token.revoke', { userId: userIdOf(req), detail: { id }, req });
    return { ok: true };
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
    // Favourite ids come from another table, so they inherit no predicate: filter before resolving.
    const shown = await browsableIds(ids, vc(req));
    const series = (await Promise.all(ids.filter((id) => shown.has(id)).map((id) => komga.series(vc(req), id).catch(() => null)))).filter(Boolean);
    // Enriched like every other series listing. Without this the favourites rail was the one place in the app
    // that got raw DTOs: no rating, no new-chapter count, no cover colour, and an unread badge showing the
    // total chapter count.
    return { content: await enrichSeries(req, series) };
  });

  app.post('/api/favorites', async (req, reply) => {
    const uid = userIdOf(req);
    const { seriesId } = z.object({ seriesId: z.string().min(1) }).parse(req.body);
    await q('INSERT INTO favorites (user_id, series_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [uid, seriesId]);
    // baseline the updates feed at the current chapter count so old chapters don't show as "new"
    const s = await komga.series(vc(req), seriesId).catch(() => null);
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
    // A collection is a listing like any other, so a title in an 18+ library stays out of it while hidden.
    // Nothing is removed from the collection itself -- reordering and membership are untouched.
    const shown = await browsableIds(ids, vc(req));
    const series = (await Promise.all(ids.filter((sid) => shown.has(sid)).map((sid) => komga.series(vc(req), sid).catch(() => null)))).filter(Boolean);
    return { ...col, items: await enrichSeries(req, series) };
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
  // ---- page bookmarks ----
  //
  // Kept behind the visibility rule like every other read: a bookmark names a book id, and listing them has
  // to go through the same predicate or it becomes a way to learn that a series you cannot see exists.
  app.get('/api/bookmarks', async (req) => {
    const { seriesId } = req.query as { seriesId?: string };
    const p = new Params();
    const ctx = vc(req);
    const uid = p.add(userIdOf(req));
    const extra = seriesId ? ` AND bm.series_id = ${p.add(seriesId)}` : '';
    // The join to lib_series is what carries every series-level rule -- soft delete, merge, library access
    // and the age cap -- through to a bookmark. Listing them without it would let someone learn that a
    // series they cannot see exists, and what they once read of it.
    return {
      content: await q(
        `SELECT bm.book_id, bm.series_id, bm.page, bm.note, bm.created_at,
                b.title AS book_title, b.number, COALESCE(so.title, s.title) AS series_title
           FROM bookmarks bm
           JOIN lib_books b   ON b.id = bm.book_id
           JOIN lib_series s  ON s.id = b.series_id AND ${browsable('s', ctx, p)}
           LEFT JOIN series_overrides so ON so.series_id = s.id
          WHERE bm.user_id = ${uid}${extra}
          ORDER BY bm.created_at DESC LIMIT 500`,
        p.values as any[],
      ),
    };
  });

  app.put('/api/bookmarks/:bookId/:page', async (req, reply) => {
    const { bookId, page } = req.params as { bookId: string; page: string };
    const n = Number(page);
    if (!Number.isInteger(n) || n < 1) return reply.code(400).send({ error: 'bad_page' });
    const b = z.object({ note: z.string().max(500).nullish() }).safeParse(req.body ?? {});
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    // Resolve the book through the backend so a bookmark cannot be created against a series the viewer
    // cannot see -- which would otherwise be a write that confirms the id exists.
    const book = await komga.book(vc(req), bookId).catch(() => null);
    if (!book) return reply.code(404).send({ error: 'not_found' });
    // An ABSENT `note` leaves the stored one alone; an explicit `null` clears it.
    //
    // These are different requests and the schema already tells them apart -- `nullish()` gives `undefined`
    // for absent and `null` for explicit -- but `?? null` used to flatten both and the upsert then wrote it
    // unconditionally. That was harmless while nothing could write a note; /moments now can. The reader's
    // star PUTs this route with an empty body, so re-starring a page you had annotated erased the note --
    // and the star re-arms itself whenever its `marks` fetch fails, which is exactly the offline case.
    const touchesNote = b.data.note !== undefined;
    await q(
      `INSERT INTO bookmarks (user_id, book_id, series_id, page, note)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (user_id, book_id, page) DO UPDATE
         SET created_at = now()${touchesNote ? ', note = EXCLUDED.note' : ''}`,
      [userIdOf(req), bookId, book.seriesId, n, b.data.note ?? null],
    );
    return { ok: true };
  });

  app.delete('/api/bookmarks/:bookId/:page', async (req) => {
    const { bookId, page } = req.params as { bookId: string; page: string };
    await q('DELETE FROM bookmarks WHERE user_id = $1 AND book_id = $2 AND page = $3',
      [userIdOf(req), bookId, Number(page)]);
    return { ok: true };
  });

  /**
   * Every note, newest first, optionally narrowed to one series.
   *
   * The by-id route below answers one series; this answers "show me everything I have written", which is what
   * a notes surface needs and what nothing could ask for before.
   *
   * Joined through `browsable()` for the same reason the bookmark listing above is: a note names a series id,
   * so listing them without the predicate is a way to learn a series you cannot see exists, and what you once
   * wrote about it.
   */
  app.get('/api/notes', async (req) => {
    const { seriesId } = req.query as { seriesId?: string };
    const p = new Params();
    const ctx = vc(req);
    const uid = p.add(userIdOf(req));
    const extra = seriesId ? ` AND n.series_id = ${p.add(seriesId)}` : '';
    return {
      content: await q(
        `SELECT n.id, n.series_id, n.book_id, n.body, n.updated_at,
                COALESCE(so.title, s.title) AS series_title, b.title AS book_title, b.number
           FROM notes n
           JOIN lib_series s ON s.id = n.series_id AND ${browsable('s', ctx, p)}
           LEFT JOIN series_overrides so ON so.series_id = s.id
           -- The series-id term below is the load-bearing half. The gate above covers the note's SERIES;
           -- without it this join hands back book_title and number for ANY book id stored in the row,
           -- including one belonging to a series this account cannot see. The bookmark listing above does
           -- not need the same term because it derives the series FROM the book, so one gate covers both.
           -- (No backticks in here: this is inside a JS template literal.)
           LEFT JOIN lib_books b ON b.id = n.book_id AND b.series_id = n.series_id
          WHERE n.user_id = ${uid}${extra}
          ORDER BY n.updated_at DESC LIMIT 500`,
        p.values as any[],
      ),
    };
  });

  app.get('/api/notes/:seriesId', async (req) => {
    const { seriesId } = req.params as { seriesId: string };
    const p = new Params();
    const ctx = vc(req);
    const uid = p.add(userIdOf(req));
    // Same join as the listing above. Without it this answered for any series id at all, including one in a
    // library the viewer has no grant for and one above their age cap.
    return {
      content: await q(
        `SELECT n.id, n.series_id, n.book_id, n.body, n.updated_at
           FROM notes n
           JOIN lib_series s ON s.id = n.series_id AND ${browsable('s', ctx, p)}
          WHERE n.user_id = ${uid} AND n.series_id = ${p.add(seriesId)}
          ORDER BY n.updated_at DESC`,
        p.values as any[],
      ),
    };
  });

  app.post('/api/notes', async (req, reply) => {
    const uid = userIdOf(req);
    const { seriesId, bookId, body } = z.object({ seriesId: z.string().min(1), bookId: z.string().optional(), body: z.string().min(1).max(4000) }).parse(req.body);
    // Resolve the series through the backend first, exactly as the bookmark write above does: creating a note
    // against a series the viewer cannot see would otherwise be a write that confirms the id exists.
    const series = await komga.series(vc(req), seriesId).catch(() => null);
    if (!series) return reply.code(404).send({ error: 'not_found' });
    // And if a chapter was named, it has to be a chapter OF that series. `bookId` arrives from the client
    // and nothing else checks it: stored unvalidated, it is an id of the caller's choosing sitting in a row
    // that later reads join against.
    if (bookId) {
      const book = await komga.book(vc(req), bookId).catch(() => null);
      if (!book || book.seriesId !== seriesId) return reply.code(404).send({ error: 'not_found' });
    }
    return one('INSERT INTO notes (user_id, series_id, book_id, body) VALUES ($1, $2, $3, $4) RETURNING id, series_id, book_id, body, updated_at', [uid, seriesId, bookId ?? null, body]);
  });

  app.patch('/api/notes/:id', async (req) => {
    const uid = userIdOf(req);
    const { id } = req.params as { id: string };
    // Same cap as the create above. Without it the 4000-char limit is bypassed by posting a short note and
    // then editing it to any length at all.
    const { body } = z.object({ body: z.string().min(1).max(4000) }).parse(req.body);
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
    const limit = Math.min(Number((req.query as Record<string, string>).limit) || 50, 200);
    const hp = new Params();
    const hctx = vc(req);
    const uid = hp.add(userIdOf(req));
    // most-recent event per book, newest first, with display titles for the history timeline
    return {
      content: await q(
        `SELECT e.book_id, e.series_id, e.page, e.completed, e.created_at,
                COALESCE(b.title, '') AS book_title, COALESCE(s.title, '') AS series_title
         FROM (
           SELECT DISTINCT ON (book_id) book_id, series_id, page, completed, created_at
           FROM reading_events WHERE user_id = ${uid}
           ORDER BY book_id, created_at DESC
         ) e
         -- These were LEFT JOINs with no predicate at all, so history listed the titles of series that had
         -- been deleted, merged away, or moved into a library the reader no longer holds. Inner joins
         -- through browsable() make history obey the same rule as every other listing, 18+ included.
         JOIN lib_books b ON b.id = e.book_id
         JOIN lib_series s ON s.id = e.series_id AND ${browsable('s', hctx, hp)}
         ORDER BY e.created_at DESC
         LIMIT ${hp.add(limit)}`,
        hp.values as any[],
      ),
    };
  });

  app.get('/api/stats', async (req) => {
    const uid = userIdOf(req);
    // Clamped, not trusted: `days` sizes a generate_series, so an unbounded value is a way to ask the
    // database to materialise a few million rows. 400 covers "a year, plus the run-up" -- the widest thing
    // the heatmap draws -- and 7 is the narrowest window in which a week's shape is visible at all.
    const windowDays = Math.max(7, Math.min(400, Math.floor(Number((req.query as Record<string, string>).days) || 90)));
    const summary = (await one('SELECT chapters_completed, series_touched, total_events, last_read_at FROM reading_stats WHERE user_id = $1', [uid])) ?? {
      chapters_completed: 0,
      series_touched: 0,
      total_events: 0,
      last_read_at: null,
    };
    // DENSE, and one definition of "a day".
    //
    // This used to `GROUP BY date_trunc(...)` and return only the days that had events, which the chart then
    // rendered as one bar per row: someone who read on five days saw five fat evenly-spaced bars under a
    // label saying "Last 90 days". The gaps -- the actual information in a reading chart -- were silently
    // deleted, and the fewer days you read the more wrong it looked.
    //
    // The two queries also disagreed with each other: this one bucketed in the server's local zone and the
    // streak query on the next line bucketed in UTC, so on a container with a non-UTC TZ the chart and the
    // streak were off by one. Both now use UTC, which is at least ONE definition; a reader's own zone would
    // need the client to say what it is, and a streak that changes when you fly is a worse bug than a
    // boundary that is a few hours off.
    const byDay = await q<{ day: string; chapters: number }>(
      `SELECT to_char(d::date, 'YYYY-MM-DD') AS day,
              coalesce(e.chapters, 0)::int   AS chapters
         FROM generate_series(
                (now() AT TIME ZONE 'UTC')::date - make_interval(days => $2 - 1),
                (now() AT TIME ZONE 'UTC')::date,
                interval '1 day') AS d
         LEFT JOIN (
           SELECT date_trunc('day', created_at AT TIME ZONE 'UTC')::date AS day,
                  count(*) FILTER (WHERE completed) AS chapters
             FROM reading_events
            WHERE user_id = $1 AND created_at > now() - make_interval(days => $2)
            GROUP BY 1
         ) e ON e.day = d::date
        ORDER BY 1`,
      [uid, windowDays],
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
    // When reading started, so a year picker can offer the years that exist rather than guessing a range.
    // Null for an account that has never read anything, which is different from "started this year".
    const firstRead = (await one<{ at: string | null }>('SELECT min(created_at) AS at FROM reading_events WHERE user_id = $1', [uid]))?.at ?? null;
    return { ...summary, days: windowDays, byDay, first_read_at: firstRead, currentStreak: streaks.current, longestStreak: streaks.longest, weekChapters, weeklyGoal: settings.weeklyGoal ?? 0 };
  });

  app.get('/api/wrapped', async (req) => {
    const uid = userIdOf(req);
    const year = Math.max(1970, Math.min(9999, Math.floor(Number((req.query as Record<string, string>).year) || new Date().getUTCFullYear())));

    // UTC, on both sides of the wire.
    //
    // This was `extract(year from created_at) = $2`, which evaluates a timestamptz in the SERVER's zone, and
    // then bucketed months and weekdays with `new Date().getMonth()/.getDay()`, which use the server's zone
    // too. /api/stats next door buckets in UTC. So on any container not running UTC the two endpoints
    // disagreed, and a chapter finished on New Year's Eve counted in the wrong year -- the exact split-brain
    // statsShape.int.test.ts was written about, sitting in the endpoint beside it.
    //
    // A half-open range rather than a function on the column, so the index on (user_id, created_at) is
    // usable; `extract(...)` was not sargable and scanned every event the account ever had.
    const rows = await q<{ series_id: string; created_at: string }>(
      `SELECT series_id, created_at
         FROM reading_events
        WHERE user_id = $1 AND completed = true
          AND created_at >= make_timestamptz($2, 1, 1, 0, 0, 0, 'UTC')
          AND created_at <  make_timestamptz($3, 1, 1, 0, 0, 0, 'UTC')`,
      [uid, year, year + 1],
    );
    const seriesCounts: Record<string, number> = {};
    const byMonth = Array(12).fill(0);
    const dow = Array(7).fill(0);
    // Dense, one slot per day of the calendar year -- 366 in a leap year, and index 0 is 1 January UTC. A
    // sparse map would make the client invent the gaps, which is what the stats chart used to do wrong.
    const yearStart = Date.UTC(year, 0, 1);
    const dayCount = Math.round((Date.UTC(year + 1, 0, 1) - yearStart) / 86_400_000);
    const byDay: number[] = Array(dayCount).fill(0);
    for (const r of rows) {
      seriesCounts[r.series_id] = (seriesCounts[r.series_id] ?? 0) + 1;
      const d = new Date(r.created_at);
      byMonth[d.getUTCMonth()]++;
      dow[d.getUTCDay()]++;
      const i = Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - yearStart) / 86_400_000);
      if (i >= 0 && i < dayCount) byDay[i]++;
    }
    // Over-take, then filter, then take five: the top series are resolved by id, so an 18+ title would
    // otherwise both appear here and, once hidden, leave the rail with four entries instead of five.
    const ranked = Object.entries(seriesCounts).sort((a, b) => b[1] - a[1]).map((e) => e[0]);
    const shownTop = await browsableIds(ranked.slice(0, 40), vc(req));
    const topIds = ranked.filter((id) => shownTop.has(id)).slice(0, 5);
    const topSeries = (
      await Promise.all(
        topIds.map(async (id) => {
          const s = await komga.series(vc(req), id).catch(() => null);
          return s ? { id, title: (s as any).metadata?.title || (s as any).name, count: seriesCounts[id], genres: (s as any).metadata?.genres ?? [] } : null;
        }),
      )
    ).filter(Boolean) as { id: string; title: string; count: number; genres: string[] }[];
    // Genres come from a pool of twenty series and are weighted by how much of each you actually read.
    //
    // They used to come from the five series above, counted one apiece: "your top genres" meant "the genres
    // of your top five series", each weighted the same whether you read three chapters of it or three
    // hundred. That is a much smaller claim than the label makes, and with five series a single long-running
    // title decided the whole answer.
    const poolIds = ranked.filter((id) => shownTop.has(id)).slice(0, 20);
    const pool = (
      await Promise.all(poolIds.map(async (id) => {
        const s = await komga.series(vc(req), id).catch(() => null);
        return s ? { id, genres: ((s as any).metadata?.genres ?? []) as string[] } : null;
      }))
    ).filter(Boolean) as { id: string; genres: string[] }[];
    const genreCounts: Record<string, number> = {};
    for (const s of pool) for (const g of s.genres) genreCounts[g] = (genreCounts[g] ?? 0) + (seriesCounts[s.id] ?? 0);
    const rankedGenres = Object.entries(genreCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);
    return {
      year,
      chapters: rows.length,
      series: Object.keys(seriesCounts).length,
      topSeries: topSeries.map((s) => ({ id: s.id, title: s.title, count: s.count })),
      topGenres: rankedGenres.map((e) => e[0]),
      topGenreCounts: rankedGenres.map(([name, count]) => ({ name, count })),
      byMonth,
      byDay,
      byDow: dow,
      busiestDow: dow.indexOf(Math.max(...dow)),
    };
  });

  // ---- settings ----
  // ---- bulk actions on many series at once ----
  //
  // One request per logical operation rather than a client-side loop: 200 requests is slow, trips the rate
  // limiter, and on partial failure leaves the user with no idea which half applied.
  //
  // An id that no longer exists does NOT fail the batch. A stale client list is the normal case (a series was
  // deleted in another tab), and refusing 50 valid ids because one is stale is hostile. The response itemises
  // what was skipped so the UI can say so.
  const bulkBody = z.object({ seriesIds: z.array(z.string()).min(1).max(500) });

  /** The subset of the requested ids that are real, visible series. */
  const liveSeries = async (ids: string[], ctx: ViewCtx): Promise<string[]> => {
    // Takes the requester's viewer, not a blanket one: this is what gates every bulk action, so a series
    // the caller cannot see must not be actionable by id either.
    const p = new Params();
    const arr = p.add(ids);
    return (await q<{ id: string }>(
      `SELECT s.id FROM lib_series s WHERE s.id = ANY(${arr}) AND ${visible('s', ctx, p)}`,
      p.values as any[],
    )).map((r) => r.id);
  };

  const skippedOf = (asked: string[], live: string[]) =>
    asked.filter((id) => !live.includes(id)).map((id) => ({ id, reason: 'not_found' }));

  app.post('/api/library/bulk/read', async (req, reply) => {
    const b = bulkBody.extend({ completed: z.boolean() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    const uid = userIdOf(req);
    const live = await liveSeries(b.data.seriesIds, vc(req));

    if (b.data.completed) {
      // GREATEST on page so marking a series read never rewinds a chapter someone is part-way through.
      // Deliberately no reading_events insert: that table records chapters actually read in the app, and
      // bulk-marking a backlog must not inflate streaks, the leaderboard or Wrapped. Same rule as the
      // `silent` flag in lib/progress.ts.
      await q(
        `INSERT INTO read_progress (user_id, book_id, series_id, page, completed)
         SELECT $1, b.id, b.series_id, COALESCE(b.pages, 0), true
           FROM lib_books b WHERE b.series_id = ANY($2)
         ON CONFLICT (user_id, book_id) DO UPDATE
           SET completed = true, page = GREATEST(read_progress.page, EXCLUDED.page), updated_at = now()`,
        [uid, live],
      );
      // One tracker push per series, not per chapter, after the write and fire-and-forget. The existing
      // per-user gate trickles them at one every 1.2s, so a big batch is a background drip, not a burst.
      for (const id of live) pushSeriesProgressAsync(uid, id);
    } else {
      // DELETE rather than completed=false: leaving a page pointer behind makes an unread series show as
      // in-progress. reading_events is untouched on purpose, for the same reason it is never cascaded.
      // Nothing is pushed: this leaves the tracker ahead of the app, which is the safe direction, and the
      // monotonic floor makes that explicit rather than accidental.
      await q(`DELETE FROM read_progress WHERE user_id = $1 AND series_id = ANY($2)`, [uid, live]);
    }
    return { ok: true, applied: live.length, skipped: skippedOf(b.data.seriesIds, live) };
  });

  app.post('/api/favorites/bulk', async (req, reply) => {
    const b = bulkBody.extend({ favorite: z.boolean() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    const uid = userIdOf(req);
    const live = await liveSeries(b.data.seriesIds, vc(req));
    if (b.data.favorite) {
      await q(
        `INSERT INTO favorites (user_id, series_id) SELECT $1, unnest($2::text[])
         ON CONFLICT (user_id, series_id) DO NOTHING`,
        [uid, live],
      );
    } else {
      await q(`DELETE FROM favorites WHERE user_id = $1 AND series_id = ANY($2)`, [uid, live]);
    }
    return { ok: true, applied: live.length, skipped: skippedOf(b.data.seriesIds, live) };
  });

  app.post('/api/library/bulk/newest', async (req, reply) => {
    const b = bulkBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    // This route fetches bytes from sources, so it sits under the same canDownload gate as sources.ts.
    // Without it the button's permission is cosmetic: a denied account could still drive downloads by id.
    const me = await one<{ role: string; perms: { canDownload?: boolean } | null }>(
      'SELECT role, perms FROM users WHERE id = $1', [userIdOf(req)]).catch(() => null);
    if (!me) return reply.code(403).send({ error: 'forbidden', message: 'Could not check your permissions.' });
    if (me.role !== 'admin' && me.perms?.canDownload === false) {
      return reply.code(403).send({ error: 'forbidden', message: "You don't have permission to download chapters." });
    }
    const live = await liveSeries(b.data.seriesIds, vc(req));
    const skipped: { id: string; reason: string }[] = [];
    // Collected rather than scanned per-series: a downloaded file is only a file until a scan makes it a
    // book, and "select all" can fan this loop out over dozens of series. persistScan() runs once after the
    // loop (runUpdateAll's own pattern), then each landed series gets its date/provenance stamps against the
    // rows that scan just created.
    const dated: { folder: string; chapters: Parameters<typeof setBookDates>[1]; landed: Parameters<typeof setBookMeta>[1] }[] = [];
    let applied = 0;
    for (const id of live) {
      try {
        // updateSeries does the listing, the stamps and the per-source back-off; newestOnly cuts its queue
        // to the single newest missing chapter, which is the whole point of this button. Sequential and
        // awaited like the read/favourite bulks: the source health system paces the network, and a source in
        // a back-off parks its own series rather than the batch.
        const r = await updateSeries(id, 1, true);
        if (r.added > 0) {
          if (r.folder && r.chapters?.length) dated.push({ folder: r.folder, chapters: r.chapters, landed: r.landed });
          applied++;
          continue;
        }
        skipped.push({ id, reason: r.outcome !== 'ok' ? r.outcome : r.failed ? 'failed' : 'up_to_date' });
      } catch {
        skipped.push({ id, reason: 'error' });
      }
    }
    // Without this, the CBZ lands on disk but never becomes a lib_books row: the reader/series page keep
    // showing the chapter as missing, and the next click's cheap on-disk stat check (downloader.ts) finds
    // the orphaned file and reports "already exists" for a chapter nobody can actually open -- the bug this
    // fixes. Logged, not swallowed, for the same reason the "Check now" route logs its own scan failure.
    if (dated.length) {
      await persistScan().catch((e) => console.warn(`[bulk/newest] scan failed: ${(e as Error)?.message || e}`));
      for (const d of dated) {
        await setBookDates(d.folder, d.chapters).catch((e) => console.warn(`[bulk/newest] date stamp failed for ${d.folder}: ${(e as Error)?.message || e}`));
        await setBookMeta(d.folder, d.landed).catch((e) => console.warn(`[bulk/newest] provenance stamp failed for ${d.folder}: ${(e as Error)?.message || e}`));
      }
    }
    return { ok: true, applied, skipped };
  });

  app.post('/api/collections/:id/items/bulk', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = bulkBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    const uid = userIdOf(req);
    const owns = await one('SELECT id FROM collections WHERE id = $1 AND user_id = $2', [id, uid]);
    if (!owns) return reply.code(404).send({ error: 'not_found' });
    const live = await liveSeries(b.data.seriesIds, vc(req));
    await q(
      `INSERT INTO collection_items (collection_id, series_id, position)
       SELECT $1, s, COALESCE((SELECT max(position) + 1 FROM collection_items WHERE collection_id = $1), 0)
         FROM unnest($2::text[]) s
       ON CONFLICT (collection_id, series_id) DO NOTHING`,
      [id, live],
    );
    return { ok: true, applied: live.length, skipped: skippedOf(b.data.seriesIds, live) };
  });

  // ---- external progress trackers (AniList) ----
  app.get('/api/trackers', async (req) => ({ content: await statusFor(userIdOf(req)) }));

  // Connect by pasting a token, for any provider. This is the honest, dependency-free path: a full OAuth
  // dance would make every self-hoster register an application with each service and keep its secret in
  // their compose file, which is a worse trade for a household app than copying a token once.
  //
  // The token is verified against the service before it is stored, so a typo fails here with the service's
  // own answer rather than silently at 3am when the first chapter tries to sync.
  const connectTracker = async (provider: Provider, req: any, reply: any) => {
    const b = z.object({ token: z.string().min(10).max(4000) }).safeParse(req.body);
    const adapter = ADAPTERS[provider];
    if (!b.success) return reply.code(400).send({ error: 'bad_request', message: `Paste your ${adapter.label} token.` });
    let who;
    try {
      who = await whoAmI(b.data.token.trim(), provider);
    } catch {
      return reply.code(400).send({ error: 'rejected', message: `${adapter.label} did not accept that token.` });
    }
    if (!who) return reply.code(400).send({ error: 'rejected', message: `${adapter.label} did not accept that token.` });
    // Record the expiry so the UI can warn before it lapses; none of these services can refresh silently.
    const expires = adapter.tokenDays ? new Date(Date.now() + adapter.tokenDays * 86400000) : null;
    await saveConnection(userIdOf(req), provider, b.data.token.trim(), who.name, expires);
    await logAudit('tracker.connect', { userId: userIdOf(req), detail: { provider, account: who.name }, req });
    return { ok: true, account: who.name };
  };

  // Kept as its own path for the clients and docs that already reference it.
  app.post('/api/trackers/anilist', async (req, reply) => connectTracker('anilist', req, reply));

  app.post('/api/trackers/:provider/connect', async (req, reply) => {
    const { provider } = req.params as { provider: string };
    if (!isProvider(provider)) return reply.code(404).send({ error: 'unknown_provider' });
    return connectTracker(provider, req, reply);
  });

  app.delete('/api/trackers/:provider', async (req) => {
    const { provider } = req.params as { provider: string };
    if (!isProvider(provider)) return { ok: true };   // nothing to disconnect from a name we do not have
    await disconnect(userIdOf(req), provider);
    await logAudit('tracker.disconnect', { userId: userIdOf(req), detail: { provider }, req });
    return { ok: true };
  });

  // Push everything already finished, for a freshly-connected account.
  app.post('/api/trackers/anilist/backfill', async (req) => {
    const uid = userIdOf(req);
    const rows = await q<{ series_id: string }>(
      `SELECT DISTINCT rp.series_id FROM read_progress rp
         JOIN series_trackers st ON st.series_id = rp.series_id AND st.provider = 'anilist'
        WHERE rp.user_id = $1 AND rp.completed = true`,
      [uid],
    );
    void (async () => { for (const r of rows) await pushSeriesProgress(uid, r.series_id).catch(() => {}); })();
    return { ok: true, series: rows.length };
  });

  // Allow the next push for one series to go DOWN.
  //
  // Progress is otherwise monotonic, because AniList accepts a lower number and rewrites the entry with no
  // undo. That is the right default, but it is wrong in one case: the tracker is ahead because the old
  // chapter number was wrong and the correction is the smaller one. Lowering a number on someone's real
  // account should be a deliberate act, so it is this route and not a side effect of anything else.
  app.post('/api/trackers/:provider/resync/:seriesId', async (req, reply) => {
    const { provider, seriesId } = req.params as { provider: string; seriesId: string };
    if (provider !== 'anilist') return reply.code(400).send({ error: 'unknown_provider' });
    const uid = userIdOf(req);
    await clearTrackerFloor(uid, seriesId);
    await pushSeriesProgress(uid, seriesId).catch(() => {});
    return { ok: true };
  });

  app.get('/api/settings', async (req) => {
    const uid = userIdOf(req);
    const row = await one<{ data: unknown }>('SELECT data FROM app_settings WHERE user_id = $1', [uid]);
    return row?.data ?? {};
  });

  app.put('/api/settings', async (req) => {
    const uid = userIdOf(req);
    // zod 4 requires a key schema as well as a value schema; z.record(valueOnly) was a v3 signature.
    const data = z.record(z.string(), z.any()).parse(req.body ?? {});
    await q(
      `INSERT INTO app_settings (user_id, data) VALUES ($1, $2::jsonb)
       ON CONFLICT (user_id) DO UPDATE SET data = app_settings.data || EXCLUDED.data`,
      [uid, JSON.stringify(data)],
    );
    // avatar is identity shown to other household members -> mirror onto the users row
    if (data.avatar && typeof data.avatar === 'object') {
      await q('UPDATE users SET avatar = $2 WHERE id = $1', [uid, JSON.stringify(data.avatar)]);
    }
    // ...and so is the name. Only an admin could set one, and only when creating the account, so anyone
    // whose display_name was left at the default saw a generic fallback where their name should be, forever,
    // with nothing on screen suggesting a cause or a fix. Stored on the users row rather than in the
    // free-form settings blob because other members read it (the leaderboard, member activity, sessions).
    if (typeof data.displayName === 'string') {
      const name = data.displayName.trim().slice(0, 40);
      if (name) await q('UPDATE users SET display_name = $2 WHERE id = $1', [uid, name]);
    }
    const row = await one<{ data: unknown }>('SELECT data FROM app_settings WHERE user_id = $1', [uid]);
    return row?.data ?? {};
  });
}
