// The read-chapter cleanup says why it keeps what it keeps (#332, @TIGamingTV).
//
// His read chapters stopped going, and the log said only "0 read chapter(s) deleted". Every rule that keeps a file is
// right on its own -- somebody part-way through, the grace period, a file fetched again since it was read, a bookmark,
// the last copy the sources no longer list, a number hidden by hand, a removed series -- and none of them said it was the
// one. At LOG_LEVEL=debug each run now writes `[cleanup]` lines: how many read chapters, how many are due, and how many
// each rule keeps, with a few of them by title.
// His lines then named the rule: the cover chapter, kept for ever whatever the cover was. It is no rule since v0.97.0:
// the cover's chapter is due like any other, and its page is kept where it is the cover (cleanupCoverPage.int.test.ts).
//
// What is asserted: one chapter per rule is attributed to exactly that rule, the due count is the job's own (dueCount,
// and the run deletes exactly that chapter), the lines appear only at debug, and an off switch is said at debug too.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const DSN = process.env.TEST_DATABASE_URL;
const ROOT = join(tmpdir(), `uchiyomi-cw-${process.pid}`);
const DL = join(tmpdir(), `uchiyomi-cwdl-${process.pid}`);
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_ROOT = ROOT;
  process.env.DL_ROOT = DL;
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

let q: <T = any>(sql: string, params?: any[]) => Promise<T[]>;
let cc: typeof import('../src/lib/chapterCleanup');
let notice: typeof import('../src/lib/noticeChapters');

const S = 's_cw_series', GONE = 's_cw_removed';
const FOLDER = 'T!cw/Hound';
const USERS = ['cw-alice', 'cw-bob'];
const ids: Record<string, string> = {};
/** The files landed ten days ago, as a download would have: a realistic mtime, not 1970. */
const LANDED_AT = Date.now() - 10 * 86_400_000;
const exists = (p: string) => stat(p).then(() => true).catch(() => false);
const uid = async (name: string) => (await q<{ id: string }>('SELECT id FROM users WHERE username = $1', [name]))[0].id;

/** A chapter of `series` on the download disk, its file written, read to the end by alice `agoDays` ago. */
async function chapter(series: string, n: number, o: { agoDays?: number; mtime?: number; read?: boolean } = {}) {
  const id = `b_cw_${series === S ? '' : 'r'}${n}`;
  const file = `${series === S ? FOLDER : 'T!cw/Gone'}/ch${n}.cbz`;
  await mkdir(join(DL, file, '..'), { recursive: true });
  await writeFile(join(DL, file), 'x'.repeat(100));
  await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, root, mtime, pages)
           VALUES ($1,$2,'T!cw',$3,$4,$5,$6,$7,20)`, [id, series, file, n, `Chapter ${n}`, DL, o.mtime ?? LANDED_AT]);
  if (o.read !== false) {
    await q(`INSERT INTO read_progress (user_id, book_id, series_id, page, completed, updated_at)
             VALUES ($1,$2,$3,20,true, now() - make_interval(days => $4))`, [await uid('cw-alice'), id, series, o.agoDays ?? 5]);
  }
  return id;
}

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  await migrate();
  cc = await import('../src/lib/chapterCleanup');
  notice = await import('../src/lib/noticeChapters');
  for (const username of USERS) {
    await q('DELETE FROM users WHERE username = $1', [username]).catch(() => {});
    await q(`INSERT INTO users (display_name, username, role, password_hash, auth_kind) VALUES ($1,$1,'user','x','password')`, [username]);
  }
});

beforeEach(async () => {
  if (!DSN) return;
  for (const t of ['bookmarks', 'read_progress']) await q(`DELETE FROM ${t} WHERE series_id = ANY($1)`, [[S, GONE]]);
  await q('UPDATE lib_series SET cover_book_id = NULL WHERE id = ANY($1)', [[S, GONE]]);
  await q('DELETE FROM series_listing WHERE series_id = ANY($1)', [[S, GONE]]);
  await q('DELETE FROM lib_books WHERE series_id = ANY($1)', [[S, GONE]]);
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [[S, GONE]]);
  await rm(DL, { recursive: true, force: true });
  await rm(ROOT, { recursive: true, force: true });
  await mkdir(DL, { recursive: true });
  await mkdir(ROOT, { recursive: true });
  notice.setHiddenNumbersActive(true);

  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, hidden_numbers) VALUES ($1,'T!cw','Hound',$2,9,'{8}')`, [S, FOLDER]);
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, deleted_at) VALUES ($1,'T!cw','Gone',$2,1, now())`, [GONE, 'T!cw/Gone']);
  ids.cover = await chapter(S, 1); // the cover chapter, due like any other (v0.97.0); its file is no archive, so no page
  ids.due = await chapter(S, 2);
  ids.reading = await chapter(S, 3);
  await q(`INSERT INTO read_progress (user_id, book_id, series_id, page, completed) VALUES ($1,$2,$3,4,false)`, [await uid('cw-bob'), ids.reading, S]);
  ids.recent = await chapter(S, 4, { agoDays: 1 });
  ids.bookmarked = await chapter(S, 5);
  await q('INSERT INTO bookmarks (user_id, book_id, series_id, page) VALUES ($1,$2,$3,7)', [await uid('cw-alice'), ids.bookmarked, S]);
  ids.changed = await chapter(S, 6, { mtime: Date.now() });
  ids.lastCopy = await chapter(S, 7);
  ids.hidden = await chapter(S, 8);
  ids.unread = await chapter(S, 9, { read: false });
  ids.removed = await chapter(GONE, 1);
  await q('UPDATE lib_series SET cover_book_id = $2 WHERE id = $1', [S, ids.cover]);
  // The series' listing: every number but 7, which the sources no longer list.
  for (const n of [1, 2, 3, 4, 5, 6, 8, 9]) {
    await q(`INSERT INTO series_listing (series_id, number, source_id, chosen) VALUES ($1,$2,'x','{}'::jsonb)`, [S, n]);
  }
});

after(async () => {
  if (!DSN) return;
  notice?.setHiddenNumbersActive(false);
  if (cc) cc.cleanupLog.on = false;
  await q('UPDATE server_settings SET cleanup_read = false, cleanup_read_days = 30 WHERE id = 1').catch(() => {});
  for (const t of ['bookmarks', 'read_progress']) await q(`DELETE FROM ${t} WHERE series_id = ANY($1)`, [[S, GONE]]).catch(() => {});
  await q('UPDATE lib_series SET cover_book_id = NULL WHERE id = ANY($1)', [[S, GONE]]).catch(() => {});
  await q('DELETE FROM series_listing WHERE series_id = ANY($1)', [[S, GONE]]).catch(() => {});
  await q('DELETE FROM lib_books WHERE series_id = ANY($1)', [[S, GONE]]).catch(() => {});
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [[S, GONE]]).catch(() => {});
  await q('DELETE FROM users WHERE username = ANY($1)', [USERS]).catch(() => {});
  await rm(DL, { recursive: true, force: true }).catch(() => {});
  await rm(ROOT, { recursive: true, force: true }).catch(() => {});
  await (await import('../src/lib/db')).pool.end().catch(() => {});
});

/** console.log while `fn` runs, the `[cleanup]` lines only. */
async function linesOf(fn: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = [];
  const was = console.log;
  console.log = (...a: unknown[]) => { const s = a.map(String).join(' '); if (s.startsWith('[cleanup]')) lines.push(s); else was(...a); };
  try { await fn(); } finally { console.log = was; }
  return lines;
}

test('every read chapter is either due or kept for a reason, each by the rule that keeps it', { skip }, async () => {
  // Reintroduce a rule in dueSql that keptReasons lacks (or attribute one wrongly): the chapter it keeps is counted due,
  // and `due` no longer equals the job's own dueCount.
  const r = await cc.keptReasons(2);
  assert.equal(r.read, 9, 'every chapter somebody opened on the download disk, the removed series too, not the unread one');
  // Reintroduce the cover chapter's veto (v0.96.0's): one fewer due, and a `cover` count below.
  assert.equal(r.due, 2, 'chapter 2, and chapter 1 though it is the cover chapter');
  assert.equal(r.due, await cc.dueCount(2), "the explanation's due count is the job's own");
  const by = Object.fromEntries(r.kept.map((k) => [k.why, k.n]));
  assert.deepEqual(by, { reading: 1, recent: 1, changed: 1, removed: 1, bookmarked: 1, last_copy: 1, hidden: 1 });
  const lastCopy = r.kept.find((k) => k.why === 'last_copy')!;
  assert.deepEqual(lastCopy.examples, ['"Hound" 7'], 'examples name the series and the number');
});

test('at debug a run says why it keeps what it keeps, and deletes exactly what it said was due', { skip }, async () => {
  await q('UPDATE server_settings SET cleanup_read = true, cleanup_read_days = 2 WHERE id = 1');
  cc.cleanupLog.on = true;
  try {
    let result: any;
    const lines = await linesOf(async () => { result = await cc.runCleanupOnce(); });
    assert.equal(lines[0], `[cleanup] on, after 2 days: 9 read chapters under ${DL}, 2 due now`);
    for (const said of [
      'kept: someone who opened it has not finished it', 'kept: finished less than 2 days ago',
      'kept: the file on disk is newer than the last read of it', 'kept: its series is removed', 'kept: it has a bookmark',
      'kept: the sources no longer list it as one they could fetch again, so it is the last copy',
      'kept: its number is hidden by hand',
    ]) assert.ok(lines.some((l) => l.includes(said)), `no line says "${said}": ${lines.join(' | ')}`);
    assert.ok(!lines.some((l) => l.includes('cover')), `a line still keeps a chapter for the cover: ${lines.join(' | ')}`);
    assert.equal(result.deleted, 2);
    assert.equal(await exists(join(DL, FOLDER, 'ch2.cbz')), false, 'the due chapter was not deleted');
    assert.equal(await exists(join(DL, FOLDER, 'ch1.cbz')), false, 'the cover chapter was not deleted');
    assert.equal(await exists(join(DL, FOLDER, 'ch7.cbz')), true, 'a kept chapter was deleted');
  } finally {
    cc.cleanupLog.on = false;
  }
});

test('the lines are written at debug only, and an off switch is said at debug', { skip }, async () => {
  // Reintroduce the lines at every level (trace() without its `cleanupLog.on`, and explainRun called whatever the
  // level): the first run below writes them; drop the off switch's trace: the second reads nothing.
  await q('UPDATE server_settings SET cleanup_read = true, cleanup_read_days = 2 WHERE id = 1');
  assert.deepEqual(await linesOf(() => cc.runCleanupOnce()), [], 'lines at the default level');
  await q('UPDATE server_settings SET cleanup_read = false WHERE id = 1');
  cc.cleanupLog.on = true;
  try {
    assert.deepEqual(await linesOf(() => cc.runCleanupOnce()),
      ['[cleanup] switched off (Admin → Settings → Downloads → Delete read chapters): nothing is looked at']);
  } finally {
    cc.cleanupLog.on = false;
  }
});
