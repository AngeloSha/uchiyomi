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
let q: any, app: any, tok: string, apiKey: string, savedPrefs: unknown, savedGhosts: boolean | undefined;

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
  const st = (await q('SELECT scanlator_prefs, komga_ghost_chapters FROM server_settings WHERE id = 1'))[0];
  savedPrefs = st?.scanlator_prefs; savedGhosts = st?.komga_ghost_chapters;
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
  await q('UPDATE server_settings SET scanlator_prefs = $1::jsonb, komga_ghost_chapters = $2 WHERE id = 1', [JSON.stringify(savedPrefs ?? {}), savedGhosts ?? false]).catch(() => {});
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
const row = async (n: number, id = S) => (await q('SELECT status, chosen, source_id, scanlator FROM series_listing WHERE series_id = $1 AND number = $2::real', [id, n]))[0];

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
