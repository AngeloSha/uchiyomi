// A file holding several chapters, end to end (v0.55.2, discussion #150): `Batman 01-07 (1987).cbz` is one book, the
// start 1 its place and number_end 7 its last chapter (lib/chapterRanges.ts says what every reader does with one).
// Through the real scanner, the real routes and the real sweep: the chapter list says "1–7", the gaps and the ghosts
// count 2 to 7 as held, the trackers are told 7 when it is finished, Mark caught up floors above 7, and a renumber,
// a stamp or a reader's mark never treats it as the one chapter its start names.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZodError } from 'zod';

const DSN = process.env.TEST_DATABASE_URL;
let ROOT = '';
if (DSN) {
  ROOT = mkdtempSync(join(tmpdir(), 'uchiyomi-rng-'));
  process.env.LIBRARY_ROOT = join(ROOT, 'lib');
  process.env.DL_ROOT = join(ROOT, 'dl');
  process.env.CACHE_DIR = join(ROOT, 'cache');
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.MIN_FREE_GB = '0';
  process.env.UPDATER_LIST_TIMEOUT_MS = '5000';
  process.env.UCHIYOMI_PING_URL = '';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const SRC = 'T!rng';
const ADAPTER = 'rng-src';
// Saga is filed where an add from its own source would put it (`<source name>/<title>`), so re-adding it meets it.
const SAGA_ADAPTER = 'rng-saga', SAGA_SOURCE = 'Sagas (rng test)';
const ADMIN = 'rng-admin';
const BATMAN = `${SRC}/Batman`;
const SAGA = `${SAGA_SOURCE}/Saga`;
const realFetch = globalThis.fetch;

let q: any, app: any, lib: any;
let H: Record<string, string> = {};
let komgaKey = '';
let adminId = '';
let S = '', SG = '';
/** lib_books ids by file name. */
const ids: Record<string, string> = {};

async function writeCbz(folder: string, file: string) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const AdmZip = require('adm-zip');
  const zip = new AdmZip();
  zip.addFile('001.jpg', Buffer.from(`page-of-${file}`));
  const dir = join(process.env.LIBRARY_ROOT!, folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), zip.toBuffer());
}

/** The source the Batman series is followed on, listing chapters 1 to 10, each with a name. */
const listed = () => Array.from({ length: 10 }, (_, i) => ({
  sourceId: `rng-${i + 1}`, number: i + 1, title: `Chapter ${i + 1}: Name ${i + 1}`, order: i + 1,
  publishedAt: new Date(Date.UTC(2020, 0, i + 1)).toISOString(), url: `https://example.invalid/rng/${i + 1}`,
}));

before(async () => {
  if (!DSN) return;
  // Nothing leaves the machine: AniList, GitHub's release check and the rest answer 404 at once.
  globalThis.fetch = (async () => new Response('', { status: 404 })) as typeof fetch;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  lib = await import('../src/lib/library');
  await migrate();
  const { registerAdapter } = await import('../src/lib/sources');
  registerAdapter({
    id: ADAPTER, name: 'Ranges (test)',
    async search() { return []; },
    async getSeries(sid: string) { return { sourceId: sid, source: ADAPTER, title: 'Batman' }; },
    async listChapters() { return listed(); },
    async getPageUrls() { return []; },
    async latest() { return []; },
  } as any);
  // A site that lists Batman under the same numbers, with names: the donor chapter-name borrowing would ask.
  registerAdapter({
    id: 'rng-donor', name: 'Donor (rng test)', lang: 'en',
    async search() { return [{ sourceId: 'batman', title: 'Batman' }]; },
    async getSeries(sid: string) { return { sourceId: sid, source: 'rng-donor', title: 'Batman' }; },
    async listChapters() { return listed().map((c) => ({ ...c, sourceId: `donor-${c.number}`, title: `Chapter ${c.number}: Borrowed ${c.number}` })); },
    async getPageUrls() { return []; },
    async latest() { return []; },
  } as any);
  registerAdapter({
    id: SAGA_ADAPTER, name: SAGA_SOURCE,
    async search() { return []; },
    async getSeries(sid: string) { return { sourceId: sid, source: SAGA_ADAPTER, title: 'Saga' }; },
    async listChapters() { return listed().slice(0, 5).map((c) => ({ ...c, sourceId: `saga-${c.number}` })); },
    async getPageUrls() { return []; },
    async latest() { return []; },
  } as any);
  await q('DELETE FROM lib_books WHERE root = ANY($1)', [[process.env.LIBRARY_ROOT, process.env.DL_ROOT]]);
  await q(`DELETE FROM lib_series WHERE source LIKE 'T!rng%' OR source = $1`, [SAGA_SOURCE]);
  await q('DELETE FROM users WHERE username = $1', [ADMIN]);
  adminId = (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind, perms)
                      VALUES ($1,$1,'x','admin','password','{}') RETURNING id`, [ADMIN]))[0].id;

  const auth = await import('../src/lib/auth');
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const cookie = (await import('@fastify/cookie')).default;
  const rateLimit = (await import('@fastify/rate-limit')).default;
  app = Fastify();
  await app.register(cookie);
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  app.setErrorHandler((err: any, _req: any, reply: any) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: 'bad_request' });
    const status = err.statusCode || 500;
    if (status >= 500) console.error('ROUTE 500:', err?.message);
    return reply.code(status).send({ error: status >= 500 ? 'internal' : err.message || 'error' });
  });
  await app.register(rateLimit, { global: false });
  for (const mod of ['sources', 'admin', 'catalog', 'komgaCompat']) await app.register((await import(`../src/routes/${mod}`)).default);
  await app.ready();
  H = { authorization: `Bearer ${app.jwt.sign({ sub: adminId, role: 'admin' })}` };
  komgaKey = (await auth.issueApiToken(adminId, 'rng-komga', ['read', 'write'], null)).token;

  // A comic collected by hand: issues 1 to 7 in one file, then 8 and 10 on their own. And a series of one range.
  for (const f of ['Batman 01-07 (1987).cbz', 'Batman #8 (1987).cbz', 'Batman #10 (1987).cbz']) await writeCbz(BATMAN, f);
  await writeCbz(SAGA, 'Saga 01-05.cbz');
  await lib.persistScan();
  S = (await q('SELECT id FROM lib_series WHERE folder = $1', [BATMAN]))[0].id;
  SG = (await q('SELECT id FROM lib_series WHERE folder = $1', [SAGA]))[0].id;
  for (const r of await q('SELECT id, file FROM lib_books WHERE series_id = ANY($1)', [[S, SG]])) ids[r.file.split('/').pop()] = r.id;
  // Followed on a source, so the sweep, the ghosts and a renumber have a listing to work with.
  await q('UPDATE lib_series SET source_id = $2, source_series_id = $3 WHERE id = $1', [S, ADAPTER, 'batman']);
});

after(async () => {
  globalThis.fetch = realFetch;
  if (!DSN) return;
  await app?.close();
  await q('DELETE FROM lib_books WHERE root = ANY($1)', [[process.env.LIBRARY_ROOT, process.env.DL_ROOT]]).catch(() => {});
  await q(`DELETE FROM lib_series WHERE source LIKE 'T!rng%' OR source = $1`, [SAGA_SOURCE]).catch(() => {});
  await q('DELETE FROM users WHERE username = $1', [ADMIN]).catch(() => {});
  if (ROOT && existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true });
});

const RANGE = 'Batman 01-07 (1987).cbz';

test('the scanner reads a range file as one book holding its chapters, and the series counts its files', { skip }, async () => {
  const rows = await q(`SELECT file, number::float8 AS number, number_end::float8 AS end, name_rule FROM lib_books
                         WHERE series_id = $1 ORDER BY number`, [S]);
  assert.deepEqual(rows.map((r: any) => [r.file.split('/').pop(), Number(r.number), r.end == null ? null : Number(r.end), r.name_rule]), [
    [RANGE, 1, 7, 2],
    ['Batman #8 (1987).cbz', 8, null, 2],
    ['Batman #10 (1987).cbz', 10, null, 2],
  ]);
  // The decision #150 left open: a 01-07 file is one book, as Mihon's booksCount and every read count have it.
  assert.equal((await q('SELECT books_count FROM lib_series WHERE id = $1', [S]))[0].books_count, 3);
  // A rescan writes the same, and keeps the rule.
  await lib.persistScan();
  assert.equal(Number((await q('SELECT number_end::float8 AS e FROM lib_books WHERE id = $1', [ids[RANGE]]))[0].e), 7);
});

test('the chapter list says the range; the Komga API sorts it by its start', { skip }, async () => {
  // Reintroduce `String(num)` for metadata.number in ownedCatalog's bookDto: the list reads "1".
  const list = (await app.inject({ method: 'GET', url: `/api/series/${S}/books`, headers: H })).json().content;
  const r = list.find((b: any) => b.id === ids[RANGE]);
  assert.equal(r.number, 1);
  assert.equal(r.numberEnd, 7);
  assert.equal(r.metadata.number, '1–7', 'the chapter list does not say the range');
  assert.equal(r.metadata.numberSort, 1);
  assert.deepEqual(list.map((b: any) => b.numberEnd), [7, null, null]);
  // One book by id, as the reader asks for it.
  assert.equal((await app.inject({ method: 'GET', url: `/api/books/${ids[RANGE]}`, headers: H })).json().metadata.number, '1–7');
  const komga = (await app.inject({ method: 'GET', url: `/api/v1/series/${S}/books`, headers: { 'x-api-key': komgaKey } })).json();
  const k = komga.content.find((b: any) => b.id === ids[RANGE]);
  assert.equal(k.metadata.numberSort, 1, 'Mihon sorts it at its start');
  assert.equal(k.number, 1);
  assert.equal(k.metadata.number, '1–7', 'and its number says the range');
});

test('a file holding chapters 1 to 7 is no gap: Health, the fill dialog and the repair count 2 to 7 as held', { skip }, async () => {
  const { haveNumbers } = await import('../src/lib/libraryNumbers');
  const { gapsOf } = await import('../src/lib/fill');
  const have = [...new Set(await haveNumbers(S))].sort((a, b) => a - b);
  assert.deepEqual(have, [1, 2, 3, 4, 5, 6, 7, 8, 10]);
  // Reintroduce by dropping HAVE_SQL's range branch: the gaps read 2-7 and 9.
  assert.deepEqual(gapsOf(have).map((g) => [g.lo, g.hi]), [[9, 9]], 'a file holding chapters 1 to 7 is no gap');
  const { runHealthChecks } = await import('../src/lib/health');
  const gaps = (await runHealthChecks()).checks.find((c: any) => c.id === 'chapter-gaps');
  const item = gaps.items.find((i: any) => i.seriesId === S);
  assert.ok(item, 'PREMISE: the real hole at 9 is a finding');
  assert.match(item.detail, /^1 missing/);
  assert.equal(gaps.items.some((i: any) => i.seriesId === SG), false, 'a series of one range has no gap');
});

test('the sweep does not fetch what a range file holds, and lists none of it as a ghost', { skip }, async () => {
  const updater = await import('../src/lib/updater');
  const r = await updater.updateSeries(S, 0);
  assert.equal(r.outcome, 'ok');
  // Reintroduce by testing the start alone in the sweep's have-set: 7 behind (2 to 7 and 9).
  const s = (await q('SELECT source_missing, source_chapters FROM lib_series WHERE id = $1', [S]))[0];
  assert.deepEqual([s.source_chapters, s.source_missing], [10, 1], 'the sweep counts what a range file holds as missing');
  const { ghostNumbers } = await import('../src/lib/komgaGhosts');
  const { listingFor } = await import('../src/lib/seriesListing');
  // Reintroduce the plain equality in the ghost anti-joins: 2 to 7 are ghosts beside the file holding them.
  assert.deepEqual(await ghostNumbers(S), [9], "a range file's numbers are no ghosts (Komga)");
  assert.deepEqual((await listingFor(S, { floor: null, admin: true })).content.map((g) => g.number), [9],
    "a range file's numbers are no ghosts (the series page)");
  // The listing's heal names the chapters it lists -- never a range file after its start's name.
  const names = Object.fromEntries((await q('SELECT file, chapter_name FROM lib_books WHERE series_id = $1', [S]))
    .map((b: any) => [b.file.split('/').pop(), b.chapter_name]));
  assert.equal(names['Batman #8 (1987).cbz'], 'Name 8', 'PREMISE: the heal ran');
  assert.equal(names[RANGE], null, 'a range file took the name of the chapter its start lists');
  // The repair's gap step, nightly: the one hole is the sweep's (listed), not seven.
  const { runRepair } = await import('../src/lib/repair');
  const rep = await runRepair(undefined, { only: ['gaps'], userId: null });
  assert.equal(rep.gaps.series, 1);
  const stored = (await q('SELECT gaps_result FROM lib_series WHERE id = $1', [S]))[0].gaps_result;
  assert.deepEqual([stored.why, stored.sweep], ['listed', 1], 'the repair counts what a range file holds as a gap');
});

test('a fetch of a number a range file holds is already here', { skip }, async () => {
  // The sweep above wrote the listing, so 3 is listed: only the file holding it stands between it and a download.
  // Reintroduce the exact-number `here` in POST /api/sources/fetch: chapter 3 is queued for download.
  const r = await app.inject({ method: 'POST', url: '/api/sources/fetch', headers: H, payload: { seriesId: S, numbers: [3] } });
  assert.equal(r.statusCode, 409, `a number a range file holds was fetched: ${r.body}`);
  assert.deepEqual(r.json().skipped, [{ number: 3, reason: 'already_here' }]);
});

test('the slow archive leaves a range file\'s chapters out of what it has left to fetch', { skip }, async () => {
  const { enqueueArchive, archiveSummaryFor } = await import('../src/lib/archive');
  const { SYSTEM_CTX } = await import('../src/lib/visibility');
  try {
    assert.equal(await enqueueArchive(S, adminId, SYSTEM_CTX), 'queued');
    // Reintroduce the plain equality in archive.ts eligibleSql: seven left (2 to 7 and 9).
    assert.equal((await archiveSummaryFor(S, adminId))?.left, 1, 'the archive would fetch what a range file holds');
  } finally {
    await q('DELETE FROM archive_queue WHERE series_id = $1', [S]);
    (await import('../src/lib/archive')).invalidateArchiveView();
  }
});

test('finishing a range file tells the tracker its end, through the web and through Mihon', { skip }, async () => {
  const { seriesProgressFor } = await import('../src/lib/trackers');
  await q('DELETE FROM read_progress WHERE user_id = $1', [adminId]);
  await q(`INSERT INTO read_progress (user_id, book_id, series_id, page, completed) VALUES ($1, $2, $3, 1, true)`, [adminId, ids[RANGE], S]);
  // Reintroduce the start in seriesProgressFor's MAX: AniList is told 1.
  assert.deepEqual(await seriesProgressFor(adminId, S), { chapters: 7, finished: false }, 'finishing a range file tells the tracker its end');
  const v2 = async () => (await app.inject({ method: 'GET', url: `/api/v2/series/${S}/read-progress/tachiyomi`, headers: { 'x-api-key': komgaKey } })).json();
  // Reintroduce `skip = r.number` in continuousRun: Mihon is told 1.
  assert.equal((await v2()).lastReadContinuousNumberSort, 7, 'the run Mihon reads ends at the range\'s end');
  assert.equal((await v2()).maxNumberSort, 10);
  // Mihon read the file (numberSort 1) and says so: the range file is the one it means.
  await q('DELETE FROM read_progress WHERE user_id = $1', [adminId]);
  const put = await app.inject({ method: 'PUT', url: `/api/v2/series/${S}/read-progress/tachiyomi`, headers: { 'x-api-key': komgaKey },
    payload: { lastBookNumberSortRead: 1 } });
  assert.equal(put.statusCode, 204);
  const done = await q('SELECT book_id FROM read_progress WHERE user_id = $1 AND completed', [adminId]);
  assert.deepEqual(done.map((r: any) => r.book_id), [ids[RANGE]]);
  assert.equal((await seriesProgressFor(adminId, S)).chapters, 7);
  await q('DELETE FROM read_progress WHERE user_id = $1', [adminId]);
  // A series that is one range file holds five chapters, as far as Mihon's total goes. Reintroduce the start in
  // readProgressDetail's max: 1.
  const saga = (await app.inject({ method: 'GET', url: `/api/v2/series/${SG}/read-progress/tachiyomi`, headers: { 'x-api-key': komgaKey } })).json();
  assert.equal(saga.maxNumberSort, 5, 'Mihon\'s chapter total stops at a range file\'s start');
});

test('the edition switcher says how far a reader got through a range file', { skip }, async () => {
  const { editionInfo } = await import('../src/lib/editions');
  const { SYSTEM_CTX } = await import('../src/lib/visibility');
  // Batman and Saga as two language editions of one work, for this test only.
  await q(`UPDATE lib_series SET work_id = '00000000-0000-4000-8000-000000000152'::uuid, lang = CASE WHEN id = $1 THEN 'en' ELSE 'es' END
            WHERE id = ANY($2)`, [S, [S, SG]]);
  await q(`INSERT INTO read_progress (user_id, book_id, series_id, page, completed) VALUES ($1, $2, $3, 1, true)`, [adminId, ids['Saga 01-05.cbz'], SG]);
  try {
    const info = await editionInfo(S, SYSTEM_CTX, adminId);
    // Reintroduce the start in editionInfo's last_read: "Español · ch. 1".
    assert.equal(info?.editions.find((e) => e.seriesId === SG)?.lastRead, 5, 'the switcher reads a finished range file\'s start');
  } finally {
    await q('DELETE FROM read_progress WHERE user_id = $1', [adminId]);
    await q('UPDATE lib_series SET work_id = NULL, lang = NULL WHERE id = ANY($1)', [[S, SG]]);
  }
});

test('Mark caught up floors the series above a range file\'s end', { skip }, async () => {
  // Saga holds one file, 01-05, and lists nothing. Reintroduce the start in the route's newest number: the floor is
  // 1.001 and the sweep would fetch 2 to 5.
  const r = await app.inject({ method: 'PATCH', url: `/api/admin/series/${SG}`, headers: H, payload: { chapterFloor: 'caught_up' } });
  assert.equal(r.statusCode, 200, r.body);
  const floor = Number((await q('SELECT chapter_floor FROM lib_series WHERE id = $1', [SG]))[0].chapter_floor);
  assert.ok(Math.abs(floor - 5.001) < 1e-9, `caught up past a range file is past its end (floor ${floor})`);
});

test('a renumber leaves a range file alone', { skip }, async () => {
  const { planFor } = await import('../src/lib/numbering');
  const p = await planFor(S, 'posting_order');
  assert.ok(p, 'PREMISE: the source answered a plan');
  const planned = [...p!.plan.moves, ...p!.plan.parked].map((m) => m.bookId);
  assert.ok(planned.includes(ids['Batman #8 (1987).cbz']), 'PREMISE: the plan holds the series\' other books');
  // Reintroduce by planning every book: the range file is in the plan, to be renamed `Chapter <n>.cbz`.
  assert.equal(planned.includes(ids[RANGE]), false, 'a renumber plans the range file');
});

test('a mark is never a range file read, and a range landing clears every failure it holds', { skip }, async () => {
  const { reconcileListingProgress } = await import('../src/lib/listingProgress');
  await q('DELETE FROM read_progress WHERE user_id = $1', [adminId]);
  // A reader ticked chapters 1 and 3 before any file held them; then the 01-07 file is what arrived.
  await q(`INSERT INTO listing_progress (user_id, series_id, number) VALUES ($1, $2, 1), ($1, $2, 3)`, [adminId, S]);
  await reconcileListingProgress({ seriesId: S });
  assert.deepEqual(await q('SELECT book_id FROM read_progress WHERE user_id = $1', [adminId]), [],
    'a mark on one chapter made the whole range file read');
  await q('DELETE FROM listing_progress WHERE user_id = $1', [adminId]);
  // Nor is a mark minted on a chapter a range file holds: 3 is listed, and the file holding it is not a ghost's.
  // Reintroduce the exact-number HELD in listingProgress.ts: a mark on 3 is written.
  const { markNumbers } = await import('../src/lib/listingProgress');
  assert.deepEqual(await markNumbers(adminId, S, [3]), { marked: 0, viaBook: 0, skipped: [] }, 'a mark was minted on a chapter a range file holds');
  // The failure ledger: a number the range file holds has landed; a number nothing holds is still failing.
  await q(`INSERT INTO chapter_failures (series_id, number, source_id, status) VALUES ($1, 3, $2, 'error'), ($1, 9, $2, 'error')`, [S, ADAPTER]);
  await lib.persistScan();
  assert.deepEqual((await q('SELECT number FROM chapter_failures WHERE series_id = $1', [S])).map((r: any) => Number(r.number)), [9],
    'a failure the range file holds is still on the ledger');
  await q('DELETE FROM chapter_failures WHERE series_id = $1', [S]);
});

test('a landing stamps the chapter it is, never a range file', { skip }, async () => {
  await lib.setBookMeta(BATMAN, [
    { number: 1, scanlator: 'Group One', source: ADAPTER, title: 'Chapter 1: Gotham' },
    { number: 8, scanlator: 'Group Eight', source: ADAPTER },
  ]);
  await lib.setBookDates(BATMAN, [{ number: 1, publishedAt: '2020-01-01T00:00:00Z' }]);
  const b = Object.fromEntries((await q('SELECT id, scanlator, published_at FROM lib_books WHERE series_id = $1', [S])).map((r: any) => [r.id, r]));
  assert.equal(b[ids['Batman #8 (1987).cbz']].scanlator, 'Group Eight', 'PREMISE: the stamp ran');
  assert.equal(b[ids[RANGE]].scanlator, null, 'chapter 1 landing stamped the range file');
  assert.equal(b[ids[RANGE]].published_at, null, 'chapter 1\'s date stamped the range file');
});

test('a borrowed chapter name is never a range file\'s', { skip }, async () => {
  const { borrowNamesFor } = await import('../src/lib/borrowNames');
  // The listing's heal named 8 and 10 (above); the range file is the series' one nameless chapter.
  await q('UPDATE lib_series SET borrow_names = true WHERE id = $1', [S]);
  try {
    // Reintroduce by borrowing for every nameless book: the range file is named "Borrowed 1".
    const r = await borrowNamesFor(S, { force: true });
    assert.equal(r.why, 'nothing_to_do', `a range file was offered a borrowed name (${JSON.stringify(r)})`);
    assert.equal((await q('SELECT chapter_name FROM lib_books WHERE id = $1', [ids[RANGE]]))[0].chapter_name, null);
  } finally {
    await q('UPDATE lib_series SET borrow_names = NULL, name_donor = NULL WHERE id = $1', [S]);
  }
});

test('an admin\'s number replaces the range, and a v0.55.1 rewrite reads as no range', { skip }, async () => {
  const { haveNumbers } = await import('../src/lib/libraryNumbers');
  const book = async () => (await app.inject({ method: 'GET', url: `/api/books/${ids[RANGE]}`, headers: H })).json();
  // Edit number & title: the file is that one chapter now.
  await q('INSERT INTO book_overrides (book_id, number) VALUES ($1, 3)', [ids[RANGE]]);
  try {
    const b = await book();
    assert.deepEqual([b.number, b.numberEnd, b.metadata.number], [3, null, '3']);
    assert.deepEqual([...new Set(await haveNumbers(S))].sort((x, y) => x - y), [3, 8, 10]);
  } finally {
    await q('DELETE FROM book_overrides WHERE book_id = $1', [ids[RANGE]]);
  }
  // v0.55.1's scan, after a rollback, writes the first number in some other name over the start and never meets
  // number_end: an end not above the number is no range.
  await q('UPDATE lib_books SET number = 1987 WHERE id = $1', [ids[RANGE]]);
  try {
    const b = await book();
    assert.deepEqual([b.number, b.numberEnd, b.metadata.number], [1987, null, '1987']);
  } finally {
    await lib.persistScan();
  }
  assert.equal((await book()).metadata.number, '1–7', 'v0.55.2\'s next scan writes the range again');
});

test('an add of a series a range file already holds downloads nothing it holds', { skip }, async () => {
  // #65's case: Remove, then add it again with every chapter. Saga's one file holds 1 to 5, and its source lists 1 to
  // 5. Reintroduce the exact-number have-set in the add: four chapters (2 to 5) are queued for a second copy.
  await q('UPDATE lib_series SET deleted_at = now() WHERE id = $1', [SG]);
  const r = await app.inject({ method: 'POST', url: '/api/sources/add', headers: H,
    payload: { source: SAGA_ADAPTER, sourceId: 'saga', chapterFrom: 'oldest', force: true } });
  assert.equal(r.statusCode, 200, r.body);
  const body = r.json();
  assert.equal(body.folder, SAGA, 'PREMISE: the add met the folder the range file is in');
  assert.deepEqual([body.chapters, body.alreadyHere], [0, 5], 'the add fetches chapters a range file holds');
});
