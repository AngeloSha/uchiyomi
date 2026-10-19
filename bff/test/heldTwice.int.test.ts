// A chapter held twice inside one series, and Keep one of each (lib/heldTwice.ts).
//
// The owner's library held 170 chapters twice in 29 series (19 Oct 2026) and nothing showed one: a second full set of a
// series in the read-only library, Suwayomi's re-downloads beside the first copy, ten `Chapter -1.cbz` that were chapter
// 1 again, one chapter under two spellings of its number. These run against real files in two roots: the download folder
// (the server deletes there) and a library folder standing in for the owner's read-only one (it never does). Each test
// names what its fix is, and how to put the old behaviour back.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const DSN = process.env.TEST_DATABASE_URL;
let ROOT = '', DL = '', LIB = '';
if (DSN) {
  ROOT = mkdtempSync(join(tmpdir(), 'yomi-ht-'));
  DL = join(ROOT, 'dl');
  LIB = join(ROOT, 'lib');
  mkdirSync(DL, { recursive: true });
  mkdirSync(LIB, { recursive: true });
  process.env.DL_ROOT = DL;
  process.env.LIBRARY_ROOT = LIB;
  process.env.CACHE_DIR = join(ROOT, 'cache');
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.MIN_FREE_GB = '0';
  process.env.UCHIYOMI_PING_URL = '';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const AdmZip = require('adm-zip');
const PIXEL = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(400, 7)]);

let q: any, held: typeof import('../src/lib/heldTwice'), health: typeof import('../src/lib/health');
let app: any, adminTok = '', user = '';

const S = 's_ht_tale', PO = 's_ht_posts', GONE = 's_ht_gone';
const DIR = 'T!ht/Held Tale', PO_DIR = 'T!ht/Posted Tale', GONE_DIR = 'T!ht/Gone Tale';
const T0 = Date.UTC(2025, 7, 15, 16, 56);
const MIN = 60_000;

function cbz(abs: string, pages = 1) {
  mkdirSync(dirname(abs), { recursive: true });
  const z = new AdmZip();
  for (let i = 1; i <= pages; i++) z.addFile(`${String(i).padStart(3, '0')}.png`, PIXEL);
  writeFileSync(abs, z.toBuffer());
}

async function series(id: string, title: string, folder: string, extra = '') {
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count${extra ? ', numbering' : ''})
           VALUES ($1, 'T!ht', $2, $3, 0${extra ? ', $4' : ''})`, extra ? [id, title, folder, extra] : [id, title, folder]);
}

/** A chapter row with a real file under `root`, saved `mtime`. */
async function book(id: string, seriesId: string, root: string, folder: string, name: string, number: number, mtime: number, pages = 1) {
  const file = `${folder}/${name}`;
  cbz(join(root, file), pages);
  await q(
    `INSERT INTO lib_books (id, series_id, source, file, number, title, mtime, root, pages)
     VALUES ($1, $2, 'T!ht', $3, $4, $5, $6, $7, $8)`,
    [id, seriesId, file, number, name, mtime, root, pages]);
  return join(root, file);
}

/**
 * The owner's shapes, in one series. Held twice: 1 (two old names in the library), 2 (the download folder's own file
 * beside the library's), 3 (`Chapter -3.cbz`, the way `Chapter -1.cbz` read as 1), 84.3 (two spellings), 9 (the copy
 * that would go is bookmarked), 10 (progress on the copy that goes). Never: 17 and 17e (an extra), 6 beside
 * `Ch. 6 - Chapter 86` (another chapter), 47 three times, 5 once.
 */
async function seed() {
  await series(S, 'Held Tale', DIR);
  const f: Record<string, string> = {};
  f.ch1 = await book('ht_1a', S, LIB, DIR, 'Ch. 1 - 1-eng-li.cbz', 1, T0, 18);
  f.c1 = await book('ht_1b', S, LIB, DIR, 'Chapter 1.cbz', 1, T0 + 9 * MIN, 18);
  f.lib2 = await book('ht_2a', S, LIB, DIR, 'Chapter 2.cbz', 2, T0);
  f.dl2 = await book('ht_2b', S, DL, DIR, 'Chapter 2.cbz', 2, T0 + 400 * 86_400_000);
  f.lib3 = await book('ht_3a', S, LIB, DIR, 'Chapter 3.cbz', 3, T0, 15);
  f.neg3 = await book('ht_3b', S, DL, DIR, 'Chapter -3.cbz', 3, T0 + 400 * 86_400_000, 127);
  f.long = await book('ht_84a', S, DL, DIR, 'Chapter 84.29999999999998.cbz', 84.3, T0 + 400 * 86_400_000, 126);
  f.short = await book('ht_84b', S, DL, DIR, 'Chapter 84.3.cbz', 84.3, T0 + 400 * 86_400_000 + 49_000, 126);
  f.c9 = await book('ht_9a', S, LIB, DIR, 'Chapter 9.cbz', 9, T0);
  f.c9r = await book('ht_9b', S, LIB, DIR, 'Chapter 9 RESUMED.cbz', 9, T0 + MIN);
  f.ch10 = await book('ht_10a', S, LIB, DIR, 'Ch. 10 - Chapter 10.cbz', 10, T0, 20);
  f.c10 = await book('ht_10b', S, LIB, DIR, 'Chapter 10.cbz', 10, T0 + 9 * MIN, 10);
  await book('ht_17a', S, LIB, DIR, 'Chapter 17.cbz', 17, T0);
  await book('ht_17b', S, LIB, DIR, 'Chapter 17e.cbz', 17, T0 + MIN);
  await book('ht_6a', S, LIB, DIR, 'Ch. 6 - Chapter6.cbz', 6, T0);
  await book('ht_6b', S, LIB, DIR, 'Ch. 6 - Chapter 86.cbz', 6, T0 + MIN);
  await book('ht_47a', S, LIB, DIR, 'Chapter 47.cbz', 47, T0);
  await book('ht_47b', S, LIB, DIR, 'Chapter 47-5.cbz', 47, T0 + MIN);
  await book('ht_47c', S, LIB, DIR, 'Chapter 47 again.cbz', 47, T0 + 2 * MIN);
  await book('ht_5', S, LIB, DIR, 'Chapter 5.cbz', 5, T0);
  // Numbered by posting order: two posts may share a number on purpose. Never offered.
  await series(PO, 'Posted Tale', PO_DIR, 'posting_order');
  await book('ht_po1', PO, LIB, PO_DIR, 'Chapter 1.cbz', 1, T0);
  await book('ht_po2', PO, LIB, PO_DIR, 'Ch. 1 - Chapter 1.cbz', 1, T0 + MIN);
  // A bookmark inside the copy of 9 that would go; chapter 10 finished in the copy that goes.
  await q(`INSERT INTO bookmarks (user_id, book_id, series_id, page) VALUES ($1, 'ht_9b', $2, 3)`, [user, S]);
  await q(`INSERT INTO read_progress (user_id, book_id, series_id, page, completed) VALUES ($1, 'ht_10b', $2, 9, true)`, [user, S]);
  return f;
}

async function wipe() {
  await q(`DELETE FROM read_progress WHERE series_id LIKE 's_ht%'`);
  await q(`DELETE FROM reading_events WHERE series_id LIKE 's_ht%'`);
  await q(`DELETE FROM bookmarks WHERE series_id LIKE 's_ht%'`);
  await q(`DELETE FROM lib_books WHERE series_id LIKE 's_ht%'`);
  await q(`UPDATE lib_series SET merged_into = NULL WHERE id LIKE 's_ht%'`);
  await q(`DELETE FROM lib_series WHERE id LIKE 's_ht%'`);
  await q(`DELETE FROM set_aside_files WHERE file LIKE 'T!ht/%'`);
  await q(`DELETE FROM health_ignored WHERE check_id = 'saved-twice'`).catch(() => {});
  rmSync(join(DL, 'T!ht'), { recursive: true, force: true });
  rmSync(join(LIB, 'T!ht'), { recursive: true, force: true });
}

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  held = await import('../src/lib/heldTwice');
  health = await import('../src/lib/health');
  await migrate();
  await q(`DELETE FROM users WHERE username = 'ht_admin'`);
  user = (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind, perms)
                    VALUES ('ht_admin', 'ht_admin', 'x', 'admin', 'password', '{}') RETURNING id`))[0].id;
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const adminRoutes = (await import('../src/routes/admin')).default;
  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register(adminRoutes);
  await app.ready();
  adminTok = `Bearer ${app.jwt.sign({ sub: user, role: 'admin' })}`;
});

beforeEach(async () => { if (DSN) await wipe(); });

after(async () => {
  if (!DSN) return;
  await app?.close();
  await wipe();
  await q(`DELETE FROM users WHERE username = 'ht_admin'`);
  rmSync(ROOT, { recursive: true, force: true });
});

const card = async () => (await health.runHealthChecks()).checks.find((c: any) => c.id === 'saved-twice');
const rowOf = (c: any, title: string) => c?.items.find((i: any) => i.title === title);
const live = async () => (await q(`SELECT id FROM lib_books WHERE series_id = $1 AND pruned_at IS NULL ORDER BY id`, [S])).map((r: any) => r.id);
const keepOnce = (id: string) => app.inject({ method: 'POST', url: `/api/admin/series/${id}/chapters/keep-once`, headers: { authorization: adminTok } });

test('Health lists a chapter held twice, and never a part, another chapter or a posting-order series', { skip }, async () => {
  await seed();
  const before = await live();
  // Which copy stays, pair by pair: the first saved; for 2 and 84.3 the download folder's own file.
  const pairs = await held.heldTwicePairs(S);
  assert.deepEqual(pairs.map((p) => [p.number, p.kept.id, p.other.id]), [
    [1, 'ht_1a', 'ht_1b'], [2, 'ht_2b', 'ht_2a'], [3, 'ht_3a', 'ht_3b'], [9, 'ht_9a', 'ht_9b'], [10, 'ht_10a', 'ht_10b'],
    [84.3, 'ht_84b', 'ht_84a'],
  ]);
  assert.deepEqual(await held.heldTwicePairs(PO), [], 'posting order: two posts may share a number');

  const c = await card();
  const row = rowOf(c, 'Held Tale');
  assert.ok(row, 'the series is on the card');
  assert.equal(row.pairs, 6);
  assert.deepEqual(row.numbers, [1, 2, 3, 9, 10, 84.3]);
  assert.deepEqual(row.bookIds, ['ht_1b', 'ht_2a', 'ht_3b', 'ht_9b', 'ht_10b', 'ht_84a'], 'the copies that would go');
  assert.equal(row.detail, '6 chapters are here twice: 1, 2, 3, 9, 10 and 1 more');
  assert.deepEqual(row.actions, ['keep_one', 'ignore'], 'Keep one of each, which an admin presses, or Ignore');
  assert.equal(rowOf(c, 'Posted Tale'), undefined);
  assert.equal(c.status, 'warn');
  assert.equal(c.summary, '1 series holds the same chapter in two files');
  assert.deepEqual(await live(), before, 'running the check removed nothing');
});

test('Keep one of each keeps one copy of each, moves reading progress, and deletes only in the download folder', { skip }, async () => {
  const f = await seed();
  const r = await keepOnce(S);
  assert.equal(r.statusCode, 200, r.body);
  const out = r.json();
  assert.deepEqual({ removed: out.removed, deleted: out.deleted, setAside: out.setAside, left: out.left },
    { removed: 5, deleted: 2, setAside: 3, left: { bookmarked: 1 } });

  // The download folder's extra copies are gone; the library's are left on disk and set aside.
  assert.equal(existsSync(f.neg3), false, '`Chapter -3.cbz` deleted');
  assert.equal(existsSync(f.long), false, 'the long spelling deleted');
  for (const k of ['ch1', 'c1', 'lib2', 'dl2', 'lib3', 'short', 'c9', 'c9r', 'ch10', 'c10']) assert.ok(existsSync(f[k]), `${k} is on disk`);
  const aside = (await q(`SELECT file, reason FROM set_aside_files WHERE file LIKE 'T!ht/%' ORDER BY file`)).map((x: any) => [x.file, x.reason]);
  assert.deepEqual(aside, [[`${DIR}/Chapter 1.cbz`, 'duplicate'], [`${DIR}/Chapter 10.cbz`, 'duplicate'], [`${DIR}/Chapter 2.cbz`, 'duplicate']]);

  const ids = await live();
  for (const gone of ['ht_1b', 'ht_2a', 'ht_3b', 'ht_10b', 'ht_84a']) assert.ok(!ids.includes(gone), `${gone} left the list`);
  for (const kept of ['ht_1a', 'ht_2b', 'ht_3a', 'ht_84b', 'ht_9a', 'ht_9b', 'ht_10a', 'ht_17a', 'ht_17b', 'ht_6a', 'ht_6b', 'ht_47a', 'ht_47b', 'ht_47c', 'ht_5']) {
    assert.ok(ids.includes(kept), `${kept} stays`);
  }
  // Chapter 10, finished in the copy that went: finished in the copy that stays, its page scaled to its 20 pages.
  const p = await q(`SELECT book_id, page, completed FROM read_progress WHERE user_id = $1 AND series_id = $2`, [user, S]);
  assert.deepEqual(p.map((x: any) => [x.book_id, x.completed]), [['ht_10a', true]]);

  // What is left on the card: 9, which a bookmark keeps twice. Asked again, nothing more goes.
  assert.equal(rowOf(await card(), 'Held Tale')?.pairs, 1);
  const again = (await keepOnce(S)).json();
  assert.deepEqual([again.removed, again.left], [0, { bookmarked: 1 }]);
});

test('Ignore keeps both until another chapter is held twice, and a merged series is refused', { skip }, async () => {
  await seed();
  const ign = await app.inject({ method: 'POST', url: '/api/admin/health/ignore', headers: { authorization: adminTok },
    payload: { check: 'saved-twice', key: `series:${S}`, ignored: true } });
  assert.equal(ign.statusCode, 200, ign.body);
  const quiet = rowOf(await card(), 'Held Tale');
  assert.equal(quiet.info, true, 'ignored: listed for reference, never a warning');
  assert.deepEqual(quiet.actions, ['unignore']);

  // A seventh chapter held twice is news again.
  await book('ht_12a', S, LIB, DIR, 'Chapter 12.cbz', 12, T0);
  await book('ht_12b', S, LIB, DIR, 'Ch. 12 - Chapter 12.cbz', 12, T0 + MIN);
  const loud = rowOf(await card(), 'Held Tale');
  assert.equal(loud.info, undefined);
  assert.equal(loud.pairs, 7);

  await series(GONE, 'Gone Tale', GONE_DIR);
  await q(`UPDATE lib_series SET merged_into = $2 WHERE id = $1`, [GONE, S]);
  assert.equal((await keepOnce(GONE)).statusCode, 409, 'a series merged into another is the survivor\'s to clean');
  assert.equal((await keepOnce('s_ht_nobody')).statusCode, 404);
});
