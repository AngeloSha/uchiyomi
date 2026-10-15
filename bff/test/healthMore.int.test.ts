// Health's covers, reading-data and tracker cards against a scratch database.
// Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

let q: any, hm: any;
const USER = '00000000-0000-4000-8000-0000000000a1';
const DAY = 24 * 3600_000;
const SER = ['hm_bare', 'hm_art', 'hm_override', 'hm_chapter'];

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  await migrate();
  ({ q } = await import('../src/lib/db'));
  hm = await import('../src/lib/healthMore');
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [SER]);
  for (const id of SER) await q(`INSERT INTO lib_series (id, source, title, folder) VALUES ($1,'test',$1,$1)`, [id]);
  await q(`INSERT INTO series_art (series_id, cover) VALUES ('hm_art', 'x.jpg') ON CONFLICT (series_id) DO UPDATE SET cover = 'x.jpg'`);
  await q(`INSERT INTO series_overrides (series_id, cover) VALUES ('hm_override', 'y.jpg') ON CONFLICT (series_id) DO UPDATE SET cover = 'y.jpg'`);
  await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, pages, root) VALUES ('hm_b1','hm_chapter','test','hm/1.cbz',1,'One',1,'/x')`);
  await q(`INSERT INTO users (id, username, display_name, password_hash) VALUES ($1,'hm_user','hm','x') ON CONFLICT (id) DO NOTHING`, [USER]);
});

after(async () => {
  if (!DSN) return;
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [SER]).catch(() => {});
  await q('DELETE FROM series_art WHERE series_id = ANY($1)', [SER]).catch(() => {});
  await q('DELETE FROM series_overrides WHERE series_id = ANY($1)', [SER]).catch(() => {});
  await q(`DELETE FROM users WHERE id = $1`, [USER]).catch(() => {});
});

test('covers: only a series with no cover set, none fetched and no chapter is a finding', { skip }, async () => {
  const card = await hm.seriesCovers();
  const ids = new Set(card.items.map((i: any) => i.seriesId));
  assert.equal(ids.has('hm_bare'), true);
  for (const id of ['hm_art', 'hm_override', 'hm_chapter']) assert.equal(ids.has(id), false, id);
  assert.equal(card.status, 'warn');
  assert.equal(card.items.find((i: any) => i.seriesId === 'hm_bare').key, 'series:hm_bare');
});

test('trackers: a refused sign-in is a finding, one expiring within 30 days only listed, a healthy one is not shown', { skip }, async () => {
  await q('DELETE FROM user_trackers WHERE user_id = $1', [USER]);
  const add = (provider: string, enabled: boolean, expires: number | null, err: string | null) =>
    q(`INSERT INTO user_trackers (user_id, provider, access_token, enabled, expires_at, last_error)
       VALUES ($1,$2,'t',$3, $4, $5)`, [USER, provider, enabled, expires === null ? null : new Date(Date.now() + expires * DAY), err]);
  await add('anilist', false, null, null);
  await add('myanimelist', true, 20, null);
  await add('kitsu', true, 200, null);
  const card = await hm.trackerSync();
  const mine = card.items.filter((i: any) => i.key?.endsWith(`:${USER}`));
  assert.deepEqual(mine.map((i: any) => [i.key.split(':')[0], !!i.info]).sort(), [['anilist', false], ['myanimelist', true]]);
  assert.equal(card.status, 'warn');
  await q('DELETE FROM user_trackers WHERE user_id = $1', [USER]);
});

test('reading data: leftover records are counted, informational, and never turn the card amber', { skip }, async () => {
  await q(`INSERT INTO reading_events (user_id, series_id, book_id, page) VALUES ($1,'hm_gone_series','hm_gone_book',1)`, [USER]);
  const card = await hm.orphanedData();
  assert.equal(card.status, 'ok');
  const row = card.items.find((i: any) => i.titleSaid?.params?.kind === 'eventsSeries');
  assert.ok(row);
  assert.equal(row.info, true);
  await q(`DELETE FROM reading_events WHERE user_id = $1 AND series_id = 'hm_gone_series'`, [USER]);
});
