// Hidden gems is "well rated, read by nobody in the household", and it read every member's places -- including the
// place lib/progress.ts keeps while Incognito reading is on. So the rail showed another member which unread series
// someone had opened privately (the audit: one Incognito page-1 read took the gem off the observer's rail). A place is
// now marked when it is kept under Incognito, and other members' private places do not count (v0.69.1).
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const LIB = 'lib_gi';
const GEM = 's_gi_gem';
let q: any, owned: any, writeProgress: any, viewCtxFor: any;
let reader = '', observer = '';

async function cleanup() {
  await q(`DELETE FROM users WHERE username LIKE 'gi-%'`);
  await q(`DELETE FROM lib_books WHERE series_id LIKE 's_gi_%'`);
  await q(`DELETE FROM series_trackers WHERE series_id LIKE 's_gi_%'`);
  await q(`DELETE FROM anilist_scores WHERE anilist_id LIKE 'gi-%'`);
  await q(`DELETE FROM lib_series WHERE id LIKE 's_gi_%'`);
  await q(`DELETE FROM libraries WHERE id = $1`, [LIB]);
}

before(async () => {
  if (!DSN) return;
  ({ q } = (await import('../src/lib/db')) as any);
  await (await import('../src/lib/migrate')).migrate();
  ({ owned } = (await import('../src/lib/ownedCatalog')) as any);
  ({ writeProgress } = (await import('../src/lib/progress')) as any);
  ({ viewCtxFor } = (await import('../src/lib/visibility')) as any);
  await cleanup();
  await q(`INSERT INTO libraries (id, name, path) VALUES ($1,'Gi','/gi')`, [LIB]);
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id) VALUES ($1,'T!gi',$1,$1,2,$2)`, [GEM, LIB]);
  for (const n of [1, 2]) {
    await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, root) VALUES ($1,$2,'T!gi',$3,$4,$5,'/library')`,
      [`b_${GEM}_${n}`, GEM, `T!gi/${GEM}/ch${n}.cbz`, n, `Chapter ${n}`]);
  }
  await q(`INSERT INTO series_trackers (series_id, provider, external_id, checked_at) VALUES ($1,'anilist','gi-1', now())`, [GEM]);
  await q(`INSERT INTO anilist_scores (anilist_id, score, popularity) VALUES ('gi-1', 90, 1000)`);
  const user = async (name: string) => (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind)
    VALUES ($1,$1,'x','user','password') RETURNING id`, [name]))[0].id as string;
  reader = await user('gi-reader');
  observer = await user('gi-observer');
});
after(async () => { if (DSN) await cleanup().catch(() => {}); });

const gemsOf = async (uid: string) => ((await owned.seriesGems(await viewCtxFor(uid, 'user'), 0, 50)).content as Array<{ id: string }>)
  .map((s) => s.id).filter((id) => id.startsWith('s_gi_'));

test("an Incognito read leaves another member's Hidden gems alone; a read in the open does not", { skip }, async () => {
  assert.deepEqual(await gemsOf(observer), [GEM], 'premise: unread and well rated, so a gem');

  // Reintroduce by dropping the incognito clause in seriesGems: the observer's gem disappears here.
  await writeProgress({ userId: reader, bookId: `b_${GEM}_1`, seriesId: GEM, page: 1, completed: false, incognito: true });
  assert.deepEqual(await gemsOf(observer), [GEM], "another member's private place told the observer what they opened");
  assert.deepEqual(await gemsOf(reader), [], 'the reader knows they opened it: off their own rail');
  assert.deepEqual((await q(`SELECT incognito FROM read_progress WHERE user_id = $1`, [reader]))[0], { incognito: true });

  // the same chapter read in the open: the place is no longer private, and the series is read by the household
  await writeProgress({ userId: reader, bookId: `b_${GEM}_1`, seriesId: GEM, page: 2, completed: false });
  assert.deepEqual((await q(`SELECT incognito FROM read_progress WHERE user_id = $1`, [reader]))[0], { incognito: false });
  assert.deepEqual(await gemsOf(observer), [], 'a read in the open still takes the gem off the household rail');

  // and a later private visit does not hide it again
  await writeProgress({ userId: reader, bookId: `b_${GEM}_1`, seriesId: GEM, page: 3, completed: false, incognito: true });
  assert.deepEqual((await q(`SELECT incognito FROM read_progress WHERE user_id = $1`, [reader]))[0], { incognito: false });
});
