// The cover picker (#242, @Squeaks72) through the real routes, with fake sources and a scripted CDN: the candidates are
// what each USABLE source's own record of the series names, and a pick sends only the source's id -- the server reads the
// picture's address from that record and keeps its own copy. A source switched off or cooling down is never asked.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DSN = process.env.TEST_DATABASE_URL;
const CONFIG = mkdtempSync(join(tmpdir(), 'yomi-coverpick-'));
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = CONFIG;
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.UCHIYOMI_PING_URL = '';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

/** A public address for the CDN (an IP literal: no resolver involved), whose answers this test scripts through fetch. */
const CDN = 'https://93.184.215.14';
/** Hosts the scripted fetch answers, matched exactly: the CDN, and the one a client tries to slip a picture in from
 *  (answered too, so a fetch of it is recorded instead of leaving the machine). */
const SCRIPTED = new Set([new URL(CDN).host, 'evil.example']);
const SID = 's_coverpick';
const SOURCES = ['cv-a', 'cv-b', 'cv-off', 'cv-cool'];
/** Every getSeries a fake source was asked, by source id; every URL the server fetched. */
const asked: string[] = [];
const fetched: string[] = [];
const realFetch = globalThis.fetch;
let q: any, app: any, auth: Record<string, string>, PNG: Buffer;

const fake = (id: string) => ({
  id, name: `Name ${id}`,
  async search() { return []; },
  async getSeries(sid: string) { asked.push(id); return { sourceId: sid, source: id, title: 'Cover Tale', coverUrl: `${CDN}/${id}.png` }; },
  async listChapters() { return []; },
  async getPageUrls() { return []; },
  async latest() { return []; },
});

before(async () => {
  if (!DSN) return;
  const sharp = (await import('sharp')).default;
  PNG = await sharp({ create: { width: 20, height: 30, channels: 3, background: '#5a7fa2' } }).png().toBuffer();
  globalThis.fetch = (async (u: any, init?: any) => {
    const url = String(u instanceof Request ? u.url : u);
    if (URL.canParse(url) && SCRIPTED.has(new URL(url).host)) {
      fetched.push(url);
      return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
    }
    return realFetch(u, init);
  }) as typeof fetch;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  await migrate();
  const { registerAdapter } = await import('../src/lib/sources');
  for (const id of SOURCES) registerAdapter(fake(id) as any);
  await q('DELETE FROM lib_series WHERE id = $1', [SID]);
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, source_id, source_series_id) VALUES ($1,'T!cv','Cover Tale','Cover Tale',0,'cv-a','a1')`, [SID]);
  for (const [i, s] of ['cv-b', 'cv-off', 'cv-cool'].entries()) {
    await q(`INSERT INTO series_sources (series_id, source_id, source_series_id, created_at) VALUES ($1,$2,$3, now() - interval '1 hour' + $4 * interval '1 minute')`, [SID, s, `${s}-1`, i]);
  }
  await q(`INSERT INTO source_health (source_id, disabled) VALUES ('cv-off', true) ON CONFLICT (source_id) DO UPDATE SET disabled = true`);
  await q(`INSERT INTO source_health (source_id, blocked_until) VALUES ('cv-cool', now() + interval '1 hour')
           ON CONFLICT (source_id) DO UPDATE SET blocked_until = EXCLUDED.blocked_until`);
  await q(`DELETE FROM users WHERE username = 'coverpick-admin'`);
  const admin = (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ('coverpick-admin','a','x','admin','password') RETURNING id`))[0].id;
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/admin')).default);
  await app.ready();
  auth = { authorization: `Bearer ${app.jwt.sign({ sub: admin, role: 'admin' })}` };
});

after(async () => {
  globalThis.fetch = realFetch;
  if (DSN) {
    await app?.close();
    await q('DELETE FROM lib_series WHERE id = $1', [SID]).catch(() => {});
    await q('DELETE FROM source_health WHERE source_id = ANY($1::text[])', [SOURCES]).catch(() => {});
    await q(`DELETE FROM users WHERE username = 'coverpick-admin'`).catch(() => {});
    await (await import('../src/lib/db')).pool.end().catch(() => {});
  }
  rmSync(CONFIG, { recursive: true, force: true });
});

test('the picker asks only usable sources, and offers each one\'s own cover', { skip }, async () => {
  asked.length = 0;
  const r = await app.inject({ method: 'GET', url: `/api/admin/series/${SID}/cover-candidates`, headers: auth });
  assert.equal(r.statusCode, 200, r.body);
  const got = r.json().content.map((c: any) => [c.sourceId, c.coverUrl, c.primary]).sort();
  assert.deepEqual(got, [['cv-a', `${CDN}/cv-a.png`, true], ['cv-b', `${CDN}/cv-b.png`, false]]);
  // Reintroduce by asking every follow: cv-off and cv-cool show up here.
  assert.deepEqual([...asked].sort(), ['cv-a', 'cv-b'], 'a switched-off or cooling source was asked');
});

test('a pick names only the source: its own record says where the picture is, and the server keeps a copy', { skip }, async () => {
  fetched.length = 0;
  // A `url` in the body is not where the picture comes from: the source's record is.
  const r = await app.inject({ method: 'PUT', url: `/api/admin/series/${SID}/art`, headers: auth,
    payload: { kind: 'cover', mode: 'source', source: 'cv-b', url: 'https://evil.example/x.png' } });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(fetched, [`${CDN}/cv-b.png`], 'the picture came from somewhere other than the source\'s record');
  const { artFile } = await import('../src/lib/seriesArt');
  const file = artFile(SID, 'cover');
  assert.ok(existsSync(file), 'no copy was kept');
  const sharp = (await import('sharp')).default;
  assert.equal((await sharp(file).metadata()).format, 'webp');
  assert.equal((await q('SELECT cover FROM series_overrides WHERE series_id = $1', [SID]))[0]?.cover, 'upload');
});

test('a source that is not usable, or not the series\' own, is refused without a request', { skip }, async () => {
  asked.length = 0;
  fetched.length = 0;
  const put = (source: string) => app.inject({ method: 'PUT', url: `/api/admin/series/${SID}/art`, headers: auth, payload: { kind: 'cover', mode: 'source', source } });
  const cool = await put('cv-cool');
  assert.equal(cool.statusCode, 409, cool.body);
  assert.equal(cool.json().error, 'source_unavailable');
  assert.equal((await put('cv-off')).statusCode, 409);
  assert.equal((await put('cv-elsewhere')).statusCode, 400, 'a source the series does not use was accepted');
  assert.deepEqual(asked, [], 'a refused source was asked');
  assert.deepEqual(fetched, []);
  // A banner is not taken from a source's cover.
  assert.equal((await app.inject({ method: 'PUT', url: `/api/admin/series/${SID}/art`, headers: auth, payload: { kind: 'banner', mode: 'source', source: 'cv-b' } })).statusCode, 400);
});
