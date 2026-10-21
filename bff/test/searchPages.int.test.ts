// A search on one source goes on past its first page (v0.96.0, #331), through the real routes.
//
// A site pages its search: BatCave answers ten at a time and has 209 for "Star Trek", and Discover showed the first ten.
// An extension's adapter now answers any page (searchPage), GET /api/sources says which sources can (`searchPages`), and
// GET /api/sources/search takes `page`. A source without paged search answers a later page with nothing -- never its
// first page again, which Discover would read as more of the same -- and a page is clamped to SEARCH_MAX_PAGE.
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

const PAGED = 'sp-paged', FLAT = 'sp-flat', ADMIN = 'sp-admin';
/** Every search a fake was asked, as `id:term:page`. */
const asked: string[] = [];
const hit = (id: string, page: number, n: number) => ({ sourceId: `${id}-${page}-${n}`, source: id, title: `Star Trek ${page}.${n}` });

function fake(id: string, paged: boolean) {
  return {
    id, name: `Name ${id}`,
    async search(term: string) { asked.push(`${id}:${term}:1`); return [hit(id, 1, 1), hit(id, 1, 2)]; },
    ...(paged ? {
      async searchPage(term: string, page: number) { asked.push(`${id}:${term}:${page}`); return page > 3 ? [] : [hit(id, page, 1), hit(id, page, 2)]; },
    } : {}),
    async getSeries(sid: string) { return { sourceId: sid, source: id, title: sid }; },
    async listChapters() { return []; },
    async getPageUrls() { return []; },
  };
}

let app: any, auth: Record<string, string>, q: any;
const search = async (source: string, page?: number | string) => {
  const r = await app.inject({ method: 'GET', url: `/api/sources/search?source=${source}&q=Star%20Trek${page === undefined ? '' : `&page=${page}`}`, headers: auth });
  assert.equal(r.statusCode, 200, r.body);
  return r.json().content.map((c: any) => c.sourceId);
};

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  await migrate();
  const { registerAdapter } = await import('../src/lib/sources');
  registerAdapter(fake(PAGED, true) as any);
  registerAdapter(fake(FLAT, false) as any);
  await q('DELETE FROM users WHERE username = $1', [ADMIN]);
  const id = (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ($1,$1,'x','admin','password') RETURNING id`, [ADMIN]))[0].id;
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/sources')).default);
  await app.ready();
  auth = { authorization: `Bearer ${app.jwt.sign({ sub: id, role: 'admin' })}` };
});

after(async () => {
  if (!DSN) return;
  await app?.close();
  await q('DELETE FROM users WHERE username = $1', [ADMIN]).catch(() => {});
  await (await import('../src/lib/db')).pool.end().catch(() => {});
});

test('GET /api/sources says which sources page their search', { skip }, async () => {
  // Reintroduce by dropping `searchPages` from the list: Discover cannot tell, and pages no search at all.
  const r = await app.inject({ method: 'GET', url: '/api/sources', headers: auth });
  assert.equal(r.statusCode, 200, r.body);
  const by = Object.fromEntries(r.json().content.map((s: any) => [s.id, s.searchPages]));
  assert.deepEqual([by[PAGED], by[FLAT]], [true, false]);
});

test('a later page of a search on one source is that page, and a source without pages answers it with nothing', { skip }, async () => {
  // Reintroduce by ignoring `page` (src.search for every page): page 2 reads page 1's cards again. Reintroduce by
  // answering a flat source's page 2 with its first page: Discover would take it for more of the same.
  asked.length = 0;
  assert.deepEqual(await search(PAGED), [`${PAGED}-1-1`, `${PAGED}-1-2`]);
  assert.deepEqual(await search(PAGED, 2), [`${PAGED}-2-1`, `${PAGED}-2-2`]);
  assert.deepEqual(await search(PAGED, 4), [], 'past the last page');
  assert.deepEqual(await search(FLAT, 2), [], "a source whose search has one page");
  assert.deepEqual(asked, [`${PAGED}:Star Trek:1`, `${PAGED}:Star Trek:2`, `${PAGED}:Star Trek:4`], 'the flat source was asked again');
});

test('a page is clamped, never trusted', { skip }, async () => {
  asked.length = 0;
  const { SEARCH_MAX_PAGE } = await import('../src/routes/sources');
  await search(PAGED, 99999);
  await search(PAGED, 'x');
  await search(PAGED, -3);
  assert.deepEqual(asked, [`${PAGED}:Star Trek:${SEARCH_MAX_PAGE}`, `${PAGED}:Star Trek:1`, `${PAGED}:Star Trek:1`]);
});
