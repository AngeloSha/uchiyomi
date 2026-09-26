// Which way a series reads (#102).
//
// Every series answered `readingDirection: 'WEBTOON'` from a constant, so the reader's "Series default" could
// never turn a page right to left, a right-to-left double spread was never reassembled, a downloaded chapter
// carried WEBTOON to the reader offline, and the Komga-compatible API told Mihon every manga was a webtoon.
// This file pins the three halves of the fix:
//
//   * DETECTION: the scanner reads ComicInfo's `<Manga>YesAndRightToLeft</Manga>`; an add records what the
//     source says (MangaDex's original language) and what the AniList match says (its country); the nightly
//     repair asks MangaDex and AniList about series added before any of that existed.
//   * PRECEDENCE: ComicInfo > source > AniList, a weaker signal never overwrites a stronger one, a file that
//     says nothing erases nothing, and the admin's override beats all of them and survives a rescan.
//   * REPORTING: the one stored value reaches the series route (the reader), the offline manifest and the
//     Komga-compatible API -- and a series nothing speaks for still says WEBTOON, exactly as before.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DSN = process.env.TEST_DATABASE_URL;
const TMP = DSN ? mkdtempSync(join(tmpdir(), 'uchiyomi-dir-')) : '';
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.CACHE_DIR = join(TMP, 'cache');
  process.env.LIBRARY_BACKEND = 'owned';
  // Both roots are this file's own, so the scans below see nothing but its fixtures.
  process.env.LIBRARY_ROOT = join(TMP, 'lib');
  process.env.DL_ROOT = join(TMP, 'dl');
  process.env.DOWNLOAD_PAGE_GAP_MS = '0';
  process.env.DOWNLOAD_MIN_GAP_MS = '0';
  process.env.MIN_FREE_GB = '0';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const ADMIN = 'dir-admin';
const MEMBER = 'dir-member';
const SRC_DIR = 'Zzz Dir Scanned';
const MANGA = 'Zzz Dir Manga';     // its ComicInfo says YesAndRightToLeft
const QUIET = 'Zzz Dir Quiet';     // its ComicInfo says No: evidence of nothing
const MD_SRC = 'dir-md';           // an adapter that knows the direction, as MangaDex does
const AL_SRC = 'dir-al';           // an adapter that does not: only the AniList match can say
const MISS_SRC = 'dir-miss';       // ...and one whose AniList search answers with somebody else's entry
const MD_TITLE = 'Zzz Dir Source Says';
const AL_TITLE = 'Zzz Dir Anilist Says';
const MISS_TITLE = 'Zzz Dir Wrong Match';
const RAW = ['s_dir_r1', 's_dir_r2', 's_dir_r3', 's_dir_r4', 's_dir_r5', 's_dir_r6', 's_dir_r7', 's_dir_r8', 's_dir_r9', 's_dir_r10', 's_dir_rank'];
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const realFetch = globalThis.fetch;
let PNG: Buffer = Buffer.alloc(0);

function comicInfo(series: string, manga?: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<ComicInfo>\n  <Series>${series}</Series>\n  <Number>1</Number>\n`
    + (manga ? `  <Manga>${manga}</Manga>\n` : '') + '</ComicInfo>';
}

async function writeChapter(dir: string, series: string, manga?: string) {
  const AdmZip = (await import('adm-zip')).default;
  mkdirSync(dir, { recursive: true });
  const z = new AdmZip();
  z.addFile('001.png', PNG);
  z.addFile('ComicInfo.xml', Buffer.from(comicInfo(series, manga)));
  writeFileSync(join(dir, 'Chapter 1.cbz'), z.toBuffer());
}

function adapter(id: string, name: string, title: string, readingDirection?: string) {
  return {
    id, name,
    async search() { return []; },
    async getSeries(sid: string) { return { sourceId: sid, source: id, title, ...(readingDirection ? { readingDirection } : {}) }; },
    async listChapters() { return [{ number: 1, title: 'Chapter 1', sourceId: `${id}-c1`, pages: 1 }]; },
    async getPageUrls(chId: string) { return [`https://example.invalid/${chId}/p1.png`]; },
    async latest() { return []; },
  };
}

/**
 * The network as this file sees it: page images from example.invalid, and AniList. The AniList match for the
 * source-says title claims KOREA on purpose -- it must lose to the source -- and the AniList-only one claims
 * JAPAN. The wrong-match title gets what SEARCH_MATCH really answered for a series called "No Direction": an
 * unrelated Japanese entry, which must say nothing.
 */
function stubNetwork() {
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = String(input?.url ?? input);
    // By host, not by prefix: `https://graphql.anilist.co.example` must not be taken for AniList (CodeQL).
    if (URL.canParse(url) && new URL(url).host === 'graphql.anilist.co') {
      const body = JSON.parse(String(init?.body ?? '{}'));
      const s: string = body?.variables?.s ?? '';
      const media = s.includes('Wrong Match')
        ? { id: 32382, title: { romaji: 'Dear Green: Hitomi no Ounowa' }, synonyms: [], countryOfOrigin: 'JP' }
        : s.includes('Source Says') ? { id: 777, title: { english: s }, countryOfOrigin: 'KR' }
        : s.includes('Anilist Says') ? { id: 778, title: { romaji: 'Something Else', english: s }, countryOfOrigin: 'JP' }
        : null;
      return new Response(JSON.stringify({ data: { Media: media } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.startsWith('https://example.invalid/')) return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
    throw new Error(`unexpected request in a test: ${url}`);
  }) as typeof fetch;
}

test('reading directions: detected, ranked, overridable, and reported everywhere', { skip }, async (t) => {
  const sharp = (await import('sharp')).default;
  PNG = await sharp({ create: { width: 4, height: 6, channels: 3, background: '#fff' } }).png().toBuffer();
  const { migrate } = await import('../src/lib/migrate');
  const { q, one } = await import('../src/lib/db');
  const { persistScan } = await import('../src/lib/library');
  const dir = await import('../src/lib/readingDirection');
  const { registerAdapter } = await import('../src/lib/sources');
  const { addSeriesFromSource } = await import('../src/routes/sources');
  const { content } = await import('../src/lib/backend');
  const { viewCtxFor } = await import('../src/lib/visibility');
  const auth = await import('../src/lib/auth');
  const { setDisabled } = await import('../src/lib/sourceHealth');
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const cookie = (await import('@fastify/cookie')).default;
  const rateLimit = (await import('@fastify/rate-limit')).default;
  await migrate();
  mkdirSync(join(TMP, 'lib'), { recursive: true });
  mkdirSync(join(TMP, 'dl'), { recursive: true });

  const cleanup = async () => {
    const ids = (await q<{ id: string }>(
      `SELECT id FROM lib_series WHERE folder LIKE 'Zzz Dir%' OR title LIKE 'Zzz Dir%' OR id = ANY($1)`, [RAW])).map((r) => r.id);
    await q('DELETE FROM series_trackers WHERE series_id = ANY($1)', [ids]).catch(() => {});
    await q('DELETE FROM series_sources WHERE series_id = ANY($1)', [ids]).catch(() => {});
    await q('DELETE FROM series_overrides WHERE series_id = ANY($1)', [ids]).catch(() => {});
    await q('DELETE FROM series_art WHERE series_id = ANY($1)', [ids]).catch(() => {});
    await q('DELETE FROM lib_books WHERE series_id = ANY($1)', [ids]).catch(() => {});
    await q('DELETE FROM lib_series WHERE id = ANY($1)', [ids]).catch(() => {});
    await q('DELETE FROM users WHERE username = ANY($1)', [[ADMIN, MEMBER]]).catch(() => {});
    await setDisabled('mangadex', false).catch(() => {});
    await q(`DELETE FROM source_health WHERE source_id = 'mangadex' AND NOT disabled`).catch(() => {});
    dir.setDirectionLookups();
  };
  await cleanup();

  const mkUser = async (name: string, role: string) => (await q<{ id: string }>(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ($1,$1,'x',$2,'password') RETURNING id`,
    [name, role]))[0].id;
  const admin = await mkUser(ADMIN, 'admin');
  const member = await mkUser(MEMBER, 'user');

  const app = Fastify();
  await app.register(cookie);
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register(rateLimit, { global: false });
  await app.register((await import('../src/routes/catalog')).default);
  await app.register((await import('../src/routes/admin')).default);
  await app.register((await import('../src/routes/downloads')).default);
  await app.register((await import('../src/routes/komgaCompat')).default);
  await app.ready();
  const as = (id: string, role: string) => ({ authorization: `Bearer ${app.jwt.sign({ sub: id, role })}` });
  const adminH = as(admin, 'admin');
  const memberH = as(member, 'user');
  const apiKey = { 'x-api-key': (await auth.issueApiToken(member, 'dir', ['read'], null)).token };

  const row = (where: string, v: string) => one<{ id: string; reading_direction: string | null; reading_direction_from: string | null }>(
    `SELECT id, reading_direction, reading_direction_from FROM lib_series WHERE ${where} = $1`, [v]);
  /** Every surface that reports a series' direction, read the way each client reads it. */
  const surfaces = async (seriesId: string, bookId: string) => {
    const s = await app.inject({ method: 'GET', url: `/api/series/${seriesId}`, headers: memberH });
    assert.equal(s.statusCode, 200, s.body);
    const m = await app.inject({ method: 'GET', url: `/api/books/${bookId}/download-manifest`, headers: memberH });
    assert.equal(m.statusCode, 200, m.body);
    const k = await app.inject({ method: 'GET', url: `/api/v1/series/${seriesId}`, headers: apiKey });
    assert.equal(k.statusCode, 200, k.body);
    return { reader: s.json().metadata?.readingDirection, manifest: m.json().readingDirection, komga: k.json().metadata?.readingDirection };
  };

  try {
    let mangaId = '', mangaBook = '', quietId = '', quietBook = '';

    await t.test('the scanner reads ComicInfo: YesAndRightToLeft is right to left, No is nothing', async () => {
      await writeChapter(join(TMP, 'dl', SRC_DIR, MANGA), MANGA, 'YesAndRightToLeft');
      await writeChapter(join(TMP, 'dl', SRC_DIR, QUIET), QUIET, 'No');
      await persistScan();
      const m = await row('folder', `${SRC_DIR}/${MANGA}`);
      const n = await row('folder', `${SRC_DIR}/${QUIET}`);
      assert.ok(m && n, 'the scan did not create the fixtures');
      assert.equal(m!.reading_direction, 'RIGHT_TO_LEFT');
      assert.equal(m!.reading_direction_from, 'comicinfo');
      // `No` is what tagging tools write by default; read as left to right it would outrank every other signal.
      assert.equal(n!.reading_direction, null, 'a ComicInfo <Manga>No</Manga> was taken as evidence');
      mangaId = m!.id; quietId = n!.id;
      mangaBook = (await one<{ id: string }>('SELECT id FROM lib_books WHERE series_id = $1', [mangaId]))!.id;
      quietBook = (await one<{ id: string }>('SELECT id FROM lib_books WHERE series_id = $1', [quietId]))!.id;
    });

    await t.test('THE POINT: a right-to-left series says so to the reader, offline and to Mihon', async () => {
      // Reintroduce `readingDirection: 'WEBTOON'` in ownedCatalog seriesDto: all three read WEBTOON.
      assert.deepEqual(await surfaces(mangaId, mangaBook), { reader: 'RIGHT_TO_LEFT', manifest: 'RIGHT_TO_LEFT', komga: 'RIGHT_TO_LEFT' });
    });

    await t.test('a series nothing speaks for still says WEBTOON everywhere, exactly as before', async () => {
      assert.deepEqual(await surfaces(quietId, quietBook), { reader: 'WEBTOON', manifest: 'WEBTOON', komga: 'WEBTOON' });
    });

    await t.test('a weaker signal never overwrites a stronger one; the same signal may correct itself', async () => {
      assert.equal(await dir.learnDirection({ id: mangaId }, 'WEBTOON', 'source'), false, 'the source overrode ComicInfo');
      assert.equal(await dir.learnDirection({ id: mangaId }, 'WEBTOON', 'anilist'), false, 'AniList overrode ComicInfo');
      assert.equal((await row('id', mangaId))!.reading_direction, 'RIGHT_TO_LEFT');

      const R = 's_dir_rank';
      await q(`INSERT INTO lib_series (id, source, title, folder, books_count) VALUES ($1,'T!dir','Zzz Dir Rank','Zzz Dir T/rank',0)`, [R]);
      assert.equal(await dir.learnDirection({ id: R }, null, 'anilist'), false, 'no evidence changed something');
      assert.equal(await dir.learnDirection({ id: R }, 'WEBTOON', 'anilist'), true);
      // Reintroduce `<` for `<=` in learnDirection: this correction is refused.
      assert.equal(await dir.learnDirection({ id: R }, 'RIGHT_TO_LEFT', 'anilist'), true, 'a signal may correct its own earlier answer');
      assert.equal(await dir.learnDirection({ id: R }, 'WEBTOON', 'source'), true, 'the source did not outrank AniList');
      assert.equal(await dir.learnDirection({ id: R }, 'RIGHT_TO_LEFT', 'anilist'), false, 'AniList outranked the source');
      assert.deepEqual({ ...(await row('id', R)) }, { id: R, reading_direction: 'WEBTOON', reading_direction_from: 'source' });
      assert.equal(await dir.learnDirection({ id: R }, 'WEBTOON', 'source'), false, 'an unchanged answer reported a change');
    });

    await t.test('a rescan whose file says nothing erases nothing; one that says something wins', async () => {
      await dir.learnDirection({ id: quietId }, 'RIGHT_TO_LEFT', 'anilist');
      await persistScan();
      assert.deepEqual({ ...(await row('id', quietId)) }, { id: quietId, reading_direction: 'RIGHT_TO_LEFT', reading_direction_from: 'anilist' },
        'a ComicInfo with no direction erased what AniList said');
      await writeChapter(join(TMP, 'dl', SRC_DIR, QUIET), QUIET, 'YesAndRightToLeft');
      await dir.learnDirection({ id: quietId }, 'WEBTOON', 'source');
      await persistScan();
      assert.equal((await row('id', quietId))!.reading_direction_from, 'comicinfo', 'the file did not outrank the source');
    });

    await t.test("the admin's direction beats the evidence, survives a rescan and a save that omits it, and clears", async () => {
      const put = (payload: Record<string, unknown>) =>
        app.inject({ method: 'PUT', url: `/api/admin/series/${mangaId}/meta`, headers: adminH, payload });
      const get = async (h = adminH) => (await app.inject({ method: 'GET', url: `/api/series/${mangaId}`, headers: h })).json();

      assert.equal((await put({ title: MANGA, readingDirection: 'LEFT_TO_RIGHT' })).statusCode, 200);
      let s = await get();
      assert.equal(s.metadata.readingDirection, 'LEFT_TO_RIGHT', 'the override did not win');
      assert.equal(s.overrides?.readingDirection, 'LEFT_TO_RIGHT', 'the edit modal cannot seed its choice');
      assert.deepEqual(s.detectedDirection, { direction: 'RIGHT_TO_LEFT', from: 'comicinfo' }, 'the modal cannot say what automatic means');
      assert.equal((await surfaces(mangaId, mangaBook)).komga, 'LEFT_TO_RIGHT');

      await persistScan();
      assert.equal((await get()).metadata.readingDirection, 'LEFT_TO_RIGHT', 'a rescan undid the override');
      // An edit modal from before this field (a cached PWA) must not wipe it on an ordinary retitle.
      // Reintroduce by writing `reading_direction = $10` unconditionally: this reads RIGHT_TO_LEFT.
      assert.equal((await put({ title: MANGA })).statusCode, 200);
      assert.equal((await get()).metadata.readingDirection, 'LEFT_TO_RIGHT', 'a save that omitted readingDirection cleared it');

      assert.equal((await put({ title: MANGA, readingDirection: null })).statusCode, 200);
      s = await get();
      assert.equal(s.metadata.readingDirection, 'RIGHT_TO_LEFT', 'null did not go back to automatic');
      assert.equal(s.overrides?.readingDirection, null);

      assert.equal((await put({ title: MANGA, readingDirection: 'SIDEWAYS' })).statusCode, 400, 'an unknown direction was stored');
      // What the evidence says is an admin detail, like the folder.
      assert.equal((await get(memberH)).detectedDirection, undefined, 'a member was told the detected direction');
    });

    await t.test('an add records what the source says, above what the AniList match says', async () => {
      stubNetwork();
      registerAdapter(adapter(MD_SRC, 'Zzz Dir MD', MD_TITLE, 'RIGHT_TO_LEFT') as any);
      registerAdapter(adapter(AL_SRC, 'Zzz Dir AL', AL_TITLE) as any);
      registerAdapter(adapter(MISS_SRC, 'Zzz Dir Miss', MISS_TITLE) as any);
      const a = await addSeriesFromSource({ source: MD_SRC, sourceId: `${MD_SRC}-1`, wait: true });
      assert.equal(a.ok, true, a.message);
      const b = await addSeriesFromSource({ source: AL_SRC, sourceId: `${AL_SRC}-1`, wait: true });
      assert.equal(b.ok, true, b.message);
      const c = await addSeriesFromSource({ source: MISS_SRC, sourceId: `${MISS_SRC}-1`, wait: true });
      assert.equal(c.ok, true, c.message);
      // The art match runs detached after the add answers; give it a moment to land.
      const settled = async (title: string, want: string) => {
        for (let i = 0; i < 60; i++) {
          const r = await row('title', title);
          if (r?.reading_direction_from === want) return r;
          await new Promise((res) => setTimeout(res, 50));
        }
        return row('title', title);
      };
      const al = await settled(AL_TITLE, 'anilist');
      assert.deepEqual([al?.reading_direction, al?.reading_direction_from], ['RIGHT_TO_LEFT', 'anilist'],
        'the AniList match did not say where an unknown title comes from');
      // By now the match for the source's title has landed too (same stub, same order), and claimed KOREA.
      await new Promise((res) => setTimeout(res, 300));
      const md = await row('title', MD_TITLE);
      assert.deepEqual([md?.reading_direction, md?.reading_direction_from], ['RIGHT_TO_LEFT', 'source'],
        'the AniList match overrode what the source said');
      // Reintroduce by learning directionFromCountry(a.country) in the add: this reads RIGHT_TO_LEFT.
      const miss = await row('title', MISS_TITLE);
      assert.ok(miss, 'the wrong-match add did not land');
      assert.equal(miss!.reading_direction, null, 'an AniList entry for some other title set the direction');
      globalThis.fetch = realFetch;
    });

    await t.test('the nightly repair asks MangaDex, then AniList, about series nothing has spoken for', async () => {
      const seed = async (id: string, extra: Record<string, unknown> = {}) => {
        await q(`INSERT INTO lib_series (id, source, title, folder, books_count, source_id, source_series_id, reading_direction, reading_direction_from)
                 VALUES ($1,'T!dir',$2,$3,0,$4,$5,$6,$7)`,
          [id, `Zzz Dir ${id}`, `Zzz Dir T/${id}`, extra.src ?? null, extra.sid ?? null, extra.dir ?? null, extra.from ?? null]);
      };
      await seed('s_dir_r1', { src: 'mangadex', sid: uuid(1) });                                 // ja -> RTL
      await seed('s_dir_r2', { src: 'somewhere' });                                                // follows MangaDex: ko
      await q(`INSERT INTO series_sources (series_id, source_id, source_series_id) VALUES ('s_dir_r2','mangadex',$1)`, [uuid(2)]);
      await seed('s_dir_r3', { src: 'mangadex', sid: uuid(3), dir: 'WEBTOON', from: 'anilist' }); // upgraded by the source
      await seed('s_dir_r4', { src: 'mangadex', sid: uuid(4), dir: 'RIGHT_TO_LEFT', from: 'comicinfo' }); // never asked
      await seed('s_dir_r5', { src: 'mangadex', sid: 'not-a-uuid' });                            // never asked
      await seed('s_dir_r6');                                                                       // linked: CN
      await seed('s_dir_r7', { src: 'mangadex', sid: uuid(7) });                                  // MangaDex answers first
      await seed('s_dir_r8', { src: 'mangadex', sid: uuid(8) });                                  // MangaDex: en, AniList: JP
      await seed('s_dir_r9');                                   // linked automatically to an entry for some other title
      await seed('s_dir_r10');                                  // the same, but a person made the link: trusted
      for (const [sid, media, by] of [['s_dir_r6', '4242', null], ['s_dir_r7', '4343', null], ['s_dir_r8', '4444', null],
        ['s_dir_r9', '4545', null], ['s_dir_r10', '4646', admin]]) {
        await q(`INSERT INTO series_trackers (series_id, provider, external_id, linked_by) VALUES ($1,'anilist',$2,$3)`, [sid, media, by]);
      }
      const asked = { md: [] as string[], al: [] as number[] };
      const langs: Record<string, string> = { [uuid(1)]: 'ja', [uuid(2)]: 'ko', [uuid(3)]: 'ja', [uuid(7)]: 'ja', [uuid(8)]: 'en' };
      // Each entry is titled after its series (seed() names them `Zzz Dir <id>`), except 4545 and 4646.
      const countries: Record<number, { country: string; titles: string[] }> = {
        4242: { country: 'CN', titles: ['Zzz Dir s_dir_r6'] },
        4343: { country: 'KR', titles: ['Zzz Dir s_dir_r7'] },
        4444: { country: 'JP', titles: ['zzz dir s-dir-r8'] },
        4545: { country: 'JP', titles: ['Dear Green: Hitomi no Ounowa'] },
        4646: { country: 'JP', titles: ['Dear Green: Hitomi no Ounowa'] },
      };
      dir.setDirectionLookups({
        async mangadex(ids) { asked.md.push(...ids); return new Map(ids.filter((i) => langs[i]).map((i) => [i, langs[i]])); },
        async anilist(ids) { asked.al.push(...ids); return new Map(ids.filter((i) => countries[i]).map((i) => [i, countries[i]])); },
      });

      const { repairLibrary } = await import('../src/lib/repair');
      const r = await repairLibrary(undefined, { only: ['directions'], userId: null });
      assert.deepEqual(r.only, ['directions']);
      const got = async (id: string) => { const x = await row('id', id); return [x?.reading_direction, x?.reading_direction_from]; };
      assert.deepEqual(await got('s_dir_r1'), ['RIGHT_TO_LEFT', 'source']);
      assert.deepEqual(await got('s_dir_r2'), ['WEBTOON', 'source'], 'a FOLLOWED MangaDex source was not asked');
      assert.deepEqual(await got('s_dir_r3'), ['RIGHT_TO_LEFT', 'source'], 'the source did not replace what AniList said');
      assert.deepEqual(await got('s_dir_r4'), ['RIGHT_TO_LEFT', 'comicinfo']);
      assert.deepEqual(await got('s_dir_r5'), [null, null]);
      assert.deepEqual(await got('s_dir_r6'), ['WEBTOON', 'anilist']);
      assert.deepEqual(await got('s_dir_r7'), ['RIGHT_TO_LEFT', 'source'], 'AniList (KR) overrode MangaDex (ja)');
      assert.deepEqual(await got('s_dir_r8'), ['RIGHT_TO_LEFT', 'anilist'], 'AniList was not asked when MangaDex could not say');
      // Reintroduce by learning directionFromCountry(a.country) for every link: r9 reads RIGHT_TO_LEFT.
      assert.deepEqual(await got('s_dir_r9'), [null, null], 'an automatic link to some other title set the direction');
      assert.deepEqual(await got('s_dir_r10'), ['RIGHT_TO_LEFT', 'anilist'], 'a link a person made was second-guessed');
      assert.ok(!asked.md.includes(uuid(4)), 'a series ComicInfo had placed was asked about');
      assert.ok(!asked.md.includes('not-a-uuid'), 'a non-MangaDex id went into the query string');
      assert.ok(!asked.al.includes(4343), 'AniList was asked about a series MangaDex had just placed');
      assert.ok(r.directions.learned >= 6, `learned ${r.directions.learned}`);

      // A second night finds nothing new to write.
      const again = await repairLibrary(undefined, { only: ['directions'], userId: null });
      assert.equal(again.directions.learned, 0, 'an unchanged answer was written again');
    });

    await t.test('MangaDex failing, or switched off, costs its own signal and nothing else', async () => {
      await q(`UPDATE lib_series SET reading_direction = NULL, reading_direction_from = NULL WHERE id = ANY($1)`,
        [['s_dir_r1', 's_dir_r6', 's_dir_r8']]);
      const asked = { md: 0, al: 0 };
      dir.setDirectionLookups({
        async mangadex() { asked.md++; throw new Error('mangadex 503'); },
        async anilist(ids) { asked.al++; return new Map(ids.filter((i) => i === 4242).map((i) => [i, { country: 'CN', titles: ['Zzz Dir s_dir_r6'] }])); },
      });
      const warned: string[] = [];
      const r = await dir.detectDirections({ max: 500, log: { info: () => {}, warn: (m) => warned.push(m) } });
      assert.equal(asked.md, 1);
      assert.equal(asked.al, 1, 'a MangaDex failure stopped AniList too');
      assert.ok(warned.some((w) => /MangaDex/.test(w)), 'the failure was not logged');
      assert.equal((await row('id', 's_dir_r1'))!.reading_direction, null, 'a failed lookup wrote something');
      assert.equal((await row('id', 's_dir_r6'))!.reading_direction, 'WEBTOON');
      assert.ok(r.learned >= 1);

      await setDisabled('mangadex', true);
      asked.md = 0;
      await dir.detectDirections({ max: 500 });
      assert.equal(asked.md, 0, 'MangaDex was asked while the admin had switched it off');
      await setDisabled('mangadex', false);
    });

    await t.test('a member cannot set a direction', async () => {
      const r = await app.inject({ method: 'PUT', url: `/api/admin/series/${mangaId}/meta`, headers: memberH,
        payload: { title: MANGA, readingDirection: 'WEBTOON' } });
      assert.equal(r.statusCode, 403);
    });

    // Keep the ctx import honest: the catalog the reader reads is the one this file asserted through routes.
    const ctx = await viewCtxFor(member);
    assert.equal((await content.series(ctx, mangaId))?.metadata?.readingDirection, 'RIGHT_TO_LEFT');
  } finally {
    globalThis.fetch = realFetch;
    await app.close();
    await cleanup();
    rmSync(TMP, { recursive: true, force: true });
  }
});
