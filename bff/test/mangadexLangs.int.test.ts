// MangaDex in other languages, switched on and off from Admin → Providers (v0.52.0, #123).
//
// The languages besides English live in server_settings.mangadex_langs and are applied live: the settings PATCH
// saves the list and makes the source registry match it, with no restart, and the boot reads it back before the
// built-ins are registered. Driven over HTTP -- what the Providers card sends, and what Discover then reads from
// GET /api/sources -- plus the boot path and Health's word for a series whose language was switched off. The
// unstated language rides on the same route.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DSN = process.env.TEST_DATABASE_URL;
let EMPTY = '';
if (DSN) {
  EMPTY = mkdtempSync(join(tmpdir(), 'yomi-mdlangs-'));
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const ADMIN = 'mdl-admin';
const SERIES = 's_mdl_es';

let q: any;
let app: any;
let headers: Record<string, string> = {};
let sources: any;

/** What GET /api/sources says about the MangaDex family, by id. */
async function family(): Promise<Map<string, any>> {
  const r = await app.inject({ method: 'GET', url: '/api/sources', headers });
  assert.equal(r.statusCode, 200, r.body);
  return new Map(r.json().content.filter((s: any) => s.id === 'mangadex' || s.id.startsWith('mangadex-')).map((s: any) => [s.id, s]));
}
const patch = (payload: unknown) => app.inject({ method: 'PATCH', url: '/api/admin/settings', headers, payload });
const stored = async () => (await q('SELECT mangadex_langs, unstated_lang FROM server_settings WHERE id = 1'))[0];

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  sources = await import('../src/lib/sources');
  await migrate();
  await q(`UPDATE server_settings SET mangadex_langs = '[]'::jsonb, unstated_lang = 'en' WHERE id = 1`);
  // The registry as the boot leaves it: nothing from a pack, then the built-ins.
  sources.reloadSources(EMPTY);
  sources.loadBuiltins();
  await q('DELETE FROM users WHERE username = $1', [ADMIN]);
  const admin = (await q(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ($1,$1,'x','admin','password') RETURNING id`,
    [ADMIN],
  ))[0].id;
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/admin')).default);
  await app.register((await import('../src/routes/sources')).default);
  await app.ready();
  headers = { authorization: `Bearer ${app.jwt.sign({ sub: admin, role: 'admin' })}` };
});

after(async () => {
  if (EMPTY) rmSync(EMPTY, { recursive: true, force: true });
  if (!DSN) return;
  await app?.close();
  await q(`UPDATE server_settings SET mangadex_langs = '[]'::jsonb, unstated_lang = 'en' WHERE id = 1`).catch(() => {});
  await q('DELETE FROM lib_series WHERE id = $1', [SERIES]).catch(() => {});
  await q('DELETE FROM users WHERE username = $1', [ADMIN]).catch(() => {});
  const { setUnstatedLang } = await import('../src/lib/lang');
  setUnstatedLang('en');
});

test('a language switched on is a source at once, one switched off is gone, and the boot brings the list back', { skip }, async () => {
  const before = await family();
  assert.deepEqual([...before.keys()], ['mangadex'], 'only English is on to begin with');
  // Providers folds the family into one card by this (web/lib/providerGroups.ts).
  assert.deepEqual(before.get('mangadex').extension, { pkgName: 'mangadex', name: 'MangaDex' });
  assert.deepEqual((await app.inject({ method: 'GET', url: '/api/admin/settings', headers })).json().mangadex_available.slice(0, 3),
    ['en', 'es-419', 'es'], 'the picker is offered every language, English first');

  // Reintroduce by not calling syncMangadexSources in the PATCH: the list is saved, and "MangaDex (ES-419) is not a
  // source" fails -- the language would appear only after a restart.
  const on = await patch({ mangadexLangs: ['es-419', 'pt-br'] });
  assert.equal(on.statusCode, 200, on.body);
  assert.deepEqual(on.json().mangadex_langs, ['es-419', 'pt-BR'], 'stored as app codes, in the table order');
  const now = await family();
  const es = now.get('mangadex-es-419');
  assert.ok(es, 'MangaDex (ES-419) is not a source');
  assert.equal(es.name, 'MangaDex (ES-419)');
  assert.equal(es.lang, 'es-419');
  assert.deepEqual(es.extension, { pkgName: 'mangadex', name: 'MangaDex' });
  assert.ok(now.has('mangadex-pt-br'));
  const audit = await q(`SELECT detail FROM audit_log WHERE event = 'settings.mangadex_langs' ORDER BY at DESC LIMIT 1`);
  assert.deepEqual(audit[0]?.detail, { from: [], to: ['es-419', 'pt-BR'] }, 'the change is not in the activity log');

  // The boot: a fresh registry and the list read back from the database before the built-ins.
  sources.reloadSources(EMPTY);
  const { loadMangadexLangs, setMangadexLangs } = await import('../src/lib/sources/mangadexLangs');
  setMangadexLangs([]);
  assert.deepEqual(await loadMangadexLangs(), ['es-419', 'pt-BR']);
  sources.loadBuiltins();
  assert.ok(sources.getSource('mangadex-es-419'), 'a restart lost the language');

  const off = await patch({ mangadexLangs: ['pt-BR'] });
  assert.equal(off.statusCode, 200, off.body);
  assert.equal(sources.getSource('mangadex-es-419'), null, 'a language switched off is still registered');
  assert.deepEqual([...(await family()).keys()].sort(), ['mangadex', 'mangadex-pt-br']);
});

test('a refused list writes nothing: a code MangaDex is not offered in, English, or not one language', { skip }, async () => {
  await patch({ mangadexLangs: ['fr'] });
  const was = await stored();
  const unknown = await patch({ mangadexLangs: ['fr', 'xx'] });
  assert.equal(unknown.statusCode, 400);
  assert.equal(unknown.json().error, 'unknown_language');
  const english = await patch({ mangadexLangs: ['en', 'es'] });
  assert.equal(english.statusCode, 400);
  assert.equal(english.json().error, 'english_always_on');
  const all = await patch({ unstatedLang: 'all', mangadexLangs: ['es'] });
  assert.equal(all.statusCode, 400);
  assert.deepEqual(await stored(), was, 'a refused PATCH changed the settings');
  assert.ok(sources.getSource('mangadex-fr') && !sources.getSource('mangadex-es'), 'a refused PATCH changed the sources');
  // MangaDex's own spelling is the app's language: es-la is es-419.
  assert.deepEqual((await patch({ mangadexLangs: ['es-la'] })).json().mangadex_langs, ['es-419']);
});

test('the unstated language is saved and applies to the next comparison at once', { skip }, async () => {
  // Reintroduce by not calling setUnstatedLang after the UPDATE: the stored value is pt-BR and unstatedLang() still
  // reads en until the next boot -- "the guard still reads the old language" fails.
  const { unstatedLang } = await import('../src/lib/lang');
  const r = await patch({ unstatedLang: 'pt-br' });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().unstated_lang, 'pt-BR');
  assert.equal(unstatedLang(), 'pt-BR', 'the guard still reads the old language');
  await patch({ unstatedLang: 'en' });
  assert.equal(unstatedLang(), 'en');
});

test("Health says a series' MangaDex language is switched off, and where to switch it back on", { skip }, async () => {
  // Reintroduce by dropping the mangadexLangOf branch in frozenSeries' `why`: the row reads "is no longer
  // installed", which sends an admin to look for an extension that never existed.
  const { frozenSeries } = await import('../src/lib/health');
  await patch({ mangadexLangs: [] });
  await q('DELETE FROM lib_series WHERE id = $1', [SERIES]);
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, source_id, source_series_id, auto_update)
           VALUES ($1,'MangaDex (ES-419)','Zzz Frozen Edition','MangaDex (ES-419)/Zzz Frozen Edition',3,'mangadex-es-419','md-1',true)`, [SERIES]);
  const off = (await frozenSeries()).items.find((i: any) => i.seriesId === SERIES);
  assert.ok(off, 'a series whose language is off is not listed as frozen');
  assert.deepEqual(off.detailSaid, [{ code: 'frozen.mangadexOff', params: { n: 3, lang: 'es-419' } }]);
  assert.equal(off.detail, '3 chapters; MangaDex in Latin American Spanish is switched off in Admin → Providers');
  // Switched back on, it updates again: nothing frozen.
  await patch({ mangadexLangs: ['es-419'] });
  assert.equal((await frozenSeries()).items.some((i: any) => i.seriesId === SERIES), false, 'switched back on, it is still frozen');
});
