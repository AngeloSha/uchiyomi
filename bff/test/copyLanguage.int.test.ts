// Chapters in the series' language (v0.62.0, lib/copyLanguage.ts), pinned against the real updater and routes with
// files on disk. The report: a server set to English only downloaded a few series in Spanish; after the admin set
// the series to English and fetched again, every chapter had two versions and the Spanish one still won.
//
//   - a copy known to be in another language is never downloaded, whichever source ranks first;
//   - a series whose every source declares another language (a language set by hand) still updates as it did;
//   - a number that exists only in another language is left out, and a manual Fetch says why;
//   - changing a series' language re-picks its stored listing at once, not at the next check;
//   - a source in every language keeps to the group of the chapters on disk, not the earliest translation;
//   - the chapters already here in another language are listed for the series page's notice, and its Fetch them
//     again replaces each one in place.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DSN = process.env.TEST_DATABASE_URL;
let ROOT = '';
if (DSN) {
  ROOT = mkdtempSync(join(tmpdir(), 'yomi-copylang-'));
  process.env.DL_ROOT = ROOT;
  process.env.DOWNLOAD_MIN_GAP_MS = '0';
  process.env.DOWNLOAD_PAGE_GAP_MS = '0';
  process.env.MIN_FREE_GB = '0';
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const LIB = 'lib_copylang';
const ES = 'cl-es';
const EN = 'cl-en';
const MIX = 'cl-mix';
const ESP = 'Zzcl Esp Scans';
const ENG = 'Zzcl Eng Scans';
const S = (k: string) => `s_cl_${k}`;
const HELD = Buffer.from('the copy already on disk');
const PIXEL = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(400, 7)]);
const ADMIN = 'cl-admin';

/** Page asks, as `<source>:<chapter number>[:<group>]`. */
const asked: string[] = [];
/** The highest number each single-language source lists; 5 unless a test says otherwise. */
const top = new Map<string, number>();

/** A source in one language (`lang`), or in every language ('all': two translations of each number). */
function source(id: string, lang: string, group: string) {
  const mixed = lang === 'all';
  return {
    id, name: `Zzz ${id}`, lang,
    async search() { return []; },
    async getSeries(sid: string) { return { sourceId: sid, source: id, title: sid }; },
    async listChapters() {
      const last = top.get(id) ?? 5;
      return Array.from({ length: last }, (_, i) => i + 1).flatMap((n) => mixed
        // Spanish out first: the earliest release, which won every tie before v0.62.0.
        ? [
            { number: n, title: `Chapter ${n}`, sourceId: `${id}-c${n}-esp`, pages: 5, scanlator: ESP, publishedAt: '2026-01-01T00:00:00Z' },
            { number: n, title: `Chapter ${n}`, sourceId: `${id}-c${n}-eng`, pages: 5, scanlator: ENG, publishedAt: '2026-01-05T00:00:00Z' },
          ]
        : [{ number: n, title: `Chapter ${n}`, sourceId: `${id}-c${n}`, pages: 5, scanlator: group }]);
    },
    async getPageUrls(chId: string) {
      const [, rest] = chId.split('-c');
      const [n, g] = rest.split('-');
      asked.push(g ? `${id}:${n}:${g}` : `${id}:${n}`);
      return Array.from({ length: 5 }, (_, i) => `https://example.invalid/${id}/${chId}/${i}.png`);
    },
    async latest() { return []; },
  };
}

let q: any, updateSeries: any;

/** A series added from `main`, following `follow` too, in `lang`, holding chapters 1..`held` by `heldGroup`. */
async function series(key: string, o: { main: string; follow?: string; lang: string | null; held?: number; heldGroup?: string }) {
  const id = S(key);
  const held = o.held ?? 4;
  await q('DELETE FROM lib_series WHERE id = $1', [id]);
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, source_id, source_series_id, auto_update, lang)
           VALUES ($1,'T!cl',$1,$1,$2,$3,$4,$5,true,$6)`, [id, held, LIB, o.main, `${o.main}-1`, o.lang]);
  if (o.follow) {
    await q(`INSERT INTO series_sources (series_id, source_id, source_series_id) VALUES ($1,$2,$3)`, [id, o.follow, `${o.follow}-1`]);
  }
  rmSync(join(ROOT, id), { recursive: true, force: true });
  mkdirSync(join(ROOT, id), { recursive: true });
  for (let n = 1; n <= held; n++) {
    writeFileSync(join(ROOT, id, `Chapter ${n}.cbz`), HELD);
    // In the download root, where Fetch again replaces a file in place (routes/admin.ts chapters/refetch).
    await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, pages, source_id, scanlator, root) VALUES ($1,$2,'T!cl',$3,$4,$5,5,$6,$7,$8)`,
      [`${id}_b${n}`, id, `${id}/Chapter ${n}.cbz`, n, `Chapter ${n}`, o.main, o.heldGroup ?? null, ROOT]);
  }
  return id;
}

const chosen5 = async (id: string) =>
  (await q(`SELECT source_id, status, chosen->>'sourceId' AS copy FROM series_listing WHERE series_id = $1 AND number = 5`, [id]))[0];

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  const { registerAdapter } = await import('../src/lib/sources');
  ({ updateSeries } = (await import('../src/lib/updater')) as any);
  await migrate();
  registerAdapter(source(ES, 'es', ESP) as any);
  registerAdapter(source(EN, 'en', ENG) as any);
  registerAdapter(source(MIX, 'all', '') as any);
  await q(`INSERT INTO libraries (id, name, path) VALUES ($1,'CopyLang',$1) ON CONFLICT (id) DO NOTHING`, [LIB]);
  globalThis.fetch = (async () => new Response(PIXEL, { status: 200, headers: { 'content-type': 'image/png' } })) as typeof fetch;
});

beforeEach(async () => {
  if (!DSN) return;
  asked.length = 0;
  top.clear();
  await q('DELETE FROM source_health WHERE source_id = ANY($1::text[])', [[ES, EN, MIX]]);
});

after(async () => {
  if (ROOT) rmSync(ROOT, { recursive: true, force: true });
  if (!DSN) return;
  await q('DELETE FROM lib_series WHERE library_id = $1', [LIB]).catch(() => {});
  await q('DELETE FROM source_health WHERE source_id = ANY($1::text[])', [[ES, EN, MIX]]).catch(() => {});
  await q('DELETE FROM libraries WHERE id = $1', [LIB]).catch(() => {});
  await q('DELETE FROM users WHERE username = $1', [ADMIN]).catch(() => {});
});

test('an English series never downloads the Spanish copy, even from the source it was added from', { skip }, async () => {
  // The report's series after its fix: added from a Spanish source, set to English, following an English one.
  const id = await series('en', { main: ES, follow: EN, lang: 'en' });
  const r = await updateSeries(id, 10);
  // Reintroduce by dropping the language spread from updateSeries' chooseOpts (lib/updater.ts): the main source wins
  // the tie, and cl-es:5 is asked.
  assert.deepEqual(asked, [`${EN}:5`]);
  assert.equal(r.added, 1);
  // The stored listing agrees with what the sweep took. Reintroduce by dropping it from decisionAfterSeries
  // (lib/seriesListing.ts): the server's pick reads the Spanish copy.
  assert.equal((await chosen5(id)).source_id, EN);
});

test("a series whose every source declares another language still updates, as it did", { skip }, async () => {
  // Korean set by hand on a manhwa read in English: no source of it has Korean, so the language is not trusted.
  const id = await series('ko', { main: EN, lang: 'ko' });
  const r = await updateSeries(id, 10);
  // Reintroduce by dropping `served` in lib/copyLanguage.ts languageRules: every English copy is dropped, and the
  // series stops updating with nothing on screen to say why.
  assert.deepEqual(asked, [`${EN}:5`]);
  assert.equal(r.added, 1);
});

test('a number only in another language is left out, and a manual Fetch says why', { skip }, async () => {
  top.set(EN, 4);
  const id = await series('only', { main: ES, follow: EN, lang: 'en' });
  await updateSeries(id, 10);
  assert.deepEqual(asked, [], `a chapter only in Spanish was downloaded: ${asked}`);
  assert.equal((await chosen5(id)).status, 'blocked');

  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  await q('DELETE FROM users WHERE username = $1', [ADMIN]);
  const admin = (await q(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ($1,$1,'x','admin','password') RETURNING id`,
    [ADMIN],
  ))[0].id;
  const app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/sources')).default);
  await app.ready();
  try {
    const headers = { authorization: `Bearer ${app.jwt.sign({ sub: admin, role: 'admin' })}` };
    const r = await app.inject({ method: 'POST', url: '/api/sources/fetch', headers, payload: { seriesId: id, numbers: [5] } });
    assert.equal(r.statusCode, 409, r.body);
    // Reintroduce by reporting every blocked number as blocked_group: the message tells the admin to unblock a group
    // that was never blocked.
    assert.deepEqual(r.json().skipped, [{ number: 5, reason: 'other_language' }]);
    assert.match(r.json().message, /only in another language/);
    assert.deepEqual(asked, []);
  } finally {
    await app.close();
  }
});

test('changing a series\' language re-picks its listing at once', { skip }, async () => {
  // Spanish first, everything held: the listing's pick for 5 is the Spanish copy, and nothing downloads.
  const id = await series('switch', { main: ES, follow: EN, lang: 'es', held: 5 });
  await updateSeries(id, 10);
  assert.equal((await chosen5(id)).source_id, ES);

  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  await q('DELETE FROM users WHERE username = $1', [ADMIN]);
  const admin = (await q(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ($1,$1,'x','admin','password') RETURNING id`,
    [ADMIN],
  ))[0].id;
  const app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/admin')).default);
  await app.ready();
  try {
    const headers = { authorization: `Bearer ${app.jwt.sign({ sub: admin, role: 'admin' })}` };
    const p = await app.inject({ method: 'PATCH', url: `/api/admin/series/${id}`, headers, payload: { lang: 'en' } });
    assert.equal(p.statusCode, 200, p.body);
    // Reintroduce by dropping the re-resolve after the language save (routes/admin.ts): the listing still names the
    // Spanish copy until the next check, and Fetch again would take it.
    assert.equal((await chosen5(id)).source_id, EN);
  } finally {
    await app.close();
  }
});

test('a source in every language keeps to the group on disk, not the earliest translation', { skip }, async () => {
  const id = await series('mix', { main: MIX, lang: null, heldGroup: ENG });
  const r = await updateSeries(id, 10);
  // Reintroduce by dropping `continuity` from releaseOrder (lib/releases.ts): the Spanish translation, out four days
  // earlier, is taken.
  assert.deepEqual(asked, [`${MIX}:5:eng`]);
  assert.equal(r.added, 1);
});

test('the chapters here in another language are listed, and Fetch again replaces them in place', { skip }, async () => {
  // The report's series after the upgrade: English, every chapter here in Spanish. Chapters 1 and 2 came from English
  // MangaDex's old fallback (a row keeps that language, migrate.ts); 3 and 4 from a Spanish source.
  const id = await series('notice', { main: EN, follow: ES, lang: 'en' });
  for (const n of [1, 2]) {
    // The same group and chapter id as the English copy that replaces it: only the kept language says it is Spanish.
    await q(`UPDATE lib_books SET lang = 'es-419', scanlator = $2, source_chapter_id = $3 WHERE id = $1`, [`${id}_b${n}`, ENG, `${EN}-c${n}`]);
  }
  await q(`UPDATE lib_books SET source_id = $2, scanlator = $3 WHERE id = ANY($1)`, [[`${id}_b3`, `${id}_b4`], ES, ESP]);
  // A Spanish chapter 3 in a library the admin built: Fetch again replaces only the downloader's own files, so it is
  // not on the notice either. Reintroduce by dropping the root check in routes/catalog.ts: it is listed, and the key
  // fails for it every time.
  await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, pages, source_id, scanlator, root)
           VALUES ($1,$2,'T!cl',$3,3,'Chapter 3',5,$4,$5,'/library')`, [`${id}_b3x`, id, `${id}/Chapter 3.cbz`, ES, ESP]);
  // Chapter 4 only in Spanish: nothing to fetch again it in, so it is not on the notice.
  top.set(EN, 3);
  await updateSeries(id, 10);

  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  await q('DELETE FROM users WHERE username = $1', [ADMIN]);
  const admin = (await q(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ($1,$1,'x','admin','password') RETURNING id`,
    [ADMIN],
  ))[0].id;
  const app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/catalog')).default);
  await app.register((await import('../src/routes/admin')).default);
  await app.ready();
  const { jobBusy } = await import('../src/routes/sources');
  try {
    const headers = { authorization: `Bearer ${app.jwt.sign({ sub: admin, role: 'admin' })}` };
    const versions = async () => {
      const r = await app.inject({ method: 'GET', url: `/api/series/${id}/versions`, headers });
      assert.equal(r.statusCode, 200, r.body);
      return r.json();
    };
    const v = await versions();
    // Reintroduce by answering null: the notice never shows, and the report's chapters stay Spanish.
    // The languages most chapters first: two in Latin American Spanish, one in Spanish.
    assert.deepEqual(v.otherLanguage, { series: 'en', langs: ['es-419', 'es'], bookIds: [`${id}_b1`, `${id}_b2`, `${id}_b3`] });
    // Each copy says when it is in another language, so the versions sheet can say why the server never takes it.
    const one = v.content.find((x: any) => x.number === 1);
    assert.deepEqual(one.copies.map((c: any) => [c.source, c.otherLanguage]).sort(), [[EN, null], [ES, 'es']]);

    const r = await app.inject({ method: 'POST', url: `/api/admin/series/${id}/chapters/refetch`, headers, payload: { bookIds: v.otherLanguage.bookIds } });
    assert.equal(r.statusCode, 200, r.body);
    for (let i = 0; i < 100 && jobBusy(id); i++) await new Promise((go) => setTimeout(go, 50));
    assert.equal(jobBusy(id), false, 'the job did not finish');
    // Reintroduce by keeping lib_books.lang when a file lands (lib/library.ts setBookMeta): chapters 1 and 2 are
    // English now and still listed as Spanish.
    assert.equal((await versions()).otherLanguage, null);
    const rows = await q(`SELECT id, source_id, lang FROM lib_books WHERE series_id = $1 AND number <= 3 AND root = $2 ORDER BY number`, [id, ROOT]);
    assert.deepEqual(rows.map((b: any) => [b.id, b.source_id, b.lang]), [1, 2, 3].map((n) => [`${id}_b${n}`, EN, null]),
      'each chapter was replaced on its own row');
  } finally {
    await app.close();
  }
});
