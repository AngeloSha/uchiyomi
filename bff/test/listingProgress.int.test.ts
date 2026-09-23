// Read marks on chapters this server does not hold (#69, lib/listingProgress): the mark routes, the listing's
// read tick, reconciliation when a marked chapter lands, and the walk the Komga surface and the tracker push
// share.
//
// What is tested here is mostly what must NOT happen, because every one of these is silent:
//   * a mark on a number the sources never listed (the listing is the authorisation, as for a fetch);
//   * a mark writing reading_events (streaks, the leaderboard and Wrapped inflating from a ticked backlog);
//   * one tick past a hole in the listing, or far ahead of the reader, reaching AniList as "read up to here";
//   * a chapter the sweep fetched becoming due for the read-chapter cleanup because somebody had marked it.
//
// The pure walk runs always; everything else is skipped unless TEST_DATABASE_URL is set.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, utimesSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZodError } from 'zod';

const DSN = process.env.TEST_DATABASE_URL;
let ROOT = '';
if (DSN) {
  ROOT = mkdtempSync(join(tmpdir(), 'yomi-lp-'));
  process.env.DL_ROOT = join(ROOT, 'dl');
  process.env.LIBRARY_ROOT = join(ROOT, 'lib');
  process.env.CACHE_DIR = join(ROOT, 'cache');
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
} else {
  // The pure walk below imports the module, which builds a (lazy, never-connected) pool from the env.
  process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused@127.0.0.1:1/none';
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

// ---- the walk, pure -----------------------------------------------------------------------------------------

test('the run: two walks, the max, and the adjacency break', async (t) => {
  const { continuousRun, mergeRun } = await import('../src/lib/listingProgress');
  const real = (ns: number[], completed: boolean | null = true) => ns.map((number) => ({ number, completed }));
  const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
  const run = (r: Array<{ number: number; completed: boolean | null }>, ghosts: number[], marks: number[]) =>
    continuousRun(mergeRun(r, ghosts, new Set(marks)));

  await t.test('with no marks it is exactly the v0.42.0 walk', () => {
    // Real 1..4 and 6..1000 read, 5 a ghost nobody marked: the skip walk reads through it.
    assert.equal(run([...real(range(1, 4)), ...real(range(6, 1000))], [5], []), 1000);
    assert.equal(run(real([1, 2, 4]), [], []), 4, 'a number with no row at all is not a gap in the real rows');
    assert.equal(run([...real([1, 2]), { number: 3, completed: null }, ...real([4])], [], []), 2, 'an unread real chapter breaks it');
  });

  await t.test('a follow-only series read to 5 reports 5', () => {
    // Reintroduce by keeping the skip walk alone (dropping `strict`): this reads 0.
    assert.equal(run([], range(1, 10), range(1, 5)), 5);
  });

  await t.test('a lone tick far ahead reports nothing', () => {
    // ⚠️ The one that would reach AniList. Real 1..10 read, ghosts 11..999 unmarked, ghost 1000 ticked.
    // Reintroduce by merging the walks into one skip-and-extend loop (`if (r.ghost && r.completed !== true)
    // continue`): this reads 1000.
    assert.equal(run(real(range(1, 10)), range(11, 1000), [1000]), 10);
  });

  await t.test('one tick past a hole in the listing reports nothing', () => {
    // ⚠️ Sources list sparsely. Without the adjacency break the strict walk treats "the next listed number"
    // as "the next chapter" and walks straight across the hole. Reintroduce by dropping the `Math.floor`
    // break in continuousRun: B reads 1000, C 951 and D 200.
    assert.equal(run(real(range(1, 12)), [1000], [1000]), 12, 'B: only 1000 is listed above 12');
    assert.equal(run(real(range(1, 12)), range(951, 1000), [951]), 12, 'C: a DMCA hole from 13 to 950');
    assert.equal(run([], range(200, 300), [200]), 0, 'D: a follow-only series whose source starts at 200');
  });

  await t.test('a contiguous run of ticks carries on from the real chapters, fractions included', () => {
    assert.equal(run(real(range(1, 12)), range(13, 200), range(13, 200)), 200);
    assert.equal(run(real(range(1, 12)), [12.5, 13, 14], [12.5, 13]), 13, '12.5 then 13, and 14 unmarked stops it');
    assert.equal(run(real(range(1, 12)), [12.6, 13], [12.6]), 12.6, 'the raw figure; the tracker push floors it to 12');
    assert.equal(run([], [0, 1, 2], [0, 1, 2]), 2, 'a series that starts at chapter 0');
  });
});

// ---- the database half ---------------------------------------------------------------------------------------

const LIB = 'lib_lp';
const S_FOLLOW = 's_lp_follow';   // follow-only: listed 1..10, nothing on disk
const S_MIXED = 's_lp_mixed';     // 1 live, 2 a tombstone, a chapter renumbered 0 -> 105; listed 1..6, 1.1, 2.5, 105, 106
const S_BIG = 's_lp_big';         // follow-only, listed 1..300, for the one-push check
const S_SCAN = 's_lp_scan';       // on disk in the download root, for reconciliation
const SCAN_FOLDER = 'T!lp/Scan Series';
const READER = 'lp-reader', OTHER = 'lp-other', NODL = 'lp-nodl', WALLED = 'lp-walled';

let q: any, app: any;
let persistScan: () => Promise<any>, runCleanupOnce: () => Promise<any>;
let readerId = '', otherId = '';
const tok: Record<string, string> = {};

/** The MAL push, the only tracker call a stub can see (trackers.int.test.ts does the same). */
const pushes: Array<{ url: string; body: string }> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (u: any, init?: any) => {
  const url = String(u);
  if (!/api\.myanimelist\.net/.test(url)) return realFetch(u, init);
  pushes.push({ url, body: String(init?.body ?? '') });
  return new Response(JSON.stringify({ status: 'reading' }), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  ({ persistScan } = (await import('../src/lib/library')) as any);
  ({ runCleanupOnce } = (await import('../src/lib/chapterCleanup')) as any);
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const catalogRoutes = (await import('../src/routes/catalog')).default;
  const personalRoutes = (await import('../src/routes/personal')).default;
  await migrate();

  await q('DELETE FROM users WHERE username = ANY($1)', [[READER, OTHER, NODL, WALLED]]);
  await q(`DELETE FROM lib_series WHERE id LIKE 's_lp_%'`);
  await q(`INSERT INTO libraries (id, name, path) VALUES ($1,'Marks',$1) ON CONFLICT (id) DO NOTHING`, [LIB]);
  const series = (id: string, folder: string) =>
    q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id) VALUES ($1,'T!lp',$1,$2,0,$3)`, [id, folder, LIB]);
  await series(S_FOLLOW, 'T!lp/Follow');
  await series(S_MIXED, 'T!lp/Mixed');
  await series(S_BIG, 'T!lp/Big');
  await series(S_SCAN, SCAN_FOLDER);

  const book = (id: string, sid: string, n: number, root = '/library') =>
    q(`INSERT INTO lib_books (id, series_id, source, file, number, title, root) VALUES ($1,$2,'T!lp',$3,$4,$5,$6)`,
      [id, sid, `${id}.cbz`, n, `Chapter ${n}`, root]);
  await book('b_lp_m1', S_MIXED, 1);
  await book('b_lp_m2', S_MIXED, 2);
  await q(`UPDATE lib_books SET pruned_at = now() WHERE id = 'b_lp_m2'`);
  await book('b_lp_m0', S_MIXED, 0);
  await q(`INSERT INTO book_overrides (book_id, number) VALUES ('b_lp_m0', 105)`);

  const listed = async (sid: string, numbers: number[]) => {
    await q(
      `INSERT INTO series_listing (series_id, number, title, source_id, chosen, status)
       SELECT $1, n, 'Chapter ' || n, 'src', '{}'::jsonb, 'available' FROM unnest($2::real[]) AS n`,
      [sid, numbers],
    );
  };
  const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
  await listed(S_FOLLOW, range(1, 10));
  await listed(S_MIXED, [1, 2, 3, 4, 5, 6, 1.1, 2.5, 105, 106]);
  await listed(S_BIG, range(1, 300));
  await listed(S_SCAN, range(1, 6));

  // The scan series: chapter 1 is on disk (and so the cover, which the cleanup never deletes).
  mkdirSync(join(ROOT, 'dl', SCAN_FOLDER), { recursive: true });
  mkdirSync(join(ROOT, 'lib'), { recursive: true });
  writeFileSync(join(ROOT, 'dl', SCAN_FOLDER, 'Chapter 1.cbz'), 'x'.repeat(100));

  const mk = async (name: string, perms: object = {}) =>
    (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind, perms) VALUES ($1,$1,'x','user','password',$2::jsonb) RETURNING id`,
      [name, JSON.stringify(perms)]))[0].id as string;
  readerId = await mk(READER);
  otherId = await mk(OTHER);
  const nodlId = await mk(NODL, { canDownload: false });
  const walledId = await mk(WALLED);
  // Restricted to no library at all: one row naming the empty id, which no library can have.
  await q('INSERT INTO user_libraries (user_id, library_id) VALUES ($1, $2)', [walledId, '']);

  app = Fastify();
  // Exactly the handler server.ts installs: a .parse() rejection is the client's 400, not a 500.
  app.setErrorHandler((err: any, req: any, reply: any) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: 'bad_request', fields: err.issues.map((i: any) => i.path.join('.')).filter(Boolean) });
    }
    const status = err.statusCode || 500;
    if (status >= 500) console.error('ROUTE 500:', req.url, err?.message);
    return reply.code(status).send({ error: status >= 500 ? 'internal' : err.message || 'error' });
  });
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register(catalogRoutes);
  await app.register(personalRoutes);
  await app.ready();
  const sign = (sub: string) => `Bearer ${app.jwt.sign({ sub, role: 'user' })}`;
  tok.reader = sign(readerId);
  tok.other = sign(otherId);
  tok.nodl = sign(nodlId);
  tok.walled = sign(walledId);
});

after(async () => {
  globalThis.fetch = realFetch;
  if (!DSN) return;
  await app?.close();
  await q(`UPDATE server_settings SET komga_ghost_chapters = false, cleanup_read = false WHERE id = 1`).catch(() => {});
  await q(`DELETE FROM read_progress WHERE series_id LIKE 's_lp_%'`).catch(() => {});
  await q(`DELETE FROM lib_books WHERE series_id LIKE 's_lp_%'`).catch(() => {});
  await q(`DELETE FROM lib_series WHERE id LIKE 's_lp_%'`).catch(() => {});
  await q('DELETE FROM libraries WHERE id = $1', [LIB]).catch(() => {});
  await q('DELETE FROM users WHERE username = ANY($1)', [[READER, OTHER, NODL, WALLED]]).catch(() => {});
  if (ROOT) rmSync(ROOT, { recursive: true, force: true });
});

const mark = (sid: string, numbers: unknown, token = tok.reader, method: 'POST' | 'DELETE' = 'POST') =>
  app.inject({ method, url: `/api/series/${sid}/listing-progress`, headers: { authorization: token }, payload: { numbers } });
const marksOf = async (uid: string, sid: string) =>
  (await q('SELECT number, completed_at, source FROM listing_progress WHERE user_id = $1 AND series_id = $2 ORDER BY number', [uid, sid]))
    .map((r: any) => ({ ...r, number: Number(r.number) }));
const listing = async (sid: string, token = tok.reader) =>
  (await app.inject({ method: 'GET', url: `/api/series/${sid}/listing`, headers: { authorization: token } })).json();

test('a mark on a chapter the server does not hold is a listing mark, and nothing else', { skip }, async () => {
  const r = await mark(S_FOLLOW, [3, 4]);
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json(), { ok: true, marked: 2, viaBook: 0, skipped: [] });
  const m = await marksOf(readerId, S_FOLLOW);
  assert.deepEqual(m.map((x: any) => x.number), [3, 4]);
  assert.ok(m.every((x: any) => x.source === 'web'));
  // ⚠️ No lib_books row is minted (the updater's have-set would then never fetch it) and no read_progress row.
  assert.equal((await q('SELECT count(*)::int n FROM lib_books WHERE series_id = $1', [S_FOLLOW]))[0].n, 0);
  assert.equal((await q('SELECT count(*)::int n FROM read_progress WHERE series_id = $1', [S_FOLLOW]))[0].n, 0);
  // ⚠️ And no reading_events: ticking a backlog is not reading in the app. Reintroduce by inserting an event
  // in markNumbers: this reads 2.
  assert.equal((await q('SELECT count(*)::int n FROM reading_events WHERE user_id = $1', [readerId]))[0].n, 0);
});

test('the listing is the authorisation: an unlisted number is skipped, and a second mark keeps the first time', { skip }, async () => {
  const before = (await marksOf(readerId, S_FOLLOW)).find((x: any) => x.number === 3);
  await new Promise((r) => setTimeout(r, 15));
  const r = await mark(S_FOLLOW, [3, 99]);
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json(), { ok: true, marked: 0, viaBook: 0, skipped: [{ number: 99, reason: 'not_listed' }] });
  const m = await marksOf(readerId, S_FOLLOW);
  assert.deepEqual(m.map((x: any) => x.number), [3, 4], 'nothing written for 99');
  assert.equal(new Date(m[0].completed_at).getTime(), new Date(before.completed_at).getTime(),
    're-ticking does not make an older mark look new');
});

test('a number the library holds is marked on its row, a tombstone included, never as a listing mark', { skip }, async () => {
  const r = await mark(S_MIXED, [1, 2]);
  assert.deepEqual(r.json(), { ok: true, marked: 0, viaBook: 2, skipped: [] });
  const rp = await q('SELECT book_id, completed FROM read_progress WHERE user_id = $1 AND series_id = $2 ORDER BY book_id', [readerId, S_MIXED]);
  assert.deepEqual(rp.map((x: any) => [x.book_id, x.completed]), [['b_lp_m1', true], ['b_lp_m2', true]]);
  assert.deepEqual(await marksOf(readerId, S_MIXED), []);
  // The renumbered chapter is held at 105 (override-aware), so it too is marked on its row.
  const ov = await mark(S_MIXED, [105]);
  assert.deepEqual(ov.json(), { ok: true, marked: 0, viaBook: 1, skipped: [] });
  assert.equal((await q('SELECT count(*)::int n FROM reading_events WHERE user_id = $1', [readerId]))[0].n, 0);
});

test('fractional numbers are marked exactly', { skip }, async () => {
  // real: 1.1 is 1.100000023841858 in float4, and bound as float8 it would miss the listing row.
  const r = await mark(S_MIXED, [1.1, 2.5]);
  assert.deepEqual(r.json(), { ok: true, marked: 2, viaBook: 0, skipped: [] });
  assert.deepEqual((await marksOf(readerId, S_MIXED)).map((x: any) => x.number), [1.1, 2.5]);
  const l = await listing(S_MIXED);
  const read = l.content.filter((g: any) => g.read).map((g: any) => g.number);
  assert.deepEqual(read, [1.1, 2.5]);
});

test('the listing draws the tick for the reader who marked it, and for nobody else', { skip }, async () => {
  const mine = await listing(S_FOLLOW);
  assert.deepEqual(mine.content.filter((g: any) => g.read === true).map((g: any) => g.number), [3, 4]);
  const theirs = await listing(S_FOLLOW, tok.other);
  assert.equal(theirs.content.length, 10);
  assert.ok(theirs.content.every((g: any) => !('read' in g)), 'absent, not false, for someone with no marks');
});

test('a renumbered chapter is not a ghost on the series page', { skip }, async () => {
  // ⚠️ b_lp_m0's filename gave 0 and an admin corrected it to 105. The anti-join used to compare the raw
  // number, so 105 was a ghost here and a real row on the Komga surface -- and once rows carry read state
  // the two disagree about whether it was read. Reintroduce by comparing `b.number = l.number` in listingFor:
  // 105 comes back.
  const l = await listing(S_MIXED);
  const nums = l.content.map((g: any) => g.number);
  assert.ok(!nums.includes(105), `105 is on disk under its corrected number: ${nums}`);
  assert.ok(nums.includes(106));
  assert.ok(!nums.includes(1) && !nums.includes(2), 'a live chapter and a tombstone are never ghosts');
});

test('un-marking deletes the mark, even one on a number the listing no longer has', { skip }, async () => {
  const r = await mark(S_FOLLOW, [3], tok.reader, 'DELETE');
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json(), { ok: true, unmarked: 1, viaBook: 0 });
  assert.deepEqual((await marksOf(readerId, S_FOLLOW)).map((x: any) => x.number), [4]);
  // A mark can outlive its listing row (the sweep rewrites the listing whole). It must stay clearable.
  await q(`INSERT INTO listing_progress (user_id, series_id, number) VALUES ($1, $2, 50)`, [readerId, S_FOLLOW]);
  const stale = await mark(S_FOLLOW, [50], tok.reader, 'DELETE');
  assert.deepEqual(stale.json(), { ok: true, unmarked: 1, viaBook: 0 });
});

test('a mark request is bounded, gated on the series, and not on the download permission', { skip }, async () => {
  const many = Array.from({ length: 501 }, (_, i) => i + 1);
  // Reintroduce by dropping `.max(LISTING_MARK_MAX)`: 501 numbers reads 200.
  assert.equal((await mark(S_BIG, many)).statusCode, 400, 'more than 500 numbers');
  // Reintroduce by dropping `.max(1e6)`: 1e40 overflows real and Postgres answers 22003, a 500.
  assert.equal((await mark(S_BIG, [1e40])).statusCode, 400, 'past float4 range');
  assert.equal((await mark(S_BIG, [1e7])).statusCode, 400, 'past a million');
  assert.equal((await mark(S_BIG, [-1])).statusCode, 400);
  assert.equal((await mark(S_BIG, [])).statusCode, 400);
  assert.equal((await mark(S_BIG, 'all')).statusCode, 400);
  // A series this viewer cannot open is 404 for both verbs, so a walled-off member cannot probe its listing.
  assert.equal((await mark(S_FOLLOW, [5], tok.walled)).statusCode, 404);
  assert.equal((await mark(S_FOLLOW, [5], tok.walled, 'DELETE')).statusCode, 404);
  assert.equal((await mark('s_lp_nope', [5])).statusCode, 404);
  // A member who may not download may still keep track: marking costs no bytes.
  const nodl = await mark(S_FOLLOW, [5], tok.nodl);
  assert.equal(nodl.statusCode, 200);
  assert.equal(nodl.json().marked, 1);
});

test('a 300-number mark queues exactly one tracker push and no reading events', { skip }, async () => {
  const trackers = await import('../src/lib/trackers');
  await q(`UPDATE server_settings SET komga_ghost_chapters = true WHERE id = 1`);
  try {
    await trackers.saveConnection(readerId, 'myanimelist', 'tok-mal', 'me', new Date(Date.now() + 86_400_000));
    await trackers.linkSeries(S_BIG, '4242', 'Big', readerId, 'myanimelist');
    pushes.length = 0;
    const numbers = Array.from({ length: 300 }, (_, i) => i + 1);
    const r = await mark(S_BIG, numbers);
    assert.deepEqual(r.json(), { ok: true, marked: 300, viaBook: 0, skipped: [] });
    for (let i = 0; i < 60 && pushes.length < 1; i++) await new Promise((res) => setTimeout(res, 50));
    await new Promise((res) => setTimeout(res, 300));
    // Reintroduce by pushing per number (writeProgress per mark): this reads 300 pushes, a burst at AniList.
    assert.equal(pushes.length, 1, 'one push for the whole request');
    assert.match(pushes[0].body, /num_chapters_read=300/, 'the contiguous run 1..300');
    assert.equal((await q('SELECT count(*)::int n FROM reading_events WHERE series_id = $1', [S_BIG]))[0].n, 0);
    // Marking the same numbers again changes nothing and pushes nothing.
    pushes.length = 0;
    await mark(S_BIG, numbers);
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(pushes.length, 0, 'an idempotent re-mark is not news');
  } finally {
    await q(`UPDATE server_settings SET komga_ghost_chapters = false WHERE id = 1`);
    await q(`DELETE FROM user_trackers WHERE user_id = $1`, [readerId]);
    await q(`DELETE FROM series_trackers WHERE series_id = $1`, [S_BIG]);
    await q(`DELETE FROM tracker_progress WHERE user_id = $1`, [readerId]);
  }
});

test('with the ghost switch off, a mark sends nothing to a tracker', { skip }, async () => {
  // With komga_ghost_chapters off (the default) seriesProgressFor ignores marks, so a push for a new mark
  // could only repeat the number already sent -- outbound traffic v0.42.0 never made. Reintroduce by pushing
  // on `marked` regardless of the switch in the POST route: "a new mark with the switch off is not news"
  // sees one push, of the real 105.
  const trackers = await import('../src/lib/trackers');
  try {
    await trackers.saveConnection(readerId, 'myanimelist', 'tok-mal', 'me', new Date(Date.now() + 86_400_000));
    await trackers.linkSeries(S_MIXED, '4343', 'Mixed', readerId, 'myanimelist');
    pushes.length = 0;
    const r = await mark(S_MIXED, [3]);
    assert.deepEqual(r.json(), { ok: true, marked: 1, viaBook: 0, skipped: [] });
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(pushes.length, 0, 'a new mark with the switch off is not news to a tracker');
    // The control, so the silence above is the rule and not a deaf stub: a number marked on its own chapter
    // row is ordinary progress and pushes whatever the switch says.
    await mark(S_MIXED, [1], tok.reader, 'DELETE');
    assert.equal(pushes.length, 0, 'an un-mark pushes nothing');
    await mark(S_MIXED, [1]);
    for (let i = 0; i < 60 && pushes.length < 1; i++) await new Promise((res) => setTimeout(res, 50));
    assert.equal(pushes.length, 1, 'a chapter row marked read still pushes');
    assert.match(pushes[0].body, /num_chapters_read=105/, 'the real MAX, the renumbered 105');
  } finally {
    await q(`DELETE FROM user_trackers WHERE user_id = $1`, [readerId]);
    await q(`DELETE FROM series_trackers WHERE series_id = $1`, [S_MIXED]);
    await q(`DELETE FROM tracker_progress WHERE user_id = $1`, [readerId]);
  }
});

test('bulk mark-unread clears the read marks too', { skip }, async () => {
  // Reintroduce by dropping the listing_progress DELETE in the bulk unread branch: the marks stay.
  assert.ok((await marksOf(readerId, S_BIG)).length > 0);
  const r = await app.inject({ method: 'POST', url: '/api/library/bulk/read', headers: { authorization: tok.reader },
    payload: { seriesIds: [S_BIG], completed: false } });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(await marksOf(readerId, S_BIG), []);
  // ...and only the caller's: another reader's marks on the same series are theirs.
  await mark(S_FOLLOW, [7], tok.other);
  await app.inject({ method: 'POST', url: '/api/library/bulk/read', headers: { authorization: tok.reader },
    payload: { seriesIds: [S_FOLLOW], completed: false } });
  assert.deepEqual((await marksOf(otherId, S_FOLLOW)).map((x: any) => x.number), [7]);
});

// ---- reconciliation -------------------------------------------------------------------------------------------

test('a marked chapter that lands becomes read on its row, stamped with the mark, and the cleanup leaves it', { skip }, async () => {
  const dir = join(ROOT, 'dl', SCAN_FOLDER);
  // The mark, made two days ago; then the sweep fetches chapter 5 today.
  await mark(S_SCAN, [5]);
  await q(`UPDATE listing_progress SET completed_at = now() - interval '2 days' WHERE user_id = $1 AND series_id = $2 AND number = 5`,
    [readerId, S_SCAN]);
  const [{ at: markedAt }] = await q(`SELECT completed_at AS at FROM listing_progress WHERE user_id = $1 AND series_id = $2 AND number = 5`,
    [readerId, S_SCAN]);
  writeFileSync(join(dir, 'Chapter 5.cbz'), 'x'.repeat(100));

  await persistScan();

  const row = (await q(`SELECT b.id, rp.completed, rp.updated_at FROM lib_books b
                          JOIN read_progress rp ON rp.book_id = b.id AND rp.user_id = $1
                         WHERE b.series_id = $2 AND b.number = 5`, [readerId, S_SCAN]))[0];
  assert.ok(row, 'the mark became a read_progress row on the chapter that landed');
  assert.equal(row.completed, true);
  assert.equal(new Date(row.updated_at).getTime(), new Date(markedAt).getTime(), 'the MARK\'s time, not now()');
  assert.deepEqual(await marksOf(readerId, S_SCAN), [], 'and the mark is gone');
  assert.equal((await q('SELECT count(*)::int n FROM reading_events WHERE series_id = $1', [S_SCAN]))[0].n, 0);

  // ⚠️ THE ONE THAT MATTERS. The cleanup at 0 days runs right after: stamped now(), the chapter would read as
  // "finished after it landed" and be deleted -- then held as a tombstone, never fetched again. Reintroduce by
  // stamping now() in reconcileListingProgress: the file is gone.
  await q(`UPDATE server_settings SET cleanup_read = true, cleanup_read_days = 0 WHERE id = 1`);
  try {
    await runCleanupOnce();
    assert.ok(existsSync(join(dir, 'Chapter 5.cbz')), 'the fetched file is still there');
  } finally {
    await q(`UPDATE server_settings SET cleanup_read = false WHERE id = 1`);
  }
});

test('a mark made after the file landed still does not make it cleanup-due', { skip }, async () => {
  // persistScan runs once at the END of a sweep, so a chapter can sit on disk while the page still draws it
  // as a ghost -- and a tick in that window postdates the file. Reintroduce by carrying lp.completed_at
  // unclamped in reconcileListingProgress: the updated_at is after the mtime and the file is deleted.
  const dir = join(ROOT, 'dl', SCAN_FOLDER);
  const file = join(dir, 'Chapter 6.cbz');
  writeFileSync(file, 'x'.repeat(100));
  const hourAgo = new Date(Date.now() - 3_600_000);
  utimesSync(file, hourAgo, hourAgo);
  const r = await mark(S_SCAN, [6]);
  assert.equal(r.json().marked, 1, 'no row yet, so it is still a ghost and still markable');

  await persistScan();

  const row = (await q(`SELECT rp.updated_at, b.mtime FROM lib_books b
                          JOIN read_progress rp ON rp.book_id = b.id AND rp.user_id = $1
                         WHERE b.series_id = $2 AND b.number = 6`, [readerId, S_SCAN]))[0];
  assert.ok(row);
  assert.ok(new Date(row.updated_at).getTime() < Number(row.mtime), 'stamped strictly before the file');
  assert.equal(Number(row.mtime), Math.floor(statSync(file).mtimeMs));
  await q(`UPDATE server_settings SET cleanup_read = true, cleanup_read_days = 0 WHERE id = 1`);
  try {
    await runCleanupOnce();
    assert.ok(existsSync(file), 'the fetched file is still there');
  } finally {
    await q(`UPDATE server_settings SET cleanup_read = false WHERE id = 1`);
  }
});

test('a mark reconciled onto a chapter the reader had started leaves the file', { skip }, async () => {
  // A merge can carry a mark onto a chapter the survivor holds, and a scan whose reconcile failed can leave
  // a mark beside a chapter the reader then opened: either way reconciliation meets an UNFINISHED row whose
  // updated_at is after the file landed. Flipped to completed while keeping that time, the chapter is due at
  // once and is deleted out from under someone partway through it. Reintroduce by GREATEST in
  // reconcileListingProgress's conflict branch: "stamped before the file" and then the file both fail.
  const { reconcileListingProgress } = await import('../src/lib/listingProgress');
  const file = join(ROOT, 'dl', SCAN_FOLDER, 'Chapter 3.cbz');
  writeFileSync(file, 'x'.repeat(100));
  const hourAgo = new Date(Date.now() - 3_600_000);
  utimesSync(file, hourAgo, hourAgo);
  await persistScan();
  const [b] = await q(`SELECT id, mtime FROM lib_books WHERE series_id = $1 AND number = 3`, [S_SCAN]);
  assert.ok(b, 'the scan minted chapter 3');
  // They opened it after it landed and are on page 2 ...
  await q(`INSERT INTO read_progress (user_id, book_id, series_id, page, completed, updated_at) VALUES ($1,$2,$3,2,false,now())`,
    [readerId, b.id, S_SCAN]);
  // ... beside a mark from two days ago that no reconcile has consumed.
  await q(`INSERT INTO listing_progress (user_id, series_id, number, completed_at) VALUES ($1,$2,3, now() - interval '2 days')`,
    [readerId, S_SCAN]);
  await reconcileListingProgress();
  const [rp] = await q(`SELECT completed, updated_at FROM read_progress WHERE user_id = $1 AND book_id = $2`, [readerId, b.id]);
  assert.equal(rp.completed, true, 'the mark still means read');
  assert.ok(new Date(rp.updated_at).getTime() < Number(b.mtime), 'stamped before the file');
  assert.deepEqual((await marksOf(readerId, S_SCAN)).filter((x: any) => x.number === 3), [], 'and the mark is gone');
  await q(`UPDATE server_settings SET cleanup_read = true, cleanup_read_days = 0 WHERE id = 1`);
  try {
    await runCleanupOnce();
    assert.ok(existsSync(file), 'the chapter they were partway through is still there');
  } finally {
    await q(`UPDATE server_settings SET cleanup_read = false WHERE id = 1`);
  }
});

test('reconciliation matches the override-aware number', { skip }, async () => {
  // A chapter whose filename said 0 and that an admin renumbered to 4: a mark on 4 belongs to it.
  const dir = join(ROOT, 'dl', SCAN_FOLDER);
  await mark(S_SCAN, [4]);
  writeFileSync(join(dir, 'Extra.cbz'), 'x'.repeat(100));
  await persistScan();
  const extra = (await q(`SELECT id FROM lib_books WHERE series_id = $1 AND file LIKE '%Extra.cbz'`, [S_SCAN]))[0];
  assert.ok(extra, 'the scan minted a row for it');
  assert.deepEqual((await marksOf(readerId, S_SCAN)).map((x: any) => x.number), [4], 'at number 0 it is not chapter 4 yet');
  await q(`INSERT INTO book_overrides (book_id, number) VALUES ($1, 4)`, [extra.id]);
  await persistScan();
  // Reintroduce by matching `b.number = lp.number` in reconcileListingProgress: the mark stays a mark.
  assert.deepEqual(await marksOf(readerId, S_SCAN), []);
  const rp = await q(`SELECT completed FROM read_progress WHERE user_id = $1 AND book_id = $2`, [readerId, extra.id]);
  assert.equal(rp[0]?.completed, true);
});
