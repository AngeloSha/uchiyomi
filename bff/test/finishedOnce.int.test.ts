// Each finished chapter counts once (#264, CheetahDoesStuff: "Wrapped says 69, I read 40").
//
// Pages are numbered from 1, and the server takes the page BEFORE the last as the end (lib/progressRules.ts
// reachedEnd), so the reader's ordinary 600 ms ping on page N-1 is stored as a completion -- and then the last page
// sends its own. One read-through, two completed events; on the live server 422 of 476 repeats were exactly that pair,
// seconds apart. Re-reads and outbox replays add more. The household board always counted DISTINCT chapters; the
// profile's chapters (and the badges on them), the Studio, the weekly goal, Wrapped, reading time and the admin's
// member stats counted events.
//
// Driven through the real progress route, so the doubled pair is the one the server really writes. The counts come
// from reading_events, never from read_progress.completed: a chapter ticked from the list and THEN read must count, and
// one only ticked must not (marking a backlog is not reading, lib/progress.ts).
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const LIB = 'lib_fo', SERIES = 's_fo';
const [A, B, MARKED] = ['b_fo_1', 'b_fo_2', 'b_fo_3'];
const PAGES = 20;
const DAY = 86_400_000;
let q: any, app: any, reader = '', admin = '';
const R: Record<string, string> = {};
const AD: Record<string, string> = {};

const put = async (book: string, page: number, completed: boolean, at?: number) => {
  const res = await app.inject({
    method: 'PUT', url: `/api/books/${book}/progress`, headers: R,
    payload: { page, completed, seriesId: SERIES, deviceId: 'fo-phone', ...(at ? { at } : {}) },
  });
  assert.equal(res.statusCode, 200, res.body);
};
const get = async (url: string, headers = R) => {
  const res = await app.inject({ method: 'GET', url, headers });
  assert.equal(res.statusCode, 200, res.body);
  return res.json();
};
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const utcDay = (t: number) => new Date(t).toISOString().slice(0, 10);

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  await migrate();
  await q(`DELETE FROM users WHERE username IN ('fo-reader', 'fo-admin')`);
  await q(`INSERT INTO libraries (id, name, path) VALUES ($1,'FO',$1) ON CONFLICT (id) DO NOTHING`, [LIB]);
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id)
           VALUES ($1,'T!fo','Finished Once',$1,3,$2) ON CONFLICT (id) DO NOTHING`, [SERIES, LIB]);
  for (const [id, n] of [[A, 1], [B, 2], [MARKED, 3]] as const) {
    await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, root, pages)
             VALUES ($1,$2,'T!fo',$3,$4,$5,'/library',$6) ON CONFLICT (id) DO NOTHING`,
      [id, SERIES, `T!fo/${SERIES}/ch${n}.cbz`, n, `Chapter ${n}`, PAGES]);
  }
  const mk = async (name: string, role: string) => (await q(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind)
     VALUES ($1,$1,'x',$2,'password') RETURNING id`, [name, role]))[0].id as string;
  reader = await mk('fo-reader', 'user');
  admin = await mk('fo-admin', 'admin');

  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const cookie = (await import('@fastify/cookie')).default;
  app = Fastify();
  await app.register(cookie);
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/catalog')).default);
  await app.register((await import('../src/routes/personal')).default);
  await app.register((await import('../src/routes/admin')).default);
  await app.ready();
  R.authorization = `Bearer ${app.jwt.sign({ sub: reader, role: 'user' })}`;
  AD.authorization = `Bearer ${app.jwt.sign({ sub: admin, role: 'admin' })}`;
});

after(async () => {
  if (!DSN) return;
  await app?.close();
  await q(`DELETE FROM users WHERE username IN ('fo-reader', 'fo-admin')`).catch(() => {});
  await q('DELETE FROM lib_books WHERE series_id = $1', [SERIES]).catch(() => {});
  await q('DELETE FROM lib_series WHERE id = $1', [SERIES]).catch(() => {});
  await q('DELETE FROM libraries WHERE id = $1', [LIB]).catch(() => {});
});

test('a read-through counts once', { skip }, async (t) => {
  // A minute ago, so every window below -- today, this week, this UTC year -- holds it.
  const at = Date.now() - 60_000;
  const year = new Date(at).getUTCFullYear();

  // Chapter 3 is ticked from the list and never opened: a silent mark writes no event, so it never counts.
  await q(`INSERT INTO read_progress (user_id, book_id, series_id, page, completed) VALUES ($1,$2,$3,$4,true)`,
    [reader, MARKED, SERIES, PAGES]);
  // Chapter 1 was ticked from the list too -- and then really read. It counts: read_progress.completed is no filter.
  await q(`INSERT INTO read_progress (user_id, book_id, series_id, page, completed) VALUES ($1,$2,$3,$4,true)`,
    [reader, A, SERIES, PAGES]);
  // Chapter 1 as the reader reads it: page 18, then the page before the last (its debounced ping says
  // completed:false and the server upgrades it), then the last page's completion ping 9 s later, then the outbox
  // replaying that ping once more.
  await put(A, 18, false, at);
  await put(A, PAGES - 1, false, at + 3_000);
  await put(A, PAGES, true, at + 12_000);
  await put(A, PAGES, true, at + 12_000);
  // Chapter 2, read the same way.
  await put(B, PAGES - 1, false, at + 40_000);
  await put(B, PAGES, true, at + 49_000);

  const done = (await q(`SELECT count(*)::int AS c FROM reading_events WHERE user_id = $1 AND completed`, [reader]))[0].c;
  assert.equal(done, 5, 'the premise: five completed events for two chapters (the page before the last counts as the end)');

  await t.test('the profile, the weekly goal and the Studio (GET /api/stats)', async () => {
    // Reintroduce count(*) in the reading_stats view (migrate.ts): chapters_completed reads 5, and the badges with it.
    // Reintroduce count(*) for the week: the weekly goal reads 5. Reintroduce count(*) per day: the heatmap's day reads 5.
    const s = await get('/api/stats');
    assert.equal(s.chapters_completed, 2, 'the profile counts chapters');
    assert.equal(s.weekChapters, 2, 'the weekly goal counts chapters');
    assert.equal(s.windowChapters, 2, "the Studio's count over its heatmap counts chapters");
    assert.equal(s.byDay.find((d: any) => d.day === utcDay(at))?.chapters, 2, "the heatmap's day counts chapters");
    assert.equal(sum(s.byDay.map((d: any) => d.chapters)), 2);
  });

  await t.test('Wrapped (GET /api/wrapped)', async () => {
    // Reintroduce the plain SELECT (no DISTINCT ON book_id): chapters reads 5, and every chart under it adds to 5.
    const w = await get(`/api/wrapped?year=${year}`);
    assert.equal(w.chapters, 2);
    assert.equal(w.series, 1);
    assert.equal(sum(w.byMonth), 2, 'the months add up to the chapters');
    assert.equal(sum(w.byDay), 2, 'the days add up to the chapters');
    assert.equal(sum(w.byDow), 2, 'the weekdays add up to the chapters');
    assert.deepEqual(w.topSeries.map((s: any) => [s.id, s.count]), [[SERIES, 2]], 'the top series counts chapters');
  });

  await t.test('reading time (GET /api/stats/time)', async () => {
    // Reintroduce `chapters: finished.length` (lib/readingTime.ts summarize): every tile reads 5.
    const r = await get('/api/stats/time?days=90');
    assert.equal(r.week.chapters, 2);
    assert.equal(r.month.chapters, 2);
    assert.equal(r.year.chapters, 2);
    assert.equal(r.window.chapters, 2);
  });

  await t.test('the household board and the admin member stats', async () => {
    // The board always counted distinct; this pins it. Reintroduce count(e.*) in /api/admin/stats: total reads 5.
    const board = (await get('/api/leaderboard')).content.find((u: any) => u.id === reader);
    assert.deepEqual([board.week, board.total], [2, 2]);
    const member = (await get('/api/admin/stats', AD)).activity.find((u: any) => u.id === reader);
    assert.deepEqual([member.week, member.total], [2, 2]);
  });

  await t.test('a chapter read again on another day lights that day, and still counts once', async () => {
    // Two days back is another UTC day, inside the week and the Studio's 90 days. The heatmap and the streak agree
    // that it was a day of reading (statsShape.int.test.ts); the counts of chapters do not move.
    const again = at - 2 * DAY;
    await put(B, PAGES, true, again);
    const s = await get('/api/stats');
    assert.equal(s.byDay.find((d: any) => d.day === utcDay(again))?.chapters, 1, 'the day of the re-read is a day of reading');
    assert.equal(s.windowChapters, 2, "but the Studio's count is still two chapters");
    assert.equal(s.weekChapters, 2);
    assert.equal(s.chapters_completed, 2);
    if (new Date(again).getUTCFullYear() === year) {
      const w = await get(`/api/wrapped?year=${year}`);
      assert.equal(w.chapters, 2, 'Wrapped counts a chapter on the day it was first finished that year');
      assert.equal(w.byDay[Math.floor((Date.UTC(year, new Date(again).getUTCMonth(), new Date(again).getUTCDate()) - Date.UTC(year, 0, 1)) / DAY)], 1);
    }
    const r = await get('/api/stats/time?days=90');
    assert.equal(r.week.chapters, 2);
  });
});
