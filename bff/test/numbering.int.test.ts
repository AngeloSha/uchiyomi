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
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
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
// Added back into a folder that already holds books (#116 review): from the same source, with and without its stored
// assignment, and from another source. The folders are the add's own: `<source name>/<title>`.
const REV = 'nb-revive';
const S7 = 's_nb_rv_raw', FOLDER7 = 'Webtoons (revive)/Istrevelia one';
const S8 = 's_nb_rv_kept', FOLDER8 = 'Webtoons (revive)/Istrevelia two';
const S9 = 's_nb_rv_moved', FOLDER9 = 'Webtoons (revive)/Istrevelia three';
const S15 = 's_nb_rv_parked', FOLDER15 = 'Webtoons (revive)/Istrevelia four';
const S16 = 's_nb_rv_holes', FOLDER16 = 'Webtoons (revive)/Istrevelia five';
const S10 = 's_nb_stray', FOLDER10 = 'Webtoons (test)/Istrevelia Stray';
const S11 = 's_nb_fetch', FOLDER11 = 'Webtoons (test)/Istrevelia Fetch';
const S12 = 's_nb_healed', FOLDER12 = 'Webtoons (test)/Istrevelia Healed';
const S13 = 's_nb_fresh', FOLDER13 = 'Webtoons (test)/Istrevelia Fresh';
const S14 = 's_nb_kept', FOLDER14 = 'Webtoons (test)/Istrevelia Kept';
// A journal found by a run while another runs it (integration-2 review, a blocker).
const S17 = 's_nb_race', FOLDER17 = 'Webtoons (test)/Istrevelia Race';
const S18 = 's_nb_resumed', FOLDER18 = 'Webtoons (test)/Istrevelia Resumed Twice';
const ALL = [S, S2, S3, S4, S5, S7, S8, S9, S10, S11, S12, S13, S14, S15, S16, S17, S18];
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
/** The same posts from another source: its own chapter ids, the same urls, titles and dates (an extension reinstalled). */
const revived = () => listing().map((c: any) => ({ ...c, sourceId: c.sourceId.replace('ist-', 'rv-') }));

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
    id: REV, name: 'Webtoons (revive)',
    async search() { return []; },
    async getSeries(sid: string) { return { sourceId: sid, source: REV, title: `Istrevelia ${sid}` }; },
    async listChapters() { return revived(); },
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
  await q('DELETE FROM lib_series WHERE id = ANY($1) OR folder = $2 OR folder LIKE $3', [ALL, 'Webtoons.com/Istrevelia', 'Webtoons (revive)/%']);
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
  await q('DELETE FROM lib_series WHERE id = ANY($1) OR folder = $2 OR folder LIKE $3', [ALL, 'Webtoons.com/Istrevelia', 'Webtoons (revive)/%']).catch(() => {});
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
  // The run that applied it counted what the sweep owns with the MOVED boundary: posts 138..226 less the two held
  // (138, 212). Reintroduce by not reading archive_boundary again after settleNumbering in updateSeries: the
  // stale source number 7 counts posts 7..226 less six held, 214.
  assert.equal((await q('SELECT source_missing FROM lib_series WHERE id = $1', [S]))[0].source_missing, 87,
    'the applying run floored at the moved archive boundary');
  assert.equal((await q('SELECT number::float8 AS n FROM download_log WHERE folder = $1', [FOLDER]))[0].n, 21, 'today\'s log names the post');
  const row = (await q('SELECT numbering, numbering_by, numbering_pending, renumber_plan FROM lib_series WHERE id = $1', [S]))[0];
  assert.deepEqual([row.numbering, row.numbering_by, row.numbering_pending, row.renumber_plan], ['posting_order', 'manual', null, null]);
  const l = await q('SELECT number::float8 AS n FROM series_listing WHERE series_id = $1 ORDER BY number', [S]);
  assert.deepEqual(l.map((x: any) => Number(x.n)), Array.from({ length: 226 }, (_, i) => i + 1), 'the listing is in posting numbers');

  // The next check fetches the lowest post it lacks -- post 2, which v0.48 filed as a version of chapter 1 -- once
  // the archive is stopped: while it is queued, everything below its boundary is the archive's to fetch
  // (updater.ts floors at GREATEST(chapter_floor, boundary)) and the check would take post 139.
  await q('DELETE FROM archive_queue WHERE series_id = $1', [S]);
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
  // A slow archive queued from the source's chapter 3: the crash leaves its boundary in source numbers too.
  await q(`INSERT INTO archive_queue (series_id, state, boundary, floor_at_start) VALUES ($1, 'queued', 3, 3)`, [S3]);
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
  // The resume moved the boundary to post 42, the first of episode 3, and the check that resumed it floors there:
  // posts 42..226 less the one held. Reintroduce by not reading archive_boundary again after resumeRenumber in
  // updateSeries: the source's 3 counts posts 3..226 less two held, 222.
  assert.equal(Number((await q('SELECT boundary::float8 AS b FROM archive_queue WHERE series_id = $1', [S3]))[0].b), 42);
  assert.equal((await q('SELECT source_missing FROM lib_series WHERE id = $1', [S3]))[0].source_missing, 184,
    'the resuming check floored at the moved archive boundary');
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
  // A book downloaded before names were stamped has none, and the listing heals it -- by the override-aware number
  // as well (lib/seriesListing.ts): raw 2 is post 21 here. Reintroduce `b.number = v.n` in replaceListing's heal:
  // the read-only book is named after post 2 ("and its own name" below).
  await q('UPDATE lib_books SET chapter_name = NULL WHERE id = $1', [`${S5}_b2`]);
  // Reintroduce by reading the raw number in updateSeries' have-set: raw 2 reads as held, post 2 is skipped and
  // post 3 is fetched instead.
  const up = await updater.updateSeries(S5, 1);
  assert.deepEqual(up.landed.map((x: any) => x.number), [2], 'post 2 is missing, whatever the read-only file is called');
  // The landing of post 2 stamps post 2, not the read-only book whose RAW number is 2 (#116 review): its chapter id
  // is the evidence every later remap trusts first. Reintroduce the raw match in setBookMeta/setBookDates
  // (library.ts BOOK_NUMBER): post 21 is stamped as post 2.
  const ro = (await q('SELECT source_chapter_id, chapter_name, published_at FROM lib_books WHERE id = $1', [`${S5}_b2`]))[0];
  assert.equal(ro.source_chapter_id, 'ist-21', 'the read-only post 21 keeps its own stamp after post 2 lands');
  // Healed as the heal names a listed number (lib/seriesListing.ts): the listing's own row for post 21.
  const l21 = (await q('SELECT title FROM series_listing WHERE series_id = $1 AND number = 21', [S5]))[0]?.title;
  assert.equal(ro.chapter_name, chapterName(l21, 21), 'and its own name, healed as post 21');
  assert.equal(new Date(ro.published_at).toISOString(), post(21).publishedAt, 'and its own date');
});

// ---- added back into a folder that already holds books (#116 review) ---------------------------------------------

/** A series removed from the library, its files left on disk: what an add of the same folder revives. */
async function seedRemoved(id: string, folder: string, cols: Record<string, unknown> = {}) {
  const keys = ['id', 'source', 'title', 'folder', 'books_count', 'library_id', 'source_id', 'source_series_id', 'auto_update', 'deleted_at', ...Object.keys(cols)];
  const vals = [id, 'Webtoons (revive)', folder.split('/')[1], folder, 0, LIB, REV, folder.split(' ').pop(), true, new Date(), ...Object.values(cols)];
  await q(`INSERT INTO lib_series (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})`, vals);
}
const addRevived = (sourceId: string) => app.inject({
  method: 'POST', url: '/api/sources/add', headers: { authorization: token },
  payload: { source: REV, sourceId, chapterFrom: 'none', archive: true },
});

test('a folder that already holds books is added for review, never numbered blind', { skip }, async () => {
  // Raw v0.48 files and no assignment to read them by: numbering the listing 1..226 over files still at the source's
  // 1..8 would file post 21 as post 2 and never fetch posts 1..8. Reintroduce by skipping addNumbering's books guard
  // (`if (false && books && ...)`): the listing is 226 rows and nothing waits for a review.
  await seedRemoved(S7, FOLDER7);
  for (const [raw, k] of [[1, 1], [2, 21], [3, 46]]) await seedBook(S7, FOLDER7, raw, k);
  const r = await addRevived('one');
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().seriesId, S7, 'the row is revived');
  const row = (await q('SELECT numbering, numbering_pending, numbering_source FROM lib_series WHERE id = $1', [S7]))[0];
  assert.deepEqual([row.numbering, row.numbering_pending, row.numbering_source], [null, 'posting_order', REV], 'added for review');
  const nums = (await q('SELECT number::float8 AS n FROM series_listing WHERE series_id = $1', [S7])).map((x: any) => Number(x.n));
  assert.equal(nums.length, 13, 'the listing in the source\'s own numbers, as the files are');
  assert.deepEqual(filesIn(FOLDER7), ['Chapter 1.cbz', 'Chapter 2.cbz', 'Chapter 3.cbz'], 'nothing renamed');
  // Its "archive the rest slowly" waits for the review too (the critic: never enqueue while numbering_pending is
  // set). Reintroduce by answering the enqueue's own `queued` (routes/sources.ts archiveRest): this reads queued.
  assert.equal(r.json().archive, 'later', 'a revived folder waits for its review');
  const aq = (await q('SELECT state, boundary FROM archive_queue WHERE series_id = $1', [S7]))[0];
  assert.deepEqual([aq?.state, aq?.boundary], ['queued', null], 'queued, with its boundary placed once the numbers settle');
});

test('added back with its assignment kept, a series is in posting numbers at once', { skip }, async () => {
  const { assignPostingNumbers, postingSequence } = await import('../src/lib/postingOrder');
  await seedRemoved(S8, FOLDER8, { numbering: 'posting_order', numbering_by: 'auto', numbering_source: REV });
  await numbering.savePostNumbers(q, S8, REV, assignPostingNumbers(postingSequence(revived())).rows);
  for (const k of [1, 21, 46]) await seedBook(S8, FOLDER8, k, k);
  const r = await addRevived('two');
  assert.equal(r.statusCode, 200, r.body);
  const row = (await q('SELECT numbering, numbering_pending FROM lib_series WHERE id = $1', [S8]))[0];
  assert.deepEqual([row.numbering, row.numbering_pending], ['posting_order', null], 'its files are in the numbers it keeps');
  const nums = (await q('SELECT number::float8 AS n FROM series_listing WHERE series_id = $1 ORDER BY number', [S8])).map((x: any) => Number(x.n));
  assert.deepEqual(nums, Array.from({ length: 226 }, (_, i) => i + 1));
  assert.deepEqual(filesIn(FOLDER8), ['Chapter 1.cbz', 'Chapter 21.cbz', 'Chapter 46.cbz']);
});

test('added back from another source, a posting-order series keeps its posting numbers', { skip }, async () => {
  // Its files are in the posting numbers of the source it was numbered by ('nb-old', an extension since reinstalled
  // under a new id); the add marks a remap. A remap of a posting-order row used to target the NEW source's raw
  // numbers while the row stayed posting-ordered: confirmed, it renamed the files to 1..13 with (2), (3) suffixes, and
  // the next check listed 1..226 over them. Now its target is the new source's posting assignment, seeded from the
  // old one, so each post keeps its number and nothing is renamed -- and a remap that renames nothing settles by
  // itself. Reintroduce by planning the remap from the raw listing (buildRenumber): the check holds it for review.
  const { assignPostingNumbers, postingSequence } = await import('../src/lib/postingOrder');
  await seedRemoved(S9, FOLDER9, { numbering: 'posting_order', numbering_by: 'auto', numbering_source: 'nb-old' });
  const old = listing().map((c: any) => ({ ...c, sourceId: c.sourceId.replace('ist-', 'old-') }));
  await numbering.savePostNumbers(q, S9, 'nb-old', assignPostingNumbers(postingSequence(old)).rows);
  for (const k of [1, 21, 46]) await seedBook(S9, FOLDER9, k, k);
  const r = await addRevived('three');
  assert.equal(r.statusCode, 200, r.body);
  const row0 = (await q('SELECT numbering, numbering_pending, numbering_source FROM lib_series WHERE id = $1', [S9]))[0];
  assert.deepEqual([row0.numbering, row0.numbering_pending, row0.numbering_source], ['posting_order', 'remap', REV]);
  const since = '2026-05-01T00:00:00.000Z';
  await q('UPDATE lib_series SET numbering_changed_at = $2 WHERE id = $1', [S9, since]);
  const up = await updater.updateSeries(S9, 0);
  assert.equal(up.outcome, 'ok', 'added back from another source, it is not held');
  assert.equal(up.renumber?.state, 'applied');
  const row = (await q('SELECT numbering, numbering_pending, numbering_source FROM lib_series WHERE id = $1', [S9]))[0];
  assert.deepEqual([row.numbering, row.numbering_pending, row.numbering_source], ['posting_order', null, REV]);
  assert.deepEqual(filesIn(FOLDER9), ['Chapter 1.cbz', 'Chapter 21.cbz', 'Chapter 46.cbz'], 'nothing renamed');
  assert.deepEqual((await q('SELECT number::float8 AS n FROM lib_books WHERE series_id = $1 ORDER BY number', [S9])).map((x: any) => Number(x.n)), [1, 21, 46]);
  const stored = await q('SELECT source_id, count(*)::int AS n FROM series_post_numbers WHERE series_id = $1 GROUP BY source_id', [S9]);
  assert.deepEqual(stored, [{ source_id: REV, n: 226 }], "one source's assignment: the one its files are in");
  // The numbering did not change, only which post each file is: Health's "numbered by posting order lately" (two
  // weeks from numbering_changed_at) is not news again. Reintroduce `numbering_changed_at = now()` in commit().
  const changed = (await q('SELECT numbering_changed_at AS at FROM lib_series WHERE id = $1', [S9]))[0].at;
  assert.equal(new Date(changed).toISOString(), since, 'a remap keeps when the numbering changed');
});

test('remapping a posting-order series: no raw listing vouches for a book, and a parked book keeps its number reserved', { skip }, async () => {
  // The remap of a series added back from another source stores the new source's posting assignment, and plans every
  // file against it. The listing the add stored is in the new source's RAW numbers, not the posting numbers the files
  // are in, so it vouches for no book: reintroduce by letting it speak (drop `listingSpeaks = false` in
  // buildRenumber) and the nameless chapter 3 is matched to raw chapter 3's post -- another post's number. A book no
  // post matches is parked, and its number has to be reserved in that assignment, as a posting_order apply reserves
  // it, or a post inserted later could be given the very number the parked file holds: reintroduce by leaving
  // `reserveParked` out of buildRenumber's plan context, and no reserved slot is stored.
  const { assignPostingNumbers, postingSequence, EXTRA_PREFIX } = await import('../src/lib/postingOrder');
  await seedRemoved(S15, FOLDER15, { numbering: 'posting_order', numbering_by: 'auto', numbering_source: 'nb-old' });
  const old = listing().map((c: any) => ({ ...c, sourceId: c.sourceId.replace('ist-', 'old-') }));
  await numbering.savePostNumbers(q, S15, 'nb-old', assignPostingNumbers(postingSequence(old)).rows);
  for (const k of [1, 21]) await seedBook(S15, FOLDER15, k, k);
  // A file of the owner's that is no post of either source, and post 3 downloaded before chapters had names.
  const bare = async (n: number, title: string) => {
    writeFileSync(join(DL, FOLDER15, `Chapter ${n}.cbz`), 'x'.repeat(100));
    await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, root) VALUES ($1,$2,'Webtoons (revive)',$3,$4,$5,$6)`,
      [`${S15}_b${n}`, S15, `${FOLDER15}/Chapter ${n}.cbz`, n, title, DL]);
  };
  await bare(300, 'A poster the owner scanned');
  await bare(3, 'Chapter 3');
  const r = await addRevived('four');
  assert.equal(r.statusCode, 200, r.body);
  assert.equal((await q('SELECT numbering_pending FROM lib_series WHERE id = $1', [S15]))[0].numbering_pending, 'remap');
  const c = await numbering.requestNumbering(S15, 'remap', { confirm: true, userId: adminId });
  assert.equal(c?.state, 'applied', JSON.stringify(c?.plan?.reasons ?? c));
  assert.deepEqual((c?.plan?.moves ?? []).filter((m: any) => m.how === 'listing').map((m: any) => [m.bookId, m.to]), [],
    'the raw listing vouches for no book');
  const parked = new Map<string, number>((c?.plan?.parked ?? []).map((m: any) => [m.bookId, m.to]));
  assert.deepEqual([...parked.keys()].sort(), [`${S15}_b3`, `${S15}_b300`], `the nameless and the owner's file are parked: ${JSON.stringify(c?.plan?.moves)}`);
  const extras = await q(`SELECT post_id, number::float8 AS n FROM series_post_numbers WHERE series_id = $1 AND post_id LIKE $2 ORDER BY post_id`, [S15, `${EXTRA_PREFIX}%`]);
  assert.deepEqual(extras.map((x: any) => [x.post_id, Number(x.n)]),
    [...parked].map(([id, to]) => [`${EXTRA_PREFIX}${id}`, to]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    "the parked book's number is reserved");
});

test('added back from another source, each file keeps the number it was given, holes and all', { skip }, async () => {
  // Its files are in the posting numbers of the old source's assignment, made when that source did not list post 3:
  // every later post is one lower than its place in today's listing. The new source's assignment is seeded from that
  // one, so each post keeps the number its file has. Reintroduce by seeding only from the new source's own rows
  // (drop priorPosts in buildRenumber): the posts are numbered by position, post 21 moves from 20 to 21, and the
  // check holds the series for a review.
  const { assignPostingNumbers, postingSequence } = await import('../src/lib/postingOrder');
  await seedRemoved(S16, FOLDER16, { numbering: 'posting_order', numbering_by: 'auto', numbering_source: 'nb-old' });
  const old = listing().filter((c: any) => c.sourceId !== 'ist-3').map((c: any) => ({ ...c, sourceId: c.sourceId.replace('ist-', 'old-') }));
  await numbering.savePostNumbers(q, S16, 'nb-old', assignPostingNumbers(postingSequence(old)).rows);
  await seedBook(S16, FOLDER16, 1, 1);
  await seedBook(S16, FOLDER16, 20, 21); // post 21, the old source's 20th
  const r = await addRevived('five');
  assert.equal(r.statusCode, 200, r.body);
  assert.equal((await q('SELECT numbering_pending FROM lib_series WHERE id = $1', [S16]))[0].numbering_pending, 'remap');
  const up = await updater.updateSeries(S16, 0);
  assert.equal(up.renumber?.state, 'applied', 'each file keeps the number it was given: nothing to confirm');
  assert.deepEqual(filesIn(FOLDER16), ['Chapter 1.cbz', 'Chapter 20.cbz'], 'nothing renamed');
  const n3 = (await q(`SELECT number::float8 AS n FROM series_post_numbers WHERE series_id = $1 AND post_id = 'rv-3'`, [S16]))[0];
  assert.ok(n3 && Number(n3.n) > 2 && Number(n3.n) < 3, `post 3, new to it, goes between 2 and 3 (${n3?.n})`);
});

test('a file already at a target name refuses the apply, and says so', { skip }, async () => {
  // On POSIX a rename replaces its target silently: a stray `Chapter 21.cbz` no scan has taken in would be lost to
  // post 21's. Reintroduce by dropping checkTargets in applyRenumber: the stray is overwritten and the plan applied.
  await seedSeries(S10, FOLDER10, { numbering_pending: 'posting_order', numbering_source: WEB });
  await seedBook(S10, FOLDER10, 2, 21);
  writeFileSync(join(DL, FOLDER10, 'Chapter 21.cbz'), 'a stray file of somebody\'s');
  const { setSummaryRefresh } = await import('../src/lib/healthSummary');
  let runs = 0;
  setSummaryRefresh(async () => { runs++; }, { everyMs: 20 });
  let r: any;
  try {
    r = await numbering.requestNumbering(S10, 'posting_order', { confirm: true, userId: adminId });
    // The confirmation made it an admin's change, applied or not: Health words it so (reintroduce by dropping the
    // refresh from requestNumbering's confirmed(): nothing refreshes).
    for (let i = 0; i < 40 && !runs; i++) await new Promise((res) => setTimeout(res, 25));
    assert.ok(runs >= 1, 'a confirmation refreshes the header summary, applied or not');
  } finally {
    setSummaryRefresh();
  }
  assert.equal(r.state, 'pending', 'not applied');
  // Carried to the answer (#116 review): the page said "the source may not have answered" and an admin retried forever.
  assert.match(r.error ?? '', /Chapter 21\.cbz is already on disk/, 'a file already at a target name refuses the apply');
  // v0.49.1: and as its code, with the file it names, for the page to say in the reader's language (lib/said.ts).
  assert.equal(r.errorSaid?.code, 'renumber.onDisk', 'the refusal is not said by its code');
  assert.match(r.errorSaid?.params?.file ?? '', /\/Chapter 21\.cbz$/, 'the file the refusal names is not its parameter');
  assert.deepEqual(filesIn(FOLDER10), ['Chapter 2.cbz', 'Chapter 21.cbz']);
  const { readFileSync } = await import('node:fs');
  assert.equal(readFileSync(join(DL, FOLDER10, 'Chapter 21.cbz'), 'utf8'), 'a stray file of somebody\'s', 'the stray is intact');
  const row = (await q('SELECT renumber_plan, numbering_pending FROM lib_series WHERE id = $1', [S10]))[0];
  assert.deepEqual([row.renumber_plan, row.numbering_pending], [null, 'posting_order'], 'no journal, still held for review');
});

test('the refresh that holds a series holds its fetch', { skip }, async () => {
  // The first Fetch after an upgrade -- before any sweep -- runs the refresh that first marks a Webtoons series for
  // review, and went on from the raw listing into a series held from that moment. Reintroduce by checking only
  // before the refresh (POST /api/sources/fetch): a job starts for raw 4.
  await seedSeries(S11, FOLDER11);
  for (const [raw, k] of [[1, 1], [2, 21], [3, 46]]) await seedBook(S11, FOLDER11, raw, k);
  const copy = { sourceId: 'ist-63', source: WEB, groups: [], scanlator: null, lang: null, pages: 1, publishedAt: null, title: post(63).title };
  await q(`INSERT INTO series_listing (series_id, number, title, source_id, chosen, status, copies) VALUES ($1, 4, $2, $3, $4::jsonb, 'available', $5::jsonb)`,
    [S11, post(63).title, WEB, JSON.stringify({ ...post(63), source: WEB }), JSON.stringify([copy])]);
  const f = await app.inject({ method: 'POST', url: '/api/sources/fetch', headers: { authorization: token }, payload: { seriesId: S11, numbers: [4] } });
  assert.equal(f.statusCode, 409, f.body);
  assert.equal(f.json().error, 'renumber_pending', 'the refresh that holds a series holds its fetch');
  assert.equal((await q('SELECT numbering_pending FROM lib_series WHERE id = $1', [S11]))[0].numbering_pending, 'posting_order');
  assert.ok(!existsSync(join(DL, FOLDER11, 'Chapter 4.cbz')), 'nothing fetched');
});

test('a healed name chooses a post but never makes a plan clean', { skip }, async () => {
  // A book downloaded before names were stamped had its name healed from the listing's chosen copy (seriesListing.ts,
  // HEALED_NAME): the listing's guess, as a date is (fixL2). Reintroduce by leaving chapterNameSource out of
  // buildRenumber's books: the move reads 'name' and the plan clean.
  const { HEALED_NAME, chapterName } = await import('../src/lib/naming');
  await seedSeries(S12, FOLDER12, { numbering_pending: 'posting_order', numbering_source: WEB });
  mkdirSync(join(DL, FOLDER12), { recursive: true });
  writeFileSync(join(DL, FOLDER12, 'Chapter 2.cbz'), 'x'.repeat(100));
  await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, root, chapter_name, chapter_name_source)
           VALUES ($1,$2,'Webtoons (test)',$3,2,'Chapter 2',$4,$5,$6)`,
    [`${S12}_b2`, S12, `${FOLDER12}/Chapter 2.cbz`, DL, chapterName(post(21).title, post(21).number), HEALED_NAME]);
  const r = await numbering.requestNumbering(S12, 'posting_order', { userId: adminId });
  assert.equal(r.state, 'needs_confirm');
  assert.deepEqual([r.plan.moves[0].to, r.plan.moves[0].how], [21, 'listing'], 'the healed name still chooses post 21');
  assert.equal(r.plan.clean, false, 'a healed name chooses a post but never makes a plan clean');
});

test('an apply refreshes the header summary', { skip }, async () => {
  // Health's numbering finding goes with the renumber, and the header's mark with it (lib/healthSummary.ts).
  // Reintroduce by dropping scheduleHealthSummaryRefresh from commit(): nothing refreshes.
  const { setSummaryRefresh } = await import('../src/lib/healthSummary');
  let runs = 0;
  setSummaryRefresh(async () => { runs++; }, { everyMs: 20 });
  try {
    await seedSeries(S13, FOLDER13);
    const r = await updater.updateSeries(S13, 0);
    assert.equal(r.renumber?.state, 'applied', 'nothing to rename, applied by the check itself');
    for (let i = 0; i < 40 && !runs; i++) await new Promise((res) => setTimeout(res, 25));
    assert.ok(runs >= 1, 'an apply refreshes the header summary');

    // A choice that renames nothing takes the finding away as surely: "Keep the source's numbers", and handing the
    // series back to the detector. Reintroduce by dropping the refresh from either branch of requestNumbering: that
    // half reads no refresh.
    await seedSeries(S14, FOLDER14, { numbering_pending: 'posting_order', numbering_source: WEB });
    runs = 0;
    assert.equal((await numbering.requestNumbering(S14, 'source', { userId: adminId }))?.state, 'unchanged');
    for (let i = 0; i < 40 && !runs; i++) await new Promise((res) => setTimeout(res, 25));
    assert.ok(runs >= 1, "keeping the source's numbers refreshes the header summary");
    runs = 0;
    assert.equal((await numbering.requestNumbering(S14, 'auto', { userId: adminId }))?.state, 'unchanged');
    for (let i = 0; i < 40 && !runs; i++) await new Promise((res) => setTimeout(res, 25));
    assert.ok(runs >= 1, 'handing it back to the detector refreshes it too');
  } finally {
    setSummaryRefresh();
  }
});

// ---- a journal and the runs that find it (integration-2 review, a blocker) ----------------------------------------

/**
 * A chain on disk, with bytes of its own in each file: raw 1 holds post 2 and raw 2 holds post 21, so the move 1 -> 2
 * lands where the move 2 -> 21 leaves -- a journal run twice moves post 2's file on over post 21's. And a read mark on
 * post 63 (raw 4, a chapter the server does not hold), which the commit moves through its map.
 */
async function seedChain(id: string, folder: string) {
  await seedSeries(id, folder, { numbering_pending: 'posting_order', numbering_source: WEB });
  await seedBook(id, folder, 1, 2);
  await seedBook(id, folder, 2, 21);
  writeFileSync(join(DL, folder, 'Chapter 1.cbz'), 'post 2 bytes');
  writeFileSync(join(DL, folder, 'Chapter 2.cbz'), 'post 21 bytes');
  await q(`INSERT INTO series_listing (series_id, number, title, source_id, chosen, status, copies) VALUES ($1, 4, $2, $3, $4::jsonb, 'available', '[]'::jsonb)`,
    [id, post(63).title, WEB, JSON.stringify(post(63))]);
  await q(`INSERT INTO listing_progress (user_id, series_id, number) VALUES ($1, $2, 4)`, [adminId, id]);
  const plan = await numbering.requestNumbering(id, 'posting_order', { userId: adminId });
  assert.deepEqual(plan.plan.moves.map((m: any) => [m.from, m.to, m.via]).sort((a: any, b: any) => a[0] - b[0]), [[1, 2, 'rename'], [2, 21, 'rename']], 'PREMISE: a chain');
}
const bytesIn = (folder: string, file: string) => (existsSync(join(DL, folder, file)) ? readFileSync(join(DL, folder, file), 'utf8') : null);
const marksOf = async (id: string) =>
  (await q('SELECT number::float8 AS n FROM listing_progress WHERE series_id = $1 AND user_id = $2', [id, adminId])).map((x: any) => Number(x.n));
/** A hook that stops the first run through it until `open`, and lets every later one through. */
function stopFirst() {
  let open!: () => void, reached!: () => void;
  const gate = new Promise<void>((r) => { open = r; });
  const there = new Promise<void>((r) => { reached = r; });
  let first = true;
  return { open, there, hook: async () => { if (first) { first = false; reached(); await gate; } } };
}
/** Until `there`, or a PREMISE failure if `run` settles first (it never reached the hook). */
const reach = (there: Promise<void>, run: Promise<unknown>) =>
  Promise.race([there, run.then(() => { throw new Error('PREMISE: the run reached its hook'); })]);

test('a check that starts while a confirmed renumber applies does not run its journal a second time', { skip }, async () => {
  // The apply's journal is on the row from its first rename until its commit, and a check of the series that starts
  // meanwhile -- the sweep reaching it, Check now, a repair step's listing refresh, the archive's listing read -- finds
  // it and resumes it, waiting for the scans the apply holds. It then ran the copy it had read: the finished journal
  // a second time, post 2's file over post 21's and every read mark mapped again (the mark on post 63, which the map
  // has no entry for, deleted). Reintroduce by running that copy (drop the read in runJournal): post 21's file holds
  // post 2's bytes.
  await seedChain(S17, FOLDER17);
  const stop = stopFirst();
  numbering.renumberHooks.afterFirstPhase = stop.hook;
  let applied: any, checked: any;
  try {
    const applying = numbering.requestNumbering(S17, 'posting_order', { confirm: true, userId: adminId });
    await reach(stop.there, applying);
    const checking = updater.updateSeries(S17, 0);
    // Long enough for the check to read the journal and wait for the scans (two small reads).
    await new Promise((r) => setTimeout(r, 500));
    stop.open();
    [applied, checked] = await Promise.all([applying, checking]);
  } finally {
    stop.open();
    numbering.renumberHooks.afterFirstPhase = undefined;
  }
  assert.equal(applied?.state, 'applied');
  assert.equal(checked?.outcome, 'ok', 'the check goes on, in the new numbers');
  assert.equal(bytesIn(FOLDER17, 'Chapter 21.cbz'), 'post 21 bytes', 'post 21 is at 21, not overwritten by a second run of the journal');
  assert.equal(bytesIn(FOLDER17, 'Chapter 2.cbz'), 'post 2 bytes', 'post 2 is at 2');
  assert.deepEqual(filesIn(FOLDER17), ['Chapter 2.cbz', 'Chapter 21.cbz']);
  assert.deepEqual(await marksOf(S17), [63], 'the read mark moved once, to post 63');
});

test('a resume that waited behind another finishes the journal from where that one left it', { skip }, async () => {
  // Two runs find a journal a crash left (the sweep and Check now, say): the first resumes it and the second waits for
  // the scans the first holds. The first renames every file and fails before its commit, leaving the journal in its
  // second phase; the second had read it in its first, and ran that phase again over the renamed files. Reintroduce
  // by running the copy read before the wait (drop `j = now` in runJournal): post 21's file holds post 2's bytes.
  await seedChain(S18, FOLDER18);
  numbering.renumberHooks.afterFirstPhase = () => { throw new Error('simulated crash'); };
  try {
    await assert.rejects(numbering.requestNumbering(S18, 'posting_order', { confirm: true, userId: adminId }), /simulated crash/);
  } finally {
    numbering.renumberHooks.afterFirstPhase = undefined;
  }
  assert.equal((await q(`SELECT renumber_plan->>'phase' AS phase FROM lib_series WHERE id = $1`, [S18]))[0].phase, 'rename', 'PREMISE: a journal in its first phase');
  const stop = stopFirst();
  let crashed = false;
  numbering.renumberHooks.afterFirstPhase = stop.hook;
  numbering.renumberHooks.afterSecondPhase = () => { if (!crashed) { crashed = true; throw new Error('simulated crash'); } };
  let first: any, second: any;
  try {
    const resuming = updater.updateSeries(S18, 0);
    await reach(stop.there, resuming);
    const waiting = updater.updateSeries(S18, 0);
    await new Promise((r) => setTimeout(r, 500));
    stop.open();
    [first, second] = await Promise.all([resuming, waiting]);
  } finally {
    stop.open();
    numbering.renumberHooks.afterFirstPhase = undefined;
    numbering.renumberHooks.afterSecondPhase = undefined;
  }
  assert.equal(first?.outcome, 'renumber_pending', 'PREMISE: the first resume failed after its renames');
  assert.equal(second?.outcome, 'ok', 'the second finished it');
  assert.equal(bytesIn(FOLDER18, 'Chapter 21.cbz'), 'post 21 bytes', 'a resume that waited behind another finishes the journal from where that one left it');
  assert.equal(bytesIn(FOLDER18, 'Chapter 2.cbz'), 'post 2 bytes');
  assert.deepEqual(filesIn(FOLDER18), ['Chapter 2.cbz', 'Chapter 21.cbz']);
  assert.deepEqual(await marksOf(S18), [63]);
  const row = (await q('SELECT numbering, numbering_pending, renumber_plan FROM lib_series WHERE id = $1', [S18]))[0];
  assert.deepEqual([row.numbering, row.numbering_pending, row.renumber_plan], ['posting_order', null, null]);
});
