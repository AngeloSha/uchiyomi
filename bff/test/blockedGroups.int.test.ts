// Blocking a scanlation group hides, at once, the chapters only blocked groups released -- on the series page and on
// the Komga list Mihon and the trackers read -- and takes them out of what anything downloads; a chapter another,
// unblocked group also released stays, its copy switched to that group's. Unblocking shows them again, at once.
// Driven through the real routes (a series' Sources & translations save and the global Scanlators save), against a
// stored listing: no source is asked, which is the point -- the change must not wait for the next check.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DSN = process.env.TEST_DATABASE_URL;
const TMP = DSN ? mkdtempSync(join(tmpdir(), 'yomi-blk-')) : '';
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.CACHE_DIR = join(TMP, 'cache');
  process.env.DL_ROOT = join(TMP, 'dl');
  process.env.LIBRARY_ROOT = join(TMP, 'lib');
  process.env.LIBRARY_BACKEND = 'owned';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const LIB = 'lib_blk', S = 's_blk', OTHER = 's_blk_other', ADMIN = 'blk-admin', SRC = 'blk-src';
let q: any, app: any, tok: string, apiKey: string, savedPrefs: unknown, savedSourcePrefs: unknown, savedGhosts: boolean | undefined;

const copy = (n: number, groups: string[]) => ({
  sourceId: `c/${n}/${groups.join('+') || 'none'}`, source: SRC, groups, scanlator: groups.join(' & ') || null,
  lang: null, pages: 10, publishedAt: '2026-01-01T00:00:00Z', title: `Chapter ${n}`,
});
/**
 * 1: Bad only.  2: Bad and Worse (two blocked groups, two copies).  3: Bad, and Good's copy.  4: Good only.
 * 5: a joint Bad & Good release (Good's work too: never blocked by Bad alone).  6: no group named (never blocked).
 */
const LISTING: Array<[number, string[][]]> = [
  [1, [['Bad']]], [2, [['Bad'], ['Worse']]], [3, [['Bad'], ['Good']]], [4, [['Good']]], [5, [['Bad', 'Good']]], [6, [[]]],
];

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  const { issueApiToken } = (await import('../src/lib/auth')) as any;
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const cookie = (await import('@fastify/cookie')).default;
  const rateLimit = (await import('@fastify/rate-limit')).default;
  await migrate();
  const st = (await q('SELECT scanlator_prefs, source_prefs, komga_ghost_chapters FROM server_settings WHERE id = 1'))[0];
  savedPrefs = st?.scanlator_prefs; savedSourcePrefs = st?.source_prefs; savedGhosts = st?.komga_ghost_chapters;
  await q(`UPDATE server_settings SET scanlator_prefs = '{"priority":[],"blocked":[],"patienceDays":2}'::jsonb, komga_ghost_chapters = true WHERE id = 1`);
  await q(`INSERT INTO libraries (id, name, path) VALUES ($1,'Blk',$1) ON CONFLICT (id) DO NOTHING`, [LIB]);
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [[S, OTHER]]);
  for (const id of [S, OTHER]) {
    await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, source_id, source_series_id)
             VALUES ($1,'T!blk',$1,$2,0,$3,$4,'x')`, [id, `T!blk/${id}`, LIB, SRC]);
    for (const [n, gs] of LISTING) {
      const copies = gs.map((g) => copy(n, g));
      const groups = [...new Set(gs.flat())];
      await q(`INSERT INTO series_listing (series_id, number, title, published_at, scanlator, groups, source_id, chosen, status, copies)
               VALUES ($1,$2,$3,'2026-01-01T00:00:00Z',$4,$5,$6,$7::jsonb,'available',$8::jsonb)`,
        [id, n, `Chapter ${n}`, copies[0].scanlator, groups, SRC, JSON.stringify({ ...copies[0], number: n }), JSON.stringify(copies)]);
    }
  }
  await q('DELETE FROM users WHERE username = $1', [ADMIN]);
  const adminId = (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ($1,$1,'x','admin','password') RETURNING id`, [ADMIN]))[0].id;
  app = Fastify();
  await app.register(cookie);
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register(rateLimit, { global: false });
  await app.register((await import('../src/routes/admin')).default);
  await app.register((await import('../src/routes/catalog')).default);
  await app.register((await import('../src/routes/komgaCompat')).default);
  await app.ready();
  tok = `Bearer ${app.jwt.sign({ sub: adminId, role: 'admin' })}`;
  apiKey = (await issueApiToken(adminId, 'blk', ['read'], null)).token;
});

after(async () => {
  if (TMP) rmSync(TMP, { recursive: true, force: true });
  if (!DSN) return;
  await app?.close();
  await q('UPDATE server_settings SET scanlator_prefs = $1::jsonb, source_prefs = $2::jsonb, komga_ghost_chapters = $3 WHERE id = 1',
    [JSON.stringify(savedPrefs ?? {}), JSON.stringify(savedSourcePrefs ?? {}), savedGhosts ?? false]).catch(() => {});
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [[S, OTHER]]).catch(() => {});
  await q('DELETE FROM libraries WHERE id = $1', [LIB]).catch(() => {});
  await q('DELETE FROM users WHERE username = $1', [ADMIN]).catch(() => {});
});

const shown = async (id = S) => (await app.inject({ method: 'GET', url: `/api/series/${id}/listing`, headers: { authorization: tok } }))
  .json().content.map((g: any) => g.number).sort((a: number, b: number) => a - b);
const mihon = async (id = S) => (await app.inject({
  method: 'GET', url: `/api/v1/series/${id}/books?unpaged=true&media_status=READY&deleted=false`, headers: { 'x-api-key': apiKey },
})).json().content.map((b: any) => b.number);
const patchSeries = (blocked: string[]) => app.inject({
  method: 'PATCH', url: `/api/admin/series/${S}`, headers: { authorization: tok },
  payload: { scanlatorPrefs: { priority: [], blocked, patienceDays: null } },
});
const row = async (n: number, id = S) => (await q(
  'SELECT status, chosen, source_id, scanlator, title, published_at FROM series_listing WHERE series_id = $1 AND number = $2::real', [id, n],
))[0];

test('blocking a group hides its only-copy chapters at once, and keeps the ones another group also released', { skip }, async () => {
  assert.deepEqual(await shown(), [1, 2, 3, 4, 5, 6], 'PREMISE: nothing is blocked');
  const r = await patchSeries(['Bad', 'Worse']);
  assert.equal(r.statusCode, 200, r.body);
  // 1 (Bad only) and 2 (Bad and Worse, both blocked) go; 3 stays on Good's copy; a joint release and a copy naming no
  // group are never blocked.
  assert.deepEqual(await shown(), [3, 4, 5, 6]);
  assert.equal((await row(1)).status, 'blocked');
  assert.equal((await row(2)).status, 'blocked');
  const three = await row(3);
  assert.equal(three.status, 'available');
  assert.deepEqual(three.chosen.groups, ['Good'], 'what is downloaded is the unblocked group\'s copy');
  assert.equal(three.scanlator, 'Good');
  // Mihon and the trackers read the same list.
  assert.deepEqual(await mihon(), [3, 4, 5, 6]);
  // Another series is untouched by one series' own block.
  assert.deepEqual(await shown(OTHER), [1, 2, 3, 4, 5, 6]);
});

test('unblocking shows them again at once, as chapters that can be fetched', { skip }, async () => {
  assert.equal((await patchSeries(['Worse'])).statusCode, 200);
  // 1 is back (Bad unblocked); 2 is back too, on Bad's copy, since Worse is still blocked but Bad is not.
  assert.deepEqual(await shown(), [1, 2, 3, 4, 5, 6]);
  assert.equal((await row(1)).status, 'available');
  const two = await row(2);
  assert.equal(two.status, 'available');
  assert.deepEqual(two.chosen.groups, ['Bad']);
  const why = (await app.inject({ method: 'GET', url: `/api/series/${S}/listing`, headers: { authorization: tok } })).json()
    .content.find((g: any) => g.number === 1).why;
  assert.equal(why, 'missing', 'a fetchable ghost, not "only a blocked group has it"');
  assert.equal((await patchSeries([])).statusCode, 200);
});

test('a block in the Scanlators settings applies to every series, and so does lifting it', { skip }, async () => {
  const set = (blocked: string[]) => app.inject({
    method: 'PATCH', url: '/api/admin/settings', headers: { authorization: tok },
    payload: { scanlatorPrefs: { priority: [], blocked, patienceDays: 2 } },
  });
  assert.equal((await set(['bad'])).statusCode, 200, 'matched by the server\'s group equality: case does not matter');
  assert.deepEqual(await shown(S), [2, 3, 4, 5, 6]);
  assert.deepEqual(await shown(OTHER), [2, 3, 4, 5, 6]);
  assert.equal((await set([])).statusCode, 200);
  assert.deepEqual(await shown(S), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(await shown(OTHER), [1, 2, 3, 4, 5, 6]);
});

test('source priority and scanlator preferences commit together before every listing is rebuilt', { skip }, async () => {
  const A = 'blk-source-a', B = 'blk-source-b', n = 9;
  const a = { ...copy(n, ['Good']), source: A, sourceId: 'a/9', title: 'From source A', publishedAt: '2026-01-01T00:00:00Z' };
  const b = { ...copy(n, ['Good']), source: B, sourceId: 'b/9', title: 'From source B', publishedAt: '2026-02-02T00:00:00Z' };
  const insert = (id: string) => q(`INSERT INTO series_listing
      (series_id, number, title, published_at, scanlator, groups, source_id, chosen, status, copies, unblocked_status)
    VALUES ($1,$2,$3,$4::timestamptz,'Good',ARRAY['Good'],$5,$6::jsonb,'available',$7::jsonb,'available')`,
  [id, n, a.title, a.publishedAt, A, JSON.stringify({ ...a, number: n }), JSON.stringify([a, b])]);
  const picked = async (id: string) => {
    const r = await row(n, id);
    return [r.source_id, r.chosen?.source, r.title, new Date(r.published_at).toISOString()];
  };
  await insert(S);
  await insert(OTHER);
  try {
    const own = await app.inject({
      method: 'PATCH', url: `/api/admin/series/${S}`, headers: { authorization: tok },
      payload: {
        scanlatorPrefs: { priority: [], blocked: [], patienceDays: null },
        sourcePrefs: { priority: [B, A] },
      },
    });
    assert.equal(own.statusCode, 200, own.body);
    assert.deepEqual(await picked(S), [B, B, b.title, new Date(b.publishedAt).toISOString()],
      'the combined per-series save rebuilt from the old source order');
    assert.deepEqual((await picked(OTHER)).slice(0, 2), [A, A], 'a per-series order changed another series');

    const global = await app.inject({
      method: 'PATCH', url: '/api/admin/settings', headers: { authorization: tok },
      payload: {
        scanlatorPrefs: { priority: [], blocked: [], patienceDays: 2 },
        sourcePrefs: { priority: [B, A] },
      },
    });
    assert.equal(global.statusCode, 200, global.body);
    assert.deepEqual(await picked(OTHER), [B, B, b.title, new Date(b.publishedAt).toISOString()],
      'the combined global save rebuilt from the old source order');

    const globalSourceOnly = await app.inject({
      method: 'PATCH', url: '/api/admin/settings', headers: { authorization: tok },
      payload: { sourcePrefs: { priority: [A, B] } },
    });
    assert.equal(globalSourceOnly.statusCode, 200, globalSourceOnly.body);
    assert.deepEqual((await picked(OTHER)).slice(0, 2), [A, A], 'a source-only global save left the old chosen copy');

    const ownSourceOnly = await app.inject({
      method: 'PATCH', url: `/api/admin/series/${S}`, headers: { authorization: tok },
      payload: { sourcePrefs: { priority: [A, B] } },
    });
    assert.equal(ownSourceOnly.statusCode, 200, ownSourceOnly.body);
    assert.deepEqual((await picked(S)).slice(0, 2), [A, A], 'a source-only series save left the old chosen copy');
  } finally {
    await q('DELETE FROM series_listing WHERE series_id = ANY($1) AND number = $2', [[S, OTHER], n]).catch(() => {});
    await q('UPDATE lib_series SET source_prefs = NULL WHERE id = $1', [S]).catch(() => {});
    await q(`UPDATE server_settings SET source_prefs = '{"priority":[]}'::jsonb WHERE id = 1`).catch(() => {});
  }
});

test('unblocking restores held and covered rather than flattening either to available', { skip }, async () => {
  const extra = [[7, 'held'], [8, 'covered']] as const;
  const save = (blocked: string[]) => app.inject({
    method: 'PATCH', url: `/api/admin/series/${S}`, headers: { authorization: tok },
    payload: { scanlatorPrefs: { priority: ['Preferred'], blocked, patienceDays: 2 } },
  });
  try {
    for (const [n, status] of extra) {
      const c = { ...copy(n, ['Bad']), publishedAt: new Date().toISOString() };
      await q(`INSERT INTO series_listing
                 (series_id, number, title, published_at, scanlator, groups, source_id, chosen, status, copies, unblocked_status)
               VALUES ($1,$2,$3,$4::timestamptz,'Bad',ARRAY['Bad'],$5,$6::jsonb,$7,$8::jsonb,$7)`,
        [S, n, `Chapter ${n}`, c.publishedAt, SRC, JSON.stringify({ ...c, number: n }), status, JSON.stringify([c])]);
    }
    assert.equal((await save(['Bad'])).statusCode, 200);
    const hidden = await q('SELECT number, status, unblocked_status FROM series_listing WHERE series_id = $1 AND number = ANY($2::real[]) ORDER BY number', [S, extra.map(([n]) => n)]);
    assert.deepEqual(hidden.map((r: any) => [Number(r.number), r.status, r.unblocked_status]),
      [[7, 'blocked', 'held'], [8, 'blocked', 'covered']]);
    assert.equal((await save([])).statusCode, 200);
    const restored = await q('SELECT number, status, unblocked_status FROM series_listing WHERE series_id = $1 AND number = ANY($2::real[]) ORDER BY number', [S, extra.map(([n]) => n)]);
    assert.deepEqual(restored.map((r: any) => [Number(r.number), r.status, r.unblocked_status]),
      [[7, 'held', 'held'], [8, 'covered', 'covered']]);
  } finally {
    await q('DELETE FROM series_listing WHERE series_id = $1 AND number = ANY($2::real[])', [S, extra.map(([n]) => n)]).catch(() => {});
    await patchSeries([]).catch(() => {});
  }
});

test('a stale listing replacement racing a newer preference save cannot put blocked copies back', { skip }, async () => {
  const { replaceListing } = await import('../src/lib/seriesListing');
  assert.equal((await patchSeries([])).statusCode, 200);
  const stored = await q(`SELECT number, title, published_at, scanlator, groups, source_id, chosen, status, copies, unblocked_status
                            FROM series_listing WHERE series_id = $1 ORDER BY number`, [S]);
  // This is the updater's snapshot prepared while no group was blocked. Whichever transaction reaches the series
  // lock first, the final listing must reflect the preference save: the save reapplies after an older writer, while
  // a later writer re-reads effective preferences after acquiring the same row/advisory locks.
  const stale = stored.map((r: any) => ({
    number: Number(r.number), title: r.title,
    publishedAt: r.published_at ? new Date(r.published_at).toISOString() : null,
    scanlator: r.scanlator, groups: r.groups ?? [], sourceId: r.source_id,
    chosen: r.chosen, status: r.status, copies: r.copies ?? [], unblockedStatus: r.unblocked_status,
  }));
  const [, saved] = await Promise.all([replaceListing(S, stale), patchSeries(['Bad', 'Worse'])]);
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal((await row(1)).status, 'blocked', 'the stale writer restored a newly blocked copy');
  assert.deepEqual((await row(3)).chosen.groups, ['Good'], 'the stale writer restored the blocked chosen copy');
  assert.equal((await patchSeries([])).statusCode, 200);
});

test('a failed listing reapply rolls back both preference routes and returns a retryable error', { skip }, async () => {
  const globalBefore = (await q('SELECT scanlator_prefs FROM server_settings WHERE id = 1'))[0].scanlator_prefs;
  const seriesBefore = (await q('SELECT scanlator_prefs FROM lib_series WHERE id = $1', [S]))[0].scanlator_prefs;
  const globalSourcesBefore = (await q('SELECT source_prefs FROM server_settings WHERE id = 1'))[0].source_prefs;
  const seriesSourcesBefore = (await q('SELECT source_prefs FROM lib_series WHERE id = $1', [S]))[0].source_prefs;
  await q(`CREATE OR REPLACE FUNCTION test_blocklist_reapply_failure() RETURNS trigger LANGUAGE plpgsql AS $fn$
           BEGIN RAISE EXCEPTION 'forced blocklist reapply failure'; END $fn$`);
  await q(`CREATE TRIGGER test_blocklist_reapply_failure
             BEFORE UPDATE ON series_listing FOR EACH ROW EXECUTE FUNCTION test_blocklist_reapply_failure()`);
  try {
    const own = await app.inject({
      method: 'PATCH', url: `/api/admin/series/${S}`, headers: { authorization: tok },
      payload: { scanlatorPrefs: { priority: [], blocked: ['Bad'], patienceDays: null }, sourcePrefs: { priority: ['new-source'] } },
    });
    assert.equal(own.statusCode, 503, own.body);
    assert.equal(own.json().error, 'blocklist_apply_failed');
    assert.deepEqual((await q('SELECT scanlator_prefs FROM lib_series WHERE id = $1', [S]))[0].scanlator_prefs, seriesBefore,
      'the per-series preference committed without its listing');
    assert.deepEqual((await q('SELECT source_prefs FROM lib_series WHERE id = $1', [S]))[0].source_prefs, seriesSourcesBefore,
      'the per-series source preference committed without its listing');

    const global = await app.inject({
      method: 'PATCH', url: '/api/admin/settings', headers: { authorization: tok },
      payload: { scanlatorPrefs: { priority: [], blocked: ['Bad'], patienceDays: 2 }, sourcePrefs: { priority: ['new-source'] } },
    });
    assert.equal(global.statusCode, 503, global.body);
    assert.equal(global.json().error, 'blocklist_apply_failed');
    assert.deepEqual((await q('SELECT scanlator_prefs FROM server_settings WHERE id = 1'))[0].scanlator_prefs, globalBefore,
      'the global preference committed without its listings');
    assert.deepEqual((await q('SELECT source_prefs FROM server_settings WHERE id = 1'))[0].source_prefs, globalSourcesBefore,
      'the global source preference committed without its listings');
  } finally {
    await q('DROP TRIGGER IF EXISTS test_blocklist_reapply_failure ON series_listing').catch(() => {});
    await q('DROP FUNCTION IF EXISTS test_blocklist_reapply_failure()').catch(() => {});
  }
});
