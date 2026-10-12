// Reading time through the real routes (v0.61.0, lib/readingTime.ts): GET /api/stats/time, GET /api/series/:id/
// reading-pace and what /api/wrapped gained -- the signed-in reader's own time, never another member's, in their
// timezone, with their own devices' names; and the household's leaderboard still counts chapters, not time.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const LIB = 'lib_rt', LIB_HIDDEN = 'lib_rt_hidden';
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
let q: any, app: any;
let reader = '', other = '';
const H: Record<string, string> = {};
const O: Record<string, string> = {};

/** Turns on `book` of `series`, `every` seconds apart, from `start` (ms), by `device`, the last one finishing it. */
async function chapter(user: string, series: string, book: string, start: number, pages: number, every: number, device: string | null) {
  for (let i = 0; i < pages; i++) {
    await q(`INSERT INTO reading_events (user_id, series_id, book_id, page, completed, device_id, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [user, series, book, i + 2, i === pages - 1, device, new Date(start + i * every * SEC).toISOString()]);
  }
}

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  await migrate();
  await q(`DELETE FROM users WHERE username IN ('rt_reader', 'rt_other')`);
  const users = await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind)
                         VALUES ('rt_reader', 'R', 'x', 'user', 'password'), ('rt_other', 'O', 'x', 'user', 'password') RETURNING id, username`);
  reader = users.find((u: any) => u.username === 'rt_reader').id;
  other = users.find((u: any) => u.username === 'rt_other').id;
  await q(`INSERT INTO libraries (id, name, path) VALUES ($1, 'RT', '/rt'), ($2, 'RT hidden', '/rt-hidden') ON CONFLICT (id) DO NOTHING`, [LIB, LIB_HIDDEN]);
  await q(`INSERT INTO user_libraries (user_id, library_id) VALUES ($1, $2)`, [reader, LIB]);
  for (const [id, lib] of [['s_rt_a', LIB], ['s_rt_b', LIB], ['s_rt_hidden', LIB_HIDDEN]]) {
    await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id) VALUES ($1, 'T!rt', $1, $1, 10, $2)`, [id, lib]);
  }
  // The reader's devices: the phone was renamed by a later sign-in; the other member's session on a device id of the
  // same name must never name the reader's.
  await q(`INSERT INTO refresh_tokens (user_id, token_hash, device_id, device_name, expires_at, created_at) VALUES
             ($1, 'rt-h1', 'dev-phone', 'Android', now() + interval '30 days', now() - interval '10 days'),
             ($1, 'rt-h2', 'dev-phone', 'iPhone', now() + interval '30 days', now() - interval '1 day'),
             ($1, 'rt-h3', 'dev-pc', 'Windows', now() + interval '30 days', now() - interval '1 day'),
             ($2, 'rt-h4', 'dev-phone', 'Their tablet', now() + interval '30 days', now())`, [reader, other]);

  // Two days ago at 00:45 UTC -- 06:15 in Kolkata: three chapters of A on the phone, a turn every 30 s, five pages each.
  const base = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()) - 2 * DAY + 45 * MIN;
  await chapter(reader, 's_rt_a', 'b_rt_a1', base, 5, 30, 'dev-phone');
  await chapter(reader, 's_rt_a', 'b_rt_a2', base + 10 * MIN, 5, 30, 'dev-phone');
  await chapter(reader, 's_rt_a', 'b_rt_a3', base + 20 * MIN, 5, 30, 'dev-phone');
  // An hour later, one chapter of B on the PC, a turn every 60 s.
  await chapter(reader, 's_rt_b', 'b_rt_b1', base + HOUR + 20 * MIN, 5, 60, 'dev-pc');
  // The other member reads a lot, at the same time, on a device id the reader also has. None of it is the reader's.
  await chapter(other, 's_rt_a', 'b_rt_a1', base, 40, 20, 'dev-phone');

  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/catalog')).default);
  await app.register((await import('../src/routes/personal')).default);
  await app.ready();
  H.authorization = `Bearer ${app.jwt.sign({ sub: reader, role: 'user' })}`;
  O.authorization = `Bearer ${app.jwt.sign({ sub: other, role: 'user' })}`;
});

after(async () => {
  if (!DSN) return;
  await q(`DELETE FROM reading_events WHERE user_id = ANY($1)`, [[reader, other]]).catch(() => {});
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [['s_rt_a', 's_rt_b', 's_rt_hidden']]).catch(() => {});
  await q('DELETE FROM libraries WHERE id = ANY($1)', [[LIB, LIB_HIDDEN]]).catch(() => {});
  await q(`DELETE FROM users WHERE username IN ('rt_reader', 'rt_other')`).catch(() => {});
  await app?.close();
});

const get = async (url: string, h = H) => {
  const r = await app.inject({ method: 'GET', url, headers: h });
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
};

test('the Studio\'s time: the reader\'s own, by window, hour and device', { skip }, async () => {
  // Per A chapter: 4 gaps of 30 s plus its opening page; B: 4 x 60 s plus its own. The typical page is the median
  // counted gap, 30 s. Reintroduce another member's events (drop the user from loadTimeline): the other member's
  // forty turns are added.
  const t = await get('/api/stats/time?days=90&tz=Asia/Kolkata');
  const a = 4 * 30 * SEC + 30 * SEC;
  const b = 4 * 60 * SEC + 30 * SEC;
  assert.equal(t.tz, 'Asia/Kolkata');
  assert.equal(t.days, 90);
  assert.deepEqual(t.week, { ms: 3 * a + b, chapters: 4 });
  assert.deepEqual(t.month, { ms: 3 * a + b, chapters: 4 });
  assert.equal(t.window.ms, 3 * a + b);
  assert.equal(t.window.chapters, 4);
  assert.equal(t.window.perChapterMs, a, 'the median of 150, 150, 150 and 270 seconds');
  // 00:45 UTC is 06:15 in Kolkata; B began at 02:05 UTC, 07:35 there.
  assert.equal(t.window.byHour[6], 3 * a);
  assert.equal(t.window.byHour[7], b);
  assert.equal(t.window.byHour.reduce((x: number, y: number) => x + y, 0), t.window.ms);
  // The phone's newest name from the reader's own sessions; another member's "Their tablet" is never it.
  assert.deepEqual(t.window.byDevice, [{ name: 'iPhone', ms: 3 * a }, { name: 'Windows', ms: b }]);
  // The other member sees their own, and only their own.
  const theirs = await get('/api/stats/time?days=90', O);
  assert.equal(theirs.window.chapters, 1);
  assert.deepEqual(theirs.window.byDevice, [{ name: 'Their tablet', ms: theirs.window.ms }]);
});

test('a timezone that is not one is UTC, and the window is clamped', { skip }, async () => {
  const t = await get('/api/stats/time?days=99999&tz=Mars%2FOlympus');
  assert.equal(t.tz, 'UTC');
  assert.equal(t.days, 400);
  // The same reading in UTC hours: A's first two chapters at 00:45 and 00:55, its third at 01:05, B at 02:05.
  const a = 4 * 30 * SEC + 30 * SEC;
  const b = 4 * 60 * SEC + 30 * SEC;
  const hours = Object.fromEntries((t.window.byHour as number[]).map((v, h) => [h, v]).filter(([, v]) => v > 0));
  assert.deepEqual(hours, { 0: 2 * a, 1: a, 2: b });
  assert.equal((await get('/api/stats/time?days=1')).days, 7);
});

test('the Studio\'s year is Wrapped\'s, to the millisecond', { skip }, async () => {
  // Both count the UTC calendar year from the same timeline. Reintroduce a window of 365 days for the Studio's year:
  // a reader who read last December sees two different figures for "this year".
  const year = new Date().getUTCFullYear();
  const t = await get('/api/stats/time?days=90&tz=Asia/Kolkata');
  const w = await get(`/api/wrapped?year=${year}&tz=Asia/Kolkata`);
  // The fixture is two days old: on 1 or 2 January it falls in last year, in both.
  assert.equal(t.year.year, year);
  assert.equal(w.ms, t.year.ms);
  assert.equal(w.chapters, t.year.chapters);
  assert.equal(w.tz, 'Asia/Kolkata');
  assert.equal(w.perChapterMs, t.year.ms ? t.window.perChapterMs : null);
  assert.deepEqual(w.byHour, t.year.ms ? t.window.byHour : Array(24).fill(0));
  // And both are the UTC calendar year by construction: a pin, because a fixture two days old lies in this calendar year
  // and in the last 365 days alike for most of the year.
  const src = readFileSync(join(__dirname, '..', 'src', 'routes', 'personal.ts'), 'utf8');
  const time = src.slice(src.indexOf("app.get('/api/stats/time'"), src.indexOf("app.get('/api/series/:id/reading-pace'"));
  assert.match(time, /const \[ys, ye\] = yearRange\(year\);[\s\S]*const yr = summarize\(tl, ys, ye, hourOf\);/);
  const wrapped = src.slice(src.indexOf("app.get('/api/wrapped'"));
  assert.match(wrapped, /const \[ys, ye\] = yearRange\(year\);\s*const time = summarize\(await loadTimeline\(uid, ys, ye\), ys, ye, hourIn\(tz\)\);/);
});

test('the reading pace of a series: its own, else the reader\'s overall, else none; 404 where it may not be seen', { skip }, async () => {
  // A has three finished chapters of its own: its median. B has one: the reader's overall 90-day median, which is A's
  // too here. Reintroduce visibility by id alone (no komga.series): the hidden library's series answers 200.
  assert.deepEqual(await get('/api/series/s_rt_a/reading-pace'), { perChapterMs: 4 * 30 * SEC + 30 * SEC, from: 'series' });
  assert.deepEqual(await get('/api/series/s_rt_b/reading-pace'), { perChapterMs: 4 * 30 * SEC + 30 * SEC, from: 'all' });
  assert.deepEqual(await get('/api/series/s_rt_b/reading-pace', O), { perChapterMs: null, from: null }, 'one chapter is nobody\'s pace');
  const hidden = await app.inject({ method: 'GET', url: '/api/series/s_rt_hidden/reading-pace', headers: H });
  assert.equal(hidden.statusCode, 404);
  const unknown = await app.inject({ method: 'GET', url: '/api/series/s_rt_nope/reading-pace', headers: H });
  assert.equal(unknown.statusCode, 404);
});

test('the leaderboard still counts chapters, and says nothing of time', { skip }, async () => {
  // Reading time is the reader's own. Reintroduce a time column on the household board: this fails on its keys.
  const board = await get('/api/leaderboard');
  const row = (board.content as any[]).find((r) => r.id === reader);
  assert.deepEqual(Object.keys(row).sort(), ['avatar', 'display_name', 'id', 'total', 'username', 'week']);
  assert.equal(row.week, 4);
});
