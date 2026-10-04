// Fetching by WHOLE chapter number (v0.48.3): POST /api/sources/fetch with `floored: true`.
//
// The Find missing chapters dialog now downloads what a source has that the series lacks, straight away, from a
// picker. Its numbers come from the fill scan, which compares sources by whole chapter numbers (lib/fill.ts
// assess), so "12" there means 12 and 12.5 in the listing. An exact match would fetch 12 and leave 12.5 behind --
// or, for a source that lists only 12.5, fetch nothing and answer "not listed".
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DSN = process.env.TEST_DATABASE_URL;
const DL = DSN ? mkdtempSync(join(tmpdir(), 'uchiyomi-fw-dl-')) : '';
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.DL_ROOT = DL;
  process.env.MIN_FREE_GB = '0';
  process.env.DOWNLOAD_MIN_GAP_MS = '0';
  process.env.DOWNLOAD_PAGE_GAP_MS = '0';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const SRC = 'fw-src';
const S = 's_fw_whole';
const FOLDER = 'Whole Source/Whole Series';
const PIXEL = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(400, 7)]);
const realFetch = globalThis.fetch;
let q: any, app: any, token = '';

/** 30.5 is a two-page notice by its source's own count; 30.6 is twenty pages, a part of chapter 30. */
const PAGES: Record<number, number> = { 30: 20, 30.5: 2, 30.6: 20 };
const ch = (n: number) => ({ sourceId: `fw/${n}`, number: n, title: `Chapter ${n}`, scanlator: 'Group', pages: PAGES[n] });

before(async () => {
  if (!DSN) return;
  globalThis.fetch = (async (u: any, init?: any) =>
    String(u).includes('example.invalid') ? new Response(PIXEL, { status: 200, headers: { 'content-type': 'image/png' } }) : realFetch(u, init)) as typeof fetch;
  const { migrate } = await import('../src/lib/migrate');
  await migrate();
  ({ q } = (await import('../src/lib/db')) as any);
  const { registerAdapter } = await import('../src/lib/sources');
  registerAdapter({
    id: SRC, name: 'Whole Source',
    async search() { return []; },
    async getSeries(sid: string) { return { sourceId: sid, source: SRC, title: 'Whole Series' }; },
    // 1 and 2 are held; 12, 12.5 and 13 are not; nothing is numbered 20; 30, 30.5 and 30.6 for the notice case.
    async listChapters() { return [1, 2, 12, 12.5, 13, 30, 30.5, 30.6].map(ch); },
    // As many pages as the listing says, or one: a chapter that delivers fewer than it listed is saved partial.
    async getPageUrls(id: string) {
      const n = PAGES[Number(id.slice(3))] ?? 1;
      return Array.from({ length: n }, (_, i) => `https://example.invalid/${encodeURIComponent(id)}/p${i + 1}.png`);
    },
    async latest() { return []; },
  } as any);
  await q(`DELETE FROM lib_series WHERE id = $1`, [S]);
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, source_id, source_series_id, auto_update)
           VALUES ($1,'Whole Source','Whole Series',$2,2,'lib',$3,'fw-1',true)`, [S, FOLDER, SRC]);
  for (const n of [1, 2]) {
    await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, root) VALUES ($1,$2,'Whole Source',$3,$4,$5,$6)`,
      [`b_fw_${n}`, S, `${FOLDER}/Chapter ${n}.cbz`, n, `Chapter ${n}`, DL]);
  }

  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/sources')).default);
  await app.ready();
  await q(`DELETE FROM users WHERE username = 'fw-admin'`);
  const admin = (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind)
                          VALUES ('fw-admin','fw-admin','x','admin','password') RETURNING id`))[0].id;
  token = app.jwt.sign({ sub: admin, role: 'admin' });
});

after(async () => {
  globalThis.fetch = realFetch;
  if (!DSN) return;
  await app?.close();
  await q(`DELETE FROM lib_books WHERE series_id = $1`, [S]).catch(() => {});
  await q(`DELETE FROM series_listing WHERE series_id = $1`, [S]).catch(() => {});
  await q(`DELETE FROM lib_series WHERE id = $1`, [S]).catch(() => {});
  await q(`DELETE FROM users WHERE username = 'fw-admin'`).catch(() => {});
  rmSync(DL, { recursive: true, force: true });
});

const fetchNums = (body: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/api/sources/fetch', headers: { authorization: `Bearer ${token}` }, payload: { seriesId: S, ...body } });
/** The job for the folder is over, so the next fetch is not refused as busy. */
const idle = async () => {
  const t0 = Date.now();
  while (Date.now() - t0 < 15_000) {
    const r = await app.inject({ method: 'GET', url: '/api/sources/jobs', headers: { authorization: `Bearer ${token}` } });
    const j = (r.json().content as any[]).find((x) => x.folder === FOLDER);
    if (!j || j.status !== 'downloading') return j;
    await new Promise((res) => setTimeout(res, 50));
  }
  return null;
};

test('a whole number fetches every listed chapter it covers, and one nothing lists is reported', { skip }, async () => {
  // Reintroduce by ignoring `floored`: 12.5 is never fetched (total 2, not 3).
  const r = await fetchNums({ numbers: [12, 13, 20], floored: true });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().total, 3, `12, 12.5 and 13 -- got ${r.body}`);
  assert.deepEqual(r.json().skipped, [{ number: 20, reason: 'not_listed' }]);
  const job = await idle();
  assert.equal(job?.status, 'done', JSON.stringify(job));
  const held = (await q(`SELECT number::float8 AS n FROM lib_books WHERE series_id = $1 AND pruned_at IS NULL ORDER BY number`, [S])).map((x: any) => Number(x.n));
  assert.deepEqual(held, [1, 2, 12, 12.5, 13], 'the chapters did not all land');
});

test('without `floored` a number means exactly that number, as it always has', { skip }, async () => {
  const r = await fetchNums({ numbers: [12] });
  assert.equal(r.statusCode, 409, 'an exact 12 that is already here was fetched again');
  assert.deepEqual(r.json().skipped, [{ number: 12, reason: 'already_here' }]);
});

test('a whole number leaves a hidden notice behind, and takes every other chapter it covers', { skip }, async () => {
  // Notice chapters (lib/noticeChapters.ts): with the series' type switched on, the two-page 30.5 is hidden from
  // everyone and the sweep never fetches it, so "30" from the Find missing dialog must not either.
  const { refreshNoticesActive } = await import('../src/lib/noticeSettings');
  await q(`UPDATE lib_series SET series_type = 'manhwa', series_type_from = 'genre' WHERE id = $1`, [S]);
  await q(`UPDATE server_settings SET hide_notice_types = '["manhwa"]'::jsonb WHERE id = 1`);
  await refreshNoticesActive();
  try {
    // Reintroduce by dropping the notice clause from the expansion: 30.5 is fetched too (total 3).
    const r = await fetchNums({ numbers: [30], floored: true });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().total, 2, `30 and the twenty-page 30.6, never the hidden 30.5 -- got ${r.body}`);
    const job = await idle();
    assert.equal(job?.status, 'done', JSON.stringify(job));
    const held = (await q(`SELECT number::float8 AS n FROM lib_books WHERE series_id = $1 AND number >= 30 ORDER BY number`, [S])).map((x: any) => Number(x.n));
    assert.deepEqual(held.map((n: number) => Math.round(n * 10) / 10), [30, 30.6]);
  } finally {
    await q(`UPDATE server_settings SET hide_notice_types = '[]'::jsonb WHERE id = 1`);
    await refreshNoticesActive();
  }
});

test('following a source refreshes the listing at once, so its chapters show without waiting for the sweep', () => {
  // A static guard: the follow route is plan-gated and exercised end to end in seriesSources.int.test.ts.
  // Reintroduce by dropping the refresh: after a follow, nothing new is listed until the next sweep.
  const admin = readFileSync(join(__dirname, '..', 'src', 'routes', 'admin.ts'), 'utf8');
  const route = admin.slice(admin.indexOf("app.post('/api/admin/series/:id/sources'"), admin.indexOf("app.delete('/api/admin/series/:id/sources/:sourceId'"));
  assert.match(route, /await logAudit\('series\.follow_source'[\s\S]*?void updateSeries\(id, 0\)\.catch\(\(\) => \{\}\);\s*return \{ ok: true, sources:/);
});
