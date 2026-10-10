// One copy of each chapter after a merge (v0.57.0, lib/extraCopies.ts, lib/mergeLeftovers.ts, lib/setAside.ts).
//
// The owner: merging two copies of a series left every chapter both had listed twice -- "not needed, I don't want
// that" -- and the dialog should say which copy has the healthier source and more chapters. These run against real
// files in two roots: the download folder (the server deletes there) and a library folder standing in for the owner's
// read-only one (it never does). Each test names what its fix is, and how to put the old behaviour back.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const DSN = process.env.TEST_DATABASE_URL;
let ROOT = '', DL = '', LIB = '';
if (DSN) {
  ROOT = mkdtempSync(join(tmpdir(), 'yomi-xc-'));
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

let q: any, admin: typeof import('../src/lib/libraryAdmin'), leftovers: typeof import('../src/lib/mergeLeftovers');
let user = '';

const KEEP = 's_xc_keep', GONE = 's_xc_gone';
const KEEP_DIR = 'T!xc/Keep Tale', GONE_DIR = 'T!xc/Gone Tale';

/** A real one-page archive, as the downloader would have written it. */
function cbz(abs: string, pages = 1) {
  mkdirSync(dirname(abs), { recursive: true });
  const z = new AdmZip();
  for (let i = 1; i <= pages; i++) z.addFile(`${String(i).padStart(3, '0')}.png`, PIXEL);
  z.addFile('ComicInfo.xml', Buffer.from('<ComicInfo><Series>Tale</Series></ComicInfo>'));
  writeFileSync(abs, z.toBuffer());
}

/** A series row. */
async function series(id: string, title: string, folder: string, extra: Record<string, unknown> = {}) {
  await q(
    `INSERT INTO lib_series (id, source, title, folder, books_count, source_id, created_at)
     VALUES ($1, 'T!xc', $2, $3, 0, $4, $5)`,
    [id, title, folder, extra.source_id ?? null, extra.created_at ?? new Date()],
  );
}

/** A chapter row with a real file (unless `noFile`) under `root`. */
async function book(id: string, seriesId: string, root: string, folder: string, name: string, number: number,
  o: { pages?: number; partial?: boolean; noFile?: boolean } = {}) {
  const file = `${folder}/${name}`;
  if (!o.noFile) cbz(join(root, file), o.pages ?? 1);
  await q(
    `INSERT INTO lib_books (id, series_id, source, file, number, title, mtime, root, pages, missing_pages)
     VALUES ($1, $2, 'T!xc', $3, $4, $5, $6, $7, $8, $9)`,
    [id, seriesId, file, number, name, Date.now(), root, o.pages ?? 1, o.partial ? [1] : null],
  );
  return join(root, file);
}

async function wipe() {
  await q(`DELETE FROM read_progress WHERE series_id LIKE 's_xc%'`);
  await q(`DELETE FROM reading_events WHERE series_id LIKE 's_xc%'`);
  await q(`DELETE FROM notes WHERE series_id LIKE 's_xc%'`);
  await q(`DELETE FROM offline_downloads WHERE series_id LIKE 's_xc%'`);
  await q(`DELETE FROM bookmarks WHERE series_id LIKE 's_xc%'`);
  await q(`DELETE FROM series_trackers WHERE series_id LIKE 's_xc%'`);
  await q(`DELETE FROM lib_books WHERE series_id LIKE 's_xc%'`);
  await q(`UPDATE lib_series SET merged_into = NULL WHERE id LIKE 's_xc%'`);
  await q(`DELETE FROM lib_series WHERE id LIKE 's_xc%'`);
  await q('DELETE FROM set_aside_files');
  await q(`DELETE FROM schema_migrations WHERE id = 'v0.57.0-merge-leftovers'`);
  rmSync(join(DL, 'T!xc'), { recursive: true, force: true });
  rmSync(join(LIB, 'T!xc'), { recursive: true, force: true });
}

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  admin = await import('../src/lib/libraryAdmin');
  leftovers = await import('../src/lib/mergeLeftovers');
  await migrate();
  await q(`DELETE FROM users WHERE username = 'xc_reader'`);
  user = (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind, perms)
                    VALUES ('xc_reader', 'xc_reader', 'x', 'admin', 'password', '{}') RETURNING id`))[0].id;
});

beforeEach(async () => { if (DSN) await wipe(); });

after(async () => {
  if (!DSN) return;
  await wipe();
  await q(`DELETE FROM users WHERE username = 'xc_reader'`);
  rmSync(ROOT, { recursive: true, force: true });
});

const rowsAt = async (n: number) => (await q(
  `SELECT b.id FROM lib_books b LEFT JOIN book_overrides o ON o.book_id = b.id
    WHERE b.series_id = $1 AND COALESCE(o.number, b.number) = $2 ORDER BY b.id`, [KEEP, n])).map((r: any) => r.id);

test("a merge keeps the kept series' copy of a chapter both had, and what was read of the other moves onto it", { skip }, async () => {
  await series(KEEP, 'Keep Tale', KEEP_DIR);
  await series(GONE, 'Gone Tale', GONE_DIR);
  // Both had 2 (download folder), 3 (the other in the library folder: never deleted), 6 (the kept copy is partial), 7
  // (a bookmark in the other copy). Only the absorbed one had 4. 5: the absorbed series held it twice (an extra filed
  // under its chapter's number), so it is no pair. 1: only the kept one.
  await book('xc_k1', KEEP, DL, KEEP_DIR, 'Chapter 1.cbz', 1);
  const k2 = await book('xc_k2', KEEP, DL, KEEP_DIR, 'Chapter 2.cbz', 2, { pages: 8 });
  await book('xc_k3', KEEP, DL, KEEP_DIR, 'Chapter 3.cbz', 3, { pages: 40 });
  await book('xc_k5', KEEP, DL, KEEP_DIR, 'Chapter 5.cbz', 5);
  const k6 = await book('xc_k6', KEEP, DL, KEEP_DIR, 'Chapter 6.cbz', 6, { partial: true });
  await book('xc_k7', KEEP, DL, KEEP_DIR, 'Chapter 7.cbz', 7);
  const g2 = await book('xc_g2', GONE, DL, GONE_DIR, 'Chapter 2.cbz', 2, { pages: 160 });
  const g3 = await book('xc_g3', GONE, LIB, GONE_DIR, 'Chapter 3.cbz', 3, { pages: 20 });
  await book('xc_g4', GONE, DL, GONE_DIR, 'Chapter 4.cbz', 4);
  await book('xc_g5', GONE, DL, GONE_DIR, 'Chapter 5.cbz', 5);
  await book('xc_g5e', GONE, DL, GONE_DIR, 'Chapter 5e.cbz', 5);
  const g6 = await book('xc_g6', GONE, DL, GONE_DIR, 'Chapter 6.cbz', 6);
  const g7 = await book('xc_g7', GONE, DL, GONE_DIR, 'Chapter 7.cbz', 7);
  // What the reader did on the absorbed copies: 2 finished, 3 half-way (page 10 of its 20), a note and a saved-offline
  // copy on 2, a bookmark inside 7.
  await q(`INSERT INTO read_progress (user_id, book_id, series_id, page, completed) VALUES ($1, 'xc_g2', $2, 159, true), ($1, 'xc_g3', $2, 10, false)`, [user, GONE]);
  await q(`INSERT INTO reading_events (user_id, series_id, book_id, page, completed) VALUES ($1, $2, 'xc_g2', 159, true)`, [user, GONE]);
  await q(`INSERT INTO notes (user_id, series_id, book_id, body) VALUES ($1, $2, 'xc_g2', 'good one')`, [user, GONE]);
  await q(`INSERT INTO offline_downloads (user_id, book_id, series_id, device_id, status) VALUES ($1, 'xc_g2', $2, 'phone', 'done')`, [user, GONE]);
  await q(`INSERT INTO bookmarks (user_id, book_id, series_id, page) VALUES ($1, 'xc_g7', $2, 3)`, [user, GONE]);

  const r = await admin.mergeSeries(GONE, KEEP, { keepOnce: { userId: user } });

  // Reintroduce by dropping removeMergeDuplicates from mergeSeries: duplicates 0, and 2, 3 and 6 are listed twice.
  assert.equal(r.duplicates, 3, '2, 3 and 6 kept once');
  assert.equal(r.keptBoth, 1, '7 stays twice: a bookmark is in the other copy');
  assert.deepEqual(await rowsAt(2), ['xc_k2'], "the kept series' copy of 2 stays");
  assert.equal(existsSync(g2), false, "the other copy's file in the download folder is deleted");
  assert.equal(existsSync(k2), true);
  assert.deepEqual(await rowsAt(3), ['xc_k3']);
  // Reintroduce by deleting anywhere (drop the root test in deleteSetAside): Chapter 3 is counted deleted and is set
  // aside no longer, though its file is still there -- the next scan lists it twice again.
  assert.equal(existsSync(g3), true, "a file outside the download folder is never touched");
  const aside = await q(`SELECT root, file, kept_book_id, reason FROM set_aside_files`);
  assert.deepEqual(aside, [{ root: LIB, file: `${GONE_DIR}/Chapter 3.cbz`, kept_book_id: 'xc_k3', reason: 'duplicate' }], 'it is set aside');
  // Reintroduce by always keeping the kept series' copy (drop the partial test in chooseCopy): xc_k6 stays.
  assert.deepEqual(await rowsAt(6), ['xc_g6'], 'a partial kept copy gives way to a whole one');
  assert.equal(existsSync(k6), false);
  assert.equal(existsSync(g6), true);
  // Reintroduce by dropping the bookmark veto in removeCopy: 7 is kept once and the bookmark points at nothing.
  assert.deepEqual(await rowsAt(7), ['xc_g7', 'xc_k7'], 'a bookmarked copy stays');
  assert.equal(existsSync(g7), true);
  // Reintroduce by pairing a number whatever else holds it (kept[0] against other[0] in pairUp): an extra is deleted.
  assert.deepEqual(await rowsAt(5), ['xc_g5', 'xc_g5e', 'xc_k5'], 'a number one side held twice is never touched');
  assert.deepEqual(await rowsAt(4), ['xc_g4'], 'a chapter only the absorbed series had still moves');
  // No tombstone: the copy is off the list, not "Deleted from the server" beside the one that stays.
  assert.equal((await q(`SELECT count(*)::int AS n FROM lib_books WHERE id IN ('xc_g2', 'xc_g3', 'xc_k6')`))[0].n, 0);
  assert.equal((await q(`SELECT count(*)::int AS n FROM lib_books WHERE series_id = $1 AND pruned_at IS NOT NULL`, [KEEP]))[0].n, 0);

  // What was read moves: 2 stays finished; 3's page 10 of 20 is page 20 of the kept copy's 40. Reintroduce by deleting
  // the progress with the row (drop the INSERT in removeCopy): 2 reads unread.
  const prog = new Map((await q(`SELECT book_id, page, completed FROM read_progress WHERE user_id = $1`, [user])).map((p: any) => [p.book_id, p]));
  assert.equal(prog.get('xc_k2')?.completed, true, 'a finished chapter stays finished');
  assert.equal(prog.get('xc_k3')?.page, 20, 'the page is where it was, in the kept copy');
  assert.equal(prog.get('xc_k3')?.completed, false);
  assert.equal(prog.has('xc_g2') || prog.has('xc_g3'), false);
  assert.deepEqual((await q(`SELECT book_id FROM reading_events WHERE user_id = $1`, [user])).map((e: any) => e.book_id), ['xc_k2'], 'the history follows');
  assert.deepEqual((await q(`SELECT book_id FROM notes WHERE user_id = $1`, [user])).map((n: any) => n.book_id), ['xc_k2'], 'the note follows');
  assert.equal((await q(`SELECT count(*)::int AS n FROM offline_downloads WHERE book_id = 'xc_g2'`))[0].n, 0, "a device's saved copy of other pages is not the kept copy");
  const s = (await q(`SELECT books_count FROM lib_series WHERE id = $1`, [KEEP]))[0];
  assert.equal(Number(s.books_count), 10, 'the count is the list: 13 rows less the 3 removed');
  const audit = await q(`SELECT detail FROM audit_log WHERE event = 'series.extra_copies' AND detail->>'id' = $1`, [KEEP]);
  assert.equal(audit.length, 1, 'one audit line');
  assert.equal(audit[0].detail.removed, 3);
});

test('a merge that does not ask keeps both copies (Rescan everything\'s merges)', { skip }, async () => {
  await series(KEEP, 'Keep Tale', KEEP_DIR);
  await series(GONE, 'Gone Tale', GONE_DIR);
  await book('xc_k2', KEEP, DL, KEEP_DIR, 'Chapter 2.cbz', 2);
  const g2 = await book('xc_g2', GONE, DL, GONE_DIR, 'Chapter 2.cbz', 2);
  const r = await admin.mergeSeries(GONE, KEEP);
  assert.equal(r.duplicates, 0);
  assert.deepEqual(await rowsAt(2), ['xc_g2', 'xc_k2']);
  assert.equal(existsSync(g2), true);
});

test('a pair whose file is not reachable is left exactly as it is', { skip }, async () => {
  await series(KEEP, 'Keep Tale', KEEP_DIR);
  await series(GONE, 'Gone Tale', GONE_DIR);
  await book('xc_k2', KEEP, DL, KEEP_DIR, 'Chapter 2.cbz', 2);
  // Its folder is not there at all: an unmounted share looks like this, and a chapter somebody removed does not.
  await book('xc_g2', GONE, DL, 'T!xc/Unmounted', 'Chapter 2.cbz', 2, { noFile: true });
  const r = await admin.mergeSeries(GONE, KEEP, { keepOnce: { userId: user } });
  assert.equal(r.duplicates, 0);
  assert.equal(r.keptBoth, 1);
  assert.deepEqual(await rowsAt(2), ['xc_g2', 'xc_k2']);
});

test('a set-aside copy stays off the list through a scan, and a new file at its path is listed', { skip }, async () => {
  const { persistScan } = await import('../src/lib/library');
  const { downloadCensus, clearCensusCache } = await import('../src/lib/downloadCensus');
  await series(KEEP, 'Keep Tale', KEEP_DIR);
  await series(GONE, 'Gone Tale', GONE_DIR);
  await book('xc_k3', KEEP, DL, KEEP_DIR, 'Chapter 3.cbz', 3);
  const g3 = await book('xc_g3', GONE, LIB, GONE_DIR, 'Chapter 3.cbz', 3);
  await admin.mergeSeries(GONE, KEEP, { keepOnce: { userId: user } });
  assert.equal(existsSync(g3), true);
  // A download-folder file set aside too (an unlink that failed): the census must not call it missing from the library.
  const stray = join(DL, KEEP_DIR, 'Chapter 99.cbz');
  cbz(stray);
  // A day old: older than the scan below, so the census reads it as missing rather than "not scanned yet".
  const dayAgo = new Date(Date.now() - 24 * 3600_000);
  utimesSync(stray, dayAgo, dayAgo);
  const { stat } = await import('node:fs/promises');
  const st = await stat(stray);
  await q(`INSERT INTO set_aside_files (root, file, series_id, number, kept_book_id, reason, mtime, size)
           VALUES ($1, $2, $3, 99, NULL, 'duplicate', $4, $5)`, [DL, `${KEEP_DIR}/Chapter 99.cbz`, KEEP, Math.floor(st.mtimeMs), st.size]);

  await persistScan();
  const listed = async (root: string, file: string) =>
    Number((await q(`SELECT count(*)::int AS n FROM lib_books WHERE root = $1 AND file = $2`, [root, file]))[0].n);
  // Reintroduce by indexing every file (drop notSetAside in persistScan): both are listed again.
  assert.equal(await listed(LIB, `${GONE_DIR}/Chapter 3.cbz`), 0, 'the set-aside copy stays off the list');
  assert.equal(await listed(DL, `${KEEP_DIR}/Chapter 99.cbz`), 0);
  assert.deepEqual(await rowsAt(3), ['xc_k3']);
  clearCensusCache();
  const census = await downloadCensus({ force: true });
  // Reintroduce by counting it (drop the set-aside test in downloadCensus): Chapter 99 is "not in the library".
  assert.equal(census.missing.some((m) => m.folder.includes('Keep Tale')), false, 'a set-aside file is not a download missing from the library');

  // A different file at that path -- copied over it by hand -- is a chapter like any other.
  cbz(g3, 3);
  await persistScan();
  assert.equal(await listed(LIB, `${GONE_DIR}/Chapter 3.cbz`), 1, 'a new file at the path is listed');
  assert.equal((await q(`SELECT count(*)::int AS n FROM set_aside_files WHERE root = $1`, [LIB]))[0].n, 0, 'and is no longer set aside');
});

test('the merges made before v0.57.0 are kept once by themselves, once; a busy series waits', { skip }, async () => {
  const { claimWriterFolders } = await import('../src/lib/bulkNewest');
  await series(KEEP, 'Keep Tale', KEEP_DIR);
  await series(GONE, 'Gone Tale', GONE_DIR);
  // As v0.56.0 left a merge: the absorbed series points at its survivor, and every chapter of both is the survivor's.
  await book('xc_k1', KEEP, DL, KEEP_DIR, 'Chapter 1.cbz', 1);
  await book('xc_k2', KEEP, LIB, KEEP_DIR, 'Chapter 2.cbz', 2);
  const g1 = await book('xc_g1', KEEP, DL, GONE_DIR, 'Chapter 1.cbz', 1);
  const g2 = await book('xc_g2', KEEP, LIB, GONE_DIR, 'Chapter 2.cbz', 2);
  await book('xc_g3', KEEP, DL, GONE_DIR, 'Chapter 3.cbz', 3);
  await q(`UPDATE lib_series SET merged_into = $1 WHERE id = $2`, [KEEP, GONE]);

  // Busy: a download holds the survivor's folder. Nothing is touched, and nothing is stamped.
  const claim = claimWriterFolders([KEEP_DIR]);
  assert.ok(claim);
  const busy = await leftovers.cleanMergeLeftovers();
  claim!.release();
  assert.equal(busy.busy, 1);
  assert.equal(busy.removed, 0);
  assert.equal((await q(`SELECT count(*)::int AS n FROM schema_migrations WHERE id = $1`, [leftovers.LEFTOVERS_DONE]))[0].n, 0);

  // Reintroduce by stamping whatever happened (drop `if (!out.busy)` in cleanMergeLeftovers): the busy pass stamps
  // itself done, and the series is never cleaned.
  const r = await leftovers.cleanMergeLeftovers();
  assert.equal(r.removed, 2);
  assert.equal(r.deleted, 1, 'the download folder copy of 1 is deleted');
  assert.equal(r.setAside, 1, 'the library folder copy of 2 is set aside');
  assert.equal(existsSync(g1), false);
  assert.equal(existsSync(g2), true);
  assert.deepEqual(await rowsAt(1), ['xc_k1']);
  assert.deepEqual(await rowsAt(2), ['xc_k2']);
  assert.deepEqual(await rowsAt(3), ['xc_g3']);
  assert.equal((await q(`SELECT count(*)::int AS n FROM schema_migrations WHERE id = $1`, [leftovers.LEFTOVERS_DONE]))[0].n, 1, 'stamped done');
  const again = await leftovers.cleanMergeLeftovers();
  assert.equal(again.done, true, 'never again');
});

test('Health suggests keeping the copy whose source works, and says why', { skip }, async () => {
  const { registerAdapter } = await import('../src/lib/sources');
  const { duplicateSeries } = await import('../src/lib/health');
  const adapter = (id: string) => ({ id, name: `Site ${id}`, lang: 'en', async search() { return []; }, async getSeries() { return null; }, async listChapters() { return []; }, async getPageUrls() { return []; } });
  registerAdapter(adapter('xc-up') as any);
  registerAdapter(adapter('xc-off') as any);
  await q(`INSERT INTO source_health (source_id, disabled) VALUES ('xc-off', true) ON CONFLICT (source_id) DO UPDATE SET disabled = true`);
  // The bigger copy is on a switched-off source; the smaller one's source still updates it.
  await series(GONE, 'Big Tale', GONE_DIR, { source_id: 'xc-off', created_at: new Date('2025-01-01') });
  await series(KEEP, 'Big Tale Again', KEEP_DIR, { source_id: 'xc-up' });
  for (const n of [1, 2, 3]) await book(`xc_big${n}`, GONE, DL, GONE_DIR, `Chapter ${n}.cbz`, n);
  await book('xc_small1', KEEP, DL, KEEP_DIR, 'Chapter 1.cbz', 1);
  await q(`INSERT INTO series_trackers (series_id, provider, external_id, checked_at) VALUES ($1, 'anilist', 'xc-1', now()), ($2, 'anilist', 'xc-1', now())`, [GONE, KEEP]);
  try {
    const check = await duplicateSeries();
    const item = check.items.find((i) => i.seriesIds?.includes(KEEP));
    assert.ok(item, 'the pair is found');
    // Reintroduce chapters-first (sort by chapters before `works` in keepOrder): the switched-off copy is suggested.
    assert.equal(item!.keep, KEEP, 'the copy whose source works');
    const facts = new Map(item!.copies!.map((c) => [c.id, c]));
    assert.equal(facts.get(GONE)?.chapters, 3);
    assert.equal(facts.get(KEEP)?.chapters, 1);
    assert.deepEqual(facts.get(GONE)?.source, { id: 'xc-off', name: 'Site xc-off', standing: 'off' });
    assert.deepEqual(facts.get(KEEP)?.source, { id: 'xc-up', name: 'Site xc-up', standing: 'usable' });
    assert.deepEqual(item!.copies!.map((c) => c.id), item!.seriesIds, 'in the order of seriesIds');
  } finally {
    await q(`DELETE FROM source_health WHERE source_id IN ('xc-up', 'xc-off')`);
  }
});
