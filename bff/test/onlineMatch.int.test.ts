// Online matches carry the series' name (v0.55.7, #168), where they are stored: the backdrop's lazy AniList lookup (the
// cover, the banner and the tracker link), an add's AniList art, the art backfill's hunt, and Health's Duplicate series,
// which groups only links known to be the series'.
//
// Kedryn's case: a comic with no online source took a manga's cover and banner, and the manga's AniList link, because
// AniList's answer to a title search was stored with no look at its name. The rule itself is onlineMatch.test.ts; the
// recheck of what was stored before is matchCheck.int.test.ts.
//
// Driven through the real routes over real CBZ chapters, with AniList, Kitsu and the art hosts faked at globalThis.fetch:
// nothing here reaches the network. Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const DSN = process.env.TEST_DATABASE_URL;
const ROOT = join(tmpdir(), `uchiyomi-onlinematch-${process.pid}`);
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.LIBRARY_ROOT = join(ROOT, 'library');
  process.env.DL_ROOT = join(ROOT, 'downloads');
  process.env.CACHE_DIR = join(ROOT, 'cache');
  process.env.DOWNLOAD_PAGE_GAP_MS = '0';
  process.env.DOWNLOAD_MIN_GAP_MS = '0';
  process.env.MIN_FREE_GB = '0';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const AdmZip = require('adm-zip');

const FOLDERS = { morgan: 'Zzz Om Morgan Lost', sasaki: 'Zzz Om Sasaki to Miyano', first: 'Zzz Om First Page', hunt: 'Zzz Om Hunt', dupA: 'Zzz Om Dup A', dupB: 'Zzz Om Dup B' };
const ID: Record<keyof typeof FOLDERS | 'addMiss' | 'addHit', string> = {} as any;
const ADMIN = 'om-admin';
// The art hosts: a literal public address, so the cover proxy's SSRF guard needs no DNS to let the fake answer.
const RED = 'https://1.1.1.1/om/red.png';
const BLUE = 'https://1.1.1.1/om/blue.png';
const MANGA_COVER = 'https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx9001-om.jpg';
const MANGA_BANNER = 'https://s4.anilist.co/file/anilistcdn/media/manga/banner/9001-om.jpg';

let app: any, q: any, sharp: any;
let adminAuth: Record<string, string> = {}, adminCookie = '';
const png: Record<'red' | 'blue' | 'green', Buffer> = {} as any;
/** Every AniList search, by what it asked. */
const asked: string[] = [];

/** What AniList answers a title search with: the manga "Sasaki to Miyano" for the comic, the entry itself for the rest. */
function aniListAnswer(s: string): unknown {
  const sasaki = {
    id: 9001, title: { romaji: 'Sasaki to Miyano', english: 'Zzz Om Sasaki to Miyano', native: '佐々木と宮野' }, synonyms: [],
    countryOfOrigin: 'JP', coverImage: { extraLarge: MANGA_COVER }, bannerImage: MANGA_BANNER, relations: { edges: [] },
  };
  if (s === 'Zzz Om Sasaki to Miyano' || s === 'Zzz Om Add Hit') return { ...sasaki, title: { ...sasaki.title, english: s } };
  // SEARCH_MATCH's best guess for a title AniList does not have: somebody else's manga.
  if (s.startsWith('Zzz Om')) return { ...sasaki, id: 9002, title: { romaji: 'Sasaki to Miyano', english: 'Sasaki and Miyano', native: null } };
  return null;
}

function fakeNetwork() {
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = new URL(String(input?.url ?? input));
    if (url.host === 'graphql.anilist.co') {
      const body = JSON.parse(String(init?.body ?? '{}'));
      const s = String(body?.variables?.s ?? '');
      asked.push(s);
      if (/type:ANIME/.test(body.query)) {
        return Response.json({ data: { Media: s.startsWith('Zzz Om') ? { title: { romaji: 'Sasaki and Miyano: Graduation' }, synonyms: [], bannerImage: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/77-x.jpg' } : null } });
      }
      return Response.json({ data: { Media: aniListAnswer(s) } });
    }
    if (url.hostname === 'kitsu.io') {
      return Response.json({ data: [{ attributes: { canonicalTitle: 'Zzz Om Hunt: Dark Novels', titles: {}, abbreviatedTitles: [], coverImage: { original: 'https://media.kitsu.app/spin.jpg' } } }] });
    }
    if (url.href === RED) return new Response(png.red, { status: 200, headers: { 'content-type': 'image/png' } });
    if (url.href === BLUE) return new Response(png.blue, { status: 200, headers: { 'content-type': 'image/png' } });
    if (url.hostname === 'example.invalid') return new Response(png.green, { status: 200, headers: { 'content-type': 'image/png' } });
    return new Response('not here', { status: 404 });
  }) as typeof fetch;
}

/** A folder of two chapters of green pages. */
async function folder(name: string) {
  await mkdir(join(ROOT, 'library', name), { recursive: true });
  for (const ch of [1, 2]) {
    const zip = new AdmZip();
    for (const n of [1, 2]) zip.addFile(`${n}.png`, png.green);
    await writeFile(join(ROOT, 'library', name, `Chapter ${ch}.cbz`), zip.toBuffer());
  }
}

/** Which colour a served picture mostly is. */
async function colourOf(bytes: Buffer): Promise<'red' | 'green' | 'blue'> {
  const { channels } = await sharp(bytes).stats();
  const [r, g, b] = channels.map((c: any) => c.mean);
  return r >= g && r >= b ? 'red' : g >= b ? 'green' : 'blue';
}

const ids = () => Object.values(ID).filter(Boolean);

before(async () => {
  if (!DSN) return;
  sharp = (await import('sharp')).default;
  png.red = await sharp({ create: { width: 60, height: 90, channels: 3, background: '#d01010' } }).png().toBuffer();
  png.blue = await sharp({ create: { width: 300, height: 80, channels: 3, background: '#1020d0' } }).png().toBuffer();
  png.green = await sharp({ create: { width: 60, height: 90, channels: 3, background: '#10c020' } }).png().toBuffer();
  ({ q } = await import('../src/lib/db'));
  await (await import('../src/lib/migrate')).migrate();
  await rm(ROOT, { recursive: true, force: true });
  await mkdir(join(ROOT, 'downloads'), { recursive: true });
  await q(`DELETE FROM lib_series WHERE folder LIKE 'Zzz Om%'`);
  for (const f of Object.values(FOLDERS)) await folder(f);
  await (await import('../src/lib/library')).persistScan();
  for (const [k, f] of Object.entries(FOLDERS)) ID[k as keyof typeof FOLDERS] = (await q(`SELECT id FROM lib_series WHERE folder = $1`, [f]))[0].id;
  await q(`DELETE FROM users WHERE username = $1`, [ADMIN]);
  const adminId = (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ($1,$1,'x','admin','password') RETURNING id`, [ADMIN]))[0].id;
  const { IMG_COOKIE } = await import('../src/lib/auth');
  const Fastify = (await import('fastify')).default;
  app = Fastify();
  await app.register((await import('@fastify/cookie')).default);
  await app.register((await import('@fastify/jwt')).default, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/images')).default);
  await app.register((await import('../src/routes/catalog')).default);
  await app.register((await import('../src/routes/admin')).default);
  await app.ready();
  adminCookie = `${IMG_COOKIE}=${app.jwt.sign({ sub: adminId, typ: 'img' })}`;
  adminAuth = { authorization: `Bearer ${app.jwt.sign({ sub: adminId, role: 'admin' })}` };
  fakeNetwork();
});

const realFetch = globalThis.fetch;
after(async () => {
  globalThis.fetch = realFetch;
  if (!DSN) return;
  await app?.close();
  for (const t of ['series_trackers', 'series_art', 'series_overrides', 'series_colors']) await q(`DELETE FROM ${t} WHERE series_id = ANY($1)`, [ids()]);
  await q(`DELETE FROM lib_books WHERE series_id = ANY($1)`, [ids()]);
  await q(`DELETE FROM lib_series WHERE id = ANY($1)`, [ids()]);
  await q(`DELETE FROM users WHERE username = $1`, [ADMIN]);
  await rm(ROOT, { recursive: true, force: true });
  await (await import('../src/lib/db')).pool.end();
});

const img = (path: string) => app.inject({ method: 'GET', url: path, headers: { cookie: adminCookie } });
const art = async (id: string) => (await q(`SELECT banner, cover, checked_at FROM series_art WHERE series_id = $1`, [id]))[0] ?? null;
const link = async (id: string) => (await q(`SELECT external_id, linked_by, checked_at FROM series_trackers WHERE series_id = $1 AND provider = 'anilist'`, [id]))[0] ?? null;

test("another work's answer to the backdrop's title search is stored as a miss: no cover, no banner, no link", { skip }, async () => {
  // Reintroduce by returning AniList's entry unchecked (fetchAniListArt without namesMatch): the comic stores the manga's
  // cover and banner and is linked to it -- the first assertion reads the manga's banner.
  const r = await img(`/img/series/${ID.morgan}/backdrop`);
  assert.equal(r.statusCode, 200, r.body.slice(0, 160));
  assert.ok(asked.includes(FOLDERS.morgan), 'AniList was not asked at all');
  const a = await art(ID.morgan);
  assert.ok(a, 'a miss is a stored row, as a 404 is: without one every view asks again');
  assert.equal(a.banner, null, "another work's banner was stored");
  assert.equal(a.cover, null, "another work's cover was stored");
  assert.ok(a.checked_at, 'a row the backdrop writes is checked');
  assert.equal(await link(ID.morgan), null, "the series was linked to another work's AniList entry");
  // Not asked again on the next view: the miss stands.
  const before = asked.filter((s) => s === FOLDERS.morgan).length;
  assert.equal((await img(`/img/series/${ID.morgan}/backdrop?style=banner`)).statusCode, 200);
  assert.equal((await img(`/img/series/${ID.morgan}/thumb`)).statusCode, 200);
  assert.equal(asked.filter((s) => s === FOLDERS.morgan).length, before, 'AniList was asked again on the next view');
});

test('an answer named as the series is stored, linked, and both are marked checked', { skip }, async () => {
  assert.equal((await img(`/img/series/${ID.sasaki}/backdrop`)).statusCode, 200);
  const a = await art(ID.sasaki);
  assert.deepEqual([a?.banner, a?.cover], [MANGA_BANNER, MANGA_COVER], 'the right entry\'s art was not kept');
  assert.ok(a.checked_at);
  const l = await link(ID.sasaki);
  assert.equal(l?.external_id, '9001');
  assert.equal(l?.linked_by, null, 'an automatic link');
  assert.ok(l?.checked_at, 'a link written by the art lookup is checked (lib/trackers.ts linkSeries)');
});

test("an add keeps AniList's art only from an entry named as the series", { skip }, async () => {
  const { registerAdapter } = await import('../src/lib/sources');
  const { addSeriesFromSource } = await import('../src/routes/sources');
  const adapter = (id: string, title: string) => ({
    id, name: `Zzz Om ${id}`,
    async search() { return []; },
    async getSeries(sid: string) { return { sourceId: sid, source: id, title, coverUrl: RED }; },
    async listChapters() { return [{ number: 1, title: 'Chapter 1', sourceId: `${id}-c1`, pages: 1 }]; },
    async getPageUrls(chId: string) { return [`https://example.invalid/${chId}/p1.png`]; },
    async latest() { return []; },
  });
  registerAdapter(adapter('om-miss', 'Zzz Om Add Miss') as any);
  registerAdapter(adapter('om-hit', 'Zzz Om Add Hit') as any);
  for (const [k, src] of [['addMiss', 'om-miss'], ['addHit', 'om-hit']] as const) {
    const r = await addSeriesFromSource({ source: src, sourceId: `${src}-1`, wait: true });
    assert.equal(r.ok, true, r.message);
    ID[k] = (await q(`SELECT id FROM lib_series WHERE source_id = $1`, [src]))[0].id;
  }
  // The art lookup runs detached after the add answers: wait for both rows to carry AniList's verdict.
  const settled = async (id: string, done: (a: any) => boolean) => {
    for (let i = 0; i < 100; i++) {
      const a = await art(id);
      if (a && done(a)) return a;
      await new Promise((res) => setTimeout(res, 50));
    }
    return art(id);
  };
  const hit = await settled(ID.addHit, (a) => !!a.banner);
  assert.equal(hit?.banner, MANGA_BANNER, 'the right entry\'s banner was not kept');
  assert.equal(hit?.cover, RED, "the source's own cover gave way to AniList's");
  // The miss: AniList was asked (after the hit's, in the same order), and its answer was another work.
  for (let i = 0; i < 100 && !asked.includes('Zzz Om Add Miss'); i++) await new Promise((res) => setTimeout(res, 50));
  await new Promise((res) => setTimeout(res, 300));
  const miss = await art(ID.addMiss);
  // Reintroduce by returning AniList's entry unchecked (fetchAniListArt without its namesMatch): the manga's banner lands
  // here, from the add's art lookup (routes/sources.ts artByTitle).
  assert.equal(miss?.banner, null, "another work's banner was stored on an add");
  assert.equal(miss?.cover, RED, "the source's cover is the series' cover");
});

test('the backfill stores only what is named as the series: AniList, the anime search, Kitsu and MangaDex alike', { skip }, async () => {
  const { registerAdapter } = await import('../src/lib/sources');
  const { huntArt } = await import('../src/routes/admin');
  const OTHER = 'https://uploads.mangadex.org/covers/11111111-1111-4111-8111-111111111111/other.jpg';
  const MINE = 'https://uploads.mangadex.org/covers/22222222-2222-4222-8222-222222222222/mine.jpg';
  // MangaDex's search, first hit somebody else's: the backfill used to take res[0] whatever it was.
  registerAdapter({
    id: 'mangadex', name: 'MangaDex',
    async search() {
      return [{ sourceId: 'o', source: 'mangadex', title: 'Zzz Om Hunt: Dark Novels', coverUrl: OTHER }, { sourceId: 'm', source: 'mangadex', title: 'Zzz Om Hunt', coverUrl: MINE }];
    },
    async getSeries() { return null; }, async listChapters() { return []; }, async getPageUrls() { return []; }, async latest() { return []; },
  } as any);
  // AniList answers another work for both the title and the harsher one; the anime search a sequel; Kitsu a spin-off.
  const found = await huntArt({ id: ID.hunt, title: FOLDERS.hunt });
  const a = await art(ID.hunt);
  assert.equal(a?.banner ?? null, null, 'a banner that is not the series\' was stored');
  // Reintroduce by keeping MangaDex's first hit: the spin-off's cover is stored.
  assert.equal(a?.cover, MINE, 'the cover is not the hit named as the series');
  assert.equal(found, 'cover');
  assert.equal(await link(ID.hunt), null, 'the backfill linked another work');
});

test('Health groups only links known to be the series\'; an unchecked automatic link groups nothing', { skip }, async () => {
  const { findingOf } = (await import('../src/lib/health')) as any;
  await q(`INSERT INTO series_trackers (series_id, provider, external_id) VALUES ($1,'anilist','om-dup'), ($2,'anilist','om-dup')`, [ID.dupA, ID.dupB]);
  // Reintroduce by reading every link in duplicateSeries: the two unrelated series one title search gave the same wrong
  // entry are a finding -- and Fix everything's merge.
  assert.equal(await findingOf('duplicates', 'anilist:om-dup'), null, 'an unchecked link groups nothing');
  await q(`UPDATE series_trackers SET checked_at = now() WHERE series_id = ANY($1)`, [[ID.dupA, ID.dupB]]);
  assert.ok(await findingOf('duplicates', 'anilist:om-dup'), 'two checked links on one entry are no longer found');
  // A person's link counts as it stands.
  await q(`UPDATE series_trackers SET checked_at = NULL, linked_by = (SELECT id FROM users WHERE username = $2) WHERE series_id = ANY($1)`, [[ID.dupA, ID.dupB], ADMIN]);
  assert.ok(await findingOf('duplicates', 'anilist:om-dup'), "a person's links are not grouped");
});
