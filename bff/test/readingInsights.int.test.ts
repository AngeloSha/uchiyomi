// Profile → Insights (GET /api/stats/insights, lib/readingInsights.ts; from @Squeaks72's #249) against a real database:
// one row per series the reader has a RECORDED read in, each finished chapter once (#264), and only what the reader may
// list -- a series rated 18+, by its library or by itself, stays out until Show 18+ is on, and a library they were not
// given stays out always. #249 pinned the 18+ rule by grepping its own source for `browsable(`; this asks the route.
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

const [CLEAN, ADULT, OTHER] = ['lib_ri_clean', 'lib_ri_adult', 'lib_ri_other'];
/** Series: read in the open; in the 18+ library; rated 18 itself; in a library the reader was not given; never read;
 *  kept only by an Incognito read (progress, no event); read by someone else. */
const S = {
  read: 's_ri_read', adult: 's_ri_adult', rated: 's_ri_rated', other: 's_ri_other',
  unread: 's_ri_unread', incognito: 's_ri_incognito', someone: 's_ri_someone',
} as const;
const LIB_OF: Record<string, string> = { [S.adult]: ADULT, [S.other]: OTHER };
const USERS = ['ri-reader', 'ri-someone'];
const DAY = 86_400_000;
let q: any, app: any, reader = '', someone = '';
const R: Record<string, string> = {};

const book = (s: string, n: number) => `b_${s}_${n}`;
const read = (u: string, s: string, n: number, at: number) => q(
  `INSERT INTO reading_events (user_id, series_id, book_id, page, completed, created_at) VALUES ($1,$2,$3,4,true,$4)`,
  [u, s, book(s, n), new Date(at).toISOString()]);
const done = (u: string, s: string, n: number) => q(
  `INSERT INTO read_progress (user_id, series_id, book_id, page, completed) VALUES ($1,$2,$3,4,true) ON CONFLICT DO NOTHING`,
  [u, s, book(s, n)]);
const insights = async (url = '/api/stats/insights') => {
  const r = await app.inject({ method: 'GET', url, headers: R });
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
};
const ids = (b: any) => b.series.map((s: any) => s.id).sort();

async function wipe() {
  await q(`DELETE FROM users WHERE username = ANY($1)`, [USERS]).catch(() => {});
  await q('DELETE FROM reading_events WHERE series_id = ANY($1)', [Object.values(S)]).catch(() => {});
  await q('DELETE FROM read_progress WHERE series_id = ANY($1)', [Object.values(S)]).catch(() => {});
  await q('DELETE FROM series_overrides WHERE series_id = ANY($1)', [Object.values(S)]).catch(() => {});
  await q('DELETE FROM lib_books WHERE series_id = ANY($1)', [Object.values(S)]).catch(() => {});
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [Object.values(S)]).catch(() => {});
  await q('DELETE FROM libraries WHERE id = ANY($1)', [[CLEAN, ADULT, OTHER]]).catch(() => {});
}

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  await migrate();
  await wipe();
  await q(`INSERT INTO libraries (id, name, path, age_rating) VALUES ($1,'RI Clean','/ri-clean',NULL), ($2,'RI Adult','/ri-adult',18),
           ($3,'RI Other','/ri-other',NULL)`, [CLEAN, ADULT, OTHER]);
  for (const s of Object.values(S)) {
    await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, genres)
             VALUES ($1,'RI Source',$2,$1,4,$3,ARRAY['Drama'])`, [s, `Zzz ${s}`, LIB_OF[s] ?? CLEAN]);
    for (const n of [1, 2, 3, 4]) {
      await q(`INSERT INTO lib_books (id, series_id, source, file, number, title) VALUES ($1,$2,'RI Source',$3,$4,'Chapter')`,
        [book(s, n), s, `ri/${s}/${n}.cbz`, n]);
    }
  }
  // Rated 18 by the series itself, in an ordinary library: the series' own rating hides it as the library's does.
  await q(`INSERT INTO series_overrides (series_id, age_rating) VALUES ($1, 18)`, [S.rated]);
  const mk = async (name: string) => (await q(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ($1,$1,'x','user','password') RETURNING id`,
    [name]))[0].id as string;
  reader = await mk('ri-reader');
  someone = await mk('ri-someone');
  // The reader was given the clean and the 18+ libraries, not the other one (they read in it before that changed).
  await q(`INSERT INTO user_libraries (user_id, library_id) VALUES ($1,$2), ($1,$3)`, [reader, CLEAN, ADULT]);

  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/personal')).default);
  await app.ready();
  R.authorization = `Bearer ${app.jwt.sign({ sub: reader, role: 'user' })}`;
});

after(async () => {
  if (!DSN) return;
  await app?.close();
  await wipe();
});

test('stats insights', { skip }, async (t) => {
  const now = Date.now();
  const at = now - 60_000;
  const tenDaysAgo = now - 10 * DAY;
  // Chapter 1 the way the reader reads it: the page before the last already counts as the end, and the last page sends
  // its own -- two completed events, one chapter (#264). Chapter 2 ten days ago.
  await read(reader, S.read, 1, at - 9_000);
  await read(reader, S.read, 1, at);
  await read(reader, S.read, 2, tenDaysAgo);
  await done(reader, S.read, 1);
  await done(reader, S.read, 2);
  for (const s of [S.adult, S.rated, S.other]) { await read(reader, s, 1, at); await done(reader, s, 1); }
  await done(reader, S.incognito, 1);
  await read(someone, S.someone, 1, at);

  await t.test('one row per series the reader has a recorded read in, and only what they may list', async () => {
    // Reintroduce `WHERE true` for browsable() in lib/readingInsights.ts: the 18+ series and the other library's are listed.
    assert.deepEqual(ids(await insights()), [S.read],
      'not the 18+ library, not the series rated 18, not a library they were not given, not one never read, not one kept '
      + 'only by an Incognito read, not someone else\'s');
  });

  await t.test('a hidden 18+ series never appears, until Show 18+ is on', async () => {
    const off = JSON.stringify(await insights());
    for (const s of [S.adult, S.rated]) assert.ok(!off.includes(s) && !off.includes(`Zzz ${s}`), `${s} is named with Show 18+ off`);
    // Show 18+ is a surfacing switch: with it on they are listed, and a library the reader was not given still is not.
    assert.deepEqual(ids(await insights('/api/stats/insights?adult=1')), [S.adult, S.rated, S.read].sort());
  });

  await t.test('the figures: the series\' chapters, what was read, when, and each chapter once', async () => {
    const s = (await insights()).series[0];
    assert.equal(s.title, `Zzz ${S.read}`);
    assert.equal(s.source, 'RI Source');
    assert.deepEqual(s.genres, ['Drama']);
    assert.equal(s.total, 4);
    assert.equal(s.read, 2);
    assert.equal(Date.parse(s.lastReadAt), at);
    // Reintroduce count(*) for `recent`: three, the doubled chapter twice.
    assert.equal(s.recent, 2, 'two chapters in the last four weeks, the doubled one once');
    const monthStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1);
    assert.equal(s.thisMonth + s.prevMonth, 2, 'both chapters fall in this month or the one before');
    assert.equal(s.thisMonth, tenDaysAgo >= monthStart ? 2 : 1);
  });

  await t.test('the best day and week count each chapter once', async () => {
    // Today: the doubled chapter 1, and the three other series' chapter 1 -- four chapters in five completed events.
    // Reintroduce count(*) in the best-day query: five.
    const b = await insights();
    const today = new Date(at).toISOString().slice(0, 10);
    assert.deepEqual(b.bestDay, { day: today, chapters: 4 });
    const d = new Date(`${today}T00:00:00Z`);
    const monday = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * DAY).toISOString().slice(0, 10);
    // Ten days ago is always another week, with one chapter. Reintroduce count(*) in the best-week query: five.
    assert.deepEqual(b.bestWeek, { start: monday, chapters: 4 }, 'a week starts on Monday, and counts each chapter once');
  });

  await t.test('a reader with nothing finished gets nothing, and a stranger gets a 401', async () => {
    const fresh = { authorization: `Bearer ${app.jwt.sign({ sub: someone, role: 'user' })}` };
    await q('DELETE FROM reading_events WHERE user_id = $1', [someone]);
    const r = (await app.inject({ method: 'GET', url: '/api/stats/insights', headers: fresh })).json();
    assert.deepEqual([r.bestDay, r.bestWeek, r.series], [null, null, []]);
    assert.equal((await app.inject({ method: 'GET', url: '/api/stats/insights' })).statusCode, 401);
  });
});
