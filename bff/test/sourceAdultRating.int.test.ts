// A whole source rated Adult only by the admin (v0.73.0, #256 from @Squeaks72), driven over HTTP.
//
// Before, a source the admin ticked as adult only tidied listings: with Show 18+ off it left Discover, but an account
// limited below 18 still got its latest and popular pages, a series' detail and the add by id, because the only thing
// that refused a source was its extension's own adult flag. Now the admin's rating is that flag: refused everywhere.
// A built-in or added site declares nothing, so the source here is unflagged, and every by-id route is asked as the
// capped account first while the source is unrated (the premise: the route answers), then rated (it refuses).
//
// Nothing rates a source BELOW its extension's flag: the contributor's "Mixed" would have let a capped account into a
// whole site, so the route takes 18 or null and nothing else.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test from 'node:test';
import assert from 'node:assert/strict';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.SOURCE_LATEST_TIMEOUT_MS = '400';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

/** Declares nothing, like every built-in and added site: only the admin's rating can make it adult. */
const PLAIN = 'sar-plain';
/** Flagged by its "extension": what a rating of 18 is held to. */
const FLAGGED = 'sar-flagged';
/** Never rated: the control that must keep answering. */
const OTHER = 'sar-other';
const USERS = ['sar-admin', 'sar-capped', 'sar-plainuser'];

function fake(id: string, name: string, isNsfw?: boolean) {
  const series = (n: number) => ({ sourceId: `${id}-${n}`, source: id, title: `${name} Title ${n}` });
  return {
    id, name, isNsfw,
    async search() { return [series(1)]; },
    // No title: an add gets past every permission and stops at `no_title` (503) before it writes anything, so the
    // premise below can show the add answering without a series landing in the library.
    async getSeries(sid: string) { return { sourceId: sid, source: id, title: '' }; },
    async listChapters() { return [{ sourceId: `${id}-c1`, number: 1, title: 'One' }]; },
    async getPageUrls() { return ['https://img.invalid/1.jpg']; },
    async latest() { return [series(1), series(2)]; },
    async popular() { return [series(3)]; },
  };
}

test('a source rated Adult only is refused to a capped account, by id, everywhere', { skip }, async (t) => {
  const { migrate } = await import('../src/lib/migrate');
  const { q, one } = await import('../src/lib/db');
  const { registerAdapter, getSource } = await import('../src/lib/sources');
  const V = await import('../src/lib/visibility');
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  await migrate();
  registerAdapter(fake(PLAIN, 'Zzz Plain Source') as any);
  registerAdapter(fake(FLAGGED, 'Zzz Flagged Source', true) as any);
  registerAdapter(fake(OTHER, 'Zzz Other Source') as any);

  const cleanup = async () => {
    await q('DELETE FROM users WHERE username = ANY($1)', [USERS]).catch(() => {});
    await q(`UPDATE server_settings SET adult_sources = '[]'::jsonb WHERE id = 1`).catch(() => {});
    V.applyAdultSources([]);
    V.invalidateAdultFilter();
  };
  await cleanup();
  const mk = async (username: string, role: string, cap: number | null) => (await q<{ id: string }>(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind, max_age_rating)
     VALUES ($1,$1,'x',$2,'password',$3) RETURNING id`, [username, role, cap]))[0].id;
  const admin = await mk('sar-admin', 'admin', null);
  const capped = await mk('sar-capped', 'user', 16);
  const plainUser = await mk('sar-plainuser', 'user', null);

  const app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/sources')).default);
  await app.register((await import('../src/routes/admin')).default);
  await app.ready();
  const as = (id: string, role = 'user') => ({ authorization: `Bearer ${app.jwt.sign({ sub: id, role })}` });
  const rate = (id: string, body: unknown, who = admin, role = 'admin') =>
    app.inject({ method: 'PUT', url: `/api/admin/sources/${encodeURIComponent(id)}/age-rating`, headers: as(who, role), payload: body as never });
  /** The five by-id routes, as the add dialog and Discover call them. */
  const byId = {
    latest: () => app.inject({ method: 'GET', url: `/api/sources/latest?source=${PLAIN}`, headers: as(capped) }),
    popular: () => app.inject({ method: 'GET', url: `/api/sources/popular?source=${PLAIN}`, headers: as(capped) }),
    detail: () => app.inject({ method: 'GET', url: `/api/sources/detail?source=${PLAIN}&sourceId=${PLAIN}-1`, headers: as(capped) }),
    add: () => app.inject({ method: 'POST', url: '/api/sources/add', headers: as(capped), payload: { source: PLAIN, sourceId: `${PLAIN}-1` } }),
    preview: (who = capped) => app.inject({ method: 'GET', url: `/api/sources/preview?source=${PLAIN}&sourceId=${PLAIN}-1`, headers: as(who) }),
  };
  const refused = (r: { statusCode: number; body: string }, what: string) => {
    assert.equal(r.statusCode, 403, `${what} answered ${r.statusCode} to a 16+ account: ${r.body}`);
    assert.ok(!r.body.includes('Zzz Plain Source Title'), `${what} leaked a title`);
  };

  try {
    await t.test('PREMISE: unrated, the source answers the capped account on every by-id route', async () => {
      const latest = await byId.latest();
      assert.equal(latest.statusCode, 200, latest.body);
      assert.ok(latest.json().content.length > 0, 'the unrated source showed the capped account nothing');
      assert.equal((await byId.popular()).statusCode, 200);
      assert.equal((await byId.detail()).statusCode, 200);
      const add = await byId.add();
      assert.equal(add.statusCode, 503, `the add stopped before the title, at ${add.statusCode}: ${add.body}`);
      assert.equal(add.json().error, 'no_title');
      // The preview is refused to every account with an age limit, rated or not (previewChapters, `age_limited`); an
      // account with no limit is what shows it answers.
      assert.equal((await byId.preview(plainUser)).statusCode, 200);
    });

    await t.test('the admin rates it Adult only', async () => {
      const r = await rate(PLAIN, { ageRating: 18 });
      assert.equal(r.statusCode, 200, r.body);
      assert.deepEqual(r.json(), { ok: true, ageRating: 18 });
      const row = await one<{ adult_sources: string[] }>('SELECT adult_sources FROM server_settings WHERE id = 1');
      assert.deepEqual(row?.adult_sources, [PLAIN], 'the rating is not the stored adult source list');
    });

    // Reintroduce each of the next four by reading the extension's flag alone in sourceAllowedFor (drop
    // `&& !sourceRatedAdult(src)`): the route answers the capped account again -- 200 with the source's covers on
    // latest and popular, 200 on detail, the add reaching `no_title` (503).
    await t.test('latest: refused', async () => { refused(await byId.latest(), 'latest'); });
    await t.test('popular: refused', async () => { refused(await byId.popular(), 'popular'); });
    await t.test('detail: refused', async () => { refused(await byId.detail(), 'detail'); });
    await t.test('add: refused, and nothing is added', async () => {
      refused(await byId.add(), 'the add');
      assert.equal(await one('SELECT 1 FROM lib_series WHERE source_id = $1', [PLAIN]), null);
    });
    // ⚠️ Not the rating's test alone: previewChapters refuses every account with an age limit before it asks whose
    // source it is (`age_limited`), so dropping the rating from sourceAllowedFor leaves this one passing. Reintroduce
    // by dropping that rule as well (`if (ctx.maxAgeRating != null) return refused(…)`): the preview of the rated
    // source then opens for the capped account, 200 with its chapters.
    await t.test('preview: refused', async () => { refused(await byId.preview(), 'the preview'); });

    await t.test('an account with no age limit still reaches it; the admin too, and the list hides it while Show 18+ is off', async () => {
      assert.equal((await app.inject({ method: 'GET', url: `/api/sources/detail?source=${PLAIN}&sourceId=${PLAIN}-1`, headers: as(plainUser) })).statusCode, 200);
      const latest = await app.inject({ method: 'GET', url: `/api/sources/latest?source=${PLAIN}&adult=1`, headers: as(plainUser) });
      assert.ok(latest.json().content.length > 0, 'an uncapped account lost the source');
      const ids = async (url: string, who: string, role: string) =>
        ((await app.inject({ method: 'GET', url, headers: as(who, role) })).json().content as Array<{ id: string }>).map((s) => s.id);
      assert.ok(!(await ids('/api/sources', admin, 'admin')).includes(PLAIN), 'listed while Show 18+ is off');
      assert.ok((await ids('/api/sources?adult=1', admin, 'admin')).includes(PLAIN), 'the reveal did not bring it back');
      assert.ok(!(await ids('/api/sources?adult=1', capped, 'user')).includes(PLAIN), 'the capped account had it listed with the reveal on');
      assert.ok((await ids('/api/sources', capped, 'user')).includes(OTHER), 'the unrated control vanished too: the rule is too wide');
    });

    await t.test('the sources overview says which sources are rated, and what each is held to without it', async () => {
      const r = await app.inject({ method: 'GET', url: '/api/admin/sources/overview', headers: as(admin, 'admin') });
      assert.equal(r.statusCode, 200);
      const by = new Map((r.json().sources as Array<{ id: string; ageRating: number | null; defaultAgeRating: number | null }>).map((s) => [s.id, s]));
      assert.deepEqual([by.get(PLAIN)?.ageRating, by.get(PLAIN)?.defaultAgeRating], [18, null]);
      assert.deepEqual([by.get(FLAGGED)?.ageRating, by.get(FLAGGED)?.defaultAgeRating], [null, 18]);
      assert.deepEqual([by.get(OTHER)?.ageRating, by.get(OTHER)?.defaultAgeRating], [null, null]);
    });

    await t.test('the route takes 18 or null and nothing else: no rating lets a capped account into a site', async () => {
      // 0 was the contributor's "Mixed", which cancelled an extension's adult flag for a whole source.
      for (const bad of [{ ageRating: 0 }, { ageRating: 16 }, { ageRating: 19 }, { ageRating: '18' }, {}, { ageRating: 18, extra: 1 }]) {
        assert.equal((await rate(FLAGGED, bad)).statusCode, 400, JSON.stringify(bad));
      }
      assert.equal((await rate('bad id!', { ageRating: 18 })).statusCode, 400);
      assert.equal((await rate(OTHER, { ageRating: 18 }, capped, 'user')).statusCode, 403, 'a member rated a source');
      assert.equal(V.sourceAllowedFor(getSource(FLAGGED), 16), false, 'the flagged source opened up');
      assert.equal(V.sourceAllowedFor(getSource(OTHER), 16), true, 'a refused request rated the source anyway');
    });

    await t.test('null takes the rating off, and the source answers the capped account again', async () => {
      assert.deepEqual((await rate(PLAIN, { ageRating: null })).json(), { ok: true, ageRating: null });
      assert.equal((await byId.detail()).statusCode, 200);
      assert.equal((await byId.latest()).statusCode, 200);
    });

    await t.test("the settings' adultSources is the same list, and a save refuses at once", async () => {
      // The 18+ lists are cached for a few seconds; the permission must not wait for that.
      const r = await app.inject({ method: 'PATCH', url: '/api/admin/settings', headers: as(admin, 'admin'), payload: { adultSources: [PLAIN.toUpperCase()] } });
      assert.equal(r.statusCode, 200, r.body);
      refused(await byId.detail(), 'detail after a settings save');
    });

    await t.test('after a restart, the stored list is read back before anything asks (an upgraded server refuses what was ticked)', async () => {
      // What an older version stored, the ticked chips: now a rating of 18.
      await q(`UPDATE server_settings SET adult_sources = $1::jsonb WHERE id = 1`, [JSON.stringify([PLAIN])]);
      V.applyAdultSources([]);
      assert.equal(V.sourceAllowedFor(getSource(PLAIN), 16), true, 'PREMISE: the in-memory copy is empty, as in a new process');
      await V.loadAdultSources();
      assert.equal(V.sourceAllowedFor(getSource(PLAIN), 16), false, 'the boot read did not restore the rating');
      refused(await byId.popular(), 'popular after a restart');
    });
  } finally {
    await app.close();
    await cleanup();
  }
});
