// Three by-id answers that skipped the viewer's grants or age cap (v0.69.1):
//   - For you and Featured served a pool cached for ten minutes, so a series a member had just lost stayed listed;
//   - GET /api/series/:id/color answered for series every sibling route hides;
//   - GET /img/sources/icon/:id served an adult source's own icon to an account capped below it.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DSN = process.env.TEST_DATABASE_URL;
const TMP = mkdtempSync(join(tmpdir(), 'uy-vg-'));
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = join(TMP, 'config');
  process.env.CACHE_DIR = join(TMP, 'cache');
  process.env.LIBRARY_BACKEND = 'owned';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const ADULT_SRC = 'vg-adult-src';
let q: any, app: any, sharp: any;
let member = '', capped = '';
const realFetch = globalThis.fetch;

before(async () => {
  if (!DSN) return;
  ({ q } = (await import('../src/lib/db')) as any);
  await (await import('../src/lib/migrate')).migrate();
  sharp = (await import('sharp')).default;
  await q(`DELETE FROM users WHERE username LIKE 'vg-%'`);
  await q(`DELETE FROM lib_series WHERE id LIKE 's_vg_%'`);
  for (const id of ['lib_vg_a', 'lib_vg_b']) {
    await q(`INSERT INTO libraries (id, name, path) VALUES ($1,$1,$2) ON CONFLICT (id) DO NOTHING`, [id, `/${id}`]);
  }
  const mkSeries = (id: string, lib: string, title: string) =>
    q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, genres, latest_mtime, created_at, summary, author)
       VALUES ($1,'T!vg',$2,$3,1,$4,$5,1,now(),'s','a')`, [id, title, `T!vg/${id}`, lib, ['Mystery']]);
  await mkSeries('s_vg_fav', 'lib_vg_a', 'Mystery Favourite');
  await mkSeries('s_vg_a2', 'lib_vg_a', 'Mystery Also A');
  await mkSeries('s_vg_b', 'lib_vg_b', 'Mystery In B');
  const mk = async (name: string, cap: number | null) => (await q(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind, max_age_rating) VALUES ($1,$1,'x','user','password',$2) RETURNING id`,
    [name, cap]))[0].id;
  member = await mk('vg-member', null);
  capped = await mk('vg-capped', 13);
  await q(`INSERT INTO favorites (user_id, series_id) VALUES ($1,'s_vg_fav')`, [member]);
  await q(`INSERT INTO series_colors (series_id, color) VALUES ('s_vg_b', '#abcdef'), ('s_vg_fav', '#123456') ON CONFLICT (series_id) DO NOTHING`);

  // An adult source whose icon is a red square, fetched from a stubbed public host.
  const red = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 220, g: 20, b: 60 } } }).png().toBuffer();
  const { registerAdapter } = await import('../src/lib/sources');
  registerAdapter({ id: ADULT_SRC, name: 'Adult Source', isNsfw: true, iconUrl: 'https://icons.invalid/adult.png',
    async search() { return []; }, async getSeries() { return null; }, async listChapters() { return []; }, async getPageUrls() { return []; } } as any);
  globalThis.fetch = (async (input: any, init?: any) => String(input).startsWith('https://icons.invalid/')
    ? new Response(red, { status: 200, headers: { 'content-type': 'image/png' } })
    : realFetch(input, init)) as typeof fetch;

  const Fastify = (await import('fastify')).default;
  app = Fastify();
  await app.register((await import('@fastify/cookie')).default);
  await app.register((await import('@fastify/jwt')).default, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/catalog')).default);
  await app.register((await import('../src/routes/images')).default);
  await app.ready();
});

after(async () => {
  globalThis.fetch = realFetch;
  if (DSN) {
    await app?.close();
    await q(`DELETE FROM users WHERE username LIKE 'vg-%'`).catch(() => {});
    await q(`DELETE FROM lib_series WHERE id LIKE 's_vg_%'`).catch(() => {});
  }
  rmSync(TMP, { recursive: true, force: true });
});

const as = (uid: string) => ({ authorization: `Bearer ${app.jwt.sign({ sub: uid, role: 'user' })}` });
const ids = (r: any) => ((r.json().content ?? []) as Array<{ id: string }>).map((s) => s.id).sort();

test('For you and Featured drop a series the member just lost, without waiting for the cache', { skip }, async () => {
  // Reintroduce by returning cached.pool in tasteRecs: the second answer still lists s_vg_b.
  const before = await app.inject({ method: 'GET', url: '/api/foryou', headers: as(member) });
  assert.equal(before.statusCode, 200, before.body);
  assert.ok(ids(before).includes('s_vg_b'), `premise: the pool holds the B series (${ids(before)})`);
  await q(`INSERT INTO user_libraries (user_id, library_id) VALUES ($1,'lib_vg_a')`, [member]);
  for (const url of ['/api/foryou', '/api/featured']) {
    const r = await app.inject({ method: 'GET', url, headers: as(member) });
    assert.equal(r.statusCode, 200, r.body);
    assert.ok(!ids(r).includes('s_vg_b'), `${url} still lists a series in a library the member lost`);
  }
});

test("a series' colour is answered only to a viewer who may open it", { skip }, async () => {
  // Reintroduce by removing the seriesVisible gate: the hidden series' colour comes back.
  const hidden = await app.inject({ method: 'GET', url: '/api/series/s_vg_b/color', headers: as(member) });
  assert.deepEqual(hidden.json(), { color: null });
  const open = await app.inject({ method: 'GET', url: '/api/series/s_vg_fav/color', headers: as(member) });
  assert.deepEqual(open.json(), { color: '#123456' });
});

test("an account capped below 18 gets an adult source's lettered tile, not its icon", { skip }, async () => {
  // Reintroduce by removing the sourceAllowedFor gate in the icon route: the capped account's tile is the red icon.
  const cookie = (uid: string) => ({ cookie: `yomi_img=${app.jwt.sign({ sub: uid, typ: 'img' })}` });
  const centre = async (r: any) => {
    const { data } = await sharp(r.rawPayload).resize(1, 1, { position: 'centre' }).raw().toBuffer({ resolveWithObject: true });
    return [...data.subarray(0, 3)];
  };
  const tile = await app.inject({ method: 'GET', url: `/img/sources/icon/${ADULT_SRC}`, headers: cookie(capped) });
  assert.equal(tile.statusCode, 200);
  const [r, g] = await centre(tile);
  assert.ok(!(r > 180 && g < 60), 'the capped account was served the adult source\'s own icon');
  const icon = await app.inject({ method: 'GET', url: `/img/sources/icon/${ADULT_SRC}`, headers: cookie(member) });
  assert.equal(icon.statusCode, 200);
  const [r2, g2] = await centre(icon);
  assert.ok(r2 > 180 && g2 < 60, 'the uncapped control sees the icon');
});
