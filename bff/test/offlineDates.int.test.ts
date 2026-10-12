// Reading done offline is dated when it was READ, not when the phone came back online (v0.61.0).
//
// The offline outbox replays page turns hours or days later with the time they happened (`at`). Until v0.61.0 the
// server used it only to order the bookmark: every reading event was inserted at arrival time, so a flight's reading
// landed in history, streaks, the weekly board and Wrapped on the day the phone synced. And a chapter first OPENED
// offline was inserted at sync time too, so every later replayed page looked older than the row and moved nothing:
// the reader resumed at the first page read offline, not the last. The time is clamped (progressRules.ts eventTime):
// never in the future, and a dead clock is not believed.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
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

const LIB = 'lib_od', SERIES = 's_od', BOOK = 'b_od_1', BOOK2 = 'b_od_2';
const USER = 'od-reader';
const HOUR = 60 * 60 * 1000;
let q: any, writeProgress: any, uid: string;

const events = async () =>
  (await q('SELECT page, created_at FROM reading_events WHERE user_id = $1 ORDER BY id', [uid])) as Array<{ page: number; created_at: Date }>;
const stored = async (book: string) =>
  (await q('SELECT page, completed FROM read_progress WHERE user_id = $1 AND book_id = $2', [uid, book]))[0];
const reset = () => Promise.all([
  q('DELETE FROM reading_events WHERE user_id = $1', [uid]),
  q('DELETE FROM read_progress WHERE user_id = $1', [uid]),
]);
const near = (a: Date, b: number, ms = 5000) => Math.abs(new Date(a).getTime() - b) < ms;

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  ({ writeProgress } = (await import('../src/lib/progress')) as any);
  await migrate();
  await q(`INSERT INTO libraries (id, name, path) VALUES ($1,'OD',$1) ON CONFLICT (id) DO NOTHING`, [LIB]);
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id)
           VALUES ($1,'T!od',$1,$1,2,$2) ON CONFLICT (id) DO NOTHING`, [SERIES, LIB]);
  for (const [id, n] of [[BOOK, 1], [BOOK2, 2]] as const) {
    await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, root, pages)
             VALUES ($1,$2,'T!od',$3,$4,$5,'/library',80) ON CONFLICT (id) DO NOTHING`,
      [id, SERIES, `T!od/${SERIES}/ch${n}.cbz`, n, `Chapter ${n}`]);
  }
  await q('DELETE FROM users WHERE username = $1', [USER]);
  uid = (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind)
                  VALUES ($1,$1,'x','user','password') RETURNING id`, [USER]))[0].id;
});

after(async () => {
  if (!DSN) return;
  await q('DELETE FROM users WHERE username = $1', [USER]).catch(() => {});
  await q('DELETE FROM lib_books WHERE series_id = $1', [SERIES]).catch(() => {});
  await q('DELETE FROM lib_series WHERE id = $1', [SERIES]).catch(() => {});
  await q('DELETE FROM libraries WHERE id = $1', [LIB]).catch(() => {});
});

test('a replayed page is dated when it was read', { skip }, async () => {
  // Reintroduce by dropping `created_at` from writeProgress's reading_events INSERT: the event reads now.
  await reset();
  const at = Date.now() - 3 * HOUR;
  await writeProgress({ userId: uid, bookId: BOOK, seriesId: SERIES, page: 5, completed: false, at });
  const [ev] = await events();
  assert.ok(near(ev.created_at, at), `dated ${new Date(ev.created_at).toISOString()}, read at ${new Date(at).toISOString()}`);
});

test("offline reading lands on the day it was read, so yesterday's streak counts it", { skip }, async () => {
  await reset();
  const yesterdayNoon = new Date(); yesterdayNoon.setUTCDate(yesterdayNoon.getUTCDate() - 1); yesterdayNoon.setUTCHours(12, 0, 0, 0);
  await writeProgress({ userId: uid, bookId: BOOK2, seriesId: SERIES, page: 79, completed: true, at: yesterdayNoon.getTime() });
  const day = (await q(`SELECT (created_at AT TIME ZONE 'UTC')::date::text AS d FROM reading_events WHERE user_id = $1`, [uid]))[0].d;
  assert.equal(day, yesterdayNoon.toISOString().slice(0, 10));
});

test('a chapter first read offline resumes where the reader stopped', { skip }, async () => {
  // Reintroduce by letting the read_progress INSERT take updated_at's default: the first replayed page creates the row
  // at sync time, the later ones are older and move nothing, and the bookmark is page 3.
  await reset();
  const t0 = Date.now() - 2 * HOUR;
  for (const [page, dt] of [[3, 0], [10, 60_000], [25, 120_000]] as const) {
    await writeProgress({ userId: uid, bookId: BOOK, seriesId: SERIES, page, completed: false, at: t0 + dt });
  }
  assert.equal((await stored(BOOK)).page, 25);
});

test('a fast clock cannot date reading in the future, and a live ping still moves the page after it', { skip }, async () => {
  // Reintroduce by dropping the upper clamp in eventTime: the event is dated two hours ahead, the row's updated_at
  // with it, and the live ping that follows is "older" and leaves the bookmark at 40.
  await reset();
  await writeProgress({ userId: uid, bookId: BOOK, seriesId: SERIES, page: 40, completed: false, at: Date.now() + 2 * HOUR });
  const [ev] = await events();
  assert.ok(new Date(ev.created_at).getTime() <= Date.now() + 2000, 'never dated ahead of now');
  await writeProgress({ userId: uid, bookId: BOOK, seriesId: SERIES, page: 41, completed: false });
  assert.equal((await stored(BOOK)).page, 41);
});

test("a dead clock's 1970 is not believed: the arrival time stands", { skip }, async () => {
  // Reintroduce by dropping the floor in eventTime: the event is dated 1970, and Wrapped grows a 1970.
  await reset();
  const before = Date.now();
  await writeProgress({ userId: uid, bookId: BOOK, seriesId: SERIES, page: 2, completed: false, at: 1_000 });
  const [ev] = await events();
  assert.ok(near(ev.created_at, before, 10_000), `dated ${new Date(ev.created_at).toISOString()}`);
});

test('eventTime: clamps to now, refuses a dead clock, keeps a believable past', async () => {
  const { eventTime, AT_FLOOR_MS } = await import('../src/lib/progressRules');
  const now = Date.UTC(2026, 9, 12, 12);
  assert.equal(eventTime(undefined, now), null);
  assert.equal(eventTime(Number.NaN, now), null);
  assert.equal(eventTime(now + HOUR, now)?.getTime(), now);
  assert.equal(eventTime(now - 3 * HOUR, now)?.getTime(), now - 3 * HOUR);
  assert.equal(eventTime(now - AT_FLOOR_MS - 1, now), null);
});
