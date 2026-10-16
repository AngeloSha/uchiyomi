// Hiding a chapter number from a series (#240 by @Squeaks72, rebuilt to hide only; lib/hiddenChapters.ts): an admin
// hides a number, for everyone, and it is gone from every surface -- the chapter list and its grey rows, next and
// previous, Continue, the unread counts and badges, Updates, the Komga-compatible API, OPDS, Insights, Health's gaps and
// the reader's -- while nothing is deleted, the sweep never fetches it, and Restore brings everything back as it was.
//
// Over HTTP against the real routes, through the real sweep and the real download helper, because the rule has to hold
// on every surface at once, and the review of #240 found the one it missed in each of three places.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Static: a dynamic import of zod is another module instance, and `instanceof ZodError` would fail in the handler.
import { ZodError } from 'zod';

const DSN = process.env.TEST_DATABASE_URL;
const ROOT = DSN ? mkdtempSync(join(tmpdir(), 'yomi-hide-')) : '';
const DL = join(ROOT, 'dl');
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.DL_ROOT = DL;
  process.env.LIBRARY_ROOT = join(ROOT, 'lib');
  process.env.CACHE_DIR = join(ROOT, 'cache');
  process.env.DOWNLOAD_MIN_GAP_MS = '0';
  process.env.DOWNLOAD_PAGE_GAP_MS = '0';
  process.env.MIN_FREE_GB = '0';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const LIB = 'lib_hc';
const MAIN = 's_hc_main';    // 1 to 4 on disk, 5 and 6 only listed
const SWEEP = 's_hc_sweep';  // followed from a fake source, for the updater and the download helper
const GAPS = 's_hc_gaps';    // 1 to 10 and 12, strays at 20 and 9001, and an impossible 9002
const TWICE = 's_hc_twice';  // a chapter saved twice from two sources
const MA = 's_hc_merge_a', MB = 's_hc_merge_b';
const OV = 's_hc_override'; // a chapter renumbered by hand
const SERIES = [MAIN, SWEEP, GAPS, TWICE, MA, MB, OV];
const ADMIN = 'hc-admin', MEMBER = 'hc-member';
const SRC = 'hc-src';
/** The chapter ids the fake source was asked for pages of: what a download tried. */
const asked: string[] = [];

test('hidden chapters: gone from every surface, never fetched, nothing deleted, and back on Restore', { skip }, async (t) => {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const auth = await import('../src/lib/auth');
  const { registerAdapter } = await import('../src/lib/sources');
  const { updateSeries } = await import('../src/lib/updater');
  const { hideNumbers, unhideNumbers } = await import('../src/lib/hiddenChapters');
  const { refreshNoticesActive } = await import('../src/lib/noticeSettings');
  const Fastify = (await import('fastify')).default;
  await migrate();

  const cleanup = async () => {
    await q('DELETE FROM lib_series WHERE id = ANY($1)', [SERIES]).catch(() => {});
    await q('DELETE FROM libraries WHERE id = $1', [LIB]).catch(() => {});
    await q('DELETE FROM users WHERE username = ANY($1)', [[ADMIN, MEMBER]]).catch(() => {});
    await refreshNoticesActive().catch(() => {});
  };
  await cleanup();

  registerAdapter({
    id: SRC, name: SRC,
    async search() { return []; },
    async getSeries(sid: string) { return { sourceId: sid, source: SRC, title: sid }; },
    async listChapters() { return [1, 2, 3].map((n) => ({ number: n, title: `Chapter ${n}`, sourceId: `hc-c${n}`, pages: 20 })); },
    // Nothing downloads: what these tests read is which chapters a download TRIED.
    async getPageUrls(chId: string) { asked.push(chId); throw new Error('no pages here'); },
    async latest() { return []; },
  } as any);

  mkdirSync(join(DL, MAIN), { recursive: true });
  await q(`INSERT INTO libraries (id, name, path) VALUES ($1, 'Hidden Shelf', '/hc')`, [LIB]);
  const series = (id: string, count: number, extra = '') =>
    q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, latest_mtime, created_at${extra ? ', source_id, source_series_id, auto_update' : ''})
       VALUES ($1, 'T!hc', $1, $1, $2, $3, 1, now()${extra ? `, '${SRC}', 'hc-1', true` : ''})`, [id, count, LIB]);
  const book = (id: string, sid: string, n: number, o: { pages?: number; source?: string; mtime?: number } = {}) =>
    q(`INSERT INTO lib_books (id, series_id, source, file, number, title, pages, root, source_id, mtime)
       VALUES ($1, $2, 'T!hc', $3, $4, $5, $6, $7, $8, $9)`,
      [id, sid, `${sid}/${id}.cbz`, n, `Chapter ${n}`, o.pages ?? 20, DL, o.source ?? null, o.mtime ?? 0]);
  const listed = (sid: string, n: number) =>
    q(`INSERT INTO series_listing (series_id, number, title, source_id, chosen, status, copies)
       VALUES ($1, $2, $3, 'src', '{}'::jsonb, 'available', '[]'::jsonb)`, [sid, n, `Chapter ${n}`]);

  await series(MAIN, 4);
  for (const n of [1, 2, 3, 4]) await book(`b_hc_${n}`, MAIN, n);
  // A real file behind chapter 3, to show the hide leaves it where it is.
  writeFileSync(join(DL, MAIN, 'b_hc_3.cbz'), 'pages');
  for (const n of [1, 2, 3, 4, 5, 6]) await listed(MAIN, n);
  await series(SWEEP, 0, 'followed');

  const admin = (await q<{ id: string }>(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ($1, $1, 'x', 'admin', 'password') RETURNING id`, [ADMIN]))[0].id;
  const member = (await q<{ id: string }>(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ($1, $1, 'x', 'user', 'password') RETURNING id`, [MEMBER]))[0].id;
  // The member has read 1 and 2, and is part-way through 3, the chapter they opened last.
  await q(`INSERT INTO read_progress (user_id, book_id, series_id, page, completed, updated_at) VALUES
             ($1, 'b_hc_1', $2, 20, true, now() - interval '3 hours'), ($1, 'b_hc_2', $2, 20, true, now() - interval '3 hours'),
             ($1, 'b_hc_3', $2, 4, false, now() - interval '1 hour')`, [member, MAIN]);

  const app = Fastify();
  app.setErrorHandler((err: any, _req: any, reply: any) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: 'bad_request' });
    return reply.code(err.statusCode || 500).send({ error: err.message || 'error' });
  });
  await app.register((await import('@fastify/cookie')).default);
  await app.register((await import('@fastify/jwt')).default, { secret: process.env.JWT_SECRET! });
  await app.register((await import('@fastify/rate-limit')).default, { global: false });
  await app.register((await import('../src/routes/catalog')).default);
  await app.register((await import('../src/routes/admin')).default);
  await app.register((await import('../src/routes/sources')).default);
  await app.register((await import('../src/routes/komgaCompat')).default);
  await app.register((await import('../src/routes/opds')).default);
  await app.register((await import('../src/routes/personal')).default);
  await app.ready();
  const asAdmin = { authorization: `Bearer ${app.jwt.sign({ sub: admin, role: 'admin' })}` };
  const asMember = { authorization: `Bearer ${app.jwt.sign({ sub: member, role: 'user' })}` };
  const komgaKey = { 'x-api-key': (await auth.issueApiToken(member, 'hc', ['read'], null)).token };
  const opds = { authorization: 'Basic ' + Buffer.from(`${MEMBER}:${await auth.issueOpdsToken(member)}`).toString('base64') };
  let seq = 0;
  const call = (method: 'GET' | 'POST', url: string, headers: Record<string, string>, payload?: unknown) =>
    app.inject({ method, url, headers, remoteAddress: `10.83.0.${++seq & 255}`, ...(payload === undefined ? {} : { payload: payload as any }) });
  const get = (url: string, headers: Record<string, string> = asMember) => call('GET', url, headers);
  const numbers = async (sid: string, headers = asMember) =>
    (await get(`/api/series/${sid}/books?size=500`, headers)).json().content.map((b: any) => b.number);
  const ghosts = async (sid: string) => (await get(`/api/series/${sid}/listing`)).json().content.map((g: any) => g.number);
  const hide = (sid: string, payload: unknown, headers = asAdmin) => call('POST', `/api/admin/series/${sid}/chapters/hide`, headers, payload);
  const unhide = (sid: string, payload: unknown, headers = asAdmin) => call('POST', `/api/admin/series/${sid}/chapters/unhide`, headers, payload);

  try {
    await t.test('a hidden chapter is gone from every surface, nothing is deleted, and Restore brings all of it back', async () => {
      assert.deepEqual(await numbers(MAIN), [1, 2, 3, 4]);
      assert.deepEqual(await ghosts(MAIN), [5, 6]);
      const deck = async () => (await get('/api/home')).json().onDeck.map((b: any) => b.id);
      assert.deepEqual(await deck(), ['b_hc_3'], 'Continue offers the chapter the member is part-way through');
      // Profile → Insights lists a series once it has a recorded read; and the reader's "chapters missing here" (#236).
      await q(`INSERT INTO reading_events (user_id, series_id, book_id, page, completed) VALUES
                 ($1, $2, 'b_hc_1', 20, true), ($1, $2, 'b_hc_2', 20, true)`, [member, MAIN]);
      const insight = async () => {
        const i = (await get('/api/stats/insights')).json().series.find((x: any) => x.id === MAIN);
        return [i?.total, i?.read];
      };
      const gaps = async () => (await get(`/api/series/${MAIN}/gaps`)).json().gaps;
      assert.deepEqual(await insight(), [4, 2]);
      assert.deepEqual(await gaps(), []);

      const r = await hide(MAIN, { numbers: [3, 6] });
      assert.equal(r.statusCode, 200, r.body);
      assert.deepEqual(r.json(), { ok: true, hidden: [3, 6] });

      // The chapter list, by id, next and previous: chapter 3 is no chapter of the series now, for anyone.
      assert.deepEqual(await numbers(MAIN), [1, 2, 4]);
      assert.deepEqual(await numbers(MAIN, asAdmin), [1, 2, 4], 'admins included');
      assert.equal((await get('/api/books/b_hc_3')).statusCode, 404, 'a hidden chapter is not there by id');
      assert.equal((await get('/api/books/b_hc_2/next')).json().id, 'b_hc_4', 'next skips it');
      // The grey row of the listed 6 goes too; the listing keeps it, which is what Restore relies on.
      assert.deepEqual(await ghosts(MAIN), [5]);
      // Unread counts and badges: the member read 1 and 2, so one chapter is left, not two.
      const s = (await get(`/api/series/${MAIN}`)).json();
      assert.deepEqual([s.booksCount, s.booksReadCount, s.booksUnreadCount], [3, 2, 1]);
      // Continue: the chapter they were part-way through is hidden, so it offers the next one.
      assert.deepEqual(await deck(), ['b_hc_4'], 'Continue offers a hidden chapter, or nothing');
      // Mihon, through the Komga-compatible API, and an e-reader through OPDS.
      assert.deepEqual((await get(`/api/v1/series/${MAIN}/books?unpaged=true`, komgaKey)).json().content.map((b: any) => b.number), [1, 2, 4]);
      assert.equal((await get(`/api/v1/series/${MAIN}`, komgaKey)).json().booksCount, 3);
      const feed = await get(`/opds/series/${MAIN}`, opds);
      assert.equal(feed.statusCode, 200, feed.body);
      assert.deepEqual([...feed.body.matchAll(/<id>yomi:book:([^<]+)<\/id>/g)].map((m) => m[1]), ['b_hc_1', 'b_hc_2', 'b_hc_4']);
      // Insights counts the chapters the series has now (noticeBook), and the reader, moving from 2 to 4, is not told
      // that 3 is missing (haveNumbers). Reintroduce by returning `held` alone from haveNumbers: the gap 3-3 comes back.
      assert.deepEqual(await insight(), [3, 2], 'Insights counts a hidden chapter');
      assert.deepEqual(await gaps(), [], 'the reader calls a hidden chapter missing');

      // Nothing was deleted: the file, its row and the member's place in it are all where they were.
      assert.ok(existsSync(join(DL, MAIN, 'b_hc_3.cbz')), 'the hide deleted the file');
      assert.equal((await q(`SELECT pruned_at FROM lib_books WHERE id = 'b_hc_3'`))[0]?.pruned_at, null, 'the row is untouched');
      assert.equal((await q(`SELECT page FROM read_progress WHERE book_id = 'b_hc_3'`))[0]?.page, 4, 'and so is the reading progress');
      assert.equal((await q(`SELECT count(*)::int AS n FROM series_listing WHERE series_id = $1 AND number = 6`, [MAIN]))[0].n, 1);

      // What the admin is told: the count on the series, and what each hidden number is.
      assert.equal((await get(`/api/series/${MAIN}`, asAdmin)).json().hiddenChapters, 2);
      assert.equal(s.hiddenChapters, undefined, 'a member is not told what is hidden');
      const list = (await get(`/api/admin/series/${MAIN}/chapters/hidden`, asAdmin)).json().content;
      assert.deepEqual(list.map((h: any) => [h.number, h.onServer, h.listed]), [[3, 1, true], [6, 0, true]]);

      // Restore: every surface at once, the next request, with nothing to re-fetch or re-check.
      // Reintroduce by deleting the listing row on hide (#240's way): 6 is not a grey row again until the next check.
      const back = await unhide(MAIN, { all: true });
      assert.equal(back.statusCode, 200, back.body);
      assert.deepEqual(back.json(), { ok: true, restored: [3, 6] });
      assert.deepEqual(await numbers(MAIN), [1, 2, 3, 4]);
      assert.deepEqual(await ghosts(MAIN), [5, 6]);
      assert.equal((await get('/api/books/b_hc_3')).statusCode, 200);
      const again = (await get(`/api/series/${MAIN}`)).json();
      assert.deepEqual([again.booksCount, again.booksUnreadCount], [4, 2]);
      assert.deepEqual(await deck(), ['b_hc_3'], 'Continue is back where the member left off');
      assert.deepEqual(await insight(), [4, 2]);
      assert.equal((await get(`/api/series/${MAIN}`, asAdmin)).json().hiddenChapters, 0);
    });

    await t.test('Updates: a chapter that lands at a hidden number is not new, and Restore makes it so', async () => {
      await q(`INSERT INTO favorites (user_id, series_id) VALUES ($1, $2)`, [member, MAIN]);
      const updates = async () => (await get('/api/updates')).json().content.map((u: any) => [u.series.id, u.newCount]);
      const land = async (id: string, n: number) => {
        await book(id, MAIN, n);
        await q('UPDATE lib_series SET books_count = books_count + 1 WHERE id = $1', [MAIN]);
      };
      try {
        assert.equal((await call('POST', '/api/updates/seen', asMember)).statusCode, 200);
        await hideNumbers(MAIN, [7], { userId: admin });
        // Reintroduce by gating lib/enrich.ts newSinceSeen on the notices alone (noticesActive): the hidden 7 is new.
        await land('b_hc_7', 7);
        assert.deepEqual(await updates(), [], 'a chapter at a hidden number is announced as new');
        await land('b_hc_8', 8);
        assert.deepEqual(await updates(), [[MAIN, 1]], 'the next real chapter is');
        assert.equal((await get('/api/home')).json().updatesCount, 1, "Home's badge disagrees with Updates");
        await unhideNumbers(MAIN, [7], { userId: admin });
        assert.deepEqual(await updates(), [[MAIN, 2]], 'restored, it came since the last look like the other');
      } finally {
        await q(`DELETE FROM lib_books WHERE id = ANY($1)`, [['b_hc_7', 'b_hc_8']]);
        await q('UPDATE lib_series SET books_count = 4 WHERE id = $1', [MAIN]);
        await q(`DELETE FROM favorites WHERE user_id = $1`, [member]);
        await q(`DELETE FROM series_seen WHERE user_id = $1`, [member]);
        await unhideNumbers(MAIN, 'all', { userId: admin });
      }
    });

    await t.test('the sweep never fetches a hidden number, and the one after Restore does', async () => {
      await hideNumbers(SWEEP, [2], { userId: admin });
      asked.length = 0;
      await updateSeries(SWEEP, 10);
      assert.deepEqual([...asked].sort(), ['hc-c1', 'hc-c3'], 'the hidden 2 was asked for');
      const s = (await q<{ source_chapters: number; source_missing: number }>('SELECT source_chapters, source_missing FROM lib_series WHERE id = $1', [SWEEP]))[0];
      assert.deepEqual([s.source_chapters, s.source_missing], [2, 2], 'the hidden 2 counted as listed, or as behind');
      // Kept in the listing, so Restore shows its grey row at once and the next sweep fetches it.
      const kept = await q<{ number: number }>('SELECT number FROM series_listing WHERE series_id = $1 ORDER BY number', [SWEEP]);
      assert.deepEqual(kept.map((r) => Number(r.number)), [1, 2, 3]);
      assert.deepEqual(await ghosts(SWEEP), [1, 3]);
      await unhideNumbers(SWEEP, [2], { userId: admin });
      await q('DELETE FROM chapter_failures WHERE series_id = $1', [SWEEP]);
      asked.length = 0;
      await updateSeries(SWEEP, 10);
      assert.ok(asked.includes('hc-c2'), 'restored, the next sweep fetches it');
      await q('DELETE FROM chapter_failures WHERE series_id = $1', [SWEEP]);
    });

    await t.test('a download queued before the hide never reaches the source', async () => {
      const { downloadWithFallback } = await import('../src/lib/chapterFallback');
      const input = (n: number, admit?: () => Promise<boolean>) => ({
        seriesId: SWEEP, title: SWEEP, folder: SWEEP, meta: { series: SWEEP },
        chapter: { number: n, title: `Chapter ${n}`, sourceId: `hc-c${n}`, source: SRC },
        alternates: async () => [], refusing: new Set<string>(), ...(admit ? { admit } : {}),
      });
      try {
        // The ledger's tries at a number go with the hide: nothing tries it again, so Health would carry it for good.
        // Reintroduce by keeping them (drop the DELETE in lib/hiddenChapters.ts hideNumbers): 1 row.
        await q(`INSERT INTO chapter_failures (series_id, number, source_id, status, attempts) VALUES ($1, 1, $2, 'error', 2)`, [SWEEP, SRC]);
        // Hidden while it waited in the queue: the helper's first look.
        await hideNumbers(SWEEP, [1], { userId: admin });
        assert.equal((await q(`SELECT count(*)::int AS n FROM chapter_failures WHERE series_id = $1`, [SWEEP]))[0].n, 0, 'a hidden number kept its ledger rows');
        asked.length = 0;
        assert.deepEqual(await downloadWithFallback(input(1) as any), { kind: 'skipped', why: 'hidden' });
        // Hidden at the last moment, while it waited for the source's slot: the look at the door (the preflight).
        let hid = false;
        const out = await downloadWithFallback(input(3, async () => {
          if (!hid) { hid = true; await hideNumbers(SWEEP, [3], { userId: admin }); }
          return true;
        }) as any);
        assert.deepEqual(out, { kind: 'skipped', why: 'hidden' });
        assert.deepEqual(asked, [], 'a hidden number reached the source');
        // A failure noted after the hide -- a download that was already under way -- earns no ledger row either.
        // Reintroduce by writing it whatever the number (lib/chapterFailures.ts): 1 row.
        const { noteChapterFailure } = await import('../src/lib/chapterFailures');
        await noteChapterFailure({ seriesId: SWEEP, title: SWEEP, number: 3, sourceId: SRC, err: new Error('no pages here') });
        assert.equal((await q(`SELECT count(*)::int AS n FROM chapter_failures WHERE series_id = $1`, [SWEEP]))[0].n, 0, 'a hidden number earned a ledger row');
      } finally {
        await unhideNumbers(SWEEP, 'all', { userId: admin });
      }
    });

    await t.test('a fetch of a hidden number is skipped as hidden', async () => {
      await hideNumbers(SWEEP, [2], { userId: admin });
      try {
        asked.length = 0;
        const r = await call('POST', '/api/sources/fetch', asAdmin, { seriesId: SWEEP, numbers: [2] });
        assert.equal(r.statusCode, 409, r.body);
        assert.equal(r.json().error, 'nothing_to_fetch', 'a job was started for it');
        assert.deepEqual(r.json().skipped, [{ number: 2, reason: 'hidden' }]);
        assert.match(r.json().message, /hidden/);
        // Beside a number that is fetchable, the job starts for that one alone.
        const both = await call('POST', '/api/sources/fetch', asAdmin, { seriesId: SWEEP, numbers: [1, 2] });
        assert.equal(both.statusCode, 200, both.body);
        assert.deepEqual([both.json().total, both.json().skipped], [1, [{ number: 2, reason: 'hidden' }]]);
        // The job runs on its own: let it end (its one chapter fails, the fake source serves no pages) before the next.
        const { jobBusy } = await import('../src/routes/sources');
        for (let i = 0; i < 100 && jobBusy(SWEEP); i++) await new Promise((r) => setTimeout(r, 100));
        assert.equal(jobBusy(SWEEP), false, 'the job never ended');
        assert.deepEqual(asked, ['hc-c1'], 'the job asked for the hidden 2');
        await q('DELETE FROM chapter_failures WHERE series_id = $1', [SWEEP]);
      } finally {
        await unhideNumbers(SWEEP, 'all', { userId: admin });
      }
    });

    await t.test('Health: a hidden number between two chapters is no gap, and a hidden chapter is neither held nor missing', async () => {
      const { haveNumbers, plausibleNumbers } = await import('../src/lib/libraryNumbers');
      const { gapsOf } = await import('../src/lib/fill');
      const { runHealthChecks } = await import('../src/lib/health');
      await series(GAPS, 15);
      for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 20, 9001, 9002]) await book(`b_hc_g${n}`, GAPS, n);
      const holes = async () => gapsOf(plausibleNumbers(await haveNumbers(GAPS))).map((g) => [g.lo, g.hi]);
      const card = async (id: string) => (await runHealthChecks()).checks.find((c) => c.id === id)?.items.filter((i) => i.seriesId === GAPS) ?? [];
      assert.deepEqual(await holes(), [[11, 11], [13, 19]]);
      assert.deepEqual((await card('outliers'))[0]?.bookIds?.slice().sort(), ['b_hc_g9001', 'b_hc_g9002'], 'two impossible numbers');
      // 11 is a stray the source lists, 20 and 9001 are strays on disk; 9002 stays.
      await hideNumbers(GAPS, [11, 20, 9001], { userId: admin });
      // Reintroduce by returning HAVE_SQL alone from haveNumbers: 11 is a gap again. Reintroduce by taking every hidden
      // number, or by dropping the clause from HAVE_SQL (lib/libraryNumbers.ts) that leaves the hidden file at 20 out:
      // 13-19 is a gap the hide made up, or a hidden chapter's file kept.
      assert.deepEqual(await holes(), [], 'a hidden number is a gap, or made one');
      assert.deepEqual(await card('chapter-gaps'), []);
      // The impossible number left is still a finding, but its Delete names the hidden 9001 no more. Reintroduce by
      // dropping the card's own clause (outlierChapters in lib/health.ts): its Delete would take a chapter nobody sees.
      assert.deepEqual((await card('outliers'))[0]?.bookIds, ['b_hc_g9002'], 'the outliers card offers to delete a hidden chapter');
      await unhideNumbers(GAPS, [11], { userId: admin });
      assert.deepEqual(await holes(), [[11, 11]], 'restored, the hole is a gap again');
    });

    await t.test('nothing deletes a hidden chapter: the read-chapter cleanup, the saved-twice list and the Chapter files card leave it alone', async () => {
      const { dueCount } = await import('../src/lib/chapterCleanup');
      const { savedTwiceGroups } = await import('../src/lib/health');
      // Read to the end by everyone who opened it, long enough ago: the cleanup's to delete.
      await q(`INSERT INTO read_progress (user_id, book_id, series_id, page, completed, updated_at)
               VALUES ($1, 'b_hc_4', $2, 20, true, now() - interval '3 days')`, [member, MAIN]);
      await series(TWICE, 2);
      await book('b_hc_t5a', TWICE, 5, { source: 'hc-a', mtime: 1000 });
      await book('b_hc_t5b', TWICE, 5, { source: 'hc-b', mtime: 2000 });
      const twice = async () => (await savedTwiceGroups()).filter((g) => g.seriesId === TWICE).map((g) => g.groups.map((x) => x.whole));
      // The earlier copy turned out unreadable when the nightly count opened it: Health's Chapter files card, whose way out
      // is Fetch again.
      await q(`UPDATE lib_books SET pages = 0, pages_checked_at = now() WHERE id = 'b_hc_t5a'`);
      const { chapterFiles } = await import('../src/lib/healthFiles');
      const unreadable = async () => (await chapterFiles()).items.filter((i) => i.seriesId === TWICE).length;
      try {
        assert.equal(await dueCount(1), 1);
        assert.deepEqual(await twice(), [[5]], 'Fix everything would delete the later copy');
        assert.equal(await unreadable(), 1, 'the unreadable copy is on the Chapter files card');
        await hideNumbers(MAIN, [4], { userId: admin });
        await hideNumbers(TWICE, [5], { userId: admin });
        // Reintroduce by dropping the clause from the cleanup's dueSql (lib/chapterCleanup.ts): 1.
        assert.equal(await dueCount(1), 0, 'the cleanup would delete a hidden chapter');
        // Reintroduce by dropping it from savedTwiceGroups (lib/health.ts): Fix everything deletes a hidden copy.
        assert.deepEqual(await twice(), [], 'Fix everything would delete a hidden chapter');
        // Reintroduce by dropping it from the card's query (lib/healthFiles.ts): it offers to replace a hidden chapter.
        assert.equal(await unreadable(), 0, 'the Chapter files card offers Fetch again on a hidden chapter');
      } finally {
        await unhideNumbers(MAIN, 'all', { userId: admin });
        await q(`DELETE FROM read_progress WHERE book_id = 'b_hc_4'`);
      }
    });

    await t.test('a merged series keeps the hide', async () => {
      const { mergeSeries } = await import('../src/lib/libraryAdmin');
      await series(MA, 3);
      await series(MB, 2);
      for (const n of [1, 2, 3]) await book(`b_hc_a${n}`, MA, n);
      for (const n of [1, 4]) await book(`b_hc_b${n}`, MB, n);
      await hideNumbers(MA, [3], { userId: admin });
      await hideNumbers(MB, [4], { userId: admin });
      const r = await mergeSeries(MA, MB);
      assert.equal(r.ok, true);
      // The absorbed series' 3 came along with its number, and stays hidden there; the survivor's own 4 stays hidden.
      // Reintroduce by dropping carryHidden from mergeSeries (lib/libraryAdmin.ts): 3 is listed under the survivor.
      assert.deepEqual(await numbers(MB), [1, 1, 2], 'the merge showed a hidden chapter');
      const kept = (await q<{ hidden: number[] }>('SELECT hidden_numbers AS hidden FROM lib_series WHERE id = $1', [MB]))[0].hidden;
      assert.deepEqual(kept.map(Number), [3, 4]);
      // A series merged away is refused: its chapters, and its hidden numbers, are the survivor's now.
      const merged = await hide(MA, { numbers: [2] });
      assert.equal(merged.statusCode, 409, merged.body);
      assert.equal(merged.json().error, 'merged');
    });

    await t.test('the routes: an admin\'s, bounded, said once, and audited', async () => {
      assert.equal((await hide(MAIN, { numbers: [2] }, asMember)).statusCode, 403, 'a member hid a chapter');
      assert.equal((await get(`/api/admin/series/${MAIN}/chapters/hidden`, asMember)).statusCode, 403);
      for (const bad of [{}, { numbers: [] }, { numbers: [-1] }, { numbers: ['2'] }, { numbers: Array.from({ length: 501 }, (_, i) => i) }]) {
        assert.equal((await hide(MAIN, bad)).statusCode, 400, JSON.stringify(bad).slice(0, 60));
      }
      assert.equal((await unhide(MAIN, { numbers: [2], all: true })).statusCode, 400, 'both, or neither, is one too many');
      assert.equal((await unhide(MAIN, {})).statusCode, 400);
      assert.equal((await hide('s_hc_nowhere', { numbers: [2] })).statusCode, 404);
      assert.equal((await get('/api/admin/series/s_hc_nowhere/chapters/hidden', asAdmin)).statusCode, 404);
      // A number hidden already is said once: the second press hides nothing new.
      assert.deepEqual((await hide(MAIN, { numbers: [2, 2] })).json(), { ok: true, hidden: [2] });
      assert.deepEqual((await hide(MAIN, { numbers: [2] })).json(), { ok: true, hidden: [] });
      assert.deepEqual((await unhide(MAIN, { numbers: [2, 9] })).json(), { ok: true, restored: [2] });
      const audit = await q<{ event: string; numbers: number[] }>(
        `SELECT event, detail->'numbers' AS numbers FROM audit_log WHERE detail->>'id' = $1 AND event LIKE 'series.chapters_%hide' ORDER BY id DESC LIMIT 2`, [MAIN]);
      assert.deepEqual(audit.map((a) => [a.event, a.numbers]), [['series.chapters_unhide', [2]], ['series.chapters_hide', [2]]]);
    });

    await t.test('a chapter is hidden by its effective number: an override\'s when there is one', async () => {
      // The series' count less its hidden chapters is two counts (lib/noticeChapters.ts hiddenBookCount): the files whose
      // own number is hidden, and the ones an override puts on a hidden number. Reintroduce by counting the file's own
      // number alone: the series reads one chapter more than it lists.
      await series(OV, 3);
      for (const n of [1, 2, 3]) await book(`b_hc_o${n}`, OV, n);
      // Chapter 2's file was renumbered by hand to 7.
      await q(`INSERT INTO book_overrides (book_id, number) VALUES ('b_hc_o2', 7)`);
      const count = async () => (await get(`/api/series/${OV}`)).json().booksCount;
      await hideNumbers(OV, [7], { userId: admin });
      assert.deepEqual([await numbers(OV), await count()], [[1, 3], 2], 'the chapter renumbered to a hidden 7 still shows');
      // Its file's own number hides nothing once an override moved it: hiding 2 hides no chapter.
      await unhideNumbers(OV, 'all', { userId: admin });
      await hideNumbers(OV, [2], { userId: admin });
      assert.deepEqual([await numbers(OV), await count()], [[1, 3, 7], 3], "a file's old number hid the chapter it no longer is");
      await unhideNumbers(OV, 'all', { userId: admin });
    });
    await t.test('the hide fragments read the hidden chapters once, and keep the notice lookup an anti-join', async () => {
      // Priced, not timed: these are the shapes that kept a 50,000-chapter library's Library grid and Continue reading
      // fast (#240's review, on a copy of it). Read once, the hidden chapters are an InitPlan; written as a correlated
      // EXISTS they were an anti-join over every chapter of the library (Library: 6 ms to 160 ms) -- reintroduce that in
      // hiddenBookIds (lib/noticeChapters.ts) and "read once" finds no InitPlan. With the notice switches on too, the
      // hand test sits inside the notice EXISTS: beside it, `NOT (EXISTS .. OR ..)` cannot be an anti-join, and
      // Continue reading was priced past jit_inline_above_cost -- reintroduce the OR and "an anti-join" fails.
      const { tx } = await import('../src/lib/db');
      const { noticeBook } = await import('../src/lib/noticeChapters');
      const rollup = () => `SELECT series_id, count(*) FROM read_progress WHERE NOT ${noticeBook('read_progress.book_id')} GROUP BY series_id`;
      const plan = (sql: string) => tx(async (qq) => (await qq(`EXPLAIN ${sql}`)).map((r: any) => r['QUERY PLAN']).join('\n'));
      /** The notice lookup's place in the plan: the nodes from the top down to its scan of lib_books (`nb_nt`). */
      const lookup = async (sql: string) => {
        const top = (await q<any>(`EXPLAIN (FORMAT JSON) ${sql}`))[0]['QUERY PLAN'][0].Plan;
        const find = (n: any, trail: any[]): any[] | null => {
          if (n.Alias === 'nb_nt') return [...trail, n];
          for (const c of n.Plans ?? []) { const f = find(c, [...trail, n]); if (f) return f; }
          return null;
        };
        return find(top, []) ?? [];
      };
      await hideNumbers(MAIN, [2], { userId: admin });
      try {
        const once = await plan(rollup());
        assert.match(once, /InitPlan/, `the hidden chapters are not read once:\n${once}`);
        await q(`UPDATE server_settings SET hide_notice_types = '["manhwa"]'::jsonb WHERE id = 1`);
        await refreshNoticesActive();
        const path = await lookup(rollup());
        const shown = path.map((n) => `${n['Node Type']}${n['Join Type'] ? ` ${n['Join Type']}` : ''}${n['Parent Relationship'] ? ` (${n['Parent Relationship']})` : ''}`).join(' > ');
        assert.ok(path.length, 'the notice lookup is not in the plan');
        assert.ok(!path.some((n) => n['Parent Relationship'] === 'SubPlan'), `the notice lookup runs once per row: ${shown}`);
        assert.ok(path.some((n) => /Anti/.test(n['Join Type'] ?? '')), `the notice lookup is no longer an anti-join: ${shown}`);
      } finally {
        await q(`UPDATE server_settings SET hide_notice_types = '[]'::jsonb WHERE id = 1`);
        await unhideNumbers(MAIN, 'all', { userId: admin });
        await refreshNoticesActive();
      }
    });
  } finally {
    await app.close();
    await cleanup();
    rmSync(ROOT, { recursive: true, force: true });
  }
});
