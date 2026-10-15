// A title its source rates adults-only is stored 18+ when it is added, and an account capped below 18 cannot list,
// open or add it by id.
//
// MangaDex rates each title (contentRating: safe, suggestive, erotica, pornographic) but is not an adult source as a
// whole, so sourceAllowedFor lets a capped account browse it. The add dropped the title's rating, so an erotica title
// was stored unrated and visible() served its pages to every capped account (the audit reproduced it with a cap-15
// account reading a page with 200). The by-id listings also painted its covers for a child's account. Search-all
// already applied the per-title rule (lib/searchAll.ts ratingOf); the by-id routes now apply the same.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DSN = process.env.TEST_DATABASE_URL;
let root = '';
if (DSN) {
  root = mkdtempSync(join(tmpdir(), 'yomi-agerated-'));
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.DL_ROOT = root;
  process.env.MIN_FREE_GB = '0';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const SRC = 'age-rated-src';
const CAPPED = 'age-rated-capped';
const ADULT = 'age-rated-adult';
const TITLES: Record<string, { title: string; contentRating: 'erotica' | 'safe' }> = {
  [`${SRC}-x`]: { title: 'Rated Erotica Tale', contentRating: 'erotica' },
  [`${SRC}-s`]: { title: 'Rated Safe Tale', contentRating: 'safe' },
};
const card = (sid: string) => ({ sourceId: sid, source: SRC, title: TITLES[sid].title, contentRating: TITLES[sid].contentRating });

/** MangaDex-shaped: not an adult source, but every title carries the source's own rating. */
function rated() {
  return {
    id: SRC, name: 'Age Rated Source',
    async search() { return Object.keys(TITLES).map(card); },
    async latest() { return Object.keys(TITLES).map(card); },
    async popular() { return Object.keys(TITLES).map(card); },
    async getSeries(sid: string) { return card(sid); },
    async listChapters() { return [1, 2].map((n) => ({ number: n, title: `Chapter ${n}`, sourceId: `r${n}`, pages: 1 })); },
    async getPageUrls(chId: string) { return [`https://example.invalid/${chId}/p1.png`]; },
  };
}

let q: any, addSeriesFromSource: any, app: any;
let capped = '', adult = '';

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  const { registerAdapter } = await import('../src/lib/sources');
  ({ addSeriesFromSource } = (await import('../src/routes/sources')) as any);
  await migrate();
  registerAdapter(rated() as any);
  await q('DELETE FROM users WHERE username = ANY($1)', [[CAPPED, ADULT]]);
  const mk = async (name: string, cap: number | null) => (await q(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind, perms, max_age_rating)
     VALUES ($1,$1,'x','user','password','{}',$2) RETURNING id`, [name, cap]))[0].id;
  capped = await mk(CAPPED, 15);
  adult = await mk(ADULT, null);
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/sources')).default);
  await app.ready();
});

after(async () => {
  if (root) rmSync(root, { recursive: true, force: true });
  if (!DSN) return;
  await app?.close();
  await q(`DELETE FROM lib_series WHERE source_id = $1`, [SRC]).catch(() => {});
  await q('DELETE FROM users WHERE username = ANY($1)', [[CAPPED, ADULT]]).catch(() => {});
});

const as = (uid: string) => ({ authorization: `Bearer ${app.jwt.sign({ sub: uid, role: 'user' })}` });
const titlesOf = (r: any) => (r.json().content as Array<{ title: string }>).map((c) => c.title).sort();

test('a MangaDex title rated erotica is stored 18+ on add, and a safe one stays unrated', { skip }, async () => {
  // Reintroduce by writing NULL for age_rating in addSeriesFromSource: this reads null, and visible() then lets
  // every capped account open the series and read its pages.
  const ero = await addSeriesFromSource({ source: SRC, sourceId: `${SRC}-x`, chapterFrom: 'none', wait: true });
  assert.equal(ero.ok, true, JSON.stringify(ero));
  const safe = await addSeriesFromSource({ source: SRC, sourceId: `${SRC}-s`, chapterFrom: 'none', wait: true });
  assert.equal(safe.ok, true, JSON.stringify(safe));
  const rows = await q(`SELECT title, age_rating FROM lib_series WHERE source_id = $1 ORDER BY title`, [SRC]);
  assert.deepEqual(rows, [{ title: 'Rated Erotica Tale', age_rating: 18 }, { title: 'Rated Safe Tale', age_rating: null }]);
});

test("a capped account's listings leave the erotica title out; an adult with Show 18+ on still sees it", { skip }, async () => {
  for (const path of ['/api/sources/search?q=tale&', '/api/sources/latest?', '/api/sources/popular?']) {
    const c = await app.inject({ method: 'GET', url: `${path}source=${SRC}&adult=1`, headers: as(capped) });
    assert.equal(c.statusCode, 200, `${path} ${c.body}`);
    assert.deepEqual(titlesOf(c), ['Rated Safe Tale'], `${path} listed an erotica title to a capped account`);
    const a = await app.inject({ method: 'GET', url: `${path}source=${SRC}&adult=1`, headers: as(adult) });
    assert.deepEqual(titlesOf(a), ['Rated Erotica Tale', 'Rated Safe Tale'], `${path}: the adult control`);
    // and with Show 18+ off it is not surfaced to the adult either, as search-all already does
    const off = await app.inject({ method: 'GET', url: `${path}source=${SRC}`, headers: as(adult) });
    assert.deepEqual(titlesOf(off), ['Rated Safe Tale'], `${path}: Show 18+ off`);
  }
});

test('a capped account is refused the erotica title by id, on detail and on add', { skip }, async () => {
  const d = await app.inject({ method: 'GET', url: `/api/sources/detail?source=${SRC}&sourceId=${SRC}-x`, headers: as(capped) });
  assert.equal(d.statusCode, 403, d.body);
  const ok = await app.inject({ method: 'GET', url: `/api/sources/detail?source=${SRC}&sourceId=${SRC}-s`, headers: as(capped) });
  assert.equal(ok.statusCode, 200, ok.body);
  const add = await app.inject({ method: 'POST', url: '/api/sources/add', headers: as(capped),
    payload: { source: SRC, sourceId: `${SRC}-x`, chapterFrom: 'none' } });
  assert.equal(add.statusCode, 403, add.body);
  const adultDetail = await app.inject({ method: 'GET', url: `/api/sources/detail?source=${SRC}&sourceId=${SRC}-x`, headers: as(adult) });
  assert.equal(adultDetail.statusCode, 200, 'the adult control opens it');
});
