// The admin's per-source age rating, end to end: the route, what it does to Discover's source list and to the fan-out, and the
// boot migration that folds the retired adult-sources list into it.
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
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const ADMIN = 'sar-admin';
const CAPPED = 'sar-capped';
/** Flagged adult by its "extension", like a Suwayomi source with isNsfw. */
const FLAGGED = 'sar-src-flagged';
/** Not flagged by anything. */
const PLAIN = 'sar-src-plain';

const asked: Record<string, number> = { [FLAGGED]: 0, [PLAIN]: 0 };
function fakeSource(id: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    id, name, ...extra,
    async search(term: string) { asked[id]++; return [{ sourceId: `${id}-1`, source: id, title: `${term} ${id}` }]; },
    async getSeries(sid: string) { return { sourceId: sid, source: id, title: name }; },
    async listChapters() { return []; },
    async getPageUrls() { return []; },
    async latest() { return []; },
    async popular() { return []; },
  };
}

test('a source rating decides adult in both directions, and survives a restart', { skip }, async (t) => {
  const { migrate } = await import('../src/lib/migrate');
  const { q, one } = await import('../src/lib/db');
  const { invalidateAdultFilter, sourceAllowedFor } = await import('../src/lib/visibility');
  const R = await import('../src/lib/sourceRatings');
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const { registerAdapter, getSource } = await import('../src/lib/sources');
  await migrate();
  registerAdapter(fakeSource(FLAGGED, 'Zzz Flagged Source', { isNsfw: true }) as any);
  registerAdapter(fakeSource(PLAIN, 'Zzz Plain Source') as any);

  const cleanup = async () => {
    await q('DELETE FROM users WHERE username = ANY($1)', [[ADMIN, CAPPED]]).catch(() => {});
    await q(`UPDATE server_settings SET source_ratings = '{}'::jsonb, adult_sources = '[]'::jsonb WHERE id = 1`).catch(() => {});
    R.applySourceRatings({});
    invalidateAdultFilter();
  };
  await cleanup();
  const admin = (await q<{ id: string }>(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ($1,$1,'x','admin','password') RETURNING id`, [ADMIN]))[0].id;
  const capped = (await q<{ id: string }>(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind, max_age_rating)
     VALUES ($1,$1,'x','user','password',16) RETURNING id`, [CAPPED]))[0].id;
  const app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/catalog')).default);
  await app.register((await import('../src/routes/sources')).default);
  await app.register((await import('../src/routes/admin')).default);
  await app.ready();
  const as = (id: string, role: string) => ({ authorization: `Bearer ${app.jwt.sign({ sub: id, role })}` });
  const rate = (id: string, body: unknown) => app.inject({ method: 'PUT', url: `/api/admin/sources/${id}/age-rating`, headers: as(admin, 'admin'), payload: body as never });
  const ids = async (who: string, role: string, url = '/api/sources') =>
    ((await app.inject({ method: 'GET', url, headers: as(who, role) })).json().content as Array<{ id: string }>).map((s) => s.id);

  try {
    await t.test('PREMISE: unrated, the flag decides: a capped account loses the flagged source and keeps the plain one', async () => {
      const list = await ids(capped, 'user');
      assert.ok(!list.includes(FLAGGED) && list.includes(PLAIN), list.join());
    });

    await t.test('Mixed lets a capped account use a flagged source, and keeps it in the fan-out with Show 18+ off', async () => {
      const r = await rate(FLAGGED, { ageRating: 0 });
      assert.equal(r.statusCode, 200, r.body);
      assert.deepEqual(r.json(), { ok: true, ageRating: 0 });
      assert.ok((await ids(capped, 'user')).includes(FLAGGED), 'the capped account still cannot reach it');
      assert.ok((await ids(admin, 'admin')).includes(FLAGGED), 'Mixed took the source off the admin\'s list with the reveal off');
    });

    await t.test('Adult only makes an unflagged source adult: refused to a capped account, hidden while Show 18+ is off, back with it', async () => {
      assert.equal((await rate(PLAIN, { ageRating: 18 })).statusCode, 200);
      assert.equal(sourceAllowedFor(getSource(PLAIN), 16), false);
      assert.ok(!(await ids(capped, 'user')).includes(PLAIN));
      assert.ok(!(await ids(admin, 'admin')).includes(PLAIN), 'hidden with the reveal off');
      assert.ok((await ids(admin, 'admin', '/api/sources?adult=1')).includes(PLAIN), 'the reveal did not bring it back');
      const before = asked[PLAIN];
      const r = await app.inject({ method: 'GET', url: '/api/sources/search-all?q=Zzzsar', headers: as(admin, 'admin') });
      assert.equal(r.statusCode, 200);
      assert.equal(asked[PLAIN] - before, 0, 'the fan-out still asked an Adult only source');
    });

    await t.test('the route takes 0, 18 or null and nothing else, and null puts the default back', async () => {
      for (const bad of [{ ageRating: 13 }, { ageRating: 19 }, { ageRating: '18' }, {}, { ageRating: 18, extra: 1 }]) {
        assert.equal((await rate(PLAIN, bad)).statusCode, 400, JSON.stringify(bad));
      }
      assert.equal((await rate('bad id', { ageRating: 18 })).statusCode, 400);
      assert.equal((await rate(FLAGGED, { ageRating: null })).statusCode, 200);
      assert.ok(!(await ids(capped, 'user')).includes(FLAGGED), 'the default (the extension flag) did not come back');
    });

    await t.test('a rating is stored, and is read again after a restart', async () => {
      const row = await one<{ source_ratings: Record<string, number> }>('SELECT source_ratings FROM server_settings WHERE id = 1');
      assert.deepEqual(row?.source_ratings, { [PLAIN]: 18 });
      R.applySourceRatings({});
      assert.equal(sourceAllowedFor(getSource(PLAIN), 16), true, 'PREMISE: the in-memory copy is empty');
      await R.loadSourceRatings();
      assert.equal(sourceAllowedFor(getSource(PLAIN), 16), false);
    });

    await t.test('the 18+ switch is still offered when a rated source is the only thing it would hide', async () => {
      const r = await app.inject({ method: 'GET', url: '/api/adult-filter', headers: as(admin, 'admin') });
      assert.equal(r.json().configured, true);
    });

    await t.test('the boot migration folds the retired adult-sources list into ratings and empties it', async () => {
      await q(`UPDATE server_settings SET adult_sources = $1::jsonb, source_ratings = $2::jsonb WHERE id = 1`,
        [JSON.stringify([FLAGGED.toUpperCase(), PLAIN]), JSON.stringify({ [PLAIN]: 0 })]);
      await q(`DELETE FROM schema_migrations WHERE id = 'adult-sources-into-ratings'`).catch(() => {});
      await migrate();
      const row = await one<{ adult_sources: unknown; source_ratings: unknown }>('SELECT adult_sources, source_ratings FROM server_settings WHERE id = 1');
      assert.deepEqual(row?.adult_sources, []);
      assert.deepEqual(row?.source_ratings, { [FLAGGED]: 18, [PLAIN]: 0 }, 'an id the admin had already rated keeps that rating');
    });
  } finally {
    await app.close();
    await cleanup();
  }
});
