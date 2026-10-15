// The compare view (#241, @Squeaks72): its page list (copyPageList) asks a source only for a copy the series' own listing
// holds, of a series the admin may see; and its two routes are an admin's, by the API's rule -- an admin's API token must
// carry the admin scope, and an OPDS reader's Basic token is never an admin's. Skipped unless TEST_DATABASE_URL is set.
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

const SRC = 'cp-src', S = 's_cp_series', LIB = 'lib_cp';
let q: any, copyPageList: any, isRefusal: any, app: any;
let adminId = '', memberId = '', adminReadTok = '', adminAdminTok = '', memberTok = '';
/** Whoever may see everything: an admin's view (lib/visibility.ts viewCtxFor). */
const ALL = { userId: null, libraryIds: null, maxAgeRating: null, hideAdultLibraries: false, adultGenres: [], adultSources: [] };
const asked: string[] = [];

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  const { registerAdapter } = await import('../src/lib/sources');
  ({ copyPageList, isRefusal } = (await import('../src/routes/sources')) as any);
  await migrate();
  registerAdapter({
    id: SRC, name: 'Copy Source',
    async search() { return []; },
    async getSeries(sid: string) { return { sourceId: sid, source: SRC, title: 'Cp' }; },
    async listChapters() { return []; },
    async latest() { return []; },
    async getPageUrls(cid: string) { asked.push(cid); return ['https://example.invalid/1.png', 'https://example.invalid/2.png']; },
  } as any);
  await q(`INSERT INTO libraries (id, name, path) VALUES ($1,'Cp',$1) ON CONFLICT (id) DO NOTHING`, [LIB]);
  await q('DELETE FROM lib_series WHERE id = $1', [S]);
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id) VALUES ($1,'T!cp','Cp','T!cp/Cp',0,$2)`, [S, LIB]);
  await q(`INSERT INTO series_listing (series_id, number, source_id, chosen, status, copies) VALUES ($1, 5, $2, '{}'::jsonb, 'available', $3::jsonb)`,
    [S, SRC, JSON.stringify([{ source: SRC, sourceId: 'listed-5' }])]);

  await q(`DELETE FROM users WHERE username LIKE 'cp-%'`);
  const mk = async (name: string, role: string) => (await q(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ($1,$1,'x',$2,'password') RETURNING id`, [name, role]))[0].id;
  adminId = await mk('cp-admin', 'admin');
  memberId = await mk('cp-member', 'user');
  const { issueApiToken } = await import('../src/lib/auth');
  adminReadTok = (await issueApiToken(adminId, 'script', ['read'], null)).token;
  adminAdminTok = (await issueApiToken(adminId, 'admin', ['read', 'write', 'admin'], null)).token;
  memberTok = (await issueApiToken(memberId, 'mihon', ['read'], null)).token;
  const Fastify = (await import('fastify')).default;
  app = Fastify();
  await app.register((await import('@fastify/jwt')).default, { secret: process.env.JWT_SECRET! });
  await app.register((await import('@fastify/cookie')).default);
  await app.register((await import('../src/routes/admin')).default);
  await app.register((await import('../src/routes/images')).default);
  await app.ready();
});

after(async () => {
  if (!DSN) return;
  await app?.close();
  await q(`DELETE FROM users WHERE username LIKE 'cp-%'`).catch(() => {});
  await q('DELETE FROM lib_series WHERE id = $1', [S]).catch(() => {});
  await q('DELETE FROM libraries WHERE id = $1', [LIB]).catch(() => {});
});

test('a copy the listing holds is answered with its page list', { skip }, async () => {
  const r = await copyPageList(S, SRC, 'listed-5', ALL);
  assert.equal(isRefusal(r), false, JSON.stringify(r));
  assert.equal(r.urls.length, 2);
});

test('a copy the listing does not hold is refused before the source is asked', { skip }, async () => {
  const r = await copyPageList(S, SRC, 'made-up-id', ALL);
  assert.equal(isRefusal(r), true);
  assert.equal(r.code, 404);
  assert.ok(!asked.includes('made-up-id'));
});

test('no source or no chapter is a bad request', { skip }, async () => {
  for (const [s, c] of [[undefined, 'listed-5'], [SRC, undefined], ['nope', 'listed-5'], [SRC, 'x'.repeat(3000)]] as const) {
    const r = await copyPageList(S, s, c, ALL);
    assert.equal(isRefusal(r) && r.code, 400);
  }
});

const page = (headers: Record<string, string>, i: string | number = 5) =>
  app.inject({ method: 'GET', url: `/img/series/${S}/copy-page?source=${SRC}&chapter=listed-5&i=${i}`, headers });
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const imgCookie = (sub: string) => ({ cookie: `yomi_img=${app.jwt.sign({ sub, typ: 'img' })}` });

test('the page count is an admin\'s: a member is refused, an admin is answered', { skip }, async () => {
  const count = (sub: string, role: string) => app.inject({ method: 'GET', url: `/api/admin/series/${S}/copy-pages?source=${SRC}&chapter=listed-5`,
    headers: bearer(app.jwt.sign({ sub, role })) });
  assert.equal((await count(memberId, 'user')).statusCode, 403);
  const ok = await count(adminId, 'admin');
  assert.equal(ok.statusCode, 200, ok.body);
  assert.deepEqual(ok.json(), { count: 2 });
});

test('a page is an admin\'s by the API\'s rule: a read-scope token of an admin is refused', { skip }, async () => {
  // Past the gate, an index the copy does not have is a 404 -- which is how these assert "let in" without fetching bytes.
  assert.equal((await page(imgCookie(adminId))).statusCode, 404, 'an admin\'s session is let in');
  assert.equal((await page(bearer(adminAdminTok))).statusCode, 404, 'an admin\'s token with the admin scope is let in');
  // Reintroduce the role-only check (#241 as opened): this one answers 404 too.
  assert.equal((await page(bearer(adminReadTok))).statusCode, 403, 'an admin\'s read token passed for an admin');
  assert.equal((await page(bearer(memberTok))).statusCode, 403);
  assert.equal((await page(imgCookie(memberId))).statusCode, 403);
  assert.equal((await page({})).statusCode, 401);
});

test('a page index the copy does not have is not found', { skip }, async () => {
  for (const i of ['-1', '2', 'x', '1.5']) assert.equal((await page(imgCookie(adminId), i)).statusCode, 404, `index ${i}`);
});

test('a hidden series\' copies are not served, nor counted', { skip }, async () => {
  // Reintroduce by dropping the seriesVisible line in copyPageList: both answer as for a visible series.
  await q(`UPDATE lib_series SET deleted_at = now() WHERE id = $1`, [S]);
  try {
    assert.equal((await page(imgCookie(adminId), 0)).statusCode, 404);
    const r = await copyPageList(S, SRC, 'listed-5', ALL);
    assert.equal(isRefusal(r) && r.code, 404);
  } finally { await q(`UPDATE lib_series SET deleted_at = NULL WHERE id = $1`, [S]); }
});
