// Release preferences over the admin routes: the per-series and global writes, and the group report the
// editor is seeded from.
//
// The report is the part worth a real database. It merges three sets that each miss what the others have
// -- the groups stamped on files (a group that released the early chapters and disbanded is only there),
// the groups in the listing the updater persisted at the last check (a group that just picked the title
// up is only there), and the names already in the prefs -- and the last one is the trap: a blocked group
// that drops out of the listing has to keep appearing, or the block can never be lifted from the page that
// set it. Since v0.33.0 the persisted listing (series_listing.copies) is the source of truth for the
// report, never the sources themselves: the series page reads it on every admin visit.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.UCHIYOMI_PING_URL = '';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const SERIES = 's_sp_1', FOLDER = 'Prefs Source/Prefs Series';
const PRIMARY = 'sp-primary';   // lists Group A, and a joint Group B & Group C release
const EXTRA = 'sp-extra';       // a followed source that lists Group D live, but whose PERSISTED copies name Group E
const BROKEN = 'sp-broken';     // a followed source whose listing throws
const USER = 'sp-admin';
let q: any, app: any, auth: Record<string, string>, savedGlobal: any;

function fake(id: string, chapters: Array<{ number: number; scanlator?: string }> | Error) {
  return {
    id, name: `Fake ${id}`,
    async search() { return []; },
    async getSeries(sid: string) { return { sourceId: sid, source: id, title: 'Prefs Series' }; },
    async listChapters() {
      if (chapters instanceof Error) throw chapters;
      return chapters.map((c) => ({ sourceId: `c/${c.number}`, number: c.number, title: `Chapter ${c.number}`, scanlator: c.scanlator }));
    },
    async getPageUrls() { return []; },
    async latest() { return []; },
  };
}

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  const { registerAdapter } = await import('../src/lib/sources');
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const adminRoutes = (await import('../src/routes/admin')).default;
  await migrate();

  registerAdapter(fake(PRIMARY, [
    { number: 1, scanlator: 'Group A' }, { number: 2, scanlator: 'Group A' }, { number: 3, scanlator: 'Group B & Group C' },
  ]) as any);
  registerAdapter(fake(EXTRA, [{ number: 3, scanlator: 'Group D' }, { number: 4, scanlator: 'Group D' }]) as any);
  registerAdapter(fake(BROKEN, new Error('site down')) as any);

  await q('DELETE FROM lib_series WHERE id = $1', [SERIES]);
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, source_id, source_series_id)
           VALUES ($1, 'T!sp', 'Prefs Series', $2, 3, $3, 'primary-s')`, [SERIES, FOLDER, PRIMARY]);
  // Two files from Group A and one from a group no source lists any more.
  for (const [n, grp] of [[1, 'Group A'], [2, 'Group A'], [3, 'Old Group']] as const) {
    await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, root, scanlator)
             VALUES ($1, $2, 'T!sp', $3, $4, $5, '/library', $6)`,
      [`b_sp_${n}`, SERIES, `${FOLDER}/Chapter ${n}.cbz`, n, `Chapter ${n}`, grp]);
  }
  await q(`INSERT INTO series_sources (series_id, source_id, source_series_id) VALUES ($1, $2, 'extra-s'), ($1, $3, 'broken-s')`,
    [SERIES, EXTRA, BROKEN]);
  // What the last check persisted (lib/seriesListing.ts shape): the primary's three numbers, 3 also from
  // the follower as Group E, and 4 from the follower alone. Deliberately NOT what the follower lists live
  // (Group D): the report must read these rows and not ask the source.
  const copy = (n: number, source: string, groups: string[]) =>
    ({ sourceId: `c/${n}/${groups.join('+')}`, source, groups, scanlator: groups.join(' & '), lang: null, pages: null, publishedAt: null });
  const rows: Array<[number, string, ReturnType<typeof copy>[]]> = [
    [1, PRIMARY, [copy(1, PRIMARY, ['Group A'])]],
    [2, PRIMARY, [copy(2, PRIMARY, ['Group A'])]],
    [3, PRIMARY, [copy(3, PRIMARY, ['Group B', 'Group C']), copy(3, EXTRA, ['Group E'])]],
    [4, EXTRA, [copy(4, EXTRA, ['Group E'])]],
  ];
  for (const [n, source, copies] of rows) {
    await q(`INSERT INTO series_listing (series_id, number, source_id, chosen, status, copies) VALUES ($1, $2, $3, $4::jsonb, 'available', $5::jsonb)`,
      [SERIES, n, source, JSON.stringify({ sourceId: copies[0].sourceId, number: n, title: `Chapter ${n}`, scanlator: copies[0].scanlator }), JSON.stringify(copies)]);
  }
  await q('DELETE FROM users WHERE username = $1', [USER]);
  const uid = (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind)
                        VALUES ($1,$1,'x','admin','password') RETURNING id`, [USER]))[0].id;
  savedGlobal = (await q('SELECT scanlator_prefs FROM server_settings WHERE id = 1'))[0]?.scanlator_prefs;
  await q(`UPDATE server_settings SET scanlator_prefs = '{"priority":[],"blocked":[],"patienceDays":2}'::jsonb WHERE id = 1`);

  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register(adminRoutes);
  await app.ready();
  auth = { authorization: `Bearer ${app.jwt.sign({ sub: uid, role: 'admin' })}` };
});

after(async () => {
  if (!DSN) return;
  await app?.close();
  await q('DELETE FROM lib_series WHERE id = $1', [SERIES]).catch(() => {});
  await q('DELETE FROM users WHERE username = $1', [USER]).catch(() => {});
  if (savedGlobal !== undefined) await q('UPDATE server_settings SET scanlator_prefs = $1::jsonb WHERE id = 1', [JSON.stringify(savedGlobal)]).catch(() => {});
});

const patchSeries = (body: any) => app.inject({ method: 'PATCH', url: `/api/admin/series/${SERIES}`, headers: auth, payload: body });
const report = async () => {
  const r = await app.inject({ method: 'GET', url: `/api/admin/series/${SERIES}/scanlators`, headers: auth });
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
};

test('per-series preferences round-trip, and null clears them', { skip }, async (t) => {
  const prefs = { priority: ['Group A'], blocked: ['Vanished Group'], patienceDays: 3 };
  await t.test('a write is read back verbatim, and the effective set reflects it', async () => {
    const r = await patchSeries({ scanlatorPrefs: prefs });
    assert.equal(r.statusCode, 200, r.body);
    const j = await report();
    assert.deepEqual(j.prefs, prefs, 'the series row holds what was written');
    assert.deepEqual(j.effective.priority, ['Group A']);
    assert.deepEqual(j.effective.blocked, ['Vanished Group']);
    assert.equal(j.effective.patienceDays, 3, 'the series patience wins over the global two days');
    assert.equal(j.global.patienceDays, 2);
  });

  await t.test('autoUpdate can ride in the same body, and neither field is required', async () => {
    const r = await patchSeries({ autoUpdate: false });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal((await q('SELECT auto_update FROM lib_series WHERE id = $1', [SERIES]))[0].auto_update, false);
    assert.deepEqual((await report()).prefs, prefs, 'a body that names only autoUpdate leaves the prefs alone');
    await patchSeries({ autoUpdate: true });
  });

  await t.test('null clears the series row, so the global preferences apply again', async () => {
    const r = await patchSeries({ scanlatorPrefs: null });
    assert.equal(r.statusCode, 200, r.body);
    const j = await report();
    assert.equal(j.prefs, null);
    assert.deepEqual(j.effective.priority, []);
    assert.equal(j.effective.patienceDays, 2, 'back to the global value');
  });
});

test('the body is checked: patience over 30 days, an empty body and unknown keys are refused', { skip }, async () => {
  assert.equal((await patchSeries({ scanlatorPrefs: { priority: [], blocked: [], patienceDays: 31 } })).statusCode, 400, 'patienceDays 31');
  assert.equal((await patchSeries({ scanlatorPrefs: { priority: [''], blocked: [], patienceDays: null } })).statusCode, 400, 'an empty group name');
  assert.equal((await patchSeries({})).statusCode, 400, 'nothing to change');
  assert.equal((await patchSeries({ title: 'x' })).statusCode, 400, 'a field this route does not own');
  const missing = await app.inject({ method: 'PATCH', url: '/api/admin/series/s_sp_nope', headers: auth, payload: { autoUpdate: true } });
  assert.equal(missing.statusCode, 404);
});

test('the global preferences persist through the settings route and are read back', { skip }, async () => {
  const prefs = { priority: ['Group Z'], blocked: ['Spam Group'], patienceDays: 5 };
  const settings = (payload: any) => app.inject({ method: 'PATCH', url: '/api/admin/settings', headers: auth, payload });
  try {
    const w = await settings({ scanlatorPrefs: prefs });
    assert.equal(w.statusCode, 200, w.body);
    assert.deepEqual(w.json().scanlator_prefs, prefs, 'the PATCH answers with the new row');
    const g = await app.inject({ method: 'GET', url: '/api/admin/settings', headers: auth });
    assert.deepEqual(g.json().scanlator_prefs, prefs, 'and GET returns it');
    const j = await report();
    assert.deepEqual(j.global, prefs, 'the series report sees the same global row');
    assert.deepEqual(j.effective.priority, ['Group Z'], 'a series with no priority of its own inherits the global one');
    assert.equal(j.effective.patienceDays, 5);
    // The settings route parses with .parse() and leaves the status to server.ts's error handler, which this
    // harness does not mount; what is pinned here is that a bad value is refused and the row is untouched.
    const bad = await settings({ scanlatorPrefs: { priority: [], blocked: [], patienceDays: 99 } });
    assert.ok(bad.statusCode >= 400, `patienceDays 99 is refused, got ${bad.statusCode}`);
    assert.deepEqual((await q('SELECT scanlator_prefs FROM server_settings WHERE id = 1'))[0].scanlator_prefs, prefs, 'and nothing was written');
  } finally {
    await settings({ scanlatorPrefs: { priority: [], blocked: [], patienceDays: 2 } });
  }
});

test('the group report merges the disk, the persisted listing, and the names already in the prefs', { skip }, async (t) => {
  await patchSeries({ scanlatorPrefs: { priority: [], blocked: ['Vanished Group'], patienceDays: null } });
  const j = await report();
  const byName = new Map<string, any>(j.groups.map((g: any) => [g.name, g]));

  await t.test('counts from the files on disk', () => {
    assert.equal(byName.get('Group A')?.onDisk, 2, `two files from Group A: ${JSON.stringify(j.groups)}`);
    assert.equal(byName.get('Old Group')?.onDisk, 1, 'a group only the disk knows is still offered');
    assert.equal(byName.get('Old Group')?.listed, 0);
  });

  await t.test('counts from the persisted primary copies, with a joint release counted for each group', () => {
    assert.equal(byName.get('Group A')?.listed, 2);
    assert.equal(byName.get('Group B')?.listed, 1, 'the joint release names Group B');
    assert.equal(byName.get('Group C')?.listed, 1, 'and Group C');
    assert.equal(byName.get('Group B')?.onDisk, 0);
  });

  await t.test('the report reads the persisted listing, not the sources', () => {
    // The follower's persisted copies name Group E; what it lists LIVE is Group D, and a source that throws
    // (BROKEN) simply has no rows. Reintroduce by listing each followed source live (seriesAndChapters) in
    // GET /scanlators as v0.32.0 did: Group D appears with listed 2 and Group E is missing -- and every
    // admin page open costs a listing call per followed source.
    assert.equal(byName.get('Group E')?.listed, 2, `the follower's persisted copies count: ${JSON.stringify(j.groups.map((g: any) => g.name))}`);
    assert.equal(byName.get('Group D'), undefined, 'a group only the live listing names is not in the report');
    assert.equal(j.groups.filter((g: any) => byName.has(g.name)).length, j.groups.length, 'every row is a named group');
  });

  await t.test('a blocked group that vanished from the listing is still offered', () => {
    // Reintroduce by dropping the loop over the effective names in GET /scanlators: this fails -- the name
    // is in `effective.blocked` and absent from `groups`, so there is no row to unblock it from.
    const gone = byName.get('Vanished Group');
    assert.ok(gone, `the blocked name is in the list: ${JSON.stringify(j.groups.map((g: any) => g.name))}`);
    assert.deepEqual([gone.onDisk, gone.listed], [0, 0]);
    assert.deepEqual(j.effective.blocked, ['Vanished Group']);
  });

  await t.test('names are deduped by spelling-insensitive key, first spelling kept', async () => {
    await patchSeries({ scanlatorPrefs: { priority: ['group-a'], blocked: [], patienceDays: null } });
    const again = await report();
    const spellings = again.groups.filter((g: any) => /group.?a/i.test(g.name));
    assert.equal(spellings.length, 1, `one row for Group A however it is spelt: ${JSON.stringify(spellings)}`);
    assert.equal(spellings[0].name, 'Group A', 'the listing spelling wins over the prefs spelling');
    await patchSeries({ scanlatorPrefs: null });
  });
});
