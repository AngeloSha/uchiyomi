// Notice chapters (lib/noticeChapters.ts): an admin may hide the notices sources post as short chapters numbered with
// a fraction -- 100.1, 100.5, with 3 pages or fewer -- per series type, and per series over its type. Off by default.
// A fractional chapter that is longer, or whose pages nobody knows yet, is a chapter (the owner's rule, v0.55.2).
//
// Over HTTP against the real routes, because the rule has to hold on every surface at once -- the app's chapter
// list, counts, next/previous and missing-chapter rows, the Komga-compatible API Mihon reads, and what the
// trackers are told -- and come back on all of them the moment the switch is off. And through the real sweep,
// which must not download a hidden one.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DSN = process.env.TEST_DATABASE_URL;
const ROOT = DSN ? mkdtempSync(join(tmpdir(), 'yomi-notice-')) : '';
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.DL_ROOT = ROOT;
  process.env.DOWNLOAD_MIN_GAP_MS = '0';
  process.env.DOWNLOAD_PAGE_GAP_MS = '0';
  process.env.MIN_FREE_GB = '0';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const LIB = 'lib_nt';
const HW = 's_nt_manhwa';     // typed manhwa by its genres
const MG = 's_nt_manga';      // typed manga by hand (series_overrides)
const KEEP = 's_nt_keep';     // a manhwa that switches the hide off for itself
const SWEEP = 's_nt_sweep';   // followed from a fake source, for the updater
const PG = 's_nt_pages';      // a manhwa whose fractional chapters are long, short and not counted
const DD = 's_nt_dd';         // Korean, filed under a lone generic "Manga"
const JJ = 's_nt_jojo';       // Japanese, carrying a site's whole genre menu
const PARTS = 's_nt_parts';   // a manhwa whose chapter 1 exists only in short parts its sources list
const SERIES = [HW, MG, KEEP, SWEEP, PG, DD, JJ, PARTS];
const ADMIN = 'nt-admin', MEMBER = 'nt-member';
const SRC = 'nt-src';
/** The chapter ids the sweep asked the fake source for pages of: what it tried to download. */
const asked: string[] = [];

test('notice chapters: off by default, hidden everywhere by type or by series, and back when switched off', { skip }, async (t) => {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const auth = await import('../src/lib/auth');
  const { registerAdapter } = await import('../src/lib/sources');
  const { updateSeries } = await import('../src/lib/updater');
  const { seriesProgressFor } = await import('../src/lib/trackers');
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const cookie = (await import('@fastify/cookie')).default;
  const rateLimit = (await import('@fastify/rate-limit')).default;
  await migrate();

  const cleanup = async () => {
    await q('DELETE FROM lib_series WHERE id = ANY($1)', [SERIES]).catch(() => {});
    await q('DELETE FROM libraries WHERE id = $1', [LIB]).catch(() => {});
    await q('DELETE FROM users WHERE username = ANY($1)', [[ADMIN, MEMBER]]).catch(() => {});
    // Shared database: a list left behind would hide chapters in every later suite.
    await q(`UPDATE server_settings SET hide_notice_types = '[]'::jsonb, hide_notice_short_only = true WHERE id = 1`).catch(() => {});
    await (await import('../src/lib/noticeSettings')).refreshNoticesActive().catch(() => {});
  };
  await cleanup();

  registerAdapter({
    id: SRC, name: SRC,
    async search() { return []; },
    async getSeries(sid: string) { return { sourceId: sid, source: SRC, title: sid }; },
    async listChapters() {
      // 2.5 is a notice by the source's own count; 3.5 is twenty pages, a chapter in parts; 4.5 nobody has counted.
      const pages: Record<number, number> = { 2.5: 2, 3.5: 20 };
      return [1, 2, 2.5, 3, 3.5, 4.5].map((n) => ({ number: n, title: `Chapter ${n}`, sourceId: `nt-c${n}`, pages: pages[n] }));
    },
    // Nothing downloads: the test is which chapters the sweep TRIES.
    async getPageUrls(chId: string) { asked.push(chId); throw new Error('no pages here'); },
    async latest() { return []; },
  } as any);

  await q(`INSERT INTO libraries (id, name, path) VALUES ($1,'Notice Shelf','/nt')`, [LIB]);
  const series = (id: string, genres: string[], count: number) =>
    q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, genres, latest_mtime, created_at)
       VALUES ($1,'T!nt',$1,$2,$3,$4,$5,1,now())`, [id, `T!nt/${id}`, count, LIB, genres]);
  await series(HW, ['Action', 'Manhwa', 'Webtoon'], 5);
  await series(MG, ['Action'], 2);
  await series(KEEP, ['Manhwa'], 2);
  await q('UPDATE lib_series SET hide_notices = false WHERE id = $1', [KEEP]);
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, genres, source_id, source_series_id, auto_update)
           VALUES ($1,'T!nt',$1,$1,0,$2,'{Manhwa}',$3,'nt-1',true)`, [SWEEP, LIB, SRC]);
  // The boot backfill types series from their genres; these were inserted after it, so type them the same way.
  const { learnTypeFromSource } = await import('../src/lib/seriesType');
  for (const [id, genres] of [[HW, ['Action', 'Manhwa', 'Webtoon']], [KEEP, ['Manhwa']], [SWEEP, ['Manhwa']]] as const) {
    await learnTypeFromSource({ id }, { genres: [...genres] });
  }
  await q(`INSERT INTO series_overrides (series_id, series_type) VALUES ($1, 'manga')`, [MG]);
  await series(PG, ['Manhwa'], 8);
  await learnTypeFromSource({ id: PG }, { genres: ['Manhwa'] });

  const book = (id: string, sid: string, n: number, pages = 3) =>
    q(`INSERT INTO lib_books (id, series_id, source, file, number, title, pages, root)
       VALUES ($1,$2,'T!nt',$3,$4,$5,$6,$7)`, [id, sid, `${id}.cbz`, n, `Chapter ${n}`, pages, ROOT]);
  /** A series_listing row whose copies say these page counts (null: a copy that does not say). */
  const listed = (sid: string, n: number, pages: Array<number | null> = []) =>
    q(`INSERT INTO series_listing (series_id, number, title, source_id, chosen, status, copies)
       VALUES ($1,$2,$3,'src','{}'::jsonb,'available',$4::jsonb)`, [sid, n, `Chapter ${n}`, JSON.stringify(pages.map((p, i) => ({
      sourceId: `${sid}-${n}-${i}`, source: 'src', groups: [], scanlator: null, lang: null, pages: p, publishedAt: null,
    })))]);
  // HW: 99, 100, the notice 100.5, a file that parsed as 0 and was renumbered to the notice 100.1, and a file that
  // parsed as 100.2 and was renumbered to 101 -- the effective number decides, both ways.
  await book('b_nt_99', HW, 99);
  await book('b_nt_100', HW, 100);
  await book('b_nt_1005', HW, 100.5);
  await book('b_nt_ov1001', HW, 0);
  await book('b_nt_ov101', HW, 100.2);
  await q(`INSERT INTO book_overrides (book_id, number) VALUES ('b_nt_ov1001', 100.1), ('b_nt_ov101', 101)`);
  await book('b_nt_m1', MG, 1);
  await book('b_nt_m15', MG, 1.5);
  await book('b_nt_k1', KEEP, 1);
  await book('b_nt_k15', KEEP, 1.5);
  // What the sources list for HW: four numbers it does not hold. 101.5 is a notice by the listing's own count;
  // 102.5 is twenty pages, a chapter in parts; nobody says how long 103.5 is.
  for (const n of [99, 100, 101, 102]) await listed(HW, n);
  await listed(HW, 100.5, [2]);
  await listed(HW, 101.5, [2, null]);
  await listed(HW, 102.5, [20]);
  await listed(HW, 103.5, [null]);
  // PG, the review's numbers: the two-page 44.5 is a notice and the twenty-page 12.5 a chapter. 7.5 was never counted
  // and nothing lists it, so nobody knows: shown. 8.5 was never counted either, and its copies say two pages: hidden.
  // 9.5 likewise, but one copy says eighteen: the most any copy says decides, so it is a chapter.
  for (const [id, n, pages] of [['b_nt_p7', 7, 20], ['b_nt_p75', 7.5, 0], ['b_nt_p85', 8.5, 0], ['b_nt_p95', 9.5, 0],
    ['b_nt_p12', 12, 20], ['b_nt_p125', 12.5, 20], ['b_nt_p44', 44, 20], ['b_nt_p445', 44.5, 2]] as const) await book(id, PG, n, pages);
  await listed(PG, 8.5, [2]);
  await listed(PG, 9.5, [2, 18]);

  const admin = (await q<{ id: string }>(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ($1,$1,'x','admin','password') RETURNING id`, [ADMIN]))[0].id;
  const member = (await q<{ id: string }>(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ($1,$1,'x','user','password') RETURNING id`, [MEMBER]))[0].id;
  // The member has read 99, 100 and the notice 100.5.
  for (const b of ['b_nt_99', 'b_nt_100', 'b_nt_1005']) {
    await q(`INSERT INTO read_progress (user_id, book_id, series_id, page, completed) VALUES ($1,$2,$3,3,true)`, [member, b, HW]);
  }

  const { ZodError } = await import('zod');
  const app = Fastify();
  // The server's own error handler maps a refused body to 400 (server.ts); a bare app would answer 500.
  app.setErrorHandler((err: any, _req: any, reply: any) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: 'bad_request' });
    return reply.code(err.statusCode || 500).send({ error: err.message || 'error' });
  });
  await app.register(cookie);
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register(rateLimit, { global: false });
  await app.register((await import('../src/routes/catalog')).default);
  await app.register((await import('../src/routes/admin')).default);
  await app.register((await import('../src/routes/komgaCompat')).default);
  await app.ready();
  const asAdmin = { authorization: `Bearer ${app.jwt.sign({ sub: admin, role: 'admin' })}` };
  const asMember = { authorization: `Bearer ${app.jwt.sign({ sub: member, role: 'user' })}` };
  const komgaKey = { 'x-api-key': (await auth.issueApiToken(member, 'nt', ['read'], null)).token };
  let seq = 0;
  const get = (url: string, headers: Record<string, string>) =>
    app.inject({ method: 'GET', url, headers, remoteAddress: `10.81.0.${++seq & 255}` });
  const numbers = async (sid: string, headers = asMember) =>
    (await get(`/api/series/${sid}/books?size=500`, headers)).json().content.map((b: any) => b.number);
  const setTypes = async (types: string[]) => {
    const r = await app.inject({ method: 'PATCH', url: '/api/admin/settings', headers: asAdmin, payload: { hideNoticeTypes: types } });
    assert.equal(r.statusCode, 200, r.body);
    return r.json();
  };

  try {
    await t.test('off by default: every chapter is listed and counted', async () => {
      const s = await q<{ t: unknown }>('SELECT hide_notice_types AS t FROM server_settings WHERE id = 1');
      assert.deepEqual(s[0].t, [], 'the setting must ship off');
      assert.deepEqual(await numbers(HW), [99, 100, 100.1, 100.5, 101]);
      assert.equal((await get(`/api/series/${HW}`, asMember)).json().booksCount, 5);
      assert.deepEqual(await numbers(PG), [7, 7.5, 8.5, 9.5, 12, 12.5, 44, 44.5]);
    });

    await t.test('series types: from the genres (origin beats Webtoon), and by hand', async () => {
      const hw = (await get(`/api/series/${HW}`, asAdmin)).json();
      assert.equal(hw.seriesType, 'manhwa');
      assert.deepEqual(hw.detectedType, { type: 'manhwa', from: 'genre' });
      assert.equal(hw.hideNoticesEffective, false);
      const mg = (await get(`/api/series/${MG}`, asAdmin)).json();
      assert.equal(mg.seriesType, 'manga');
      assert.equal(mg.overrides.seriesType, 'manga');
      // Members are not told any of it.
      assert.equal((await get(`/api/series/${HW}`, asMember)).json().seriesType, undefined);
    });

    await t.test('series types: a genre menu or a lone Manga is no evidence, so the source and AniList decide', async () => {
      await series(DD, ['Action', 'Manga'], 0);
      await series(JJ, ['Manga', 'Manhwa', 'Manhua'], 0);
      const { learnTypeFromAniList } = await import('../src/lib/seriesType');
      // What the add flow and the direction detector hand over: MangaDex's original language, AniList's country.
      await learnTypeFromSource({ id: DD }, { genres: ['Action', 'Manga'], originalLanguage: 'ko' });
      await learnTypeFromSource({ id: JJ }, { genres: ['Manga', 'Manhwa', 'Manhua'] });
      await learnTypeFromAniList({ id: JJ }, JJ, { country: 'JP', titles: [JJ] });
      // Reintroduce the first origin named (lib/seriesTypeSignals.ts typeFromGenres): DD reads manga from the genre,
      // which MangaDex cannot outrank, and JJ manhwa, which AniList cannot.
      const dd = (await get(`/api/series/${DD}`, asAdmin)).json();
      assert.deepEqual([dd.seriesType, dd.detectedType], ['manhwa', { type: 'manhwa', from: 'source' }], 'a lone Manga outranked MangaDex');
      const jj = (await get(`/api/series/${JJ}`, asAdmin)).json();
      assert.deepEqual([jj.seriesType, jj.detectedType], ['manga', { type: 'manga', from: 'anilist' }], 'a genre menu outranked AniList');
    });

    await t.test('the settings route takes known types only, and reads them back', async () => {
      const bad = await app.inject({ method: 'PATCH', url: '/api/admin/settings', headers: asAdmin, payload: { hideNoticeTypes: ['novel'] } });
      assert.equal(bad.statusCode, 400);
      const row = await setTypes(['manhwa']);
      assert.deepEqual(row.hide_notice_types, ['manhwa']);
    });

    await t.test('on for manhwa: the chapter list, by-id, next and the counts leave the notices out', async () => {
      // By the effective number both ways: the file renumbered to 100.1 goes, the 100.2 renumbered to 101 stays.
      assert.deepEqual(await numbers(HW), [99, 100, 101]);
      assert.equal((await get('/api/books/b_nt_1005', asMember)).statusCode, 404, 'a hidden chapter is not there by id');
      const next = (await get('/api/books/b_nt_100/next', asMember)).json();
      assert.equal(next.id, 'b_nt_ov101', 'next skips the notice');
      const s = (await get(`/api/series/${HW}`, asMember)).json();
      assert.equal(s.booksCount, 3, 'the stored count less the hidden notices');
      // The read notice does not stand in for the unread 101.
      assert.equal(s.booksReadCount, 2);
      assert.equal(s.booksUnreadCount, 1);
      // Admins included.
      assert.deepEqual(await numbers(HW, asAdmin), [99, 100, 101]);
      const a = (await get(`/api/series/${HW}`, asAdmin)).json();
      assert.equal(a.hideNoticesEffective, true);
      // the hidden count includes notices that were never downloaded: 100.1 and 100.5 on disk, 101.5 only listed.
      // Reintroduce by counting lib_books alone: this reads 2, and 0 for a series whose notices were never fetched.
      assert.equal(a.hiddenNotices, 3);
    });

    await t.test('only a short chapter is a notice: two pages hidden, twenty shown, not counted shown', async () => {
      // The owner's library: of 1,759 x.y chapters about 170 had 3 pages or fewer and about 1,500 had 6 or more.
      // Reintroduce any fraction (drop the page test from bookIsNotice): 12.5, 7.5 and 9.5 go too.
      assert.deepEqual(await numbers(PG), [7, 7.5, 9.5, 12, 12.5, 44], 'the short chapters, and only they, are hidden');
      assert.equal((await get(`/api/series/${PG}`, asMember)).json().booksCount, 6);
      assert.equal((await get('/api/books/b_nt_p445', asMember)).statusCode, 404, 'the two-page 44.5 is still there by id');
      assert.equal((await get('/api/books/b_nt_p125', asMember)).statusCode, 200, 'the twenty-page 12.5 is gone by id');
      // Counted at last -- the reader opened it, or the repair did -- 7.5 turns out to be a two-page notice.
      await q(`UPDATE lib_books SET pages = 2 WHERE id = 'b_nt_p75'`);
      assert.deepEqual(await numbers(PG), [7, 9.5, 12, 12.5, 44]);
      await q(`UPDATE lib_books SET pages = 0 WHERE id = 'b_nt_p75'`);
    });

    await t.test('the missing-chapter rows, and other types untouched', async () => {
      const ghosts = (await get(`/api/series/${HW}/listing`, asMember)).json().content.map((g: any) => g.number);
      assert.deepEqual(ghosts, [102, 102.5, 103.5],
        'the listed two-page 101.5 is not missing; it is not a chapter here -- but the long 102.5 and the uncounted 103.5 are');
      assert.deepEqual(await numbers(MG), [1, 1.5], 'manga is not switched on');
      assert.deepEqual(await numbers(KEEP), [1, 1.5], "a series' own off beats its type's on");
    });

    await t.test('Mihon: the Komga chapter list, the series counts and the progress run', async () => {
      const list = (await get(`/api/v1/series/${HW}/books?unpaged=true`, komgaKey)).json();
      assert.deepEqual(list.content.map((b: any) => b.number), [99, 100, 101]);
      const series = (await get(`/api/v1/series/${HW}`, komgaKey)).json();
      assert.equal(series.booksCount, 3);
      const prog = (await get(`/api/v2/series/${HW}/read-progress/tachiyomi`, komgaKey)).json();
      assert.equal(prog.booksCount, 3);
      assert.equal(prog.booksReadCount, 2);
      assert.equal(prog.lastReadContinuousNumberSort, 100);
    });

    await t.test('the trackers: a series read to the end is finished with an unread notice in it', async () => {
      await q(`INSERT INTO read_progress (user_id, book_id, series_id, page, completed) VALUES ($1,'b_nt_ov101',$2,3,true)`, [member, HW]);
      assert.deepEqual(await seriesProgressFor(member, HW), { chapters: 101, finished: true });
      await setTypes([]);
      // With the switch off the unread 100.1 is a chapter again, and the series is not finished.
      assert.equal((await seriesProgressFor(member, HW)).finished, false);
      await setTypes(['manhwa']);
    });

    await t.test("a series' own switch: on beats its type's off, and null follows the type again", async () => {
      const on = await app.inject({ method: 'PATCH', url: `/api/admin/series/${MG}`, headers: asAdmin, payload: { hideNotices: true } });
      assert.equal(on.statusCode, 200, on.body);
      assert.deepEqual({ ...on.json(), ok: undefined }, { ok: undefined, hideNotices: true, hideNoticesEffective: true, hiddenNotices: 1 });
      assert.deepEqual(await numbers(MG), [1]);
      const back = await app.inject({ method: 'PATCH', url: `/api/admin/series/${MG}`, headers: asAdmin, payload: { hideNotices: null } });
      assert.equal(back.json().hideNoticesEffective, false);
      assert.deepEqual(await numbers(MG), [1, 1.5]);
    });

    await t.test('the sweep skips only a notice its source says is short, and does not count it as missing', async () => {
      asked.length = 0;
      await updateSeries(SWEEP, 10);
      // The twenty-page 3.5 and the uncounted 4.5 are fetched like any chapter: the sweep cannot know 4.5 is a notice
      // until it is here and counted.
      assert.deepEqual([...asked].sort(), ['nt-c1', 'nt-c2', 'nt-c3', 'nt-c3.5', 'nt-c4.5'], 'the two-page 2.5, and only it, is never fetched');
      const s = await q<{ source_chapters: number; source_missing: number }>('SELECT source_chapters, source_missing FROM lib_series WHERE id = $1', [SWEEP]);
      assert.equal(s[0].source_missing, 5);
      assert.equal(s[0].source_chapters, 5);
      // Kept in the listing, so switching off shows it at once and the next sweep fetches it.
      const listed = await q<{ number: number }>('SELECT number FROM series_listing WHERE series_id = $1 ORDER BY number', [SWEEP]);
      assert.deepEqual(listed.map((r) => Number(r.number)), [1, 2, 2.5, 3, 3.5, 4.5]);
      await setTypes([]);
      asked.length = 0;
      await q('DELETE FROM chapter_failures WHERE series_id = $1', [SWEEP]);
      await updateSeries(SWEEP, 10);
      assert.ok(asked.includes('nt-c2.5'), 'switched off, the next sweep fetches it');
    });

    await t.test('switched off: everything is back on the next request, nothing was deleted', async () => {
      await setTypes([]);
      assert.deepEqual(await numbers(HW), [99, 100, 100.1, 100.5, 101]);
      assert.equal((await get(`/api/series/${HW}`, asMember)).json().booksCount, 5);
      const ghosts = (await get(`/api/series/${HW}/listing`, asMember)).json().content.map((g: any) => g.number);
      assert.deepEqual(ghosts, [101.5, 102, 102.5, 103.5]);
      assert.equal((await get('/api/books/b_nt_1005', asMember)).statusCode, 200);
    });

    await t.test('a chapter that exists only in short parts is not a gap while they are hidden', async () => {
      // 0 and 2 are here; chapter 1 exists only as 1.1, 1.2 and 1.3, a few pages each, which only the sources list.
      await series(PARTS, ['Manhwa'], 2);
      await learnTypeFromSource({ id: PARTS }, { genres: ['Manhwa'] });
      await book('b_nt_pt0', PARTS, 0, 20);
      await book('b_nt_pt2', PARTS, 2, 20);
      for (const n of [0, 2]) await listed(PARTS, n, [20]);
      for (const [n, p] of [[1.1, 2], [1.2, 2], [1.3, 3]]) await listed(PARTS, n, [p]);
      const { haveNumbers } = await import('../src/lib/libraryNumbers');
      const { gapsOf } = await import('../src/lib/fill');
      const { runRepair } = await import('../src/lib/repair');
      const holes = async () => gapsOf(await haveNumbers(PARTS)).map((g) => [g.lo, g.hi]);
      // Off, the sweep fetches the parts, so the hole at 1 is the sweep's to fill: listed, and fetched next check.
      assert.deepEqual(await holes(), [[1, 1]]);
      await setTypes(['manhwa']);
      try {
        // On, the sweep never fetches them -- and a hole it "would fetch" was a finding nothing could clear. They are
        // what they would be with the switch off: chapter 1 of the series. Reintroduce by dropping the hidden
        // listing from HAVE_SQL (lib/libraryNumbers.ts): the hole is back, and Fill now leaves it to the sweep.
        assert.deepEqual(await holes(), [], 'chapter 1, hidden in parts, is a gap');
        const r = await runRepair(undefined, { only: ['gaps'], seriesId: PARTS, userId: null });
        assert.ok(r, 'the repair did not start');
        assert.deepEqual([r.gaps.series, r.gaps.sweep], [0, 0], 'Fill now found a hole and left it for a sweep that never fetches it');
      } finally {
        await setTypes([]);
      }
    });

    await t.test('the hidden counts are read through the fractional index, not every chapter', async () => {
      // On the review's 48k-chapter library a single count over all of a series' chapters, run for every series the
      // grid sorts, priced the Library grid past jit_above_cost, and every read-progress roll-up visited every chapter
      // to find 170 notices. The plan the indexes allow, whatever this small table's statistics prefer.
      // Reintroduce the single count in hiddenBookCount, or drop mayBeNotice from noticeBook: lib_books_fraction_idx
      // is not in the plan.
      const { tx } = await import('../src/lib/db');
      const { hiddenBookCount, noticeBook } = await import('../src/lib/noticeChapters');
      await setTypes(['manhwa']);
      try {
        const [count, rollup] = await tx(async (qq) => {
          await qq('SET LOCAL enable_seqscan = off');
          const plan = async (sql: string) => (await qq(`EXPLAIN ${sql}`)).map((r: any) => r['QUERY PLAN']).join('\n');
          return [await plan(`SELECT ${hiddenBookCount('s')} FROM lib_series s`),
            await plan(`SELECT series_id, count(*) FROM read_progress WHERE NOT ${noticeBook('read_progress.book_id')} GROUP BY series_id`)];
        });
        assert.match(count, /lib_books_fraction_idx/, `the hidden count visits every chapter:\n${count}`);
        assert.match(rollup, /lib_books_fraction_idx/, `the roll-up visits every chapter:\n${rollup}`);
      } finally {
        await setTypes([]);
      }
    });

    await t.test("a series' own switch alone turns the hide on, and nothing hides once it is back", async () => {
      // Every type off: the queries are the previous release's (lib/noticeChapters.ts `active`) until something hides.
      const { noticesActive } = await import('../src/lib/noticeChapters');
      assert.equal(noticesActive(), false, 'with every switch off the fragments must be constants');
      const on = await app.inject({ method: 'PATCH', url: `/api/admin/series/${MG}`, headers: asAdmin, payload: { hideNotices: true } });
      assert.equal(on.statusCode, 200, on.body);
      // Reintroduce by dropping refreshNoticesActive after the series PATCH (routes/admin.ts): 1.5 is still listed.
      assert.deepEqual(await numbers(MG), [1], "a series' own switch hid nothing while every type was off");
      assert.equal(noticesActive(), true);
      await app.inject({ method: 'PATCH', url: `/api/admin/series/${MG}`, headers: asAdmin, payload: { hideNotices: null } });
      assert.deepEqual(await numbers(MG), [1, 1.5]);
      assert.equal(noticesActive(), false, 'nothing hides any more, so the fragments must be constants again');
    });

    // ---- v0.55.3 (#147, TIGamingTV's switch): "Only hide short ones (3 pages or fewer)", on by default ------------------

    const setShortOnly = async (on: unknown) =>
      app.inject({ method: 'PATCH', url: '/api/admin/settings', headers: asAdmin, payload: { hideNoticeShortOnly: on } });

    await t.test('only short ones ships on, and the settings route turns it off, refreshing the rule the queries are built by', async () => {
      const { noticesShortOnly } = await import('../src/lib/noticeChapters');
      const row = (await get('/api/admin/settings', asAdmin)).json();
      assert.equal(row.hideNoticeShortOnly, true, 'the switch must ship on: v0.55.2\'s page rule');
      assert.equal(noticesShortOnly(), true);
      assert.equal((await setShortOnly('no')).statusCode, 400, 'a switch takes a boolean');
      const off = await setShortOnly(false);
      assert.equal(off.statusCode, 200, off.body);
      assert.equal(off.json().hideNoticeShortOnly, false, 'read back off');
      // Reintroduce by dropping refreshNoticesActive after the PATCH (routes/admin.ts): the rule in force is still the
      // page rule, and the next subtest's twenty-page 12.5 is still listed.
      assert.equal(noticesShortOnly(), false, 'the queries are built by the old rule');
    });

    await t.test('short only off: every chapter numbered like 12.5 of a type switched on is hidden, a range never', async () => {
      // TIGamingTV's original rule. Reintroduce by dropping the `!shortOnly` branch from bookIsNotice (lib/noticeChapters.ts):
      // the twenty-page 12.5 and the uncounted 7.5 are still listed.
      await setTypes(['manhwa']);
      try {
        assert.deepEqual(await numbers(PG), [7, 12, 44], 'every fraction goes, whatever its pages');
        assert.equal((await get(`/api/series/${PG}`, asMember)).json().booksCount, 3);
        assert.equal((await get('/api/books/b_nt_p125', asMember)).statusCode, 404, 'the twenty-page 12.5 is gone by id');
        const list = (await get(`/api/v1/series/${PG}/books?unpaged=true`, komgaKey)).json();
        assert.deepEqual(list.content.map((b: any) => b.number), [7, 12, 44], 'Mihon reads the same chapters');
        // The listed fractions go with them, the long and the uncounted alike: only 102 is missing from HW.
        // Reintroduce by dropping the branch from listedIsNotice: 102.5 and 103.5 are still missing chapters.
        const ghosts = (await get(`/api/series/${HW}/listing`, asMember)).json().content.map((g: any) => g.number);
        assert.deepEqual(ghosts, [102]);
        const a = (await get(`/api/series/${PG}`, asAdmin)).json();
        assert.equal(a.hideNoticeShortOnly, false, 'the sheet is told which rule its switch hides by');
        assert.equal(a.hiddenNotices, 5, '7.5, 8.5, 9.5, 12.5 and 44.5');
        assert.deepEqual(await numbers(MG), [1, 1.5], 'manga is still not switched on');
        // A file holding a range of chapters is never a notice, by either rule.
        await book('b_nt_prange', PG, 10.5, 2);
        await q(`UPDATE lib_books SET number_end = 11 WHERE id = 'b_nt_prange'`);
        try {
          assert.deepEqual(await numbers(PG), [7, 10.5, 12, 44], 'a short range was hidden with the fractions');
        } finally {
          await q(`DELETE FROM lib_books WHERE id = 'b_nt_prange'`);
        }
        // The sweep fetches none of SWEEP's fractions: by its listing every one is a notice now. Reintroduce by dropping
        // the branch from isListedNotice: the twenty-page 3.5 and the uncounted 4.5 are asked for.
        asked.length = 0;
        await q('DELETE FROM chapter_failures WHERE series_id = $1', [SWEEP]);
        await updateSeries(SWEEP, 10);
        assert.deepEqual([...asked].sort(), ['nt-c1', 'nt-c2', 'nt-c3'], 'a fraction was fetched while every fraction is hidden');
      } finally {
        await setTypes([]);
        await q('DELETE FROM chapter_failures WHERE series_id = $1', [SWEEP]);
      }
    });

    await t.test('short only off with no type on: nothing is hidden, and the fragments are constants', async () => {
      const { noticesActive, noticesShortOnly, noticeHidden, listedHidden, noticeBook } = await import('../src/lib/noticeChapters');
      assert.equal(noticesShortOnly(), false);
      assert.equal(noticesActive(), false, 'nothing hides');
      // The previous release's queries, whatever the rule: every fragment a constant until something hides.
      assert.deepEqual([noticeHidden('s', 'b', 'ov'), listedHidden('s', 'l'), noticeBook('b.id')], ['false', 'false', 'false']);
      assert.deepEqual(await numbers(PG), [7, 7.5, 8.5, 9.5, 12, 12.5, 44, 44.5]);
      assert.deepEqual(await numbers(HW), [99, 100, 100.1, 100.5, 101]);
      // And back on: the page rule, as before.
      assert.equal((await setShortOnly(true)).statusCode, 200);
      await setTypes(['manhwa']);
      try {
        assert.deepEqual(await numbers(PG), [7, 7.5, 9.5, 12, 12.5, 44], 'back on, the short ones only');
      } finally {
        await setTypes([]);
      }
    });

    await t.test('the type can be set by hand and cleared back to automatic', async () => {
      const put = (body: Record<string, unknown>) => app.inject({ method: 'PUT', url: `/api/admin/series/${HW}/meta`, headers: asAdmin,
        payload: { title: null, summary: null, author: null, status: null, genres: null, ...body } });
      assert.equal((await put({ seriesType: 'comic' })).statusCode, 200);
      assert.equal((await get(`/api/series/${HW}`, asAdmin)).json().seriesType, 'comic');
      // Absent leaves it, as the reading direction.
      assert.equal((await put({})).statusCode, 200);
      assert.equal((await get(`/api/series/${HW}`, asAdmin)).json().seriesType, 'comic');
      assert.equal((await put({ seriesType: null })).statusCode, 200);
      assert.equal((await get(`/api/series/${HW}`, asAdmin)).json().seriesType, 'manhwa');
    });
  } finally {
    await app.close();
    await cleanup();
    rmSync(ROOT, { recursive: true, force: true });
  }
});
