// Posting-order numbering, applied (#116, lib/numbering.ts): the listing layer, the stored assignment, and the
// renumber of a series already in a library -- held until an admin confirms, then applied in place with its book
// ids, progress and marks kept, finished after a crash, and undone without losing a file.
//
// The shapes are Istrevelia's: 226 posts that the Webtoons extension's rule puts on 13 numbers. The first test
// drives the real Suwayomi adapter against the fake engine; the rest use a plain adapter serving the same posts
// the same way (sourceOrder as `order`, the extension's " (ch. N)" names), because they download pages.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeSuwayomi, istreveliaPosts, webtoonsNumbers, SOURCE_IDS, type FakeSuwayomi } from './fixtures/fakeSuwayomi';

const DSN = process.env.TEST_DATABASE_URL;
let ROOT = '';
let DL = '';
if (DSN) {
  ROOT = mkdtempSync(join(tmpdir(), 'uchiyomi-nb-'));
  DL = join(ROOT, 'dl');
  mkdirSync(DL, { recursive: true });
  process.env.DL_ROOT = DL;
  process.env.LIBRARY_ROOT = join(ROOT, 'lib');
  process.env.CACHE_DIR = join(ROOT, 'cache');
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.MIN_FREE_GB = '0';
  process.env.DOWNLOAD_MIN_GAP_MS = '0';
  process.env.DOWNLOAD_PAGE_GAP_MS = '0';
  process.env.UPDATER_LIST_TIMEOUT_MS = '5000';
  process.env.UCHIYOMI_PING_URL = '';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const LIB = 'lib_nb';
const WEB = 'nb-web', FOL = 'nb-fol';
const S = 's_nb_held', FOLDER = 'Webtoons (test)/Istrevelia Held';
const S2 = 's_nb_crash1', FOLDER2 = 'Webtoons (test)/Istrevelia Crash One';
const S3 = 's_nb_crash2', FOLDER3 = 'Webtoons (test)/Istrevelia Crash Two';
const S4 = 's_nb_follow', FOLDER4 = 'Webtoons (test)/Istrevelia Followed';
const S5 = 's_nb_override', FOLDER5 = 'Webtoons (test)/Istrevelia Read Only';
const ALL = [S, S2, S3, S4, S5];
/** How many times the follower was asked for its chapter list. */
let folAsked = 0;
const PIXEL = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(400, 7)]);
const realFetch = globalThis.fetch;

let q: any, app: any, lib: any, numbering: any, updater: any, token = '', adminId = '';
let fake: FakeSuwayomi | null = null;

// The posts, oldest first, numbered by the extension's rule: 226 posts, 13 numbers.
const POSTS = DSN ? istreveliaPosts() : [];
const NUMS = DSN ? webtoonsNumbers(POSTS, false) : [];
/** Post k (1-based, posting order) as the Suwayomi adapter hands it over. */
const post = (k: number) => ({
  sourceId: `ist-${k}`, number: NUMS[k - 1].chapterNumber, title: NUMS[k - 1].name,
  publishedAt: new Date(POSTS[k - 1].uploadDate).toISOString(), order: k, url: POSTS[k - 1].url, pages: 1,
});
const listing = () => POSTS.map((_: unknown, i: number) => post(i + 1)).sort((a: any, b: any) => a.number - b.number || a.order - b.order);

/** The books a v0.48 install holds: raw number -> the post whose file it is (the 46th is the FIFTH post of 3). */
const HELD: Array<[number, number]> = [[1, 1], [2, 21], [3, 46], [5, 85], [6, 110], [7, 138], [8, 212]];

before(async () => {
  if (!DSN) return;
  // Pages from the test sources; nothing else leaves the machine (the add's AniList art call gets a 404 at once).
  globalThis.fetch = (async (u: any) =>
    String(u).includes('example.invalid') ? new Response(PIXEL, { status: 200, headers: { 'content-type': 'image/png' } }) : new Response('', { status: 404 })) as typeof fetch;
  fake = await startFakeSuwayomi();
  process.env.SUWAYOMI_URL = fake.url;
  const { migrate } = await import('../src/lib/migrate');
  await migrate();
  ({ q } = (await import('../src/lib/db')) as any);
  lib = await import('../src/lib/library');
  numbering = await import('../src/lib/numbering');
  updater = await import('../src/lib/updater');
  const { registerAdapter } = await import('../src/lib/sources');
  const { makeSuwayomiAdapter } = await import('../src/lib/sources/suwayomi/sources');
  // The real adapter over the fake engine, in process: the product's own query strings against the pinned schema.
  const run = (async (query: string, variables: Record<string, unknown> = {}) => {
    const r = await fake!.query(query, variables);
    if (r.errors?.length) throw new Error(`suwayomi: ${r.errors[0].message}`);
    return r.data;
  }) as any;
  registerAdapter(makeSuwayomiAdapter({ id: SOURCE_IDS.webtoons, name: 'Webtoons.com', lang: 'en', supportsLatest: false }, run));
  registerAdapter({
    id: WEB, name: 'Webtoons (test)',
    async search() { return []; },
    async getSeries(sid: string) { return { sourceId: sid, source: WEB, title: 'Istrevelia' }; },
    async listChapters() { return listing(); },
    async getPageUrls(id: string) { return [`https://example.invalid/${encodeURIComponent(id)}/p1.png`]; },
    async latest() { return []; },
  } as any);
  registerAdapter({
    id: FOL, name: 'Follower (test)',
    async search() { return []; },
    async getSeries(sid: string) { return { sourceId: sid, source: FOL, title: 'Istrevelia' }; },
    async listChapters() { folAsked++; return Array.from({ length: 20 }, (_, i) => ({ sourceId: `fol-${i + 1}`, number: i + 1, title: `Chapter ${i + 1}` })); },
    async getPageUrls(id: string) { return [`https://example.invalid/${encodeURIComponent(id)}/p1.png`]; },
    async latest() { return []; },
  } as any);
  await q('DELETE FROM source_health WHERE source_id = ANY($1)', [[WEB, FOL, `sw:${SOURCE_IDS.webtoons}`]]);
  await q(`INSERT INTO libraries (id, name, path) VALUES ($1,'Numbered',$1) ON CONFLICT (id) DO NOTHING`, [LIB]);
  await q('DELETE FROM lib_series WHERE id = ANY($1) OR folder = $2', [ALL, 'Webtoons.com/Istrevelia']);
  await q('DELETE FROM download_log WHERE folder = $1', [FOLDER]);

  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/sources')).default);
  await app.ready();
  await q(`DELETE FROM users WHERE username = 'nb-admin'`);
  adminId = (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind)
                      VALUES ('nb-admin','nb-admin','x','admin','password') RETURNING id`))[0].id;
  token = `Bearer ${app.jwt.sign({ sub: adminId, role: 'admin' })}`;
});

after(async () => {
  globalThis.fetch = realFetch;
  if (!DSN) return;
  numbering.renumberHooks.afterFirstPhase = undefined;
  numbering.renumberHooks.afterSecondPhase = undefined;
  await app?.close();
  await fake?.close();
  await q('DELETE FROM lib_series WHERE id = ANY($1) OR folder = $2', [ALL, 'Webtoons.com/Istrevelia']).catch(() => {});
  await q('DELETE FROM download_log WHERE folder = $1', [FOLDER]).catch(() => {});
  await q('DELETE FROM libraries WHERE id = $1', [LIB]).catch(() => {});
  await q(`DELETE FROM users WHERE username = 'nb-admin'`).catch(() => {});
  rmSync(ROOT, { recursive: true, force: true });
});

/** A series row routed to the test source, with nothing decided about its numbering. */
async function seedSeries(id: string, folder: string, extra: Record<string, unknown> = {}) {
  const cols = ['id', 'source', 'title', 'folder', 'books_count', 'library_id', 'source_id', 'source_series_id', 'auto_update', ...Object.keys(extra)];
  const vals = [id, 'Webtoons (test)', 'Istrevelia', folder, 0, LIB, WEB, 'istrevelia', true, ...Object.values(extra)];
  await q(`INSERT INTO lib_series (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`, vals);
}
/** A v0.48 chapter on disk: `Chapter <raw>.cbz` holding post k, named as setBookMeta named it. */
async function seedBook(series: string, folder: string, raw: number, k: number) {
  mkdirSync(join(DL, folder), { recursive: true });
  writeFileSync(join(DL, folder, `Chapter ${raw}.cbz`), 'x'.repeat(100));
  const { chapterName } = await import('../src/lib/naming');
  await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, root, chapter_name, source_id)
           VALUES ($1,$2,'Webtoons (test)',$3,$4,$5,$6,$7,$8)`,
    [`${series}_b${raw}`, series, `${folder}/Chapter ${raw}.cbz`, raw, `Chapter ${raw}`, DL, chapterName(post(k).title, post(k).number), WEB]);
}
const booksOf = async (series: string) =>
  new Map<string, { number: number; file: string }>((await q('SELECT id, number::float8 AS number, file FROM lib_books WHERE series_id = $1', [series]))
    .map((r: any) => [r.id, { number: Number(r.number), file: r.file }]));
const filesIn = (folder: string) => readdirSync(join(DL, folder)).sort();

test('a Webtoons-shaped add is numbered by posting order', { skip }, async () => {
  const source = `sw:${SOURCE_IDS.webtoons}`;
  const sourceId = String(fake!.manga('Istrevelia').id);
  // Reintroduce by counting the raw list in GET /api/sources/detail: 13 chapters, 1-8.
  const d = await app.inject({ method: 'GET', url: `/api/sources/detail?source=${encodeURIComponent(source)}&sourceId=${sourceId}`, headers: { authorization: token } });
  assert.equal(d.statusCode, 200, d.body);
  const detail = d.json();
  assert.deepEqual({ count: detail.count, first: detail.first, last: detail.last }, { count: 226, first: 1, last: 226 }, 'the dialog counts posts, not numbers');
  assert.equal(detail.numbering.applied, 'posting_order');
  assert.equal(detail.numbering.verdict, 'strong');
  assert.deepEqual(detail.numbering.alt, { count: 13, first: 1, last: 8 }, 'the source\'s own reading, for the switch');
  assert.deepEqual(detail.numbering.biggest, { number: 7, posts: 73 });
  assert.equal(detail.numbering.extSourceId, SOURCE_IDS.webtoons, 'the settings deep link');

  // Reintroduce by numbering nothing in addSeriesFromSource (`const chapters = listed`): 13 listing rows.
  const r = await app.inject({ method: 'POST', url: '/api/sources/add', headers: { authorization: token }, payload: { source, sourceId, chapterFrom: 'none' } });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().nothing, true);
  const id = r.json().seriesId;
  const row = (await q('SELECT numbering, numbering_by, numbering_source, numbering_pending, numbering_note, chapter_floor::float8 AS floor FROM lib_series WHERE id = $1', [id]))[0];
  assert.deepEqual([row.numbering, row.numbering_by, row.numbering_source, row.numbering_pending], ['posting_order', 'auto', source, null]);
  assert.equal(row.numbering_note.verdict, 'strong');
  assert.equal(Math.round(Number(row.floor) * 1000) / 1000, 226.001, 'Nothing yet floors above the last POST');
  const l = await q('SELECT number::float8 AS n, copies FROM series_listing WHERE series_id = $1 ORDER BY number', [id]);
  assert.equal(l.length, 226, 'one listing row per post');
  assert.deepEqual(l.map((x: any) => Number(x.n)), Array.from({ length: 226 }, (_, i) => i + 1));
  assert.ok(l.every((x: any) => x.copies.length === 1), `no post is a version of another: ${JSON.stringify(l.filter((x: any) => x.copies.length !== 1).slice(0, 2))}`);
  assert.equal(l[1].copies[0].title, 'Episode 1 - Page 3-4', 'each post keeps its own title, without the " (ch. N)"');
  assert.equal(l[1].copies[0].sourceNumber, 1, 'and the number the source gave it');
  const stored = await q('SELECT count(*)::int AS n, count(*) FILTER (WHERE gone_at IS NULL)::int AS live FROM series_post_numbers WHERE series_id = $1', [id]);
  assert.deepEqual(stored[0], { n: 226, live: 226 }, 'the assignment is kept, so the numbers never move');
});

test('an existing series is held for review, not renamed', { skip }, async () => {
  await seedSeries(S, FOLDER);
  for (const [raw, k] of HELD) await seedBook(S, FOLDER, raw, k);
  // What v0.48 left: its listing (raw 4 chosen as post 63), a mark on the ghost at 4, a failure at 5, reading
  // progress and a bookmark, a queued slow archive and a download in today's log.
  await q(`INSERT INTO series_listing (series_id, number, title, source_id, chosen, status, copies) VALUES ($1, 4, $2, $3, $4::jsonb, 'available', '[]'::jsonb)`,
    [S, post(63).title, WEB, JSON.stringify(post(63))]);
  await q(`INSERT INTO listing_progress (user_id, series_id, number) VALUES ($1, $2, 4)`, [adminId, S]);
  await q(`INSERT INTO chapter_failures (series_id, number, source_id, status, attempts) VALUES ($1, 5, $2, 'error', 2)`, [S, WEB]);
  await q(`INSERT INTO read_progress (user_id, book_id, series_id, page, completed) VALUES ($1, $2, $3, 5, false)`, [adminId, `${S}_b3`, S]);
  await q(`INSERT INTO bookmarks (user_id, book_id, series_id, page, note) VALUES ($1, $2, $3, 3, 'here')`, [adminId, `${S}_b2`, S]);
  await q(`INSERT INTO archive_queue (series_id, state, boundary, floor_at_start) VALUES ($1, 'queued', 7, 7)`, [S]);
  await q(`INSERT INTO download_log (folder, title, number, source, origin, status, started_at) VALUES ($1, 'Istrevelia', 2, $2, 'sweep', 'done', now())`, [FOLDER, WEB]);
  const before = await booksOf(S);

  // Reintroduce by applying unattended (`if (false)` for the confirm check in settleNumbering): outcome 'ok'
  // and the files renamed.
  const r = await updater.updateSeries(S, 1);
  assert.equal(r.outcome, 'renumber_pending', 'held, whatever the plan');
  assert.equal(r.added, 0, 'nothing downloads under numbers that are about to move');
  assert.equal(r.renumber?.state, 'needs_review');
  const row = (await q('SELECT numbering, numbering_pending, numbering_source, renumber_plan FROM lib_series WHERE id = $1', [S]))[0];
  assert.deepEqual([row.numbering, row.numbering_pending, row.numbering_source, row.renumber_plan], [null, 'posting_order', WEB, null]);
  assert.deepEqual(await booksOf(S), before, 'no row moved');
  assert.deepEqual(filesIn(FOLDER), HELD.map(([raw]) => `Chapter ${raw}.cbz`).sort(), 'no file moved');
  assert.deepEqual((await q('SELECT number::float8 AS n FROM series_listing WHERE series_id = $1', [S])).map((x: any) => Number(x.n)), [4], 'the listing is left as it was');
  // A manual fetch waits too: whatever it fetched would land under a number the plan is about to move.
  // Reintroduce by dropping renumberRefusal from POST /api/sources/fetch: a job starts for raw 4.
  const f = await app.inject({ method: 'POST', url: '/api/sources/fetch', headers: { authorization: token }, payload: { seriesId: S, numbers: [4] } });
  assert.equal(f.statusCode, 409, f.body);
  assert.equal(f.json().error, 'renumber_pending');

  // The plan an admin is shown, without changing anything.
  const p = await numbering.requestNumbering(S, 'posting_order', { userId: adminId });
  assert.equal(p.state, 'needs_confirm');
  const moves = new Map(p.plan.moves.map((m: any) => [m.bookId, m]));
  for (const [raw, k] of HELD) assert.equal((moves.get(`${S}_b${raw}`) as any)?.to, k, `Chapter ${raw}.cbz is post ${k}`);
  assert.equal((moves.get(`${S}_b3`) as any).how, 'name', 'the fifth post of episode 3, by its name');
  assert.deepEqual(filesIn(FOLDER), HELD.map(([raw]) => `Chapter ${raw}.cbz`).sort(), 'still nothing moved');
});

test('an admin\'s confirmation renumbers it in place: ids, progress, marks, floors and the log follow', { skip }, async () => {
  const before = await booksOf(S);
  const r = await numbering.requestNumbering(S, 'posting_order', { confirm: true, userId: adminId });
  assert.equal(r.state, 'applied');
  const after = await booksOf(S);
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), 'the same book ids, none minted, none lost');
  for (const [raw, k] of HELD) {
    assert.deepEqual(after.get(`${S}_b${raw}`), { number: k, file: `${FOLDER}/Chapter ${k}.cbz` }, `Chapter ${raw}.cbz became chapter ${k}`);
  }
  assert.deepEqual(filesIn(FOLDER), HELD.map(([, k]) => `Chapter ${k}.cbz`).sort(), 'renamed on disk, nothing left at a temporary name');
  assert.equal((await q('SELECT page FROM read_progress WHERE book_id = $1', [`${S}_b3`]))[0]?.page, 5, 'reading progress stays with its chapter');
  assert.equal((await q('SELECT note FROM bookmarks WHERE book_id = $1', [`${S}_b2`]))[0]?.note, 'here', 'and so does the bookmark');
  // Reintroduce by dropping the listing_progress remap in commit(): the mark stays at 4, which is post 4 now.
  assert.deepEqual((await q('SELECT number::float8 AS n FROM listing_progress WHERE series_id = $1', [S])).map((x: any) => Number(x.n)), [63],
    'the mark on the ghost moved to its post');
  assert.equal((await q('SELECT count(*)::int AS n FROM chapter_failures WHERE series_id = $1', [S]))[0].n, 0, 'failures counted against old numbers are gone');
  // Reintroduce by dropping the archive_queue UPDATE in commit(): the boundary stays at 7 -- post 7 -- and the
  // archive would take posts 7..137 for chapters the sweep already owns.
  const aq = (await q('SELECT boundary::float8 AS b, floor_at_start::float8 AS f FROM archive_queue WHERE series_id = $1', [S]))[0];
  assert.deepEqual([Number(aq.b), Number(aq.f)], [138, 138], 'the archive boundary is the first post of episode 7');
  assert.equal((await q('SELECT number::float8 AS n FROM download_log WHERE folder = $1', [FOLDER]))[0].n, 21, 'today\'s log names the post');
  const row = (await q('SELECT numbering, numbering_by, numbering_pending, renumber_plan FROM lib_series WHERE id = $1', [S]))[0];
  assert.deepEqual([row.numbering, row.numbering_by, row.numbering_pending, row.renumber_plan], ['posting_order', 'manual', null, null]);
  const l = await q('SELECT number::float8 AS n FROM series_listing WHERE series_id = $1 ORDER BY number', [S]);
  assert.deepEqual(l.map((x: any) => Number(x.n)), Array.from({ length: 226 }, (_, i) => i + 1), 'the listing is in posting numbers');

  // The next check fetches the lowest post it lacks -- post 2, which v0.48 filed as a version of chapter 1.
  const up = await updater.updateSeries(S, 1);
  assert.equal(up.outcome, 'ok');
  assert.deepEqual(up.landed.map((x: any) => [x.number, x.chapterId]), [[2, 'ist-2']], 'post 2, stamped with its own chapter id');
  assert.ok(existsSync(join(DL, FOLDER, 'Chapter 2.cbz')));
});

test('the undo keeps every file, and keeping the source\'s numbers is sticky', { skip }, async () => {
  // Chapter 2 (post 2) in the library, stamped as a landing stamps it.
  await lib.persistScan();
  await lib.setBookMeta(FOLDER, [{ number: 2, source: WEB, title: 'Episode 1 - Page 3-4', chapterId: 'ist-2' }]);
  assert.equal((await q(`SELECT source_chapter_id FROM lib_books WHERE series_id = $1 AND number = 2`, [S]))[0]?.source_chapter_id, 'ist-2');
  const ids = [...(await booksOf(S)).keys()].sort();
  assert.equal(ids.length, 8);

  const r = await numbering.requestNumbering(S, 'source', { confirm: true, userId: adminId });
  assert.equal(r.state, 'applied');
  const after = await booksOf(S);
  assert.deepEqual([...after.keys()].sort(), ids, 'no book lost or minted');
  assert.deepEqual([...after.values()].map((b) => b.number).sort((a, b) => a - b), [1, 1, 2, 3, 5, 6, 7, 8], 'back at the source\'s numbers');
  // Posts 1 and 2 are both the source's chapter 1: one keeps the plain name, the other reads back as 1 too.
  const files = filesIn(FOLDER);
  assert.ok(files.includes('Chapter 1.cbz') && files.includes('Chapter 1 (2).cbz'), files.join(', '));
  assert.equal(files.length, 8);
  const { numFromName } = await import('../src/lib/naming');
  assert.equal(numFromName('Chapter 1 (2).cbz'), 1);
  const row = (await q('SELECT numbering, numbering_by, numbering_pending FROM lib_series WHERE id = $1', [S]))[0];
  assert.deepEqual([row.numbering, row.numbering_by, row.numbering_pending], ['source', 'manual', null]);
  assert.equal((await q('SELECT count(*)::int AS n FROM series_post_numbers WHERE series_id = $1', [S]))[0].n, 0);

  // Reintroduce by letting decideNumbering ignore a manual choice: the detector marks it for review again.
  const up = await updater.updateSeries(S, 0);
  assert.equal(up.outcome, 'ok', 'the detector still fires, and the admin\'s choice stands');
  assert.equal((await q('SELECT numbering_pending FROM lib_series WHERE id = $1', [S]))[0].numbering_pending, null);
});

test('a crash between the two rename phases is finished by the next check', { skip }, async () => {
  await seedSeries(S2, FOLDER2, { numbering_pending: 'posting_order', numbering_source: WEB });
  for (const [raw, k] of [[1, 1], [2, 21], [3, 42]]) await seedBook(S2, FOLDER2, raw, k);
  const before = await booksOf(S2);
  numbering.renumberHooks.afterFirstPhase = () => { throw new Error('simulated crash'); };
  try {
    await assert.rejects(numbering.requestNumbering(S2, 'posting_order', { confirm: true }), /simulated crash/);
  } finally {
    numbering.renumberHooks.afterFirstPhase = undefined;
  }
  assert.ok((await q('SELECT renumber_plan FROM lib_series WHERE id = $1', [S2]))[0].renumber_plan, 'the journal is there');
  const mid = filesIn(FOLDER2);
  assert.ok(mid.includes('Chapter 1.cbz') && mid.filter((f) => /\.renumber-[0-9a-f]+$/.test(f)).length === 2, mid.join(', '));
  await lib.persistScan();
  assert.deepEqual(await booksOf(S2), before, 'a scan in between neither mints nor moves a row');

  // Reintroduce by dropping the resume at the top of updateSeries: the files stay at their temporary names.
  const r = await updater.updateSeries(S2, 0);
  assert.equal(r.outcome, 'ok');
  assert.deepEqual(filesIn(FOLDER2), ['Chapter 1.cbz', 'Chapter 21.cbz', 'Chapter 42.cbz']);
  const after = await booksOf(S2);
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());
  assert.deepEqual([...after.values()].map((b) => b.number).sort((a, b) => a - b), [1, 21, 42]);
  assert.equal((await q('SELECT renumber_plan FROM lib_series WHERE id = $1', [S2]))[0].renumber_plan, null);
});

test('a crash after the renames leaves the folder to its journal: the scan mints nothing', { skip }, async () => {
  await seedSeries(S3, FOLDER3, { numbering_pending: 'posting_order', numbering_source: WEB });
  for (const [raw, k] of [[1, 1], [2, 21], [3, 42]]) await seedBook(S3, FOLDER3, raw, k);
  const before = await booksOf(S3);
  numbering.renumberHooks.afterSecondPhase = () => { throw new Error('simulated crash'); };
  try {
    await assert.rejects(numbering.requestNumbering(S3, 'posting_order', { confirm: true }), /simulated crash/);
  } finally {
    numbering.renumberHooks.afterSecondPhase = undefined;
  }
  assert.deepEqual(filesIn(FOLDER3), ['Chapter 1.cbz', 'Chapter 21.cbz', 'Chapter 42.cbz'], 'the files moved, the rows did not');
  // Reintroduce by dropping `if (known?.renumbering) continue;` in scanOnce: the scan files Chapter 21.cbz and
  // Chapter 42.cbz as two new books with new ids, and the resume then meets them on the (root, file) index.
  await lib.persistScan();
  assert.deepEqual(await booksOf(S3), before, 'no second row for a renamed file');
  const r = await updater.updateSeries(S3, 0);
  assert.equal(r.outcome, 'ok');
  const after = await booksOf(S3);
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());
  assert.deepEqual([...after.values()].map((b) => b.file).sort(), [`${FOLDER3}/Chapter 1.cbz`, `${FOLDER3}/Chapter 21.cbz`, `${FOLDER3}/Chapter 42.cbz`]);
});

test('a scan asked for during a renumber waits for it', { skip }, async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const n0 = lib.scanCount();
  const held = lib.withScansHeld(async () => { await gate; return lib.scanCount(); });
  await new Promise((r) => setTimeout(r, 20));
  const scan = lib.persistScan();
  await new Promise((r) => setTimeout(r, 100));
  let during = -1;
  try {
    during = lib.scanCount();
  } finally {
    // Released whatever happens: a hold left in place would stall every renumber after this test.
    release();
  }
  // Reintroduce by not waiting for the hold in scanOnce: the scan starts while the renames would be running.
  assert.equal(during, n0, 'no scan starts inside the hold');
  assert.equal(await held, n0);
  await scan;
  assert.equal(lib.scanCount(), n0 + 1, 'and the one asked for runs after it');
});

test('followers are not merged under posting order, and nothing is hunted, followed or borrowed for it', { skip }, async () => {
  await seedSeries(S4, FOLDER4);
  await q(`INSERT INTO series_sources (series_id, source_id, source_series_id) VALUES ($1, $2, 'fol-series')`, [S4, FOL]);
  // No chapter row at all: nothing to rename, so the detector's verdict is applied by the check itself.
  const r = await updater.updateSeries(S4, 0);
  assert.equal(r.outcome, 'ok');
  assert.equal(r.renumber?.state, 'applied');
  assert.deepEqual((await q('SELECT numbering, numbering_by FROM lib_series WHERE id = $1', [S4]))[0], { numbering: 'posting_order', numbering_by: 'auto' });
  // Reintroduce by merging the follower's copies with the numbered list in updateSeries: its 1..20 are listed as
  // versions of posts 1..20.
  const l = await q('SELECT number::float8 AS n, copies FROM series_listing WHERE series_id = $1 ORDER BY number', [S4]);
  assert.equal(l.length, 226);
  assert.ok(l.every((x: any) => x.copies.every((c: any) => c.source === WEB)), 'every copy is the numbering source\'s');
  // The next check starts in posting order. Reintroduce by keeping `followed` whole: the follower is asked.
  folAsked = 0;
  assert.equal((await updater.updateSeries(S4, 0)).outcome, 'ok');
  assert.equal(folAsked, 0, 'a follower is not even asked');
  const again = await q('SELECT copies FROM series_listing WHERE series_id = $1', [S4]);
  assert.ok(again.length === 226 && again.every((x: any) => x.copies.every((c: any) => c.source === WEB)), 'and still every copy is the numbering source\'s');

  // Three chapters on the server, so the fill scan has something to measure.
  for (const n of [1, 2, 3]) {
    await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, root) VALUES ($1,$2,'Webtoons (test)',$3,$4,$5,$6)`,
      [`${S4}_b${n}`, S4, `${FOLDER4}/Chapter ${n}.cbz`, n, `Chapter ${n}`, DL]);
  }
  const { huntSource } = await import('../src/lib/sourceHunt');
  assert.equal((await huntSource(S4, 5, { allowed: () => true, budget: { left: 3 } })).why, 'posting_order');
  const { autoFollow } = await import('../src/lib/autoFollow');
  assert.deepEqual((await autoFollow(S4, [{ source: FOL, sourceId: 'fol-series' }])).map((x: any) => x.why), ['posting_order']);
  const { borrowNamesFor } = await import('../src/lib/borrowNames');
  assert.equal((await borrowNamesFor(S4, { force: true })).why, 'posting_order');
  const scan = await app.inject({ method: 'POST', url: '/api/sources/fill/scan', headers: { authorization: token }, payload: { seriesId: S4 } });
  assert.equal(scan.statusCode, 200, scan.body);
  const cands = new Map((scan.json().candidates as any[]).map((c) => [c.source, c]));
  assert.equal(cands.get(FOL)?.why, 'posting_order', 'the follower is named, with the reason');
  assert.equal(cands.get(WEB)?.count, 226, 'the series\' own source, in its posting numbers');
});

test('a chapter in a root the server cannot rename in moves by override, and the sweep reads the override', { skip }, async () => {
  await seedSeries(S5, FOLDER5, { numbering_pending: 'posting_order', numbering_source: WEB });
  await seedBook(S5, FOLDER5, 1, 1);
  // Post 21 as raw 2, in the read library: a root that is not there to write to (LIBRARY_ROOT was never made).
  const { chapterName } = await import('../src/lib/naming');
  await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, root, chapter_name, source_id)
           VALUES ($1,$2,'Webtoons (test)',$3,2,'Chapter 2',$4,$5,$6)`,
    [`${S5}_b2`, S5, `${FOLDER5}/Chapter 2.cbz`, process.env.LIBRARY_ROOT, chapterName(post(21).title, post(21).number), WEB]);
  const r = await numbering.requestNumbering(S5, 'posting_order', { confirm: true });
  assert.equal(r.state, 'applied');
  const b2 = (await q('SELECT b.number::float8 AS n, b.file, o.number::float8 AS ov FROM lib_books b LEFT JOIN book_overrides o ON o.book_id = b.id WHERE b.id = $1', [`${S5}_b2`]))[0];
  assert.deepEqual([Number(b2.n), b2.file, Number(b2.ov)], [2, `${FOLDER5}/Chapter 2.cbz`, 21], 'the file stays; its override carries the post\'s number');
  // Reintroduce by reading the raw number in updateSeries' have-set: raw 2 reads as held, post 2 is skipped and
  // post 3 is fetched instead.
  const up = await updater.updateSeries(S5, 1);
  assert.deepEqual(up.landed.map((x: any) => x.number), [2], 'post 2 is missing, whatever the read-only file is called');
});
