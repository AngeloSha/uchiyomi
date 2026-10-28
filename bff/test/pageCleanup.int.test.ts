import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const AdmZip = require('adm-zip');
const DSN = process.env.TEST_DATABASE_URL;
const ROOT = DSN ? mkdtempSync(join(tmpdir(), 'uchiyomi-cleanup-api-')) : '';
if (DSN) Object.assign(process.env, { DATABASE_URL: DSN, JWT_SECRET: 'page-cleanup-tests-secret-at-least-sixteen',
  CONFIG_DIR: join(ROOT, 'config'), CACHE_DIR: join(ROOT, 'cache'), LIBRARY_ROOT: join(ROOT, 'library'),
  DL_ROOT: join(ROOT, 'downloads'), LIBRARY_BACKEND: 'owned' });
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';
const S = 's_cleanup_api_series', S2 = 's_cleanup_api_other_series';
const A = 'b_cleanup_api_book', B = 'b_cleanup_api_other_source', C = 'b_cleanup_api_other_series_book', U = 'b_cleanup_api_unknown';
const SRC = 'cleanup_api_source', OTHER = 'cleanup_api_other_source';
const FOLDER = 'Cleanup Test/Series', FOLDER2 = 'Cleanup Test/Other';
let q: typeof import('../src/lib/db').q, pool: typeof import('../src/lib/db').pool;
let app: any, admin: Record<string, string>, member: Record<string, string>, adminId: string;
let png: Buffer, gif: Buffer;
const files: Record<string, string> = { [A]: `${FOLDER}/Chapter 1.cbz`, [B]: `${FOLDER}/Chapter 2.cbz`,
  [C]: `${FOLDER2}/Chapter 1.cbz`, [U]: `${FOLDER}/Chapter 3.cbz` };
const physical = (id = A) => join(ROOT, 'library', files[id]);
const get = (suffix = 'page-cleanup', id = A, headers = admin) => app.inject({ method: 'GET', url: `/api/admin/books/${id}/${suffix}`, headers });
const change = (action: string, pages: number[], revision: string, headers = admin, confirm: unknown = true) =>
  app.inject({ method: 'POST', url: `/api/admin/books/${A}/page-cleanup`, headers, payload: { action, pages, revision, confirm } });
const rule = (scope: string, skipGif: boolean | null, id = A) => app.inject({ method: 'PUT', url: `/api/admin/books/${id}/page-rules`, headers: admin, payload: { scope, skipGif, confirm: true } });
const pages = (id = A) => app.inject({ method: 'GET', url: `/api/books/${id}/pages`, headers: admin });

before(async () => {
  if (!DSN) return;
  await Promise.all(['config', 'cache', 'library', 'downloads'].map((p) => mkdir(join(ROOT, p), { recursive: true })));
  ({ q, pool } = await import('../src/lib/db'));
  await (await import('../src/lib/migrate')).migrate();
  const Fastify = (await import('fastify')).default;
  app = Fastify();
  await app.register((await import('@fastify/jwt')).default, { secret: process.env.JWT_SECRET! });
  await app.register((await import('@fastify/cookie')).default);
  for (const route of ['admin', 'catalog', 'downloads', 'images']) await app.register((await import(`../src/routes/${route}`)).default);
  await app.ready();
  const roles: Record<string, Record<string, string>> = {};
  for (const role of ['admin', 'user']) {
    const [u] = await q<{ id: string }>(`INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ($1,$1,'x',$2,'password') RETURNING id`, [`cleanup-api-${role}`, role]);
    if (role === 'admin') adminId = u.id;
    const token = app.jwt.sign({ sub: u.id, role });
    roles[role] = { authorization: `Bearer ${token}`, cookie: `yomi_img=${app.jwt.sign({ sub: u.id, typ: 'img' })}` };
  }
  admin = roles.admin; member = roles.user;
  png = await sharp({ create: { width: 120, height: 180, channels: 3, background: 'red' } }).png().toBuffer();
  gif = await sharp({ create: { width: 120, height: 180, channels: 3, background: 'blue' } }).gif().toBuffer();
});
beforeEach(async () => {
  if (!DSN) return;
  await rm(join(ROOT, 'config', 'page-trash'), { recursive: true, force: true });
  await q('DELETE FROM source_page_rules WHERE source_id = ANY($1)', [[SRC, OTHER]]);
  await q('DELETE FROM read_progress WHERE series_id = ANY($1)', [[S, S2]]);
  await q('DELETE FROM bookmarks WHERE series_id = ANY($1)', [[S, S2]]);
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [[S, S2]]);
  for (const [id, folder] of [[S, FOLDER], [S2, FOLDER2]]) {
    await mkdir(join(ROOT, 'library', folder), { recursive: true });
    await q(`INSERT INTO lib_series (id, source, title, folder, source_id, source_series_id) VALUES ($1,'Cleanup Test',$1,$2,$3,'remote')`, [id, folder, SRC]);
  }
  for (const [id, source, series] of [[A, SRC, S], [B, OTHER, S], [C, SRC, S2], [U, null, S]] as const) {
    const z = new AdmZip(); z.addFile('001.png', png); z.addFile('002.gif', gif); z.addFile('003.png', png);
    z.addFile('ComicInfo.xml', Buffer.from('<ComicInfo><Title>Saved title</Title></ComicInfo>'));
    await writeFile(physical(id), z.toBuffer());
    await q(`INSERT INTO lib_books (id, series_id, source, file, root, number, pages, source_id, fp_at) VALUES ($1,$2,'Cleanup Test',$3,$4,$5,3,$6,now())`,
      [id, series, files[id], join(ROOT, 'library'), id === B ? 2 : id === U ? 3 : 1, source]);
  }
});
after(async () => {
  if (!DSN) return;
  await app?.close();
  await q('DELETE FROM users WHERE username LIKE $1', ['cleanup-api-%']);
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [[S, S2]]);
  await q('DELETE FROM source_page_rules WHERE source_id = ANY($1)', [[SRC, OTHER]]);
  await pool.end();
  await rm(ROOT, { recursive: true, force: true });
});

test('physical previews/edits and source rule changes require an admin', { skip }, async () => {
  assert.equal((await get('page-cleanup', A, {})).statusCode, 401);
  assert.equal((await get('page-cleanup', A, member)).statusCode, 403);
  assert.equal((await get('page-rules', A, member)).statusCode, 403);
  assert.equal((await change('remove', [2], 'a'.repeat(64), member)).statusCode, 403);
  const r = await app.inject({ method: 'PUT', url: `/api/admin/books/${A}/page-rules`, headers: member,
    payload: { scope: 'source', skipGif: true, confirm: true } });
  assert.equal(r.statusCode, 403);
});

test('preview/confirmation and live series visibility are enforced before changing bytes', { skip }, async () => {
  const original = await readFile(physical());
  const preview = await get(); assert.equal(preview.statusCode, 200, preview.body);
  assert.equal((await change('remove', [2], preview.json().revision, admin, false)).statusCode, 400);
  await q('UPDATE lib_series SET deleted_at = now() WHERE id = $1', [S]);
  assert.equal((await get()).statusCode, 404);
  assert.equal((await change('remove', [2], preview.json().revision)).statusCode, 404);
  assert.deepEqual(await readFile(physical()), original);
});

test('removed slots, progress/bookmarks/marks and restored originals survive a rescan and offline manifest', { skip }, async () => {
  await q(`INSERT INTO read_progress (user_id, book_id, series_id, page) VALUES ($1,$2,$3,3)`, [adminId, A, S]);
  await q(`INSERT INTO bookmarks (user_id, book_id, series_id, page, note) VALUES ($1,$2,$3,3,'story stays at page 3')`, [adminId, A, S]);
  await q(`INSERT INTO spread_marks (user_id, book_id, page, mark, pages) VALUES ($1,$2,2,'split',3)`, [adminId, A]);
  await q(`INSERT INTO page_hashes (book_id, page, hash, override) VALUES ($1,2,'abc',false),($1,3,'story',NULL)`, [A]);
  const imageBefore = await app.inject({ method: 'GET', url: `/img/books/${A}/page/2?w=200`, headers: admin });
  assert.equal(imageBefore.statusCode, 200, imageBefore.body);
  const preview = (await get()).json();
  const removed = await change('remove', [2], preview.revision);
  assert.equal(removed.statusCode, 200, removed.body);
  let listed = await pages(); assert.equal(listed.statusCode, 200, listed.body);
  assert.deepEqual(listed.json().map((p: any) => p.number), [1, 2, 3]);
  assert.equal(listed.json()[1].removed, true); assert.equal(listed.json()[1].junk, true);
  assert.equal(listed.json()[1].mark, 'split');
  assert.match(listed.json()[0].contentVersion, /^[a-f0-9]{64}$/);
  assert.equal((await app.inject({ method: 'GET', url: `/img/books/${A}/page/2?w=200&cv=${preview.contentVersion}`, headers: admin })).statusCode, 409,
    'an old download URL cannot receive different bytes after an edit');
  const imageAfter = await app.inject({ method: 'GET', url: `/img/books/${A}/page/2?w=200&cv=${listed.json()[1].contentVersion}`, headers: admin });
  assert.equal(imageAfter.statusCode, 200, imageAfter.body); assert.notDeepEqual(imageAfter.rawPayload, imageBefore.rawPayload);
  const manifest = await app.inject({ method: 'GET', url: `/api/books/${A}/download-manifest`, headers: admin });
  assert.equal(manifest.json().pages[1].removed, true); assert.equal(manifest.json().pages[1].junk, true);
  assert.match(manifest.json().pages[1].url, /\?cv=/);
  assert.equal((await q('SELECT page FROM read_progress WHERE book_id = $1', [A]))[0].page, 3);
  assert.equal((await q('SELECT page FROM bookmarks WHERE book_id = $1', [A]))[0].page, 3);
  assert.equal((await q('SELECT override, hash FROM page_hashes WHERE book_id = $1 AND page = 2', [A]))[0].override, false);
  assert.equal((await q('SELECT hash FROM page_hashes WHERE book_id = $1 AND page = 3', [A]))[0].hash, 'story');
  await (await import('../src/lib/library')).persistScan();
  listed = await pages(); assert.equal(listed.json()[1].removed, true, 'scans must not forget physical removal');
  const restored = await change('restore', [2], removed.json().revision);
  assert.equal(restored.statusCode, 200, restored.body);
  assert.equal((await pages()).json()[1].removed, undefined);
  const { cbzEntry } = await import('../src/lib/library');
  assert.deepEqual(await cbzEntry(physical(), '002.gif'), gif);
});

test('permanent purge is explicit, preserves numbered slots and reports retained/unused storage truthfully', { skip }, async () => {
  const preview = (await get()).json();
  const removed = await change('remove', [2], preview.revision);
  assert.equal(removed.statusCode, 200, removed.body);
  assert.equal(removed.json().pages[1].restorable, true);
  assert.equal(removed.json().retainedBytes, gif.length);
  assert.equal((await change('purge', [2], removed.json().revision, admin, false)).statusCode, 400);
  const purged = await change('purge', [2], removed.json().revision);
  assert.equal(purged.statusCode, 200, purged.body);
  assert.equal(purged.json().retainedBytes, 0); assert.equal(purged.json().pages[1].removed, true);
  assert.equal(purged.json().pages[1].restorable, false);
  const listed = (await pages()).json();
  assert.deepEqual(listed.map((p: any) => p.number), [1, 2, 3]);
  assert.equal(listed[1].removed, true); assert.equal(listed[1].restorable, false);
  const manifest = (await app.inject({ method: 'GET', url: `/api/books/${A}/download-manifest`, headers: admin })).json();
  assert.equal(manifest.pages[1].restorable, false);
  assert.equal((await change('restore', [2], purged.json().revision)).statusCode, 409);
  assert.equal((await change('purge-unused', [], purged.json().revision)).statusCode, 200);
});

test('writer claims and database locks refuse simultaneous edits; a stale preview cannot apply', { skip }, async () => {
  const preview = (await get()).json();
  const { claimWriterFolders } = await import('../src/lib/bulkNewest');
  const claim = claimWriterFolders([FOLDER]); assert.ok(claim);
  try { assert.equal((await change('remove', [2], preview.revision)).statusCode, 409); } finally { claim.release(); }
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,354))', [`page-cleanup:${A}`]);
    assert.equal((await change('remove', [2], preview.revision)).statusCode, 409);
  } finally { await client.query('ROLLBACK'); client.release(); }
  assert.equal((await change('remove', [2], preview.revision)).statusCode, 200);
  assert.equal((await change('remove', [1], preview.revision)).statusCode, 409);
});

test('GIF rules default off, apply only to recorded stable source IDs, and per-page rescue wins', { skip }, async () => {
  assert.equal((await pages()).json()[1].junk, undefined);
  const preview = await get('page-rules'); assert.equal(preview.statusCode, 200, preview.body);
  assert.equal(preview.json().sourceRule, null); assert.deepEqual(preview.json().pages.map((p: any) => p.number), [2]);
  assert.equal((await rule('source', true)).statusCode, 200);
  assert.equal((await pages()).json()[1].junk, true);
  assert.equal((await pages(C)).json()[1].junk, true, 'same stable source on another series');
  assert.equal((await pages(B)).json()[1].junk, undefined, 'another source in the same series');
  assert.equal((await pages(U)).json()[1].junk, undefined, 'unknown provenance does not inherit primary source');
  const rescue = await app.inject({ method: 'PUT', url: `/api/books/${A}/pages/2/junk`, headers: admin, payload: { junk: false } });
  assert.equal(rescue.statusCode, 200); assert.equal((await pages()).json()[1].junk, undefined);
  assert.equal((await get('page-rules')).json().pages[0].rescued, true, 'rule preview identifies a saved per-page exception');
  assert.equal((await pages(C)).json()[1].junk, true, 'one rescue changes only one page');
  assert.equal((await rule('source', false)).statusCode, 200);
  assert.equal((await pages(C)).json()[1].junk, undefined);
});

test('series scopes override source rules and can return to the source default', { skip }, async () => {
  await rule('source', true); await rule('series', false);
  assert.equal((await pages()).json()[1].junk, undefined);
  assert.equal((await pages(C)).json()[1].junk, true);
  await rule('series', null); assert.equal((await pages()).json()[1].junk, true);
  await rule('source', false); await rule('series', true);
  assert.equal((await pages()).json()[1].junk, true);
  assert.equal((await pages(C)).json()[1].junk, undefined);
  assert.equal((await rule('source', true, U)).statusCode, 409, 'unknown source cannot create a rule');
});
