// Incognito reading (v0.61.0, lib/incognito.ts): the place is kept, and nothing else.
//
// The owner's ruling: it covers the WHOLE account, enforced on the server. So these go through the real routes -- the
// app's progress PUT, Mihon's read-progress PUT, the settings PUT -- and watch the two things it must stop: a
// reading_events row (history, streaks, Wrapped, the boards and Top 10 all read that table) and a tracker push, which
// the fetch stub below counts. A push is fire-and-forget, so a control case first proves one lands within the wait.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ZodError } from 'zod';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const LIB = 'lib_inc', SERIES = 's_inc', USER = 'inc-reader';
const book = (n: number) => `b_inc_${n}`;

// MyAnimeList stands in for every tracker: its push is a PATCH the stub can see (as in trackers.int.test.ts).
const pushes: string[] = [];
const realFetch = globalThis.fetch;

let q: any, app: any, uid = '', token = '', writeProgress: any;
const H = () => ({ authorization: `Bearer ${app.jwt.sign({ sub: uid, role: 'user' })}` });

const events = async () => (await q('SELECT count(*)::int AS n FROM reading_events WHERE user_id = $1', [uid]))[0].n as number;
const progressOf = async (n: number) =>
  (await q('SELECT page, completed FROM read_progress WHERE user_id = $1 AND book_id = $2', [uid, book(n)]))[0] ?? null;
/** Waits for the push count to reach `n`, up to `ms`; answers the count it saw. */
const pushedBy = async (n: number, ms = 3000) => {
  const end = Date.now() + ms;
  while (pushes.length < n && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  return pushes.length;
};
const finish = (n: number, extra: Record<string, unknown> = {}) =>
  app.inject({ method: 'PUT', url: `/api/books/${book(n)}/progress`, headers: H(), payload: { page: 9, completed: true, ...extra } });
const setIncognito = async (on: unknown) => app.inject({ method: 'PUT', url: '/api/settings', headers: H(), payload: { incognito: on } });

before(async () => {
  if (!DSN) return;
  globalThis.fetch = (async (u: any, init?: any) => {
    const url = String(u);
    if (!/api\.myanimelist\.net/.test(url)) return realFetch(u, init);
    const answer = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
    // Since v0.61.2 (#201) a push reads the series first: a GET, answered as a series still coming out and not on the
    // list. Only the write is a push.
    if (String(init?.method ?? 'GET') === 'GET') return answer({ status: 'currently_publishing', num_chapters: 0 });
    pushes.push(String(init?.body ?? ''));
    return answer({ status: 'reading' });
  }) as typeof fetch;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  ({ writeProgress } = (await import('../src/lib/progress')) as any);
  const trackers = await import('../src/lib/trackers');
  const auth = await import('../src/lib/auth');
  await migrate();
  await q('DELETE FROM users WHERE username = $1', [USER]);
  await q('DELETE FROM lib_series WHERE id = $1', [SERIES]);
  await q(`INSERT INTO libraries (id, name, path) VALUES ($1,'Inc','/inc') ON CONFLICT (id) DO NOTHING`, [LIB]);
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id) VALUES ($1,'T!inc','Inc Series',$1,4,$2)`, [SERIES, LIB]);
  for (let n = 1; n <= 4; n++) {
    await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, root, pages) VALUES ($1,$2,'T!inc',$3,$4,$5,'/library',10)`,
      [book(n), SERIES, `T!inc/${SERIES}/ch${n}.cbz`, n, `Chapter ${n}`]);
  }
  uid = (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ($1,$1,'x','user','password') RETURNING id`, [USER]))[0].id;
  await trackers.saveConnection(uid, 'myanimelist', 'tok-mal', 'me-on-mal', new Date(Date.now() + 86_400_000));
  await trackers.linkSeries(SERIES, '777', 'Inc Series', uid, 'myanimelist');
  token = (await auth.issueApiToken(uid, 'inc', ['read', 'write'], null)).token;

  const Fastify = (await import('fastify')).default;
  app = Fastify();
  await app.register((await import('@fastify/cookie')).default);
  await app.register((await import('@fastify/jwt')).default, { secret: process.env.JWT_SECRET! });
  app.setErrorHandler((err: any, _req: any, reply: any) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: 'bad_request' });
    return reply.code(err.statusCode || 500).send({ error: err.message || 'error' });
  });
  await app.register((await import('@fastify/rate-limit')).default, { global: false });
  await app.register((await import('../src/routes/catalog')).default);
  await app.register((await import('../src/routes/personal')).default);
  await app.register((await import('../src/routes/komgaCompat')).default);
  await app.ready();
});

after(async () => {
  globalThis.fetch = realFetch;
  if (!DSN) return;
  await app?.close();
  await q('DELETE FROM read_progress WHERE series_id = $1', [SERIES]).catch(() => {});
  await q('DELETE FROM users WHERE username = $1', [USER]).catch(() => {});
  await q('DELETE FROM lib_books WHERE series_id = $1', [SERIES]).catch(() => {});
  await q('DELETE FROM lib_series WHERE id = $1', [SERIES]).catch(() => {});
  await q('DELETE FROM libraries WHERE id = $1', [LIB]).catch(() => {});
});

test('Incognito reading, through the routes', { skip }, async (t) => {
  await t.test('with it off, finishing a chapter records it and tells the tracker (the control)', async () => {
    const r = await finish(1);
    assert.equal(r.statusCode, 200, r.payload);
    assert.equal(await events(), 1);
    assert.equal(await pushedBy(1), 1, 'the push lands within the wait, so the waits below mean something');
    assert.match(pushes[0], /num_chapters_read=1/);
  });

  await t.test('Incognito must be on or off', async () => {
    // Reintroduce by accepting anything for `incognito` in PUT /api/settings: "yes" is saved and this reads 200.
    const bad = await setIncognito('yes');
    assert.equal(bad.statusCode, 400, bad.payload);
    assert.equal(bad.json().error, 'bad_settings');
    const saved = (await app.inject({ method: 'GET', url: '/api/settings', headers: H() })).json();
    assert.equal(saved.incognito, undefined, 'nothing was stored');
  });

  await t.test('an incognito chapter keeps its place and leaves no trace: the switch alone', async () => {
    assert.equal((await setIncognito(true)).statusCode, 200);
    const r = await finish(2); // the request says nothing about it: the server reads the switch
    assert.equal(r.statusCode, 200, r.payload);
    assert.deepEqual(await progressOf(2), { page: 9, completed: true }, 'Keep reading and resuming still work');
    // Reintroduce by writing the reading event regardless of `incognito` in writeProgress: this reads 2.
    assert.equal(await events(), 1, 'no reading event');
    assert.equal(await pushedBy(2, 1500), 1, 'no tracker push');
  });

  await t.test("the request's own flag is enough: a chapter read while it was on, sent after it went off", async () => {
    assert.equal((await setIncognito(false)).statusCode, 200);
    const r = await finish(3, { incognito: true });
    assert.equal(r.statusCode, 200, r.payload);
    assert.deepEqual(await progressOf(3), { page: 9, completed: true });
    // Reintroduce by dropping `w.incognito === true ||` in writeProgress: the event is written, the push sent.
    assert.equal(await events(), 1, 'no reading event');
    assert.equal(await pushedBy(2, 1500), 1, 'no tracker push');
  });

  await t.test("a Mihon read-progress PUT pushes nothing under Incognito", async () => {
    assert.equal((await setIncognito(true)).statusCode, 200);
    const r = await app.inject({ method: 'PUT', url: `/api/v2/series/${SERIES}/read-progress/tachiyomi`, headers: { 'x-api-key': token },
      payload: { lastBookNumberSortRead: 4 } });
    assert.equal(r.statusCode, 204, r.payload);
    assert.equal((await progressOf(4))?.completed, true, 'the phone\'s progress is kept');
    // Reintroduce by pushing in pushSeriesProgressAsync without asking incognitoOn: chapter 4 reaches the tracker.
    assert.equal(await pushedBy(2, 1500), 1, 'no tracker push');
    assert.equal(await events(), 1);
  });

  await t.test('a deliberate resync still pushes: the person asked for it', async () => {
    const r = await app.inject({ method: 'POST', url: `/api/trackers/myanimelist/resync/${SERIES}`, headers: H() });
    assert.equal(r.statusCode, 200, r.payload);
    assert.equal(await pushedBy(2), 2);
    assert.match(pushes[1], /num_chapters_read=4/, 'and it catches the tracker up to the real count');
  });

  await t.test('a failed read of the switch is treated as on', async () => {
    // Reintroduce by answering false from incognitoOn's catch: the event below is written.
    assert.equal((await setIncognito(false)).statusCode, 200);
    await q('ALTER TABLE app_settings RENAME TO app_settings_inc_gone');
    try {
      await writeProgress({ userId: uid, bookId: book(1), seriesId: SERIES, page: 3, completed: false });
    } finally {
      await q('ALTER TABLE app_settings_inc_gone RENAME TO app_settings');
    }
    assert.equal(await events(), 1, 'no event while the switch could not be read');
    // ...and with it readable again (and off), reading is recorded as ever.
    await writeProgress({ userId: uid, bookId: book(1), seriesId: SERIES, page: 4, completed: false });
    assert.equal(await events(), 2);
  });
});
