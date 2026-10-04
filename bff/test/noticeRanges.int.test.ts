// Notice chapters (#147, lib/noticeChapters.ts) beside files holding a range of chapters (#150, lib/chapterRanges.ts),
// both new in v0.55.2. The notice rule reads a book's pages; a range is one file holding several chapters. A range is
// never a notice, however few its pages, and with a type switched on every count -- the Library's, Mihon's, the
// trackers', Health's, "Hidden now" and Updates -- agrees on what is left: the files shown, each range one of them.
//
// Through the real scanner (rule 2 reads `Solo 09.5-10.cbz` as 9.5 to 10) and the real routes.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Static: a dynamic import of zod is another module instance, and `instanceof ZodError` would fail in the handler.
import { ZodError } from 'zod';

const DSN = process.env.TEST_DATABASE_URL;
let ROOT = '';
if (DSN) {
  ROOT = mkdtempSync(join(tmpdir(), 'uchiyomi-nrg-'));
  process.env.LIBRARY_ROOT = join(ROOT, 'lib');
  process.env.DL_ROOT = join(ROOT, 'dl');
  process.env.CACHE_DIR = join(ROOT, 'cache');
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.MIN_FREE_GB = '0';
  process.env.UCHIYOMI_PING_URL = '';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const SOLO = 'T!nrg/Solo';
const ADMIN = 'nrg-admin', MEMBER = 'nrg-member';
const realFetch = globalThis.fetch;
/**
 * The shelf, file -> stored page count: a range 1 to 7, then 8, the two-page notice 8.5, 9, a two-page RANGE from 9.5
 * to 10 (a part and a chapter in one file: short, fractional, and never a notice), and 11.
 */
const SHELF: Record<string, number> = {
  'Solo 01-07.cbz': 20, 'Solo 08.cbz': 20, 'Solo 08.5.cbz': 2, 'Solo 09.cbz': 20, 'Solo 09.5-10.cbz': 2, 'Solo 11.cbz': 20,
};
const RANGE_SHORT = 'Solo 09.5-10.cbz', NOTICE = 'Solo 08.5.cbz';

let q: any, app: any, lib: any;
let S = '';
let asAdmin: Record<string, string> = {}, asMember: Record<string, string> = {}, komgaKey: Record<string, string> = {};
let memberId = '';
/** lib_books ids by file name. */
const ids: Record<string, string> = {};
let seq = 0;
const get = (url: string, headers: Record<string, string>) =>
  app.inject({ method: 'GET', url, headers, remoteAddress: `10.83.0.${++seq & 255}` });
const numbers = async () => (await get(`/api/series/${S}/books?size=500`, asMember)).json().content.map((b: any) => b.number);
/** The switch as an admin sets it, through the route (which refreshes the in-process flag). */
const setTypes = async (types: string[]) => {
  const r = await app.inject({ method: 'PATCH', url: '/api/admin/settings', headers: asAdmin, payload: { hideNoticeTypes: types } });
  assert.equal(r.statusCode, 200, r.body);
};

async function writeCbz(file: string) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const AdmZip = require('adm-zip');
  const zip = new AdmZip();
  zip.addFile('001.jpg', Buffer.from(`page-of-${file}`));
  const dir = join(process.env.LIBRARY_ROOT!, SOLO);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), zip.toBuffer());
}

/** Files arriving as a scan meets them, counted as the reader or the nightly repair would count them. */
async function shelve(files: Record<string, number>) {
  for (const f of Object.keys(files)) await writeCbz(f);
  await lib.persistScan();
  S = (await q('SELECT id FROM lib_series WHERE folder = $1', [SOLO]))[0].id;
  for (const r of await q('SELECT id, file FROM lib_books WHERE series_id = $1', [S])) ids[r.file.split('/').pop()] = r.id;
  for (const [f, pages] of Object.entries(files)) await q('UPDATE lib_books SET pages = $2 WHERE id = $1', [ids[f], pages]);
}

before(async () => {
  if (!DSN) return;
  // Nothing leaves the machine: AniList and the rest answer 404 at once.
  globalThis.fetch = (async () => new Response('', { status: 404 })) as typeof fetch;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  lib = await import('../src/lib/library');
  await migrate();
  await q('DELETE FROM lib_books WHERE root = $1', [process.env.LIBRARY_ROOT]);
  await q(`DELETE FROM lib_series WHERE source LIKE 'T!nrg%'`);
  await q('DELETE FROM users WHERE username = ANY($1)', [[ADMIN, MEMBER]]);
  const user = async (name: string, role: string) => (await q(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ($1,$1,'x',$2,'password') RETURNING id`, [name, role]))[0].id;
  const adminId = await user(ADMIN, 'admin');
  memberId = await user(MEMBER, 'user');

  const auth = await import('../src/lib/auth');
  const Fastify = (await import('fastify')).default;
  app = Fastify();
  await app.register((await import('@fastify/cookie')).default);
  await app.register((await import('@fastify/jwt')).default, { secret: process.env.JWT_SECRET! });
  await app.register((await import('@fastify/rate-limit')).default, { global: false });
  app.setErrorHandler((err: any, _req: any, reply: any) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: 'bad_request' });
    return reply.code(err.statusCode || 500).send({ error: err.message || 'error' });
  });
  for (const mod of ['catalog', 'admin', 'komgaCompat']) await app.register((await import(`../src/routes/${mod}`)).default);
  await app.ready();
  asAdmin = { authorization: `Bearer ${app.jwt.sign({ sub: adminId, role: 'admin' })}` };
  asMember = { authorization: `Bearer ${app.jwt.sign({ sub: memberId, role: 'user' })}` };
  komgaKey = { 'x-api-key': (await auth.issueApiToken(memberId, 'nrg', ['read'], null)).token };

  await shelve(SHELF);
  // A manhwa by the admin's word; the switch is off until a test turns it on.
  await q(`INSERT INTO series_overrides (series_id, series_type) VALUES ($1, 'manhwa')`, [S]);
});

after(async () => {
  globalThis.fetch = realFetch;
  if (!DSN) return;
  // Shared database: a list left behind would hide chapters in every later suite.
  await q(`UPDATE server_settings SET hide_notice_types = '[]'::jsonb WHERE id = 1`).catch(() => {});
  await (await import('../src/lib/noticeSettings')).refreshNoticesActive().catch(() => {});
  await app?.close();
  await q('DELETE FROM lib_books WHERE root = $1', [process.env.LIBRARY_ROOT]).catch(() => {});
  await q(`DELETE FROM lib_series WHERE source LIKE 'T!nrg%'`).catch(() => {});
  await q('DELETE FROM users WHERE username = ANY($1)', [[ADMIN, MEMBER]]).catch(() => {});
  if (ROOT && existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true });
});

test('PREMISE: the scanner reads the shelf as six files, two of them ranges', { skip }, async () => {
  const rows = await q(`SELECT number::float8 AS n, number_end::float8 AS e FROM lib_books WHERE series_id = $1 ORDER BY number`, [S]);
  assert.deepEqual(rows.map((r: any) => [r.n, r.e]), [[1, 7], [8, null], [8.5, null], [9, null], [9.5, 10], [11, null]]);
  assert.deepEqual(await numbers(), [1, 8, 8.5, 9, 9.5, 11], 'every switch off, every file is listed');
});

test('a range is never a notice, however short; an admin\'s number makes it one chapter, judged like any other', { skip }, async () => {
  await setTypes(['manhwa']);
  try {
    // Reintroduce by dropping the range test from bookIsNotice (lib/noticeChapters.ts): the two-page 9.5-10 goes too,
    // and chapter 10 with it.
    assert.deepEqual(await numbers(), [1, 8, 9, 9.5, 11], 'a range is never a notice: the two-page 9.5-10 was hidden');
    const range = (await get(`/api/books/${ids[RANGE_SHORT]}`, asMember));
    assert.equal(range.statusCode, 200, 'a short range is not there by id');
    assert.deepEqual([range.json().numberEnd, range.json().metadata.number], [10, '9.5–10']);
    assert.equal((await get(`/api/books/${ids[NOTICE]}`, asMember)).statusCode, 404, 'PREMISE: the two-page 8.5 is a notice');
    assert.equal((await get(`/api/series/${S}`, asMember)).json().booksCount, 5);
    assert.equal((await get(`/api/series/${S}`, asAdmin)).json().hiddenNotices, 1, 'the range was counted among the hidden');
    // Edit number & title: the admin says the file is chapter 9.5 alone (lib/chapterRanges.ts: an admin's number
    // replaces the range). Then it is a two-page 9.5 like any other, and a notice. Reintroduce the raw
    // `number_end IS NULL` for the range test: the override is ignored and it stays.
    await q('INSERT INTO book_overrides (book_id, number) VALUES ($1, 9.5)', [ids[RANGE_SHORT]]);
    try {
      assert.deepEqual(await numbers(), [1, 8, 9, 11], 'a file an admin numbered as one chapter is still read as a range');
      assert.equal((await get(`/api/books/${ids[RANGE_SHORT]}`, asMember)).statusCode, 404);
    } finally {
      await q('DELETE FROM book_overrides WHERE book_id = $1', [ids[RANGE_SHORT]]);
    }
  } finally {
    await setTypes([]);
  }
});

test('notices and ranges together: the Library, Mihon, the trackers, Health and "Hidden now" count the same files', { skip }, async () => {
  const { seriesProgressFor } = await import('../src/lib/trackers');
  const { haveNumbers } = await import('../src/lib/libraryNumbers');
  const { gapsOf } = await import('../src/lib/fill');
  // What the sources list beside the shelf: a two-page 3.5 that the 01-07 file holds, a two-page 11.5 only they list,
  // and a real 12 nobody has fetched.
  for (const [n, pages] of [[3.5, 2], [11.5, 2], [12, 20]]) {
    await q(`INSERT INTO series_listing (series_id, number, title, source_id, chosen, status, copies)
             VALUES ($1, $2, $3, 'src', '{}'::jsonb, 'available', $4::jsonb)`, [S, n, `Chapter ${n}`,
      JSON.stringify([{ sourceId: `nrg-${n}`, source: 'src', groups: [], scanlator: null, lang: null, pages, publishedAt: null }])]);
  }
  // The member has read every file but the notice.
  for (const f of Object.keys(SHELF).filter((f) => f !== NOTICE)) {
    await q(`INSERT INTO read_progress (user_id, book_id, series_id, page, completed) VALUES ($1, $2, $3, 1, true)`, [memberId, ids[f], S]);
  }
  const counts = async () => {
    const s = (await get(`/api/series/${S}`, asMember)).json();
    return [s.booksCount, s.booksReadCount, s.booksUnreadCount];
  };
  const readShelf = async () => {
    const r = await app.inject({ method: 'POST', url: '/api/series/search', headers: asMember,
      payload: { size: 100, condition: { readStatus: { operator: 'is', value: 'READ' } } } });
    assert.equal(r.statusCode, 200, r.body);
    return r.json().content.some((s: any) => s.id === S);
  };
  const mihon = async () => {
    const s = (await get(`/api/v1/series/${S}`, komgaKey)).json();
    const p = (await get(`/api/v2/series/${S}/read-progress/tachiyomi`, komgaKey)).json();
    return [s.booksCount, p.booksCount, p.booksReadCount, p.lastReadContinuousNumberSort, p.maxNumberSort];
  };
  const ghosts = async () => (await get(`/api/series/${S}/listing`, asMember)).json().content.map((g: any) => g.number);
  try {
    // Off: six files, the notice 8.5 among them and unread -- the run stops at 8 and the series is not finished.
    assert.deepEqual(await counts(), [6, 5, 1]);
    assert.equal(await readShelf(), false);
    assert.deepEqual(await mihon(), [6, 6, 5, 8, 11]);
    assert.deepEqual(await seriesProgressFor(memberId, S), { chapters: 11, finished: false });
    assert.deepEqual(await ghosts(), [11.5, 12], 'the 01-07 file holds the listed 3.5');

    await setTypes(['manhwa']);
    // On: five files, every one read. The range 9.5-10 is one of them (never a notice), and counts once.
    assert.deepEqual(await counts(), [5, 5, 0], 'the Library counts disagree');
    assert.equal(await readShelf(), true, 'the Library\'s "read" filter disagrees with the series\' own counts');
    assert.deepEqual(await mihon(), [5, 5, 5, 11, 11], 'Mihon reads another shelf');
    assert.deepEqual(await seriesProgressFor(memberId, S), { chapters: 11, finished: true }, 'the trackers read another shelf');
    // No gap: the ranges hold 2 to 7 and 10, the notices are held, saved or listed.
    assert.deepEqual(gapsOf([...new Set(await haveNumbers(S))].sort((a, b) => a - b)).map((g) => [g.lo, g.hi]), []);
    assert.deepEqual(await ghosts(), [12]);
    // "Hidden now": the saved 8.5 and the listed 11.5. The listed 3.5 is the 01-07 file's -- the switch hides
    // nothing there, on or off. Reintroduce the exact-number test in hiddenNoticeCount (lib/noticeChapters.ts): 3.
    assert.equal((await get(`/api/series/${S}`, asAdmin)).json().hiddenNotices, 2, '"Hidden now" counts a number a range file holds');
  } finally {
    await setTypes([]);
    await q('DELETE FROM read_progress WHERE user_id = $1', [memberId]);
    await q('DELETE FROM series_listing WHERE series_id = $1', [S]);
  }
});

test('Updates: a new range file is one new file, a new notice none, across the switch', { skip }, async () => {
  await q(`INSERT INTO favorites (user_id, series_id) VALUES ($1, $2)`, [memberId, S]);
  const updates = async () => (await get('/api/updates', asMember)).json().content.map((u: any) => [u.series.id, u.newCount]);
  try {
    await setTypes(['manhwa']);
    assert.equal((await app.inject({ method: 'POST', url: '/api/updates/seen', headers: asMember })).statusCode, 200);
    assert.deepEqual(await updates(), []);
    // A file holding 12 to 14 and a two-page 14.5 arrive in one scan.
    await shelve({ 'Solo 12-14.cbz': 20, 'Solo 14.5.cbz': 2 });
    assert.deepEqual(await updates(), [[S, 1]], 'a new range is one new file, and a new notice is nothing new');
    const home = (await get('/api/home', asMember)).json();
    assert.equal(home.updatesCount, 1, "Home's badge disagrees with Updates");
    assert.equal(home.favorites.find((f: any) => f.id === S)?.yomi?.newCount, 1, "the favourite's own new count disagrees");
    await setTypes([]);
    assert.deepEqual(await updates(), [[S, 2]], 'switched off, the new notice is new too');
  } finally {
    await setTypes([]);
    await q('DELETE FROM favorites WHERE user_id = $1', [memberId]);
    await q('DELETE FROM series_seen WHERE user_id = $1', [memberId]);
  }
});
