// A site added by address knows its language (v0.62.0), pinned against the real routes: the add reads it from the
// homepage it fetches anyway (a fake solver serves the pages), and the site's sheet changes it, which re-picks the
// chapters of every series that uses the site at once. Before, every such site was in the unstated language, so a
// Spanish site passed for English: English series followed it automatically and took its chapters.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DSN = process.env.TEST_DATABASE_URL;
let DIR = '';
if (DSN) {
  DIR = mkdtempSync(join(tmpdir(), 'yomi-sitelang-'));
  process.env.CUSTOM_SITES_FILE = join(DIR, 'sites.json');
  process.env.DL_ROOT = join(DIR, 'lib');
  process.env.DOWNLOAD_MIN_GAP_MS = '0';
  process.env.DOWNLOAD_PAGE_GAP_MS = '0';
  process.env.MIN_FREE_GB = '0';
  process.env.SOURCE_TEST_TIMEOUT_MS = '5000';
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
  delete process.env.FLARESOLVERR_FALLBACK_URL;
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const LIB = 'lib_sitelang';
const ADMIN = 'sl-admin';
const EN = 'sl-en';
const SITE = 'slsite';
const S = (k: string) => `s_sl_${k}`;

/** Each fake site's homepage, by host. A Madara page carries `wp-manga`, which detect.ts reads as the engine. */
const PAGES: Record<string, string> = {
  'es-site.invalid': '<!DOCTYPE html><html lang="es-ES" class="no-js"><head><title>Es</title></head><body class="wp-manga"></body></html>',
  'en-site.invalid': '<!DOCTYPE html><html lang="en-US"><head><title>En</title></head><body class="wp-manga"></body></html>',
  'pt-site.invalid': '<!DOCTYPE html><html><head><meta property="og:locale" content="pt_BR" /></head><body></body></html>',
};

let solver: Server;
let q: any, updateSeries: any, sources: any;
let app: any, headers: Record<string, string>;

const sitesFile = () => JSON.parse(readFileSync(process.env.CUSTOM_SITES_FILE!, 'utf8')) as Array<Record<string, unknown>>;

/** A source in one language, or (no `lang`) one that declares none: chapters 1..5, one copy each. */
function source(id: string, lang?: string) {
  return {
    id, name: `Zzz ${id}`, ...(lang ? { lang } : {}),
    async search() { return []; },
    async getSeries(sid: string) { return { sourceId: sid, source: id, title: sid }; },
    async listChapters() {
      return [1, 2, 3, 4, 5].map((n) => ({ number: n, title: `Chapter ${n}`, sourceId: `${id}-c${n}`, pages: 5, scanlator: `Zzsl ${id}` }));
    },
    async getPageUrls() { return []; },
    async latest() { return []; },
  };
}

before(async () => {
  if (!DSN) return;
  writeFileSync(process.env.CUSTOM_SITES_FILE!, '[]');
  solver = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let host = '';
      try { host = new URL(JSON.parse(body).url).host; } catch { /* answered as a page that is not there */ }
      const page = PAGES[host];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(page
        ? { status: 'ok', solution: { url: `https://${host}/`, status: 200, response: page, cookies: [], userAgent: 'test' } }
        : { status: 'error', message: `no page for ${host}` }));
    });
  });
  await new Promise<void>((go) => solver.listen(0, '127.0.0.1', go));
  process.env.FLARESOLVERR_URL = `http://127.0.0.1:${(solver.address() as AddressInfo).port}`;

  const { migrate } = await import('../src/lib/migrate');
  await migrate();
  ({ q } = (await import('../src/lib/db')) as any);
  sources = await import('../src/lib/sources');
  ({ updateSeries } = (await import('../src/lib/updater')) as any);
  await q(`INSERT INTO libraries (id, name, path) VALUES ($1,'SiteLang',$1) ON CONFLICT (id) DO NOTHING`, [LIB]);
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
  await app.ready();
  headers = { authorization: `Bearer ${app.jwt.sign({ sub: admin, role: 'admin' })}` };
});

after(async () => {
  if (!DSN) return;
  await app?.close();
  solver?.closeAllConnections();
  solver?.close();
  await q('DELETE FROM lib_series WHERE library_id = $1', [LIB]).catch(() => {});
  await q('DELETE FROM libraries WHERE id = $1', [LIB]).catch(() => {});
  await q('DELETE FROM users WHERE username = $1', [ADMIN]).catch(() => {});
  rmSync(DIR, { recursive: true, force: true });
});

const add = (payload: Record<string, string>) => app.inject({ method: 'POST', url: '/api/admin/sources/custom', headers, payload });

test('a site added by address takes the language its homepage says', { skip }, async () => {
  const r = await add({ engine: 'auto', name: 'Zzsl Es', base: 'https://es-site.invalid' });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual([r.json().engine, r.json().lang], ['madara', 'es']);
  // Reintroduce by dropping `lang` from the pushed site (routes/admin.ts): the add says Spanish and stores nothing.
  assert.equal(sitesFile().find((s) => s.id === 'zzsles')?.lang, 'es');
  // And the engine declares it, which is what the follow guard and the release rules read.
  assert.equal(sources.getSource('zzsles')?.lang, 'es');
});

test('English from a homepage is not stored: the site stays in the unstated language', { skip }, async () => {
  const r = await add({ engine: 'auto', name: 'Zzsl En', base: 'https://en-site.invalid' });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().lang, null);
  assert.equal('lang' in (sitesFile().find((s) => s.id === 'zzslen') ?? {}), false);
  assert.equal(sources.getSource('zzslen')?.lang, undefined);
});

test('a picked engine still reads the homepage for the language', { skip }, async () => {
  const r = await add({ engine: 'mangathemesia', name: 'Zzsl Pt', base: 'https://pt-site.invalid' });
  assert.equal(r.statusCode, 200, r.body);
  // Reintroduce by sniffing only for 'auto': a picked engine's site is stored with no language.
  assert.equal(r.json().lang, 'pt-BR');
  assert.equal(sitesFile().find((s) => s.id === 'zzslpt')?.lang, 'pt-BR');
});

test('a taken name is refused before the homepage is fetched', { skip }, async () => {
  const r = await add({ engine: 'auto', name: 'Zzsl Es', base: 'https://nowhere.invalid' });
  assert.equal(r.statusCode, 409, r.body);
});

test('the sheet\'s language re-picks the chapters of every series that uses the site, at once', { skip }, async () => {
  writeFileSync(process.env.CUSTOM_SITES_FILE!, JSON.stringify([
    ...sitesFile(), { engine: 'madara', id: SITE, name: 'Zzsl Site', base: 'https://sl-site.invalid', order: 100 },
  ]));
  // The site as the engine serves it would, and an English source beside it.
  sources.unregisterAdapter(SITE);
  sources.registerAdapter(source(SITE) as any);
  sources.unregisterAdapter(EN);
  sources.registerAdapter(source(EN, 'en') as any);
  // An English series added from the site, following the English source, every chapter held: nothing downloads.
  const id = S('repick');
  await q('DELETE FROM lib_series WHERE id = $1', [id]);
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, source_id, source_series_id, auto_update, lang)
           VALUES ($1,'T!sl',$1,$1,5,$2,$3,$4,true,'en')`, [id, LIB, SITE, `${SITE}-1`]);
  await q(`INSERT INTO series_sources (series_id, source_id, source_series_id) VALUES ($1,$2,$3)`, [id, EN, `${EN}-1`]);
  mkdirSync(join(process.env.DL_ROOT!, id), { recursive: true });
  for (let n = 1; n <= 5; n++) {
    writeFileSync(join(process.env.DL_ROOT!, id, `Chapter ${n}.cbz`), 'held');
    await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, pages, source_id) VALUES ($1,$2,'T!sl',$3,$4,$5,5,$6)`,
      [`${id}_b${n}`, id, `${id}/Chapter ${n}.cbz`, n, `Chapter ${n}`, SITE]);
  }
  await updateSeries(id, 10);
  const chosen5 = async () =>
    (await q(`SELECT source_id FROM series_listing WHERE series_id = $1 AND number = 5`, [id]))[0]?.source_id;
  // The site declares nothing, so its copy is English as far as anything knows, and the main source wins the tie.
  assert.equal(await chosen5(), SITE);

  const r = await app.inject({ method: 'PATCH', url: `/api/admin/sources/custom/${SITE}`, headers, payload: { lang: 'es-MX' } });
  assert.equal(r.statusCode, 200, r.body);
  // As a source's code: Mexican Spanish is the Latin American edition.
  assert.equal(r.json().lang, 'es-419');
  assert.equal(r.json().smoke, null, 'a language says nothing about whether the site answers: no test');
  assert.equal(sitesFile().find((s) => s.id === SITE)?.lang, 'es-419');
  assert.equal(sources.getSource(SITE)?.lang, 'es-419', 'the reload built the site with its language');
  // Reintroduce by dropping the re-pick after the language save (routes/admin.ts): the listing still names the
  // Spanish site's copy until the series' next check, and Fetch again would take it.
  assert.equal(await chosen5(), EN);
});

test('a new address keeps the site\'s language, and a language that is not one is refused', { skip }, async () => {
  const moved = await app.inject({ method: 'PATCH', url: `/api/admin/sources/custom/${SITE}`, headers, payload: { base: 'https://sl-site2.invalid/' } });
  assert.equal(moved.statusCode, 200, moved.body);
  assert.equal(moved.json().base, 'https://sl-site2.invalid');
  assert.notEqual(moved.json().smoke, null, 'a new address is tested');
  assert.equal(sitesFile().find((s) => s.id === SITE)?.lang, 'es-419');

  const bad = await app.inject({ method: 'PATCH', url: `/api/admin/sources/custom/${SITE}`, headers, payload: { lang: 'all' } });
  assert.equal(bad.statusCode, 400, bad.body);
  assert.equal(bad.json().error, 'unknown_language');
  const empty = await app.inject({ method: 'PATCH', url: `/api/admin/sources/custom/${SITE}`, headers, payload: {} });
  assert.equal(empty.statusCode, 400, empty.body);
  const none = await app.inject({ method: 'PATCH', url: '/api/admin/sources/custom/zzsl-not-there', headers, payload: { lang: 'es' } });
  assert.equal(none.statusCode, 404, none.body);
});
