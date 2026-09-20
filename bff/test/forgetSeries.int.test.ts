// Forget: the only code path that hard-deletes a series row, and with it everyone's history on it.
//
// Two things make it dangerous, and the tests here are shaped around them:
//
//   1. RESURRECTION. persistScan skips a folder only while a deleted_at / merged_into row exists for it, so
//      forgetting a series whose folder is still on disk -- or whose files merely look gone because the
//      share is unmounted -- has the next scan mint a fresh id for the same folder, next to the history that
//      was just erased. Hence the refusals: live row, live chapter rows (an unmounted share leaves every row
//      live, because nothing marks a file it cannot see), a folder that still holds chapters, root
//      unreachable. A 'missing' tombstone is NOT a refusal: verify writes it only on a root it proved
//      mounted, so it means the file is gone, not hiding.
//   2. COLLATERAL. After a merge the absorbed row's chapters belong to the survivor, while bookmarks, progress
//      and tracker floors can still carry the absorbed id (older merges left them behind; an offline outbox
//      replays whatever series_id the phone had). A purge keyed on series_id erases live history on chapters
//      the reader can still open. Hence: re-point first, delete per-book rows by book id only, and refuse the
//      whole transaction if anything on someone else's chapter is still filed here.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile, stat } from 'fs/promises';
import { readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const DSN = process.env.TEST_DATABASE_URL;
const ROOT = join(tmpdir(), `uchiyomi-fg-${process.pid}`);
const DL = join(tmpdir(), `uchiyomi-fgdl-${process.pid}`);
const CONFIG = join(tmpdir(), `uchiyomi-fgcfg-${process.pid}`);

if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = CONFIG;
  process.env.LIBRARY_ROOT = ROOT;
  process.env.DL_ROOT = DL;
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

let q: <T = any>(sql: string, params?: any[]) => Promise<T[]>;
let admin: typeof import('../src/lib/libraryAdmin');
let artFile: (id: string, kind: 'cover' | 'banner') => string;
let app: any;
let auth: Record<string, string>;

const SRC = 'T!fg';
// S = the series under test, O = an unrelated one that must survive untouched, A/B = a merge pair,
// C/D = a second merge pair whose marker must not be disturbed.
const S = 's_fg_gone', O = 's_fg_other', A = 's_fg_absorbed', B = 's_fg_survivor', C = 's_fg_c', D = 's_fg_d';
const ALL = [S, O, A, B, C, D];
const users: string[] = [];
const exists = (p: string) => stat(p).then(() => true).catch(() => false);

/** Every table with a series_id column, the way the purge must leave them: nothing for the forgotten ids. */
const SERIES_TABLES = [
  'lib_books', 'read_progress', 'reading_events', 'bookmarks', 'notes', 'offline_downloads', 'favorites',
  'collection_items', 'ratings', 'series_colors', 'series_art', 'series_seen', 'series_trackers', 'series_overrides',
  'series_sources', 'series_listing', 'chapter_failures', 'tracker_progress',
];
const BOOK_TABLES = ['read_progress', 'reading_events', 'bookmarks', 'notes', 'offline_downloads', 'book_overrides', 'page_hashes'];

async function series(id: string, title: string, opts: { deleted?: boolean; mergedInto?: string } = {}) {
  await q(
    `INSERT INTO lib_series (id, source, title, folder, books_count, deleted_at, merged_into)
     VALUES ($1,$2,$3,$4,0,$5,$6)`,
    [id, SRC, title, `${SRC}/${id}`, opts.deleted ? new Date() : null, opts.mergedInto ?? null],
  );
}
async function book(id: string, sid: string, n: number, opts: { pruned?: 'deleted' | 'missing' | 'cleanup'; root?: string } = {}) {
  await q(
    `INSERT INTO lib_books (id, series_id, source, file, number, title, mtime, root, pruned_at, pruned_reason)
     VALUES ($1,$2,$3,$4,$5,$1,$6,$7,$8,$9)`,
    [id, sid, SRC, `${SRC}/${sid}/ch${n}.cbz`, n, 1000 * n, opts.root ?? ROOT,
     opts.pruned ? new Date() : null, opts.pruned === 'cleanup' ? null : opts.pruned ?? null],
  );
}

/** One row of everything a member can own about a series, on its first book. */
async function history(uid: string, sid: string, bid: string) {
  await q(`INSERT INTO read_progress (user_id, book_id, series_id, page, completed) VALUES ($1,$2,$3,5,true)`, [uid, bid, sid]);
  await q(`INSERT INTO reading_events (user_id, series_id, book_id, page, completed) VALUES ($1,$2,$3,5,true)`, [uid, sid, bid]);
  await q(`INSERT INTO bookmarks (user_id, book_id, series_id, page, note) VALUES ($1,$2,$3,2,'here')`, [uid, bid, sid]);
  await q(`INSERT INTO notes (user_id, series_id, book_id, body) VALUES ($1,$2,$3,'a chapter note')`, [uid, sid, bid]);
  await q(`INSERT INTO notes (user_id, series_id, book_id, body) VALUES ($1,$2,NULL,'a series note')`, [uid, sid]);
  await q(`INSERT INTO offline_downloads (user_id, book_id, series_id, device_id, status) VALUES ($1,$2,$3,'dev','done')`, [uid, bid, sid]);
  await q(`INSERT INTO favorites (user_id, series_id) VALUES ($1,$2)`, [uid, sid]);
  await q(`INSERT INTO ratings (user_id, series_id, stars) VALUES ($1,$2,4)`, [uid, sid]);
  await q(`INSERT INTO series_seen (user_id, series_id, seen_books_count) VALUES ($1,$2,1)`, [uid, sid]);
  await q(`INSERT INTO tracker_progress (user_id, series_id, provider, chapters) VALUES ($1,$2,'anilist',5)`, [uid, sid]);
  const c = await q<{ id: string }>(`INSERT INTO collections (user_id, name) VALUES ($1,$2) RETURNING id`, [uid, `fg-${sid}`]);
  await q(`INSERT INTO collection_items (collection_id, series_id, position) VALUES ($1,$2,0)`, [c[0].id, sid]);
}
/** The series-level rows nobody owns. */
async function derived(sid: string, bid: string) {
  await q(`INSERT INTO series_colors (series_id, color) VALUES ($1,'#123456')`, [sid]);
  await q(`INSERT INTO series_art (series_id, banner, cover) VALUES ($1,'b','c')`, [sid]);
  await q(`INSERT INTO series_trackers (series_id, provider, external_id) VALUES ($1,'anilist','42')`, [sid]);
  await q(`INSERT INTO series_overrides (series_id, title) VALUES ($1,'Override')`, [sid]);
  await q(`INSERT INTO series_sources (series_id, source_id, source_series_id) VALUES ($1,'src','x')`, [sid]);
  await q(`INSERT INTO series_listing (series_id, number, source_id, chosen) VALUES ($1,9,'src','{}')`, [sid]);
  await q(`INSERT INTO chapter_failures (series_id, number, source_id, status) VALUES ($1,9,'src','failed')`, [sid]);
  await q(`INSERT INTO book_overrides (book_id, number) VALUES ($1,1.5)`, [bid]);
  await q(`INSERT INTO page_hashes (book_id, page, hash) VALUES ($1,0,'h')`, [bid]);
  await mkdir(CONFIG + '/series-art', { recursive: true });
  await writeFile(artFile(sid, 'cover'), 'art');
}

const rowsFor = (t: string, col: string, ids: string[]) =>
  q(`SELECT 1 FROM ${t} WHERE ${col} = ANY($1)`, [ids]).then((r) => r.length);

async function wipe() {
  const books = (await q<{ id: string }>(`SELECT id FROM lib_books WHERE source = $1`, [SRC])).map((b) => b.id);
  for (const t of BOOK_TABLES) await q(`DELETE FROM ${t} WHERE book_id = ANY($1)`, [books]).catch(() => {});
  for (const t of SERIES_TABLES) await q(`DELETE FROM ${t} WHERE series_id = ANY($1)`, [ALL]).catch(() => {});
  await q(`DELETE FROM collections WHERE name LIKE 'fg-%'`).catch(() => {});
  await q(`DELETE FROM lib_series WHERE source = $1`, [SRC]);
  await q(`DELETE FROM audit_log WHERE event = 'series.forget' AND detail->>'id' = ANY($1)`, [ALL]).catch(() => {});
  for (const d of [ROOT, DL]) {
    await rm(d, { recursive: true, force: true }).catch(() => {});
    await mkdir(d, { recursive: true });
  }
}

before(async () => {
  if (!DSN) return;
  await mkdir(ROOT, { recursive: true });
  await mkdir(DL, { recursive: true });
  await mkdir(CONFIG, { recursive: true });
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  admin = await import('../src/lib/libraryAdmin');
  ({ artFile } = await import('../src/lib/seriesArt'));
  await migrate();
  for (const name of ['fg_one', 'fg_two', 'fg_admin']) {
    await q(`DELETE FROM users WHERE username = $1`, [name]);
    const r = await q<{ id: string }>(
      `INSERT INTO users (display_name, username, role, password_hash, auth_kind) VALUES ($1,$1,$2,'x','password') RETURNING id`,
      [name, name === 'fg_admin' ? 'admin' : 'user'],
    );
    users.push(r[0].id);
  }
  // The real route, so the confirmation, the status codes and the audit row are exercised through the
  // endpoint rather than asserted around it.
  const adminRoutes = (await import('../src/routes/admin')).default;
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register(adminRoutes);
  await app.ready();
  auth = { authorization: `Bearer ${app.jwt.sign({ sub: users[2], role: 'admin' })}` };
});

beforeEach(async () => { if (DSN) await wipe(); });

after(async () => {
  if (!DSN) return;
  await wipe().catch(() => {});
  await app?.close();
  await q(`DELETE FROM users WHERE username = ANY($1)`, [['fg_one', 'fg_two', 'fg_admin']]).catch(() => {});
  for (const d of [ROOT, DL, CONFIG]) await rm(d, { recursive: true, force: true }).catch(() => {});
});

// ---- refusals ----

test('forget refuses a series that is still in the library', { skip }, async () => {
  // Remove first, always: hiding is undoable and forgetting is not, so the escalation order is enforced
  // here and not only in the UI. Reintroduce by dropping the `!row.deleted_at && !row.merged_into` check:
  // the row below is gone.
  await series(S, 'Live');
  await book('b_fg_1', S, 1, { pruned: 'deleted' });
  const r = await admin.forgetSeries(S);
  assert.equal(r.ok, false);
  assert.equal((r as any).refused, 'live');
  assert.match((r as any).message, /Remove the series first/);
  assert.equal(await rowsFor('lib_series', 'id', [S]), 1, 'a refused forget must not touch anything');
});

test('forget refuses while any chapter row still claims a file', { skip }, async () => {
  // A live row means bytes on disk, and a folder on disk is rescanned as a brand-new series the moment the
  // hidden row that was protecting it is gone. Reintroduce by dropping the `live` refusal: the row is gone.
  await series(S, 'Half', { deleted: true });
  await book('b_fg_1', S, 1, { pruned: 'deleted' });
  await book('b_fg_2', S, 2);
  const r = await admin.forgetSeries(S);
  assert.equal(r.ok, false);
  assert.equal((r as any).refused, 'live_books');
  // "claims", not "is on disk": the row is the only witness, and on a share that is not mounted the file is
  // not on any disk we can see. The old wording told a #55 admin the opposite of the truth.
  assert.match((r as any).message, /1 chapter row still claims a file on disk/);
  assert.equal((r as any).fix, 'Delete files, then Forget.');
  assert.equal(await rowsFor('lib_series', 'id', [S]), 1);
});

test('a series whose chapters went missing on a mounted share can be forgotten', { skip }, async () => {
  // ⚠️ 'missing' is verify's mark, and verify writes it ONLY on a root it proved mounted (its whole-batch
  // rule): the file was not there while the disk was. An unmounted share never produces it -- it leaves
  // every row LIVE, which the live_books refusal above catches. Until v0.38.0's fix pass this refused with
  // "Mount the library" on a mounted library, and the Delete files chip (live_books 0) was hidden, so the
  // series could never be forgotten (R3's probe P3). Reintroduce by refusing on `pruned_reason = 'missing'`:
  // r.ok reads false.
  await series(S, 'Restored without files', { deleted: true });
  await book('b_fg_1', S, 1, { pruned: 'deleted', root: DL });
  await book('b_fg_2', S, 2, { pruned: 'missing', root: DL });
  const r = await admin.forgetSeries(S);
  assert.equal(r.ok, true, r.ok ? '' : (r as any).message);
  assert.equal(r.books, 2);
  assert.equal(await rowsFor('lib_series', 'id', [S]), 0);
});

test('a read-library series whose folder was removed by hand can be forgotten after Delete files', { skip }, async () => {
  // #55's own scenario: the admin rm -rf'd the folder on the NAS, then Remove. Nothing in the app ever
  // marks a read-library row, so both rows stay live, the Removed row offers Delete files (live_books 2),
  // and Delete files must reconcile them -- the root is provably mounted, another series' file is right
  // there -- so that live_books drops to 0, the row offers Forget, and Forget goes through. Reintroduce by
  // dropping the reconciliation in deleteSeriesFiles (`if (!st) continue;` and nothing else): live_books
  // reads 2 and the forget is refused.
  await series(S, 'By Hand', { deleted: true });
  await book('b_fg_1', S, 1);
  await book('b_fg_2', S, 2);
  await series(O, 'Neighbour');
  await book('b_fg_o1', O, 1);
  await mkdir(join(ROOT, SRC, O), { recursive: true });
  await writeFile(join(ROOT, SRC, O, 'ch1.cbz'), 'still here');
  await history(users[0], S, 'b_fg_1');

  const df = await admin.deleteSeriesFiles(S);
  assert.equal(df.ok, true, df.ok ? '' : (df as any).reason);
  assert.equal(df.files, 0, 'nothing was on disk to unlink');
  const list = await app.inject({ method: 'GET', url: '/api/admin/series/deleted', headers: auth });
  const row = list.json().content.find((x: any) => x.id === S);
  assert.equal(row.live_books, 0, 'the Removed row still hides Forget behind live rows whose files are long gone');
  assert.equal(row.pruned_books, 2);
  const reasons = await q<{ pruned_reason: string }>(`SELECT pruned_reason FROM lib_books WHERE series_id = $1`, [S]);
  assert.deepEqual(reasons.map((x) => x.pruned_reason), ['deleted', 'deleted'], "the rows must say 'deleted', or the sweep fetches them back");

  const r = await admin.forgetSeries(S);
  assert.equal(r.ok, true, r.ok ? '' : (r as any).message);
  assert.equal(r.users, 1);
  assert.equal(await rowsFor('lib_series', 'id', [S]), 0);
  assert.equal(await rowsFor('lib_books', 'series_id', [O]), 1, "the neighbour's row was touched");
  assert.equal(await exists(join(ROOT, SRC, O, 'ch1.cbz')), true, "the neighbour's file was touched");
});

test('forget refuses while the folder still holds chapters on any root', { skip }, async () => {
  // Every row is a tombstone (the cleanup let the bytes go) but the folder itself is still there under the
  // download root with a chapter in it -- a re-download, a hand copy. persistScan would file it as new.
  // Reintroduce by dropping the folder loop: the row is gone.
  await series(S, 'Folder', { deleted: true });
  await book('b_fg_1', S, 1, { pruned: 'cleanup', root: DL });
  await mkdir(join(DL, SRC, S), { recursive: true });
  await writeFile(join(DL, SRC, S, 'ch7.cbz'), 'back');
  const r = await admin.forgetSeries(S);
  assert.equal(r.ok, false);
  assert.equal((r as any).refused, 'folder_present');
  assert.match((r as any).message, new RegExp(`"${SRC}/${S}" still holds chapters under`));
  assert.equal(await rowsFor('lib_series', 'id', [S]), 1);
});

test("forget of a survivor after Delete files is not refused on the absorbed row's empty folder", { skip }, async () => {
  // The scanner's rule: findSeriesDirs lists a directory only when listChapters finds something in it, so an
  // empty folder cannot come back as a series. Delete files on a survivor used to unlink the absorbed
  // row's files (they moved to the survivor) and leave its directory standing, and Forget then refused
  // forever on a folder that could resurrect nothing, with the Delete files chip already hidden (R3's probe
  // P2). Reintroduce by refusing on `realpath` alone in the folder loop: refused reads folder_present.
  await series(B, 'Survivor', { deleted: true });
  await series(A, 'Absorbed', { mergedInto: B });
  await book('b_fg_b1', B, 1);
  await book('b_fg_a1', B, 2); // moved by the merge; its file is still under A's folder
  await q(`UPDATE lib_books SET file = $1 WHERE id = 'b_fg_a1'`, [`${SRC}/${A}/ch2.cbz`]);
  for (const [sid, name] of [[B, 'ch1.cbz'], [A, 'ch2.cbz']]) {
    await mkdir(join(ROOT, SRC, sid), { recursive: true });
    await writeFile(join(ROOT, SRC, sid, name), 'bytes');
  }
  const df = await admin.deleteSeriesFiles(B);
  assert.equal(df.ok, true, df.ok ? '' : (df as any).reason);
  assert.equal(df.files, 2);
  // Belt and braces: even if a folder were left (or re-created empty by a sweep), Forget must not refuse on it.
  await mkdir(join(ROOT, SRC, A), { recursive: true });
  const r = await admin.forgetSeries(B);
  assert.equal(r.ok, true, r.ok ? '' : `${(r as any).refused}: ${(r as any).message}`);
  assert.equal(r.absorbed, 1);
  assert.equal(await rowsFor('lib_series', 'id', [A, B]), 0);
});

test('forget refuses while a root it would have to check is not there', { skip }, async () => {
  // A root that cannot be stat'ed is the unmounted case with no tombstones to show for it: "absent" is not
  // an answer it can give. Reintroduce by dropping the `stat(root)` check: the row is gone.
  await series(S, 'NoRoot', { deleted: true });
  await book('b_fg_1', S, 1, { pruned: 'deleted' });
  await rm(DL, { recursive: true, force: true });
  try {
    const r = await admin.forgetSeries(S);
    assert.equal(r.ok, false);
    assert.equal((r as any).refused, 'missing_files');
    assert.match((r as any).message, /is not there right now/);
    assert.equal(await rowsFor('lib_series', 'id', [S]), 1);
  } finally {
    await mkdir(DL, { recursive: true });
  }
});

// ---- the purge ----

test('forget leaves zero rows for the series in every table and nothing else is touched', { skip }, async () => {
  // Per table, on purpose: four of these have no foreign key (reading_events, offline_downloads, bookmarks,
  // tracker_progress) and would orphan silently if the purge forgot one. Reintroduce by removing any table
  // from SERIES_KEYED_TABLES / BOOK_KEYED_TABLES in forgetSeries: its assertion below names it.
  await series(S, 'Gone', { deleted: true });
  await book('b_fg_1', S, 1, { pruned: 'deleted' });
  await book('b_fg_2', S, 2, { pruned: 'deleted', root: DL });
  await series(O, 'Other');
  await book('b_fg_o1', O, 1);
  for (const u of [users[0], users[1]]) {
    await history(u, S, 'b_fg_1');
    await history(u, O, 'b_fg_o1');
  }
  await derived(S, 'b_fg_1');
  await derived(O, 'b_fg_o1');
  const statsBefore = await q<{ chapters_completed: string; series_touched: string }>(
    `SELECT chapters_completed, series_touched FROM reading_stats WHERE user_id = $1`, [users[0]]);

  const r = await admin.forgetSeries(S);
  assert.equal(r.ok, true, r.ok ? '' : (r as any).message);
  assert.equal(r.books, 2);
  assert.equal(r.absorbed, 0);
  assert.equal(r.users, 2, 'both members lost history here');

  for (const t of SERIES_TABLES) {
    assert.equal(await rowsFor(t, 'series_id', [S]), 0, `${t} still has rows for the forgotten series`);
  }
  for (const t of BOOK_TABLES) {
    assert.equal(await rowsFor(t, 'book_id', ['b_fg_1', 'b_fg_2']), 0, `${t} still has rows for its chapters`);
  }
  assert.equal(await rowsFor('lib_series', 'id', [S]), 0);
  assert.equal(await exists(artFile(S, 'cover')), false, 'the art file on disk was left behind');

  // The other series, and both members' rows on it, are exactly as they were.
  for (const t of SERIES_TABLES) {
    const want = ['lib_books', 'series_colors', 'series_art', 'series_trackers', 'series_overrides', 'series_sources',
                  'series_listing', 'chapter_failures'].includes(t) ? 1 : t === 'notes' ? 4 : 2;
    assert.equal(await rowsFor(t, 'series_id', [O]), want, `${t} lost rows belonging to another series`);
  }
  assert.equal(await rowsFor('book_overrides', 'book_id', ['b_fg_o1']), 1);
  assert.equal(await rowsFor('page_hashes', 'book_id', ['b_fg_o1']), 1);
  assert.equal(await exists(artFile(O, 'cover')), true);
  assert.equal((await q(`SELECT 1 FROM collections WHERE user_id = $1`, [users[0]])).length, 2, 'a collection itself must survive; only its item goes');

  // And the stats view moved, which is the whole reason this is a separate, typed step.
  const statsAfter = await q<{ chapters_completed: string; series_touched: string }>(
    `SELECT chapters_completed, series_touched FROM reading_stats WHERE user_id = $1`, [users[0]]);
  assert.equal(Number(statsBefore[0].series_touched), 2);
  assert.equal(Number(statsAfter[0].series_touched), 1, 'reading_stats still counts the forgotten series');
  assert.equal(Number(statsAfter[0].chapters_completed), Number(statsBefore[0].chapters_completed) - 1);
});

test('forget of a series with no chapter rows at all still works', { skip }, async () => {
  // A hidden series that never had a chapter (or lost them to an older version) cannot go through Delete
  // files ("no files on disk"), and must not be stuck forever between the two.
  await series(S, 'Empty', { deleted: true });
  const r = await admin.forgetSeries(S);
  assert.equal(r.ok, true, r.ok ? '' : (r as any).message);
  assert.equal(r.books, 0);
  assert.equal(await rowsFor('lib_series', 'id', [S]), 0);
});

// ---- merges ----

test('merge: a bookmark follows its chapter to the survivor', { skip }, async () => {
  // Reintroduce by dropping 'bookmarks' from the re-point loop in mergeSeries: the bookmark below is still
  // filed under the absorbed id.
  await series(A, 'Absorbed');
  await series(B, 'Survivor');
  await book('b_fg_a1', A, 1);
  await book('b_fg_b1', B, 1);
  await q(`INSERT INTO bookmarks (user_id, book_id, series_id, page, note) VALUES ($1,'b_fg_a1',$2,3,'x')`, [users[0], A]);
  await admin.mergeSeries(A, B);
  const bm = await q<{ series_id: string }>(`SELECT series_id FROM bookmarks WHERE user_id = $1 AND book_id = 'b_fg_a1'`, [users[0]]);
  assert.equal(bm.length, 1, 'the bookmark was lost in the merge');
  assert.equal(bm[0].series_id, B, 'the bookmark still names the absorbed series');
});

test('merge: the tracker floor carries to the survivor and never goes backwards', { skip }, async () => {
  // A floor is the high-water mark already told to AniList; the lower of two would rewind the real entry on
  // the next push. Reintroduce by dropping the GREATEST (or the whole carry): users[0] reads 3, or nothing.
  await series(A, 'Absorbed');
  await series(B, 'Survivor');
  await book('b_fg_a1', A, 1);
  await book('b_fg_b1', B, 1);
  await q(`INSERT INTO tracker_progress (user_id, series_id, provider, chapters) VALUES ($1,$2,'anilist',12)`, [users[0], A]);
  await q(`INSERT INTO tracker_progress (user_id, series_id, provider, chapters) VALUES ($1,$2,'anilist',3)`, [users[0], B]);
  await q(`INSERT INTO tracker_progress (user_id, series_id, provider, chapters) VALUES ($1,$2,'anilist',7)`, [users[1], A]);
  await admin.mergeSeries(A, B);
  const rows = await q<{ user_id: string; chapters: number }>(`SELECT user_id, chapters FROM tracker_progress WHERE series_id = $1`, [B]);
  assert.equal(rows.find((r) => r.user_id === users[0])?.chapters, 12, "the survivor's lower floor won");
  assert.equal(rows.find((r) => r.user_id === users[1])?.chapters, 7, 'the other member\'s floor did not carry over');
  assert.equal(await rowsFor('tracker_progress', 'series_id', [A]), 0, 'a stale floor was left under the absorbed id');
});

test('forget keeps a bookmark and progress on a chapter that moved to the survivor', { skip }, async () => {
  // The rows an OLDER merge left behind, or an offline outbox replayed: a bookmark and a progress row that
  // still carry the absorbed series_id while their chapter belongs to the survivor. Forgetting the absorbed
  // row must move them, not erase them -- the reader can still open that chapter. Reintroduce by deleting
  // bookmarks (or read_progress) by series_id before the re-point loop, or by dropping 'bookmarks' from
  // BOOK_KEYED_USER_TABLES: the rows below are gone.
  await series(A, 'Absorbed');
  await series(B, 'Survivor');
  await book('b_fg_a1', A, 1);
  await book('b_fg_b1', B, 1);
  await admin.mergeSeries(A, B);
  // the stale rows, inserted the way a pre-v0.38.0 merge or an outbox replay leaves them
  await q(`INSERT INTO bookmarks (user_id, book_id, series_id, page, note) VALUES ($1,'b_fg_a1',$2,3,'keep me')`, [users[0], A]);
  await q(`INSERT INTO read_progress (user_id, book_id, series_id, page, completed) VALUES ($1,'b_fg_a1',$2,9,true)`, [users[0], A]);
  await q(`INSERT INTO reading_events (user_id, series_id, book_id, page, completed) VALUES ($1,$2,'b_fg_a1',9,true)`, [users[0], A]);

  const r = await admin.forgetSeries(A);
  assert.equal(r.ok, true, r.ok ? '' : (r as any).message);
  assert.equal(r.books, 0, 'an absorbed row owns no chapters');
  const bm = await q<{ series_id: string; note: string }>(`SELECT series_id, note FROM bookmarks WHERE user_id = $1 AND book_id = 'b_fg_a1'`, [users[0]]);
  assert.equal(bm[0]?.note, 'keep me', 'a live bookmark on a chapter the reader can still open was erased');
  assert.equal(bm[0]?.series_id, B, 'the bookmark was left filed under a series that no longer exists');
  const rp = await q<{ series_id: string; page: number }>(`SELECT series_id, page FROM read_progress WHERE user_id = $1 AND book_id = 'b_fg_a1'`, [users[0]]);
  assert.equal(rp[0]?.page, 9, 'reading progress on a survivor\'s chapter was erased');
  assert.equal(rp[0]?.series_id, B);
  assert.equal((await q(`SELECT 1 FROM reading_events WHERE book_id = 'b_fg_a1' AND series_id = $1`, [B])).length, 1, 'the reading event did not follow');
  assert.equal(await rowsFor('lib_series', 'id', [A]), 0, 'the absorbed row itself must go');
  assert.equal(await rowsFor('lib_books', 'series_id', [B]), 2, 'the survivor lost chapters');
});

test('forget of a survivor takes the rows it absorbed with it, and leaves other merges alone', { skip }, async () => {
  // `merged_into` is ON DELETE SET NULL. Deleting only the survivor would flip every row merged into it to
  // live -- no books, a stale books_count, and a folder the next scan repopulates under the old id.
  // Reintroduce by deleting `WHERE id = $1` instead of `= ANY($ids)`: A below reads live.
  await series(B, 'Survivor', { deleted: true });
  await series(A, 'Absorbed', { mergedInto: B });
  await book('b_fg_b1', B, 1, { pruned: 'deleted' });
  await book('b_fg_a1', B, 2, { pruned: 'deleted' }); // moved by the merge
  await series(D, 'Other survivor');
  await series(C, 'Other absorbed', { mergedInto: D });
  await book('b_fg_d1', D, 1);
  await history(users[0], B, 'b_fg_b1');
  await q(`INSERT INTO tracker_progress (user_id, series_id, provider, chapters) VALUES ($1,$2,'anilist',2)`, [users[1], A]);

  const r = await admin.forgetSeries(B);
  assert.equal(r.ok, true, r.ok ? '' : (r as any).message);
  assert.equal(r.absorbed, 1);
  assert.equal(r.books, 2);
  assert.equal(r.users, 2, 'the member whose only trace was a floor under the absorbed id was not counted');
  assert.equal(await rowsFor('lib_series', 'id', [A, B]), 0, 'an absorbed row was left behind (and is now live)');
  assert.equal(await rowsFor('tracker_progress', 'series_id', [A]), 0);
  const c = await q<{ merged_into: string }>(`SELECT merged_into FROM lib_series WHERE id = $1`, [C]);
  assert.equal(c[0].merged_into, D, 'an unrelated merge marker was disturbed');
});

test('forget of a survivor refuses while an absorbed folder still holds chapters', { skip }, async () => {
  // The scanner files a merged folder's chapters under the survivor, so the absorbed folder coming back is
  // the same resurrection by another path. Reintroduce by checking only `row.folder`: B is gone.
  await series(B, 'Survivor', { deleted: true });
  await series(A, 'Absorbed', { mergedInto: B });
  await book('b_fg_b1', B, 1, { pruned: 'deleted' });
  await mkdir(join(ROOT, SRC, A), { recursive: true });
  await writeFile(join(ROOT, SRC, A, 'ch3.cbz'), 'back');
  const r = await admin.forgetSeries(B);
  assert.equal(r.ok, false);
  assert.equal((r as any).refused, 'folder_present');
  assert.equal(await rowsFor('lib_series', 'id', [A, B]), 2);
});

test('users counts members who lose history, not a NEW badge or a carried tracker floor', { skip }, async () => {
  // The toast reads "N members' history on it is gone", so N must be members who lose HISTORY. series_seen
  // is the NEW-badge counter -- a member who only opened the series page has a row -- and an absorbed row's
  // tracker floor is carried to its survivor, not lost (R3's probe P8). Reintroduce by adding series_seen
  // back to the UNION, or by counting tracker_progress over every id: one of the two counts below reads 1
  // too many.
  await series(S, 'Glanced at', { deleted: true });
  await book('b_fg_1', S, 1, { pruned: 'deleted' });
  await history(users[0], S, 'b_fg_1');
  await q(`INSERT INTO series_seen (user_id, series_id, seen_books_count) VALUES ($1,$2,1)`, [users[1], S]);
  const r = await admin.forgetSeries(S);
  assert.equal(r.ok, true, r.ok ? '' : (r as any).message);
  assert.equal(r.users, 1, 'a member who only ever opened the series page was counted as losing history');

  await series(B, 'Survivor');
  await series(A, 'Absorbed', { mergedInto: B });
  await book('b_fg_b1', B, 1);
  await q(`INSERT INTO tracker_progress (user_id, series_id, provider, chapters) VALUES ($1,$2,'anilist',9)`, [users[1], A]);
  const r2 = await admin.forgetSeries(A);
  assert.equal(r2.ok, true, r2.ok ? '' : (r2 as any).message);
  assert.equal(r2.users, 0, 'a tracker floor that was carried to the survivor was counted as lost');
  const floor = await q<{ chapters: number }>(`SELECT chapters FROM tracker_progress WHERE user_id = $1 AND series_id = $2`, [users[1], B]);
  assert.equal(floor[0]?.chapters, 9, 'the floor did not reach the survivor');
});

test('every table that names a series or a book is one the purge covers', { skip }, async () => {
  // The three hand-written table lists in forgetSeries are checked against the schema itself, so a table
  // added later with a series_id / book_id column -- four of today's have no foreign key, which is the
  // pattern this schema keeps adding -- fails here instead of orphaning rows on every forget with nothing
  // noticing. The purge reports `rowsByTable` for every table it touched (count 0 included), and
  // read_progress is deleted through book_id only, so it is added by name. Reintroduce by creating a scratch
  // table with a series_id column inside the test (`CREATE TABLE fg_scratch (series_id text)`) before the
  // forget: it is named below as uncovered.
  await series(S, 'Coverage', { deleted: true });
  await book('b_fg_1', S, 1, { pruned: 'deleted' });
  await history(users[0], S, 'b_fg_1');
  await derived(S, 'b_fg_1');
  const r = await admin.forgetSeries(S);
  assert.equal(r.ok, true, r.ok ? '' : (r as any).message);
  const covered = new Set([...Object.keys(r.rowsByTable).map((k) => k.split(':')[0]), 'read_progress', 'lib_series', 'lib_books']);

  const byColumn = await q<{ table_name: string }>(
    `SELECT DISTINCT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name IN ('series_id', 'book_id')`);
  const byFk = await q<{ table_name: string }>(
    `SELECT DISTINCT c.conrelid::regclass::text AS table_name FROM pg_constraint c
      WHERE c.contype = 'f' AND c.confrelid IN ('lib_series'::regclass, 'lib_books'::regclass)`);
  const need = new Set([...byColumn, ...byFk].map((x) => x.table_name));
  // Views are not tables the purge has to touch.
  const views = new Set((await q<{ table_name: string }>(`SELECT table_name FROM information_schema.views WHERE table_schema = 'public'`)).map((x) => x.table_name));
  const uncovered = [...need].filter((t) => !views.has(t) && !covered.has(t));
  assert.deepEqual(uncovered, [], `forgetSeries does not purge: ${uncovered.join(', ')} -- add it to the table lists in libraryAdmin.ts`);
  assert.ok(need.size >= 20, `the schema probe found only ${need.size} tables; it is not looking at the right database`);
});

test('the assertion leaves the transaction by throwing, so a trip rolls the per-book deletes back', () => {
  // Static, because the assertion is unreachable by data: step (1) re-points exactly the rows it looks for,
  // in the same transaction. What it guards is a future edit that drops or reorders step (1) -- and at that
  // point a refusal RETURNED from the tx callback would commit the per-book deletes of step (2) and answer
  // "Nothing was changed". Reintroduce by returning the refusal object instead of throwing Stranded.
  const src = readFileSync(join(__dirname, '..', 'src', 'lib', 'libraryAdmin.ts'), 'utf8');
  const block = src.slice(src.indexOf('if (stranded.length) {'), src.indexOf("refused: 'stranded'"));
  assert.match(block, /throw new Stranded\(\{/, 'the stranded refusal must be thrown out of the transaction');
  assert.doesNotMatch(block, /\breturn \{/, 'a returned refusal commits the deletes already made');
  assert.match(src, /if \(e instanceof Stranded\) return e\.refusal;/, 'forgetSeries must convert the throw back into a refusal');
});

// ---- the route ----
//
// Separate tests rather than subtests: the top-level beforeEach wipes before every subtest too, which
// would take the seeded series away between them.

/** A hidden series with one LIVE chapter and one member's history on it. */
async function seedForRoute() {
  await series(S, 'Gone', { deleted: true });
  await book('b_fg_1', S, 1);
  await history(users[0], S, 'b_fg_1');
}
const forget = (id: string, payload: unknown, headers = auth) =>
  app.inject({ method: 'POST', url: `/api/admin/series/${id}/forget`, headers, payload });

test('route: a wrong title is a 400 and changes nothing', { skip }, async () => {
  await seedForRoute();
  const res = await forget(S, { confirm: 'gone' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'confirm_mismatch');
  assert.equal(await rowsFor('lib_series', 'id', [S]), 1);
});

test('route: a typed NFC title confirms an NFD one', { skip }, async () => {
  // A folder or ComicInfo.xml written on macOS carries "Cafe" + U+0301; every keyboard types U+00E9. Byte
  // for byte those never match, so the series could never be confirmed -- on either route (R3's probe
  // P6). Reintroduce by comparing `.trim()` alone in sameTitle (routes/admin.ts): both answers read 400.
  const nfd = 'Café Story';
  const nfc = 'Café Story';
  assert.notEqual(nfd, nfc, 'the fixture must be two different byte strings');
  await series(S, nfd, { deleted: true });
  await book('b_fg_1', S, 1);
  const df = await app.inject({ method: 'POST', url: `/api/admin/series/${S}/delete-files`, headers: auth, payload: { confirm: nfc } });
  assert.notEqual(df.json().error, 'confirm_mismatch', `delete-files: ${df.body}`);
  await q(`UPDATE lib_books SET pruned_at = now(), pruned_reason = 'deleted' WHERE series_id = $1`, [S]);
  const res = await forget(S, { confirm: nfc });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(await rowsFor('lib_series', 'id', [S]), 0);
});

test('route: no body is a 400, an unknown series a 404, a member a 403', { skip }, async () => {
  await seedForRoute();
  assert.equal((await forget(S, {})).statusCode, 400);
  assert.equal((await forget(S, {})).json().error, 'bad_request');
  assert.equal((await forget('s_fg_nope', { confirm: 'x' })).statusCode, 404);
  const member = { authorization: `Bearer ${app.jwt.sign({ sub: users[0], role: 'user' })}` };
  assert.equal((await forget(S, { confirm: 'Gone' }, member)).statusCode, 403);
  assert.equal(await rowsFor('lib_series', 'id', [S]), 1);
});

test('route: a refusal is a 409 carrying the message and the fix', { skip }, async () => {
  await seedForRoute();
  const res = await forget(S, { confirm: 'Gone' });
  assert.equal(res.statusCode, 409);
  const b = res.json();
  assert.equal(b.error, 'refused');
  assert.match(b.message, /still claims a file on disk/);
  assert.equal(b.fix, 'Delete files, then Forget.');
  assert.equal(await rowsFor('read_progress', 'series_id', [S]), 1, 'a refused forget erased history');
});

test('route: success answers the counts and writes series.forget to the audit log', { skip }, async () => {
  await seedForRoute();
  await q(`UPDATE lib_books SET pruned_at = now(), pruned_reason = 'deleted' WHERE series_id = $1`, [S]);
  const res = await forget(S, { confirm: '  Gone ' });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), { ok: true, books: 1, absorbed: 0, users: 1 });
  assert.equal(await rowsFor('lib_series', 'id', [S]), 0);
  const audit = await q<{ detail: any; user_id: string }>(
    `SELECT detail, user_id FROM audit_log WHERE event = 'series.forget' AND detail->>'id' = $1`, [S]);
  assert.equal(audit.length, 1, 'no audit row: the only record that the forget happened');
  assert.equal(audit[0].user_id, users[2]);
  assert.equal(audit[0].detail.title, 'Gone');
  assert.equal(audit[0].detail.folder, `${SRC}/${S}`);
  assert.equal(audit[0].detail.books, 1);
  assert.equal(audit[0].detail.users, 1);
  assert.equal(audit[0].detail.rowsByTable.reading_events, 1, 'the audit must say how much history went, per table');
});
