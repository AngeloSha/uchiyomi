// Following a second source for a series, driven through the real routes.
//
// The follow is gated on the fill-scan plan the same way a fill is: the plan is the only place the "is this
// the same series?" judgement is made (lib/fill.ts explains why it is a judgement and not a proof), and a
// bare (source, id) pair taken from the body would let a client follow a source that numbers a different
// story 1..N -- after which every "new chapter" the updater merges in is the wrong book, named exactly like
// the right one. The fixtures are the fill suite's: a RICH source that carries everything, the POOR one the
// series was built from, and a WRONG one whose numbering overlaps by accident.
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
  process.env.SCAN_SEARCH_MS = '2000';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const LIB = 'lib_follow', SERIES = 's_follow_1', FOLDER = 'Follow Source/Followed Series';
const RICH = 'follow-rich';    // has 1..11
const POOR = 'follow-poor';    // has only 8..11, which is what our library was built from
const WRONG = 'follow-wrong';  // a different series that numbers 1..3
const USER = 'follow-admin';
let q: any, app: any, auth: Record<string, string>;

const page = (n: number) => ({ sourceId: `c/${n}`, number: n, title: `Chapter ${n}` });

function fake(id: string, name: string, nums: number[], title: string) {
  return {
    id, name,
    async search() { return [{ sourceId: `${id}-s`, source: id, title, coverUrl: undefined }]; },
    async getSeries(sid: string) { return { sourceId: sid, source: id, title }; },
    async listChapters() { return nums.map(page); },
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
  const sourceRoutes = (await import('../src/routes/sources')).default;
  const adminRoutes = (await import('../src/routes/admin')).default;
  const catalogRoutes = (await import('../src/routes/catalog')).default;
  await migrate();

  registerAdapter(fake(RICH, 'Rich Source', [1,2,3,4,5,6,7,8,9,10,11], 'Followed Series Deluxe Edition') as any);
  registerAdapter(fake(POOR, 'Poor Source', [8,9,10,11], 'Followed Series') as any);
  registerAdapter(fake(WRONG, 'Wrong Source', [1,2,3], 'Followed Series') as any);
  await q('DELETE FROM source_health WHERE source_id = ANY($1)', [[RICH, POOR, WRONG]]);

  await q(`INSERT INTO libraries (id, name, path) VALUES ($1,'Follow',$1) ON CONFLICT (id) DO NOTHING`, [LIB]);
  await q(`DELETE FROM lib_series WHERE id = $1`, [SERIES]);
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, source_id, source_series_id, source_chapters)
           VALUES ($1,'T!follow','Followed Series',$2,4,$3,$4,'follow-poor-s',4)`,
    [SERIES, FOLDER, LIB, POOR]);
  for (const n of [8, 9, 10, 11]) {
    await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, root)
             VALUES ($1,$2,'T!follow',$3,$4,$5,'/library')`,
      [`b_follow_${n}`, SERIES, `${FOLDER}/Chapter ${n}.cbz`, n, `Chapter ${n}`]);
  }
  await q('DELETE FROM users WHERE username = $1', [USER]);
  const uid = (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind)
                        VALUES ($1,$1,'x','admin','password') RETURNING id`, [USER]))[0].id;

  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register(sourceRoutes);
  await app.register(adminRoutes);
  await app.register(catalogRoutes);
  await app.ready();
  auth = { authorization: `Bearer ${app.jwt.sign({ sub: uid, role: 'admin' })}` };
});

after(async () => {
  if (!DSN) return;
  await app?.close();
  await q('DELETE FROM lib_series WHERE id = $1', [SERIES]).catch(() => {});
  await q('DELETE FROM libraries WHERE id = $1', [LIB]).catch(() => {});
  await q('DELETE FROM users WHERE username = $1', [USER]).catch(() => {});
  await q('DELETE FROM source_health WHERE source_id = ANY($1)', [[RICH, POOR, WRONG]]).catch(() => {});
});

const scan = async () => {
  const r = await app.inject({ method: 'POST', url: '/api/sources/fill/scan', headers: auth, payload: { seriesId: SERIES } });
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
};
const follow = (body: any, id = SERIES) =>
  app.inject({ method: 'POST', url: `/api/admin/series/${id}/sources`, headers: auth, payload: body });
const unfollow = (sourceId: string) =>
  app.inject({ method: 'DELETE', url: `/api/admin/series/${SERIES}/sources/${sourceId}`, headers: auth });
const seriesPage = async () => {
  const r = await app.inject({ method: 'GET', url: `/api/series/${SERIES}`, headers: auth });
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
};
const brief = (list: any[]) => list.map((s) => [s.sourceId, s.primary]);

test('a source the plan found to carry the series can be followed, and the series page lists it', { skip }, async (t) => {
  const plan = await scan();
  const rich = plan.candidates.find((c: any) => c.source === RICH);
  assert.ok(rich, 'the rich source was found by title');
  assert.equal(rich.coverage, 1);

  await t.test('before: the series page shows the primary alone', async () => {
    const page = await seriesPage();
    assert.deepEqual(brief(page.sources), [[POOR, true]]);
    assert.equal(page.sources[0].name, 'Poor Source');
    assert.equal(page.sources[0].sourceSeriesId, 'follow-poor-s');
    assert.equal(page.sources[0].chapters, 4, 'what the primary last said');
    assert.equal(page.sources[0].registered, true);
    assert.equal(page.scanlatorPrefs, null, 'an admin sees the (empty) release preferences');
    assert.equal(plan.following.length, 0, 'the scan says nothing is followed yet');
  });

  await t.test('the follow lands and answers with the new list', async () => {
    const r = await follow({ planId: plan.planId, source: RICH, sourceSeriesId: rich.sourceSeriesId });
    assert.equal(r.statusCode, 200, r.body);
    const j = r.json();
    assert.equal(j.ok, true);
    assert.deepEqual(brief(j.sources), [[POOR, true], [RICH, false]], 'primary first, then the follower');
    const extra = j.sources[1];
    assert.equal(extra.name, 'Rich Source');
    assert.equal(extra.sourceSeriesId, rich.sourceSeriesId);
    assert.equal(extra.registered, true);
    assert.equal(extra.checkedAt, null, 'never checked yet');
    const row = (await q('SELECT title, coverage, added_by FROM series_sources WHERE series_id = $1 AND source_id = $2', [SERIES, RICH]))[0];
    assert.equal(row.title, 'Followed Series Deluxe Edition', 'the candidate’s own title is kept, for the picker to show');
    assert.equal(Number(row.coverage), 1);
    assert.ok(row.added_by, 'who followed it is recorded');
  });

  await t.test('GET /api/series/:id lists the same sources, and the scan now says it is followed', async () => {
    const page = await seriesPage();
    assert.deepEqual(brief(page.sources), [[POOR, true], [RICH, false]]);
    assert.deepEqual((await scan()).following, [RICH]);
  });

  await t.test('following again is an update, not a second row', async () => {
    const again = await follow({ planId: (await scan()).planId, source: RICH, sourceSeriesId: rich.sourceSeriesId });
    assert.equal(again.statusCode, 200, again.body);
    assert.equal((await q('SELECT count(*)::int AS n FROM series_sources WHERE series_id = $1', [SERIES]))[0].n, 1);
  });

  await t.test('a member sees the sources too, and not the preferences', async () => {
    const member = (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind)
                             VALUES ('follow-member','follow-member','x','user','password') RETURNING id`))[0].id;
    try {
      const r = await app.inject({ method: 'GET', url: `/api/series/${SERIES}`,
        headers: { authorization: `Bearer ${app.jwt.sign({ sub: member, role: 'user' })}` } });
      assert.equal(r.statusCode, 200, r.body);
      assert.deepEqual(brief(r.json().sources), [[POOR, true], [RICH, false]]);
      assert.ok(!('scanlatorPrefs' in r.json()), 'release preferences are an admin field');
      assert.ok(!('folder' in r.json()), 'and so is the folder, as before');
    } finally {
      await q(`DELETE FROM users WHERE username = 'follow-member'`);
    }
  });
});

test('a source with a different story is refused', { skip }, async () => {
  // Reintroduce by deleting the not_followable guard in POST /api/admin/series/:id/sources: this answers
  // 200 and the WRONG fixture is followed, so its 1..3 would be merged in as this series' chapters 1..3.
  const plan = await scan();
  const wrong = plan.candidates.find((c: any) => c.source === WRONG);
  assert.ok(wrong, 'the wrong source is in the plan, marked');
  assert.equal(wrong.why, 'numbering_mismatch');
  assert.ok(wrong.coverage < 0.9);
  const r = await follow({ planId: plan.planId, source: WRONG, sourceSeriesId: wrong.sourceSeriesId });
  assert.equal(r.statusCode, 400, r.body);
  assert.equal(r.json().error, 'not_followable');
  assert.equal(r.json().reason, 'numbering_mismatch', 'the plan’s reason is passed on');
  assert.equal((await q('SELECT count(*)::int AS n FROM series_sources WHERE series_id = $1 AND source_id = $2', [SERIES, WRONG]))[0].n, 0);
});

test('the other refusals: stale plan, the primary itself, a source not in the plan, another series’ plan, a disabled source', { skip }, async (t) => {
  const plan = await scan();
  await t.test('an unknown plan is stale, not re-derived', async () => {
    const r = await follow({ planId: 'fp_deadbeefdeadbeef', source: RICH, sourceSeriesId: `${RICH}-s` });
    assert.equal(r.statusCode, 409);
    assert.equal(r.json().error, 'plan_stale');
  });
  await t.test('the series’ own source cannot be followed: it would list every chapter twice', async () => {
    const poor = plan.candidates.find((c: any) => c.source === POOR && c.pinned);
    assert.ok(poor, 'the primary is the pinned candidate');
    const r = await follow({ planId: plan.planId, source: POOR, sourceSeriesId: poor.sourceSeriesId });
    assert.equal(r.statusCode, 409);
    assert.equal(r.json().error, 'is_primary');
  });
  await t.test('a source the plan never offered', async () => {
    const r = await follow({ planId: plan.planId, source: 'follow-nowhere', sourceSeriesId: 'x' });
    assert.equal(r.statusCode, 400);
    assert.equal(r.json().error, 'not_in_plan');
  });
  await t.test('a plan made for another series', async () => {
    const r = await follow({ planId: plan.planId, source: RICH, sourceSeriesId: `${RICH}-s` }, 's_follow_other');
    assert.equal(r.statusCode, 400);
    assert.equal(r.json().error, 'bad_request');
  });
  await t.test('a source switched off between the scan and the follow', async () => {
    const { setDisabled } = await import('../src/lib/sourceHealth');
    await setDisabled(RICH, true);
    try {
      const r = await follow({ planId: plan.planId, source: RICH, sourceSeriesId: `${RICH}-s` });
      assert.equal(r.statusCode, 409, r.body);
      assert.equal(r.json().error, 'source_unavailable');
    } finally {
      await setDisabled(RICH, false);
    }
  });
  await t.test('and a body with the fields missing', async () => {
    assert.equal((await follow({ source: RICH })).statusCode, 400);
  });
});

test('unfollowing removes the row, and a second unfollow is 404', { skip }, async () => {
  assert.deepEqual(brief((await seriesPage()).sources), [[POOR, true], [RICH, false]], 'still followed from the first test');
  const r = await unfollow(RICH);
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(brief(r.json().sources), [[POOR, true]]);
  assert.deepEqual(brief((await seriesPage()).sources), [[POOR, true]]);
  assert.equal((await unfollow(RICH)).statusCode, 404);
  assert.equal((await q('SELECT count(*)::int AS n FROM series_sources WHERE series_id = $1', [SERIES]))[0].n, 0);
});
