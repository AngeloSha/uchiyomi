// One credential for a third-party client: an API token fetches pages and covers, not only JSON.
//
// The Mihon extension holds exactly one secret, an API token from Profile -> Connections. Until v0.29.0 that
// token opened /api/* and nothing else: /img/* took the yomi_img cookie or the OPDS Basic token, so a client
// that had listed a chapter's pages could not fetch a single one of them without a second credential pasted
// in. This drives the real image routes through a real scanned CBZ, because the file resolution
// (visibleBookFile, a JOIN through lib_series with the viewer's grants) is exactly what has to keep applying.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const DSN = process.env.TEST_DATABASE_URL;
const ROOT = join(tmpdir(), `uchiyomi-imgbearer-${process.pid}`);
const DL = join(tmpdir(), `uchiyomi-imgbearerdl-${process.pid}`);
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.LIBRARY_ROOT = ROOT;
  process.env.DL_ROOT = DL;
  // The image routes write resized variants here; the default is the container's /cache volume.
  process.env.CACHE_DIR = join(tmpdir(), `uchiyomi-imgbearer-cache-${process.pid}`);
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const AdmZip = require('adm-zip');

// A real 1x1 PNG, so the page route serves genuine image bytes rather than whatever it makes of garbage.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

let app: any, q: any, pool: any;
let bookId = '', seriesId = '';
let readTok = '', expiredTok = '', revokedTok = '', outsiderTok = '';

before(async () => {
  if (!DSN) return;
  ({ q, pool } = await import('../src/lib/db'));
  await (await import('../src/lib/migrate')).migrate();
  const { persistScan } = await import('../src/lib/library');
  const { issueApiToken, revokeApiToken } = await import('../src/lib/auth');
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const cookie = (await import('@fastify/cookie')).default;
  const imageRoutes = (await import('../src/routes/images')).default;

  await q(`DELETE FROM lib_books`); await q(`DELETE FROM lib_series`);
  await q(`DELETE FROM users WHERE username LIKE 'ib-%'`);
  await q(`DELETE FROM libraries WHERE id = 'ib-private'`).catch(() => {});
  await rm(ROOT, { recursive: true, force: true }); await mkdir(join(ROOT, 'Bearer Test'), { recursive: true });
  await mkdir(DL, { recursive: true });
  const zip = new AdmZip(); zip.addFile('001.png', PNG);
  await writeFile(join(ROOT, 'Bearer Test', 'ch1.cbz'), zip.toBuffer());
  await persistScan();
  const s = await q(`SELECT id FROM lib_series WHERE folder = 'Bearer Test'`);
  seriesId = s[0].id;
  bookId = (await q(`SELECT id FROM lib_books WHERE series_id = $1`, [seriesId]))[0].id;

  const mk = async (name: string) => (await q<{ id: string }>(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ($1,$1,'x','user','password') RETURNING id`, [name]))[0].id;
  const reader = await mk('ib-reader');
  const outsider = await mk('ib-outsider');

  readTok = (await issueApiToken(reader, 'mihon', ['read'], null)).token;
  expiredTok = (await issueApiToken(reader, 'old', ['read'], new Date(Date.now() - 60_000))).token;
  const rv = await issueApiToken(reader, 'gone', ['read'], null);
  revokedTok = rv.token; await revokeApiToken(reader, rv.id);

  // The outsider is granted a DIFFERENT library only, so the scanned series is outside their grants.
  await q(`INSERT INTO libraries (id, name, path, sort_order) VALUES ('ib-private','Private','/nowhere',99) ON CONFLICT (id) DO NOTHING`);
  await q(`INSERT INTO user_libraries (user_id, library_id) VALUES ($1,'ib-private') ON CONFLICT DO NOTHING`, [outsider]);
  outsiderTok = (await issueApiToken(outsider, 'mihon', ['read'], null)).token;

  app = Fastify();
  await app.register(cookie);
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register(imageRoutes); // its own preHandler calls authorizeImageRequest, as server.ts's root hook does
  await app.ready();
});
after(async () => {
  if (!DSN) return;
  await app?.close();
  await q(`DELETE FROM lib_books`); await q(`DELETE FROM lib_series`);
  await q(`DELETE FROM users WHERE username LIKE 'ib-%'`);
  await q(`DELETE FROM libraries WHERE id = 'ib-private'`).catch(() => {});
  await rm(ROOT, { recursive: true, force: true }); await rm(DL, { recursive: true, force: true });
  await rm(process.env.CACHE_DIR!, { recursive: true, force: true });
  await pool.end();
});

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

test('THE REGRESSION: a read-scoped API token fetches a page', { skip }, async () => {
  // Reintroduce by deleting the bearer branch in authorizeImageRequest: this is a 401.
  const r = await app.inject({ method: 'GET', url: `/img/books/${bookId}/page/1`, headers: bearer(readTok) });
  assert.equal(r.statusCode, 200, r.body.slice(0, 120));
  assert.match(r.headers['content-type'] as string, /^image\/png/);
  assert.ok(r.rawPayload.subarray(0, 8).equals(PNG.subarray(0, 8)), 'the bytes are the page, not a placeholder');
});

test('and a cover, with the same token', { skip }, async () => {
  const r = await app.inject({ method: 'GET', url: `/img/series/${seriesId}/thumb`, headers: bearer(readTok) });
  assert.equal(r.statusCode, 200, r.body.slice(0, 120));
  assert.match(r.headers['content-type'] as string, /^image\//);
});

test('the token that just worked holds the read scope and nothing else', { skip }, async () => {
  // A token with ONLY `read` is what the README asks people to mint, so the two passes above must have
  // been made with one. Checked against the stored row rather than assumed from the call that minted it.
  // Reintroduce by requiring `write` in the bearer branch: the first test 403s and this one still passes,
  // which is why this test is here to name the scope rather than to stand alone.
  const { createHash } = await import('node:crypto');
  const row = (await q(`SELECT scopes FROM api_tokens WHERE token_hash = $1`, [createHash('sha256').update(readTok).digest('hex')]))[0];
  assert.deepEqual(row?.scopes, ['read']);
});

test('an expired token is refused', { skip }, async () => {
  const r = await app.inject({ method: 'GET', url: `/img/books/${bookId}/page/1`, headers: bearer(expiredTok) });
  assert.equal(r.statusCode, 401);
});

test('a revoked token is refused on the very next request', { skip }, async () => {
  // Revocation is a DELETE of the row; every request resolves the hash against the table, so there is no
  // cache to outlive it. Reintroduce by caching resolveApiToken results: this returns 200.
  const r = await app.inject({ method: 'GET', url: `/img/books/${bookId}/page/1`, headers: bearer(revokedTok) });
  assert.equal(r.statusCode, 401);
});

test('a token proves who you are, not what you may see: library grants still apply', { skip }, async () => {
  // ⚠️ The outsider holds a perfectly valid read token for a different library. The page is resolved
  // through visibleBookFile, which JOINs the series with the viewer's grants -- exactly as for a session or
  // the OPDS token. Reintroduce by binding viewCtxFor(null) instead of the token's user: this serves the page.
  const r = await app.inject({ method: 'GET', url: `/img/books/${bookId}/page/1`, headers: bearer(outsiderTok) });
  assert.equal(r.statusCode, 404, 'a book outside the grants must not exist for this token');
});

test('a bearer that is not an API token falls through to the other schemes, and fails closed', { skip }, async () => {
  // A session JWT is deliberately NOT accepted here (it never was): images use the yomi_img cookie for
  // browsers. A stray "Bearer <jwt>" must not be mistaken for an API token nor for a Basic credential.
  const jwt = app.jwt.sign({ sub: 'someone', role: 'user' });
  const r = await app.inject({ method: 'GET', url: `/img/books/${bookId}/page/1`, headers: bearer(jwt) });
  assert.equal(r.statusCode, 401);
  const none = await app.inject({ method: 'GET', url: `/img/books/${bookId}/page/1` });
  assert.equal(none.statusCode, 401);
});
