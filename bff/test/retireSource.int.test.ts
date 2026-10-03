// Retiring a source once nothing uses it as a main source (lib/retireSource.ts, v0.54.0), through the real routes.
//
// The owner: "can u remove any extension/providers that are not working good for me". Removing a site added by address
// used to happen at once with no check, and every series from it froze; these pin that a source is retired only once no
// series has it as its main source, that its follows go with their listing rows, and what "remove" means for each kind:
// a site leaves the list, an extension's source is switched off in its extension, anything else is only turned off.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DSN = process.env.TEST_DATABASE_URL;
let DIR = '';
if (DSN) {
  DIR = mkdtempSync(join(tmpdir(), 'yomi-retire-'));
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.CUSTOM_SITES_FILE = join(DIR, 'sites.json');
  process.env.SOURCES_DIR = join(DIR, 'no-pack');
  process.env.UCHIYOMI_PING_URL = '';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const LIB = 'lib_retire', ADMIN = 'retire-admin';
const MAIN = 'rs-main', PACK = 'rs-pack', SITE = 'rssite', SITE2 = 'rssite2', EXT = 'sw:9990001';
const S = (k: string) => `s_rs_${k}`;
const SITES = [
  { engine: 'madara', id: SITE, name: 'RS Site', base: 'https://rs-site.invalid', order: 100 },
  { engine: 'madara', id: SITE2, name: 'RS Site 2', base: 'https://rs-site2.invalid', order: 100 },
];
let q: any, app: any, auth: Record<string, string>, adminId = '';
const stub = (id: string) => ({ id, name: `Name ${id}`, search: async () => [], getSeries: async () => null,
  listChapters: async () => [], getPageUrls: async () => [], latest: async () => [] });

/** A series on `main`, following `follows`, each with a listing row and a chapter on disk. */
async function series(key: string, main: string, follows: string[] = []) {
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, source_id, source_series_id)
           VALUES ($1,'T!rs',$1,$1,1,$2,$3,$4)`, [S(key), LIB, main, `${main}|${key}`]);
  await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, pages) VALUES ($1, $2, 'T!rs', $3, 1, 'Chapter 1', 1)`,
    [`${S(key)}_b1`, S(key), `${S(key)}/Chapter 1.cbz`]);
  for (const [i, f] of follows.entries()) {
    await q(`INSERT INTO series_sources (series_id, source_id, source_series_id) VALUES ($1, $2, $3)`, [S(key), f, `${f}|${key}`]);
    await q(`INSERT INTO series_listing (series_id, number, source_id, chosen) VALUES ($1, $2, $3, '{}'::jsonb)`, [S(key), 10 + i, f]);
  }
}
const retire = (id: string, payload: unknown = {}) =>
  app.inject({ method: 'POST', url: `/api/admin/sources/${encodeURIComponent(id)}/retire`, headers: auth, payload });
const count = async (sql: string, params: unknown[]) => (await q(sql, params))[0].n;
const sitesFile = () => JSON.parse(readFileSync(process.env.CUSTOM_SITES_FILE!, 'utf8')).map((x: any) => x.id);

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  await migrate();
  await q(`INSERT INTO libraries (id, name, path) VALUES ($1,'Retire',$1) ON CONFLICT (id) DO NOTHING`, [LIB]);
  await q('DELETE FROM users WHERE username = $1', [ADMIN]);
  adminId = (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ($1,$1,'x','admin','password') RETURNING id`, [ADMIN]))[0].id;
  const Fastify = (await import('fastify')).default;
  app = Fastify();
  await app.register((await import('@fastify/jwt')).default, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/admin')).default);
  await app.ready();
  auth = { authorization: `Bearer ${app.jwt.sign({ sub: adminId, role: 'admin' })}` };
});

beforeEach(async () => {
  if (!DSN) return;
  writeFileSync(process.env.CUSTOM_SITES_FILE!, JSON.stringify(SITES));
  // A removal reloads the registry, which drops whatever a test registered: every test starts from the same one.
  await (await import('../src/lib/sources')).reloadAll();
  const { registerAdapter } = await import('../src/lib/sources');
  for (const id of [MAIN, PACK]) registerAdapter(stub(id) as any);
  await q('DELETE FROM lib_series WHERE library_id = $1', [LIB]);
  await q('DELETE FROM source_health WHERE source_id = ANY($1::text[])', [[MAIN, PACK, SITE, SITE2, EXT]]);
  await q(`DELETE FROM suwayomi_sources WHERE source_id = '9990001'`);
  await q(`DELETE FROM audit_log WHERE event = 'source.retire'`);
});

after(async () => {
  if (DIR) rmSync(DIR, { recursive: true, force: true });
  if (!DSN) return;
  await app?.close();
  await q('DELETE FROM lib_series WHERE library_id = $1', [LIB]).catch(() => {});
  await q('DELETE FROM libraries WHERE id = $1', [LIB]).catch(() => {});
  await q('DELETE FROM users WHERE username = $1', [ADMIN]).catch(() => {});
  await q('DELETE FROM source_health WHERE source_id = ANY($1::text[])', [[MAIN, PACK, SITE, SITE2, EXT]]).catch(() => {});
  await q(`DELETE FROM suwayomi_sources WHERE source_id = '9990001'`).catch(() => {});
  await (await import('../src/lib/db')).pool.end().catch(() => {});
});

test("a source is not retired while it is some series' main source: Replace it first", { skip }, async () => {
  // Reintroduce by dropping retireSource's in-use guard: the source is switched off under its series, and 200.
  await series('one', PACK, [SITE]);
  const r = await retire(PACK, { how: 'off' });
  assert.equal(r.statusCode, 409, `refuses while it is some series' main source: ${r.body}`);
  assert.deepEqual([r.json().error, r.json().main], ['in_use', 1], "refuses while it is some series' main source");
  assert.equal(r.json().messageSaid.code, 'retire.inUse');
  assert.equal(r.json().message, 'It is the main source of 1 series. Replace it first.');
  const { isDisabled } = await import('../src/lib/sourceHealth');
  assert.equal(await isDisabled(PACK), false, 'nothing was switched off');
  // A source the series only follows is no obstacle: its follow goes, and the series keeps its main source.
  const site = await retire(SITE, { how: 'off' });
  assert.equal(site.statusCode, 200, site.body);
  assert.deepEqual(site.json(), { ok: true, done: 'turned_off', followsDropped: 1 });
  assert.equal(await isDisabled(SITE), true);
  assert.equal(await count('SELECT count(*)::int AS n FROM series_sources WHERE series_id = $1', [S('one')]), 0);
  assert.equal((await q('SELECT source_id FROM lib_series WHERE id = $1', [S('one')]))[0].source_id, PACK);
  assert.equal((await retire(PACK, { how: 'maybe' })).statusCode, 400);
});

test('a site added by address is removed: out of its follows, their listing rows and the site list, and the chapters stay', { skip }, async () => {
  // Reintroduce by dropping the follows' DELETE in retireSource: the series still follows the site. By dropping the
  // site list's rewrite: it is still in sites.json and loaded.
  const { getSource } = await import('../src/lib/sources');
  await series('a', MAIN, [SITE]);
  await series('b', MAIN, [SITE, SITE2]);
  assert.ok(getSource(SITE), 'PREMISE: the site is loaded from sites.json');
  const r = await retire(SITE, { how: 'remove' });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json(), { ok: true, done: 'removed', followsDropped: 2 });
  assert.equal(await count('SELECT count(*)::int AS n FROM series_sources WHERE source_id = $1', [SITE]), 0, 'its follows are dropped');
  assert.equal(await count('SELECT count(*)::int AS n FROM series_listing WHERE source_id = $1', [SITE]), 0, 'with their listing rows');
  assert.deepEqual(sitesFile(), [SITE2], 'and it is out of the site list');
  assert.equal(getSource(SITE), null, 'and unloaded');
  assert.equal(await count('SELECT count(*)::int AS n FROM series_sources WHERE source_id = $1', [SITE2]), 1, 'another site is untouched');
  assert.equal(await count('SELECT count(*)::int AS n FROM lib_books WHERE series_id = ANY($1::text[])', [[S('a'), S('b')]]), 2, 'the chapters stay');
  const audit = (await q(`SELECT user_id, detail FROM audit_log WHERE event = 'source.retire'`))[0];
  assert.equal(audit.user_id, adminId);
  assert.deepEqual([audit.detail.source, audit.detail.how, audit.detail.done, audit.detail.followsDropped], [SITE, 'remove', 'removed', 2]);
});

test("an extension's source is switched off in its extension; a built-in or a pack source is only turned off", { skip }, async () => {
  // Reintroduce by dropping the extension branch in retireSource: it reads turned_off and stays switched on there.
  const { isDisabled } = await import('../src/lib/sourceHealth');
  await q(`INSERT INTO suwayomi_sources (source_id, name, lang, enabled) VALUES ('9990001', 'Ext Source', 'en', true)`);
  await series('c', MAIN, [EXT]);
  const ext = await retire(EXT, { how: 'remove' });
  assert.equal(ext.statusCode, 200, ext.body);
  assert.deepEqual(ext.json(), { ok: true, done: 'switched_off', followsDropped: 1 }, "an extension's source is switched off in its extension");
  assert.equal((await q(`SELECT enabled FROM suwayomi_sources WHERE source_id = '9990001'`))[0].enabled, false);
  assert.equal(await isDisabled(EXT), false, 'not turned off under Sources as well: one switch, where it comes back on');
  assert.equal(await count('SELECT count(*)::int AS n FROM series_sources WHERE series_id = $1', [S('c')]), 0);

  const pack = await retire(PACK, { how: 'remove' });
  assert.deepEqual(pack.json(), { ok: true, done: 'turned_off', followsDropped: 0 }, 'a pack source has nowhere to be removed from: turned off, and said so');
  assert.equal(await isDisabled(PACK), true);
  const def = await retire(MAIN, {});
  assert.equal(def.statusCode, 409, 'still a main source: refused whatever is asked');
});

test("the custom site's delete is refused while it is some series' main source", { skip }, async () => {
  // Reintroduce by dropping the guard on DELETE /api/admin/sources/custom/:id: 200, and the series is frozen.
  await series('d', SITE2);
  const del = () => app.inject({ method: 'DELETE', url: `/api/admin/sources/custom/${SITE2}`, headers: auth });
  const r = await del();
  assert.equal(r.statusCode, 409, `the delete is refused while the site is in use: ${r.body}`);
  assert.deepEqual([r.json().error, r.json().main, r.json().messageSaid?.code], ['in_use', 1, 'retire.inUse']);
  assert.deepEqual(sitesFile(), [SITE, SITE2], "the custom site's delete is refused while it is in use");
  await q('DELETE FROM lib_series WHERE id = $1', [S('d')]);
  const ok = await del();
  assert.equal(ok.statusCode, 200, ok.body);
  assert.deepEqual(sitesFile(), [SITE], 'and done once nothing has it as its main source');
});
