// What the server says about the scout's work (v0.81.0): a Health row ends on what the scout last did for its series, and
// a source the server followed on its own says why on the series' Sources sheet. The owner's ask was for the downloads
// to find their own way; these are where a reader sees that they did.
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

const LIB = 'lib_scw';
const GONE = 'scw-gone';        // a main source that is not installed: its series cannot update (frozen)
const MAIN = 'scw-main', FOUND = 'scw-found', PICKED = 'scw-picked';
const FROZEN = 's_scw_frozen', SHEET = 's_scw_sheet';
let q: any;

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  await migrate();
  const { registerAdapter } = await import('../src/lib/sources');
  for (const id of [MAIN, FOUND, PICKED]) {
    registerAdapter({ id, name: id === FOUND ? 'Found Site' : id, async search() { return []; }, async getSeries() { return null; },
      async listChapters() { return []; }, async getPageUrls() { return []; } } as any);
  }
  await q(`INSERT INTO libraries (id, name, path) VALUES ($1,'Words',$1) ON CONFLICT (id) DO NOTHING`, [LIB]);
  for (const [id, src] of [[FROZEN, GONE], [SHEET, MAIN]]) {
    await q('DELETE FROM lib_series WHERE id = $1', [id]).catch(() => {});
    await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, source_id, source_series_id, auto_update)
             VALUES ($1,'T!scw',$1,$1,3,$2,$3,$1,true)`, [id, LIB, src]);
  }
});

after(async () => {
  if (!DSN) return;
  await q(`DELETE FROM lib_series WHERE id = ANY($1::text[])`, [[FROZEN, SHEET]]).catch(() => {});
  await q(`DELETE FROM audit_log WHERE event = 'series.follow_source' AND detail->>'id' = ANY($1::text[])`, [[FROZEN, SHEET]]).catch(() => {});
  await q('DELETE FROM libraries WHERE id = $1', [LIB]).catch(() => {});
  await q(`DELETE FROM users WHERE username = 'scw-admin'`).catch(() => {});
});

test('a Health row ends on what the scout last did for its series', { skip }, async () => {
  const { frozenSeries } = await import('../src/lib/health');
  const rowOf = async () => (await frozenSeries(undefined, 'up', { all: true })).items.find((i: any) => i.seriesId === FROZEN) as any;
  assert.ok(await rowOf(), 'PREMISE: a series whose source is not installed is frozen');
  assert.ok(!/Searched/.test((await rowOf()).detail), 'nothing about the scout before it looked');
  await q(`INSERT INTO series_scout (series_id, reason, last_at, verdict, detail) VALUES ($1, 'idle', now(), 'exhausted', '{"asked": 5, "searches": 6}'::jsonb)
           ON CONFLICT (series_id) DO UPDATE SET last_at = now(), verdict = 'exhausted', detail = EXCLUDED.detail`, [FROZEN]);
  // Reintroduce by dropping scoutLines from the frozen rows (lib/health.ts): no line.
  assert.match((await rowOf()).detail, /Searched 5 other sources on \d{4}-\d\d-\d\d: none has it yet/);
  assert.ok((await rowOf()).detailSaid.some((p: any) => p.code === 'scout.notFound'), 'said by its code, for the reader\'s language');
  await q(`UPDATE series_scout SET verdict = 'followed', detail = '{"asked": 1, "followed": "scw-found"}'::jsonb WHERE series_id = $1`, [FROZEN]);
  assert.match((await rowOf()).detail, /Searched 1 other source on \d{4}-\d\d-\d\d: now also using Found Site/, 'the source by its name');
  // A look that asked nobody (a series at its follower limit, every source cooling) says nothing.
  await q(`UPDATE series_scout SET verdict = 'cap', detail = '{"asked": 0, "searches": 0}'::jsonb WHERE series_id = $1`, [FROZEN]);
  assert.ok(!/Searched/.test((await rowOf()).detail));
});

test('a source the server followed on its own says why on the Sources sheet', { skip }, async () => {
  const { seriesSourcesFor } = await import('../src/lib/seriesSources');
  await q(`DELETE FROM users WHERE username = 'scw-admin'`);
  const admin = (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind, perms)
                          VALUES ('scw-admin','scw-admin','x','admin','password','{}'::jsonb) RETURNING id`))[0].id;
  await q(`INSERT INTO series_sources (series_id, source_id, source_series_id, added_by) VALUES ($1, $2, 'f-1', NULL), ($1, $3, 'p-1', $4)
           ON CONFLICT DO NOTHING`, [SHEET, FOUND, PICKED, admin]);
  await q(`INSERT INTO audit_log (event, detail) VALUES ('series.follow_source', $1::jsonb)`,
    [JSON.stringify({ id: SHEET, source: FOUND, auto: true, reason: 'scout' })]);
  const list = await seriesSourcesFor(SHEET);
  const found = list.find((s: any) => s.sourceId === FOUND)!;
  // Reintroduce by dropping the audit read (lib/seriesSources.ts `reasons`): foundFor is null.
  assert.equal(found.foundFor, 'scout');
  assert.ok(found.followedAt, 'and since when');
  const picked = list.find((s: any) => s.sourceId === PICKED)!;
  assert.deepEqual([picked.auto, picked.foundFor, picked.followedAt], [false, null, null], 'a person\'s follow explains nothing');
  // An automatic follow with no reason on its audit row is the add's own.
  await q(`INSERT INTO audit_log (event, detail) VALUES ('series.follow_source', $1::jsonb)`,
    [JSON.stringify({ id: SHEET, source: FOUND, auto: true })]);
  assert.equal((await seriesSourcesFor(SHEET)).find((s: any) => s.sourceId === FOUND)!.foundFor, 'add', 'the newest row says');
});

test('one switch: where the two old switches disagreed, the upgrade leaves both off', { skip }, async () => {
  // v0.81.0: "Finish downloads on their own" is the one switch for everything automatic about downloads, looking for other
  // sources included (lib/migrate.ts v0.81.0-one-switch-for-automatic-downloads). An admin who had turned either part
  // off must not find it switched back on. Reintroduce by keeping one column's value for both (`SET
  // auto_follow_on_failure = finish_downloads`): the search an admin turned off comes back on.
  const { migrate } = await import('../src/lib/migrate');
  const ID = 'v0.81.0-one-switch-for-automatic-downloads';
  try {
    for (const [finish, follow, want] of [[true, false, [false, false]], [false, true, [false, false]], [true, true, [true, true]], [false, false, [false, false]]] as const) {
      await q('UPDATE server_settings SET finish_downloads = $1, auto_follow_on_failure = $2 WHERE id = 1', [finish, follow]);
      await q('DELETE FROM schema_migrations WHERE id = $1', [ID]);
      await migrate();
      const r = (await q('SELECT finish_downloads AS f, auto_follow_on_failure AS a FROM server_settings WHERE id = 1'))[0];
      assert.deepEqual([r.f, r.a], [...want], `finish ${finish}, follow ${follow}`);
    }
  } finally {
    await q('UPDATE server_settings SET finish_downloads = true, auto_follow_on_failure = true WHERE id = 1');
  }
});
