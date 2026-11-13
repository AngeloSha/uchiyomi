// Reading progress an import brings over (#433, lib/importProgress.ts), against a real database: what an import marks,
// for whom, and with which time. What is tested is mostly what must NOT happen, because every one of these is silent:
//   * a mark past what exists, or past how far a tracker says the person got;
//   * a chapter already read here touched (its time is when it was read HERE);
//   * a reading_events row, a tracker push, or another account's reading moved;
//   * a file made due for the read-chapter cleanup, the job that deletes the files of chapters read here.
// The route half -- marked at intake for the titles already here, at /run once a series exists, and only when asked --
// is in importBatch.int.test.ts, beside the import's other routes.
//
// The pure half runs always; everything else is skipped unless TEST_DATABASE_URL is set.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DSN = process.env.TEST_DATABASE_URL;
let ROOT = '';
if (DSN) {
  ROOT = mkdtempSync(join(tmpdir(), 'yomi-ip-'));
  process.env.DL_ROOT = join(ROOT, 'dl');
  process.env.LIBRARY_ROOT = join(ROOT, 'lib');
  process.env.CACHE_DIR = join(ROOT, 'cache');
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
} else {
  // The pure half imports the modules, which build a (lazy, never-connected) pool from the env.
  process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused@127.0.0.1:1/none';
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

// ---- the pure half --------------------------------------------------------------------------------------------

test('how far the trackers say: the highest of a row\'s links, and nothing from a provider named twice', async () => {
  // Reintroduce by taking every link's progress in readUpTo: the torn AniList pair says 150, a number about two
  // different entries, which the link refuses to choose between as well.
  const { readUpTo } = await import('../src/lib/importProgress');
  assert.equal(readUpTo([{ provider: 'anilist', externalId: '1', progress: 12 }, { provider: 'myanimelist', externalId: '2', progress: 15.9 }]), 15);
  assert.equal(readUpTo([
    { provider: 'anilist', externalId: '1', progress: 150 }, { provider: 'anilist', externalId: '2', progress: 3 },
    { provider: 'kitsu', externalId: '3', progress: 7 },
  ]), 7);
  assert.equal(readUpTo([]), 0);
});

test('a continued batch keeps its read chapters, held to the range a real takes', async () => {
  // The second batch of a long backup reads its entries back from remaining_entries, JSON the database hands back.
  // Reintroduce by leaving readNumbers out of normalizeImportEntries (lib/importMetadata.ts): undefined, and the rest
  // of a 600-title backup marks nothing.
  const { normalizeImportEntries } = await import('../src/lib/importMetadata');
  const [entry] = normalizeImportEntries(JSON.parse(JSON.stringify([{ title: 'Continued', readNumbers: [3, 1, 2.5, -1, 1e7, 'x', null, 3] }])));
  assert.deepEqual(entry.readNumbers, [1, 2.5, 3]);
});

// ---- the database half -----------------------------------------------------------------------------------------

const LIB = 'lib_ip';
const S_MAIN = 's_ip_main';     // books 1..10 on the download disk, listed 1..20: the issue's own case
const S_CLEAN = 's_ip_clean';   // books 1..10 on the download disk, listed 1..10: the cleanup
const S_SET = 's_ip_set';       // books 0..3, listed 0..20: a backup's read set with no tracker
const S_SKIP = 's_ip_skip';     // books 1..3, listed 1..5: numbered otherwise
const S_RANGE = 's_ip_range';   // a file holding 1-7, and 8; listed 1..10
const OWNER = 'ip-owner', OTHER = 'ip-other';
/** When the files landed: an hour ago, so a read stamped now() is "after the file" and one stamped before it is not. */
const LANDED_AT = Date.now() - 3_600_000;

let q: any;
let ownerId = '', otherId = '';

/** The MAL push, the only tracker call a stub can see (listingProgress.int.test.ts does the same): writes only. */
const pushes: Array<{ url: string; body: string }> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (u: any, init?: any) => {
  const url = String(u);
  if (!/api\.myanimelist\.net/.test(url)) return realFetch(u, init);
  const answer = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
  if (String(init?.method ?? 'GET') === 'GET') return answer({ status: 'currently_publishing', num_chapters: 0 });
  pushes.push({ url, body: String(init?.body ?? '') });
  return answer({ status: 'reading' });
}) as typeof fetch;

const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  await migrate();
  await q('DELETE FROM users WHERE username = ANY($1)', [[OWNER, OTHER]]);
  await q(`DELETE FROM read_progress WHERE series_id LIKE 's_ip_%'`);
  await q(`DELETE FROM lib_books WHERE series_id LIKE 's_ip_%'`);
  await q(`DELETE FROM lib_series WHERE id LIKE 's_ip_%'`);
  await q(`INSERT INTO libraries (id, name, path) VALUES ($1,'Imported',$1) ON CONFLICT (id) DO NOTHING`, [LIB]);
  const mk = async (name: string) =>
    (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ($1,$1,'x','user','password') RETURNING id`, [name]))[0].id as string;
  ownerId = await mk(OWNER);
  otherId = await mk(OTHER);
  const { DL_ROOT } = await import('../src/lib/library');
  for (const [sid, books, listed] of [
    [S_MAIN, range(1, 10), range(1, 20)], [S_CLEAN, range(1, 10), range(1, 10)], [S_SET, range(0, 3), range(0, 20)],
    [S_SKIP, range(1, 3), range(1, 5)], [S_RANGE, [1, 8], range(1, 10)],
  ] as Array<[string, number[], number[]]>) {
    await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id) VALUES ($1,'T!ip',$1,$2,$3,$4)`,
      [sid, `T!ip/${sid}`, books.length, LIB]);
    await q(
      `INSERT INTO lib_books (id, series_id, source, file, number, title, root, pages, mtime)
       SELECT $1 || '_' || n, $1, 'T!ip', 'T!ip/' || $1 || '/Chapter ' || n || '.cbz', n, 'Chapter ' || n, $3, 10, $4
         FROM unnest($2::real[]) AS n`,
      [sid, books, DL_ROOT, LANDED_AT],
    );
    await q(
      `INSERT INTO series_listing (series_id, number, title, source_id, chosen, status)
       SELECT $1, n, 'Chapter ' || n, 'src', '{}'::jsonb, 'available' FROM unnest($2::real[]) AS n`,
      [sid, listed],
    );
  }
  // Batman 01-07: one file, chapters 1 to 7 (lib/chapterRanges.ts).
  await q(`UPDATE lib_books SET number_end = 7 WHERE id = $1`, [`${S_RANGE}_1`]);
});

after(async () => {
  globalThis.fetch = realFetch;
  if (!DSN) return;
  await q(`UPDATE server_settings SET cleanup_read = false WHERE id = 1`).catch(() => {});
  await q(`DELETE FROM read_progress WHERE series_id LIKE 's_ip_%'`).catch(() => {});
  await q(`DELETE FROM lib_books WHERE series_id LIKE 's_ip_%'`).catch(() => {});
  await q(`DELETE FROM lib_series WHERE id LIKE 's_ip_%'`).catch(() => {});
  await q('DELETE FROM libraries WHERE id = $1', [LIB]).catch(() => {});
  await q('DELETE FROM users WHERE username = ANY($1)', [[OWNER, OTHER]]).catch(() => {});
  if (ROOT) rmSync(ROOT, { recursive: true, force: true });
});

/** One reader's rows on one series, by book: whether finished, the page, and the time in ms. */
const progressOf = async (uid: string, sid: string) => Object.fromEntries(
  (await q(`SELECT book_id, completed, page, updated_at FROM read_progress WHERE user_id = $1 AND series_id = $2`, [uid, sid]))
    .map((r: any) => [r.book_id, { completed: r.completed, page: r.page, at: new Date(r.updated_at).getTime() }]));
const marksOf = async (uid: string, sid: string) =>
  (await q(`SELECT number, source FROM listing_progress WHERE user_id = $1 AND series_id = $2 ORDER BY number`, [uid, sid]))
    .map((r: any) => ({ number: Number(r.number), source: r.source }));
/** Everything another account has here, as one value to compare before and after. */
const othersState = async () => JSON.stringify([
  await q(`SELECT * FROM read_progress WHERE user_id = $1 ORDER BY book_id`, [otherId]),
  await q(`SELECT * FROM listing_progress WHERE user_id = $1 ORDER BY series_id, number`, [otherId]),
]);
const progress = (uid: string, bookId: string, sid: string, page: number, completed: boolean, agoSeconds: number) =>
  q(`INSERT INTO read_progress (user_id, book_id, series_id, page, completed, updated_at) VALUES ($1,$2,$3,$4,$5, now() - make_interval(secs => $6))`,
    [uid, bookId, sid, page, completed, agoSeconds]);

test('an import marks what it read: held chapters on their rows, listed ones as marks, no further than the tracker', { skip }, async () => {
  // The issue's case: chapters 1-10 here (4 read here a minute ago, 6 open on page 3), 1-20 listed, the tracker at 15.
  // Reintroduce by dropping the bound (every held or listed number marked): 16 to 20 are marked. By dropping
  // `WHERE NOT read_progress.completed`: 15 are counted, and 4's time moves to before its file. By marking through
  // writeProgress (lib/progress.ts) per chapter: the chapter left open is stamped now. By writing an event, or pushing,
  // beside a right stamp: "a reading_events row", "a tracker push".
  const { importReadProgress } = await import('../src/lib/importProgress');
  const trackers = await import('../src/lib/trackers');
  await progress(ownerId, `${S_MAIN}_4`, S_MAIN, 10, true, 60);
  await progress(ownerId, `${S_MAIN}_6`, S_MAIN, 3, false, 30);
  await progress(otherId, `${S_MAIN}_2`, S_MAIN, 2, false, 600);
  await progress(otherId, `${S_MAIN}_7`, S_MAIN, 10, true, 300);
  await q(`INSERT INTO listing_progress (user_id, series_id, number) VALUES ($1, $2, 12)`, [otherId, S_MAIN]);
  await trackers.saveConnection(ownerId, 'myanimelist', 'tok-mal', 'me', new Date(Date.now() + 86_400_000));
  await trackers.linkSeries(S_MAIN, '4243', 'Main', ownerId, 'myanimelist');
  try {
    const read4 = (await progressOf(ownerId, S_MAIN))[`${S_MAIN}_4`].at;
    const others = await othersState();
    pushes.length = 0;

    // 12.5 and 99 are neither held nor listed: nothing is written for them.
    const marked = await importReadProgress(ownerId, S_MAIN, [2, 12.5, 99], 15);
    assert.equal(marked, 14, 'nine chapters held (4 was read already) and five listed');

    const rows = await progressOf(ownerId, S_MAIN);
    assert.deepEqual(range(1, 10).filter((n) => rows[`${S_MAIN}_${n}`]?.completed !== true), [], 'every held chapter at or below 15 is read');
    assert.equal(rows[`${S_MAIN}_4`].at, read4, 'the chapter read here keeps the time it was read here');
    assert.ok(rows[`${S_MAIN}_6`].at < LANDED_AT, 'the chapter left open is read as of before its file landed');
    assert.equal(rows[`${S_MAIN}_6`].page, 10, 'and to its last page');
    const marks = await marksOf(ownerId, S_MAIN);
    assert.deepEqual(marks.map((m: any) => m.number), [11, 12, 13, 14, 15], 'the listed chapters up to 15, and nothing past it');
    assert.ok(marks.every((m: any) => m.source === 'import'));

    assert.equal((await q('SELECT count(*)::int n FROM reading_events WHERE user_id = $1', [ownerId]))[0].n, 0, 'a reading_events row');
    for (let i = 0; i < 12; i++) await new Promise((res) => setTimeout(res, 50));
    assert.equal(pushes.length, 0, 'a tracker push');
    assert.equal(await othersState(), others, 'another account\'s reading moved');

    // Marking again changes nothing: a number marked is marked once.
    assert.equal(await importReadProgress(ownerId, S_MAIN, [2, 12.5, 99], 15), 0);

    // The control, so the silence above is the rule and not a deaf stub: the reader's own push goes out.
    trackers.pushSeriesProgressAsync(ownerId, S_MAIN);
    for (let i = 0; i < 60 && pushes.length < 1; i++) await new Promise((res) => setTimeout(res, 50));
    assert.equal(pushes.length, 1, 'PREMISE: a push for this series reaches the stub');
  } finally {
    await q(`DELETE FROM user_trackers WHERE user_id = $1`, [ownerId]);
    await q(`DELETE FROM series_trackers WHERE series_id = $1`, [S_MAIN]);
    await q(`DELETE FROM tracker_progress WHERE user_id = $1`, [ownerId]);
  }
});

test('an imported read is a read of an earlier copy: the 0-day cleanup finds nothing new to delete', { skip }, async () => {
  // The read-chapter cleanup deletes a chapter's file once everyone who started it finished THE COPY ON DISK
  // (chapterCleanup.ts dueSql: done_at >= the file's mtime). Reintroduce by stamping now() in importReadProgress: ten
  // chapters an established library just imported are due, and the next hourly run deletes them for good.
  const { importReadProgress } = await import('../src/lib/importProgress');
  const { dueCount } = await import('../src/lib/chapterCleanup');
  await q(`UPDATE server_settings SET cleanup_read = true, cleanup_read_days = 0 WHERE id = 1`);
  try {
    const due = await dueCount(0);
    assert.equal(await importReadProgress(ownerId, S_CLEAN, [], 10), 10);
    assert.equal(await dueCount(0), due, 'an imported read made a file due');
    // PREMISE: the same reads stamped now() are due -- what keeps them is the stamp, not another of dueSql's rules.
    await q(`UPDATE read_progress SET updated_at = now() WHERE user_id = $1 AND series_id = $2`, [ownerId, S_CLEAN]);
    assert.equal(await dueCount(0), due + 10);
  } finally {
    await q(`UPDATE server_settings SET cleanup_read = false WHERE id = 1`);
    await q(`DELETE FROM read_progress WHERE series_id = $1`, [S_CLEAN]);
  }
});

test('a backup\'s read set alone marks what it names, and a tracker at 0 is no bound at all', { skip }, async () => {
  // Reintroduce by dropping `$4::real > 0` from either statement: a tracker at 0 marks chapter 0, the prologue nobody said
  // was read. 18.5 and 30 are not listed: nothing is written for them.
  const { importReadProgress } = await import('../src/lib/importProgress');
  assert.equal(await importReadProgress(ownerId, S_SET, [3, 17, 18.5, 30], 0), 2);
  assert.deepEqual(Object.keys(await progressOf(ownerId, S_SET)), [`${S_SET}_3`]);
  assert.deepEqual((await marksOf(ownerId, S_SET)).map((m: any) => m.number), [17]);
});

test('a series numbered otherwise is not marked: posting order, chapter titles, or a renumber pending', { skip }, async () => {
  // Chapter 2 on Mihon is not post 2 here (#116), nor the second chapter by its title (#379). Reintroduce by dropping
  // SAME_NUMBERS from importReadProgress: the first of these marks.
  const { importReadProgress } = await import('../src/lib/importProgress');
  for (const [col, value] of [['numbering', 'posting_order'], ['numbering', 'titles'], ['numbering_pending', 'titles'], ['renumber_plan', '{}']]) {
    await q(`UPDATE lib_series SET ${col} = $2 WHERE id = $1`, [S_SKIP, value]);
    try {
      assert.equal(await importReadProgress(ownerId, S_SKIP, [1, 2], 5), 0, `${col} ${value}`);
    } finally {
      await q(`UPDATE lib_series SET ${col} = NULL WHERE id = $1`, [S_SKIP]);
    }
  }
  assert.deepEqual([await progressOf(ownerId, S_SKIP), await marksOf(ownerId, S_SKIP)], [{}, []]);
  await q(`UPDATE lib_series SET numbering = 'source' WHERE id = $1`, [S_SKIP]);
  assert.equal(await importReadProgress(ownerId, S_SKIP, [1, 2], 5), 5, 'PREMISE: numbered by its source, it is marked');
});

test('a range is read only to its end: never on its first chapter alone', { skip }, async () => {
  // Batman 01-07 is one file. Reintroduce by dropping the rangeEnd test on the read set: chapter 1 alone marks all seven.
  // Reintroduce by bounding the start instead of lastNumber: a tracker at 5 marks it. Inside the file, 2 to 7 are held,
  // so none is a mark either.
  const { importReadProgress } = await import('../src/lib/importProgress');
  assert.equal(await importReadProgress(ownerId, S_RANGE, [1], 0), 0);
  assert.equal(await importReadProgress(ownerId, S_RANGE, [], 5), 0);
  assert.deepEqual([await progressOf(ownerId, S_RANGE), await marksOf(ownerId, S_RANGE)], [{}, []]);
  assert.equal(await importReadProgress(ownerId, S_RANGE, [], 8), 2, 'at 8 the range is read, and 8 with it');
});
