// Several trackers at once.
//
// AniList was the only one, and MyAnimeList is the bigger service by users. The schema was already keyed on
// `(user_id, provider)` and the module said so in a comment -- "provider is carried everywhere so MAL/Kitsu
// can be added without a migration" -- and that held: nothing about the tables changed.
//
// What that comment did NOT cover is the part these tests are about. `linkSeries` took a provider argument
// and then hardcoded `'anilist'` in its INSERT, so any link made for a second service would have been stored
// as an AniList one and read back with the wrong external id -- pushing a user's Kitsu progress to whatever
// AniList entry happened to share that number. And the push path resolved exactly one connection, so a user
// with two trackers connected would have had one of them silently do nothing.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test from 'node:test';
import assert from 'node:assert/strict';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const SERIES = 's_trk_multi';

test('every provider has a complete adapter', async () => {
  const { ADAPTERS, PROVIDERS, isProvider } = await import('../src/lib/trackerProviders');
  assert.deepEqual(PROVIDERS.sort(), ['anilist', 'kitsu', 'myanimelist']);
  for (const p of PROVIDERS) {
    const a = ADAPTERS[p];
    assert.equal(a.id, p, `${p}: the adapter must know its own id, since it is looked up by it`);
    assert.ok(a.label, `${p}: needs a display name`);
    assert.ok(a.tokenHelp, `${p}: needs to tell the user where to get a token, or nobody can connect it`);
    assert.equal(typeof a.whoAmI, 'function');
    assert.equal(typeof a.setProgress, 'function');
  }
  assert.ok(isProvider('kitsu'));
  assert.ok(!isProvider('goodreads'), 'an unknown name must not be accepted as a provider');
  assert.ok(!isProvider(undefined));
});

test('multi-provider tracking', { skip }, async (t) => {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const trackers = await import('../src/lib/trackers');
  await migrate();

  await q('DELETE FROM series_trackers WHERE series_id = $1', [SERIES]).catch(() => {});
  await q('DELETE FROM lib_series WHERE id = $1', [SERIES]).catch(() => {});
  await q(`DELETE FROM users WHERE username = 'trk-multi'`).catch(() => {});
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count) VALUES ($1,'T!trk',$1,$2,1)`,
    [SERIES, `T!trk/${SERIES}`]);
  const u = await q<{ id: string }>(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind)
     VALUES ('trk-multi','trk-multi','x','user','password') RETURNING id`);
  const userId = u[0].id;

  try {
    await t.test('THE BUG: a link is stored under the provider it was made for', async () => {
      await trackers.linkSeries(SERIES, '111', 'On AniList', null, 'anilist');
      await trackers.linkSeries(SERIES, '222', 'On MAL', null, 'myanimelist');
      await trackers.linkSeries(SERIES, '333', 'On Kitsu', null, 'kitsu');

      const rows = await q<{ provider: string; external_id: string }>(
        'SELECT provider, external_id FROM series_trackers WHERE series_id = $1 ORDER BY provider', [SERIES]);
      assert.deepEqual(rows, [
        { provider: 'anilist', external_id: '111' },
        { provider: 'kitsu', external_id: '333' },
        { provider: 'myanimelist', external_id: '222' },
      ], 'each link must keep its own id -- the INSERT used to write every one as anilist');
    });

    await t.test('the default is still AniList, so existing callers are unchanged', async () => {
      await q('DELETE FROM series_trackers WHERE series_id = $1', [SERIES]);
      await trackers.linkSeries(SERIES, '444', 'Default');
      const r = await q<{ provider: string }>('SELECT provider FROM series_trackers WHERE series_id = $1', [SERIES]);
      assert.equal(r[0].provider, 'anilist');
    });

    await t.test('status lists every provider, connected or not', async () => {
      const st = await trackers.statusFor(userId);
      assert.equal(st.length, 3, 'the UI offers what it is told about, so all three must be listed');
      for (const s of st) {
        assert.ok(s.label, 'each needs a display name');
        assert.ok(s.tokenHelp, 'each needs to say where a token comes from');
      }
      assert.deepEqual(st.map((s) => s.connected), [false, false, false]);
    });

    await t.test('connections are independent: one does not disturb another', async () => {
      await trackers.saveConnection(userId, 'anilist', 'token-a', 'me-on-anilist', new Date(Date.now() + 86400000));
      await trackers.saveConnection(userId, 'myanimelist', 'token-m', 'me-on-mal', new Date(Date.now() + 86400000));

      const st = await trackers.statusFor(userId);
      const byId = Object.fromEntries(st.map((s) => [s.provider, s]));
      assert.equal(byId.anilist.connected, true);
      assert.equal(byId.anilist.accountName, 'me-on-anilist');
      assert.equal(byId.myanimelist.connected, true);
      assert.equal(byId.myanimelist.accountName, 'me-on-mal');
      assert.equal(byId.kitsu.connected, false, 'an unconnected provider stays unconnected');

      await trackers.disconnect(userId, 'anilist');
      const after = Object.fromEntries((await trackers.statusFor(userId)).map((s) => [s.provider, s]));
      assert.equal(after.anilist.connected, false, 'disconnecting one');
      assert.equal(after.myanimelist.connected, true, 'must not disconnect the other');
    });

    await t.test('the high-water mark is per provider, not shared', async () => {
      // The floor stops a tracker being walked backwards. Sharing it across services would mean progress
      // pushed to one silently blocking the other, which is the same class of bug as the shared link id.
      await q('DELETE FROM tracker_progress WHERE user_id = $1 AND series_id = $2', [userId, SERIES]);
      for (const [p, n] of [['anilist', 10], ['myanimelist', 3]] as const) {
        await q(
          `INSERT INTO tracker_progress (user_id, series_id, provider, chapters, pushed_at)
           VALUES ($1,$2,$3,$4,now())`, [userId, SERIES, p, n]);
      }
      const rows = await q<{ provider: string; chapters: number }>(
        'SELECT provider, chapters FROM tracker_progress WHERE user_id = $1 AND series_id = $2 ORDER BY provider',
        [userId, SERIES]);
      assert.deepEqual(rows, [
        { provider: 'anilist', chapters: 10 },
        { provider: 'myanimelist', chapters: 3 },
      ]);

      await trackers.clearTrackerFloor(userId, SERIES, 'myanimelist');
      const left = await q<{ provider: string }>(
        'SELECT provider FROM tracker_progress WHERE user_id = $1 AND series_id = $2', [userId, SERIES]);
      assert.deepEqual(left, [{ provider: 'anilist' }],
        'clearing the floor for one provider must leave the others alone');
    });

    await t.test('pushing with nothing connected does nothing, quietly', async () => {
      await trackers.disconnect(userId, 'myanimelist');
      await trackers.pushSeriesProgress(userId, SERIES);   // must not throw
    });
  } finally {
    await q('DELETE FROM series_trackers WHERE series_id = $1', [SERIES]).catch(() => {});
    await q('DELETE FROM lib_series WHERE id = $1', [SERIES]).catch(() => {});
    await q(`DELETE FROM users WHERE username = 'trk-multi'`).catch(() => {});
  }
});
