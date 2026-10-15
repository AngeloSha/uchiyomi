// A library's reading defaults: set through POST/PATCH /api/admin/libraries, listed on GET, and sent with a series in it.
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DSN = process.env.TEST_DATABASE_URL;
const ROOT = mkdtempSync(join(tmpdir(), 'yomi-librdr-'));
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.LIBRARY_ROOT = ROOT;
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

test('a library carries reading defaults the reader can layer under the source and the series', { skip }, async () => {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const adminRoutes = (await import('../src/routes/admin')).default;
  const catalogRoutes = (await import('../src/routes/catalog')).default;
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  await migrate();
  await q(`DELETE FROM libraries WHERE id <> 'lib' AND path = 'LrdShelf'`).catch(() => {});
  await q(`DELETE FROM users WHERE username LIKE 'lrd-%'`).catch(() => {});
  const mk = async (name: string, role: string) => (await q<{ id: string }>(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ($1,$1,'x',$2,'password') RETURNING id`, [name, role]))[0].id;
  const admin = await mk('lrd-admin', 'admin');
  const member = await mk('lrd-member', 'user');
  const app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register(adminRoutes);
  await app.register(catalogRoutes);
  await app.ready();
  const as = (id: string, role: string) => ({ authorization: `Bearer ${app.jwt.sign({ sub: id, role })}` });
  let libId = '';
  try {
    // Created with defaults; a key it does not know is dropped.
    const made = await app.inject({ method: 'POST', url: '/api/admin/libraries', headers: as(admin, 'admin'),
      payload: { name: 'Shelf', path: 'LrdShelf', readerPrefs: { mode: 'paged', spread: true, zoom: 3 } } });
    assert.equal(made.statusCode, 200, made.body);
    libId = made.json().id;
    const row = async () => (await app.inject({ method: 'GET', url: '/api/admin/libraries', headers: as(admin, 'admin') }))
      .json().content.find((l: any) => l.id === libId);
    assert.deepEqual((await row()).reader_prefs, { mode: 'paged', spread: true });

    // A series in it carries them, for every viewer; only an admin is told which library it is.
    await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id) VALUES ('s_lrd','T!lrd','Lrd','LrdShelf/Lrd',0,$1)
             ON CONFLICT (id) DO UPDATE SET library_id = $1`, [libId]);
    const asAdmin = await app.inject({ method: 'GET', url: '/api/series/s_lrd', headers: as(admin, 'admin') });
    assert.equal(asAdmin.statusCode, 200, asAdmin.body);
    assert.deepEqual(asAdmin.json().libraryReader, { mode: 'paged', spread: true });
    assert.deepEqual(asAdmin.json().library, { id: libId, name: 'Shelf' });
    const asMember = await app.inject({ method: 'GET', url: '/api/series/s_lrd', headers: as(member, 'user') });
    assert.deepEqual(asMember.json().libraryReader, { mode: 'paged', spread: true });
    assert.equal(asMember.json().library, undefined, 'the library itself is not shown to a member');

    // An edit that does not mention them leaves them; null clears them.
    await app.inject({ method: 'PATCH', url: `/api/admin/libraries/${libId}`, headers: as(admin, 'admin'), payload: { name: 'Shelf 2' } });
    assert.deepEqual((await row()).reader_prefs, { mode: 'paged', spread: true });
    const cleared = await app.inject({ method: 'PATCH', url: `/api/admin/libraries/${libId}`, headers: as(admin, 'admin'), payload: { readerPrefs: null } });
    assert.equal(cleared.statusCode, 200, cleared.body);
    assert.equal((await row()).reader_prefs, null);
    assert.equal((await app.inject({ method: 'GET', url: '/api/series/s_lrd', headers: as(member, 'user') })).json().libraryReader, null);

    // Set again by edit; an invalid value is a 400 and changes nothing.
    await app.inject({ method: 'PATCH', url: `/api/admin/libraries/${libId}`, headers: as(admin, 'admin'), payload: { readerPrefs: { pagedDirection: 'rtl' } } });
    assert.deepEqual((await row()).reader_prefs, { pagedDirection: 'rtl' });
    const bad = await app.inject({ method: 'PATCH', url: `/api/admin/libraries/${libId}`, headers: as(admin, 'admin'), payload: { readerPrefs: { mode: 'sideways' } } });
    assert.equal(bad.statusCode, 400);
    assert.deepEqual((await row()).reader_prefs, { pagedDirection: 'rtl' });
  } finally {
    await q(`DELETE FROM lib_series WHERE id = 's_lrd'`).catch(() => {});
    if (libId) await q('DELETE FROM libraries WHERE id = $1', [libId]).catch(() => {});
    await q(`DELETE FROM users WHERE username LIKE 'lrd-%'`).catch(() => {});
    await app.close();
    rmSync(ROOT, { recursive: true, force: true });
  }
});
