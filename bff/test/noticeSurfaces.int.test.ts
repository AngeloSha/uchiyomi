// Notice chapters (lib/noticeChapters.ts) on the surfaces noticeChapters.int.test.ts does not reach: each one is
// driven with every switch off -- where it must be exactly what v0.55.1 served -- and with its series' type switched
// on, where the short notice is gone and nothing else is.
//
// The review removed the rule from six of these places at once and the suite stayed green. Over HTTP against the
// real routes, with real archives on disk, because some of them hand out bytes.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Static: a dynamic import of zod is another module instance, and `instanceof ZodError` would fail in the handler.
import { ZodError } from 'zod';

const DSN = process.env.TEST_DATABASE_URL;
const TMP = DSN ? mkdtempSync(join(tmpdir(), 'yomi-nts-')) : '';
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.CACHE_DIR = join(TMP, 'cache');
  process.env.LIBRARY_BACKEND = 'owned';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const LIB = 'lib_nts';
const S = 's_nts_main';
const USER = 'nts-reader';
/** id -> [number, stored page count]. 2.5 is the notice: two pages. b_nts_9's file says 9; the admin renumbered it to 0. */
const BOOKS: Record<string, [number, number]> = {
  b_nts_1: [1, 20], b_nts_2: [2, 20], b_nts_25: [2.5, 2], b_nts_3: [3, 20], b_nts_9: [9, 20],
};
const basic = (u: string, p: string) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');
/** The book ids of an OPDS acquisition feed, in the order it lists them. */
const feedIds = (xml: string) => [...xml.matchAll(/<id>yomi:book:([^<]+)<\/id>/g)].map((m) => m[1]);

test('notice chapters, surface by surface: unchanged with every switch off, the notice gone when on', { skip }, async (t) => {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const auth = await import('../src/lib/auth');
  const { refreshNoticesActive } = await import('../src/lib/noticeSettings');
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const sharp = (await import('sharp')).default;
  const AdmZip = require('adm-zip');
  await migrate();

  /** Every switch, as the routes write them, and the in-process flag the routes refresh after writing. */
  const hide = async (types: string[]) => {
    await q(`UPDATE server_settings SET hide_notice_types = $1::jsonb WHERE id = 1`, [JSON.stringify(types)]);
    await refreshNoticesActive();
  };
  const cleanup = async () => {
    await q('DELETE FROM lib_series WHERE id = $1', [S]).catch(() => {});
    await q('DELETE FROM libraries WHERE id = $1', [LIB]).catch(() => {});
    await q('DELETE FROM users WHERE username = $1', [USER]).catch(() => {});
    // Shared database: a list left behind would hide chapters in every later suite.
    await q(`UPDATE server_settings SET hide_notice_short_only = true WHERE id = 1`).catch(() => {});
    await hide([]).catch(() => {});
  };
  await cleanup();

  // Real archives, two pages each: the stored page count is what the notice rule reads, the bytes what is served.
  const png = await sharp({ create: { width: 300, height: 400, channels: 3, background: '#335577' } }).png().toBuffer();
  mkdirSync(join(TMP, 'lib'), { recursive: true });
  await q(`INSERT INTO libraries (id, name, path) VALUES ($1, 'Notice Surfaces', '/nts')`, [LIB]);
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, genres, series_type, series_type_from, latest_mtime, created_at)
           VALUES ($1, 'T!nts', 'Notice Surfaces', $1, $2, $3, '{Manhwa}', 'manhwa', 'genre', 1, now())`, [S, Object.keys(BOOKS).length, LIB]);
  for (const [id, [n, pages]] of Object.entries(BOOKS)) {
    const z = new AdmZip();
    z.addFile('001.png', png);
    z.addFile('002.png', png);
    writeFileSync(join(TMP, 'lib', `${id}.cbz`), z.toBuffer());
    // No title, so OPDS labels each entry by its number.
    await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, pages, root)
             VALUES ($1, $2, 'T!nts', $3, $4, NULL, $5, $6)`, [id, S, `${id}.cbz`, n, pages, join(TMP, 'lib')]);
  }
  await q(`INSERT INTO book_overrides (book_id, number) VALUES ('b_nts_9', 0)`);
  // What the sources list beyond the shelf: 5 and 6, twenty pages each, and the two-page notice 5.5 between them.
  for (const [n, pages] of [[5, 20], [5.5, 2], [6, 20]]) {
    await q(`INSERT INTO series_listing (series_id, number, title, source_id, chosen, status, copies)
             VALUES ($1, $2, $3, 'src', '{}'::jsonb, 'available', $4::jsonb)`, [S, n, `Chapter ${n}`,
      JSON.stringify([{ sourceId: `nts-${n}`, source: 'src', groups: [], scanlator: null, lang: null, pages, publishedAt: null }])]);
  }
  const uid = (await q<{ id: string }>(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ($1, $1, 'x', 'user', 'password') RETURNING id`, [USER]))[0].id;

  const app = Fastify();
  await app.register((await import('@fastify/cookie')).default);
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register((await import('@fastify/rate-limit')).default, { global: false });
  app.setErrorHandler((err: any, _req: any, reply: any) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: 'bad_request' });
    return reply.code(err.statusCode || 500).send({ error: err.message || 'error' });
  });
  await app.register((await import('../src/routes/opds')).default);
  await app.register((await import('../src/routes/catalog')).default);
  await app.register((await import('../src/routes/images')).default);
  await app.register((await import('../src/routes/personal')).default);
  await app.register((await import('../src/routes/komgaCompat')).default);
  await app.ready();
  const opds = { authorization: basic(USER, await auth.issueOpdsToken(uid)) };
  const komgaKey = { 'x-api-key': (await auth.issueApiToken(uid, 'nts', ['read'], null)).token };
  const asUser = { authorization: `Bearer ${app.jwt.sign({ sub: uid, role: 'user' })}` };
  let seq = 0;
  const get = (url: string, headers: Record<string, string>) =>
    app.inject({ method: 'GET', url, headers, remoteAddress: `10.82.0.${++seq & 255}` });
  /** A chapter landing as a scan lands it: the row, and the series' stored count of rows. */
  const land = async (id: string, n: number, pages: number) => {
    await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, pages, root) VALUES ($1, $2, 'T!nts', $3, $4, NULL, $5, $6)`,
      [id, S, `${id}.cbz`, n, pages, join(TMP, 'lib')]);
    await q(`UPDATE lib_series SET books_count = books_count + 1 WHERE id = $1`, [S]);
  };
  const unland = async (ids: string[]) => {
    const gone = await q(`DELETE FROM lib_books WHERE id = ANY($1) RETURNING id`, [ids]);
    await q(`UPDATE lib_series SET books_count = books_count - $2 WHERE id = $1`, [S, gone.length]);
  };

  try {
    await t.test('OPDS: off, the chapter feed is v0.55.1\'s -- every chapter, by the number on the file; on, the notice goes', async () => {
      const off = await get(`/opds/series/${S}`, opds);
      assert.equal(off.statusCode, 200, off.body);
      // The file numbered 9 that the admin renumbered to 0 is listed where the file's number puts it, as it always
      // was. Reintroduce the renumber (COALESCE(ov.number, b.number) in the SELECT and the ORDER BY): it moves first
      // and reads "Chapter 0".
      assert.deepEqual(feedIds(off.body), ['b_nts_1', 'b_nts_2', 'b_nts_25', 'b_nts_3', 'b_nts_9'], 'OPDS changed its order with every switch off');
      assert.match(off.body, /<title>Chapter 9<\/title>/, 'OPDS changed a chapter\'s number with every switch off');
      await hide(['manhwa']);
      const on = await get(`/opds/series/${S}`, opds);
      assert.deepEqual(feedIds(on.body), ['b_nts_1', 'b_nts_2', 'b_nts_3', 'b_nts_9'], 'the two-page 2.5 is still in the OPDS feed');
      await hide([]);
    });

    await t.test('page bytes: off, a notice serves its pages on both routes; on, neither does, and nothing else changes', async () => {
      const img = (id: string) => get(`/img/lib/books/${id}/page/1`, opds);
      const pse = (id: string) => get(`/opds/book/${id}/page/0`, opds);
      assert.deepEqual([(await img('b_nts_25')).statusCode, (await pse('b_nts_25')).statusCode], [200, 200],
        "with every switch off the notice's pages are served");
      await hide(['manhwa']);
      try {
        // Reintroduce by dropping the notice clause from visibleBookFile (lib/visibility.ts): both still serve it.
        assert.deepEqual([(await img('b_nts_25')).statusCode, (await pse('b_nts_25')).statusCode], [404, 404],
          'a hidden notice still hands out its pages');
        assert.deepEqual([(await img('b_nts_2')).statusCode, (await pse('b_nts_2')).statusCode], [200, 200]);
      } finally {
        await hide([]);
      }
    });

    await t.test('history: off, a notice read is in it; on, it is not', async () => {
      await q(`INSERT INTO reading_events (user_id, series_id, book_id, page, completed) VALUES ($1, $2, 'b_nts_2', 1, true), ($1, $2, 'b_nts_25', 1, true)`, [uid, S]);
      const read = async () => (await get('/api/history', asUser)).json().content.map((e: any) => e.book_id).sort();
      try {
        assert.deepEqual(await read(), ['b_nts_2', 'b_nts_25'], 'history changed with every switch off');
        await hide(['manhwa']);
        // Reintroduce by dropping the notice clause from /api/history (routes/personal.ts): 2.5 is still there.
        assert.deepEqual(await read(), ['b_nts_2'], 'a hidden notice is still in history');
      } finally {
        await hide([]);
        await q(`DELETE FROM reading_events WHERE user_id = $1`, [uid]);
      }
    });

    await t.test('Continue Reading: off, the notice you are part-way through; on, the next chapter instead', async () => {
      // 1, 2 and the renumbered 0 read; the notice 2.5 opened last and left part-way.
      await q(`INSERT INTO read_progress (user_id, book_id, series_id, page, completed, updated_at) VALUES
                 ($1, 'b_nts_1', $2, 1, true, now() - interval '3 hours'), ($1, 'b_nts_2', $2, 1, true, now() - interval '3 hours'),
                 ($1, 'b_nts_9', $2, 1, true, now() - interval '3 hours'), ($1, 'b_nts_25', $2, 0, false, now() - interval '1 hour')`, [uid, S]);
      const deck = async () => (await get('/api/home', asUser)).json().onDeck.map((b: any) => b.id);
      try {
        assert.deepEqual(await deck(), ['b_nts_25'], 'Continue Reading changed with every switch off');
        await hide(['manhwa']);
        // Reintroduce by dropping the notice clauses from the pick (routes/catalog.ts /api/home): the hidden 2.5 is
        // picked, cannot be resolved, and the series drops out of the rail.
        assert.deepEqual(await deck(), ['b_nts_3'], 'Continue Reading offers a hidden notice, or nothing');
      } finally {
        await hide([]);
        await q(`DELETE FROM read_progress WHERE user_id = $1`, [uid]);
      }
    });

    await t.test('ghost chapters: off, a listed notice is a ghost for Mihon; on, it is not', async () => {
      await q(`UPDATE server_settings SET komga_ghost_chapters = true WHERE id = 1`);
      const ghosts = async () => (await get(`/api/v1/series/${S}/books?unpaged=true`, komgaKey)).json().content
        .filter((b: any) => String(b.id).startsWith('g_')).map((b: any) => b.number);
      try {
        assert.deepEqual(await ghosts(), [5, 5.5, 6], 'the ghosts changed with every switch off');
        await hide(['manhwa']);
        // Reintroduce by dropping the notice clause from lib/komgaGhosts.ts: 5.5 is still a ghost Mihon counts.
        assert.deepEqual(await ghosts(), [5, 6], 'a hidden notice is still a ghost');
      } finally {
        await hide([]);
        await q(`UPDATE server_settings SET komga_ghost_chapters = false WHERE id = 1`);
      }
    });

    await t.test('the slow archive: off, a listed notice is its work; on, it is not', async () => {
      const { archiveSummaryFor, invalidateArchiveView } = await import('../src/lib/archive');
      await q(`INSERT INTO archive_queue (series_id, state, boundary) VALUES ($1, 'queued', 100)`, [S]);
      const left = async () => { invalidateArchiveView(); return (await archiveSummaryFor(S, null))?.left; };
      try {
        assert.equal(await left(), 3, "5, 5.5 and 6 are the archive's to fetch with every switch off");
        await hide(['manhwa']);
        // Reintroduce by dropping the notice clause from the archive's work list (lib/archive.ts eligibleSql): 3.
        assert.equal(await left(), 2, 'the archive still means to fetch the two-page 5.5');
      } finally {
        await hide([]);
        await q(`DELETE FROM archive_queue WHERE series_id = $1`, [S]);
      }
    });

    await t.test('a hidden notice as the cover chapter: the cover comes from the first chapter shown', async () => {
      // A series whose lowest chapter is a two-page notice (the scan makes the lowest live chapter the cover chapter).
      // Each width is its own cache entry, so each request below really draws the cover.
      await q(`UPDATE lib_series SET cover_book_id = 'b_nts_25' WHERE id = $1`, [S]);
      try {
        // Images take the OPDS token as a reader app sends it (routes/images.ts authorizeImageRequest).
        const off = await get(`/img/lib/series/${S}/thumb`, opds);
        assert.equal(off.statusCode, 200, `with every switch off the cover is the cover chapter's first page (${off.statusCode})`);
        await hide(['manhwa']);
        // Reintroduce by reading cover_book_id alone: the notice is hidden, its pages are nobody's, and this is a 404.
        const on = await get(`/img/lib/series/${S}/thumb?w=800`, opds);
        assert.equal(on.statusCode, 200, `the series lost its cover to a hidden notice (${on.statusCode})`);
        assert.equal(on.headers['content-type'], 'image/webp');
      } finally {
        await hide([]);
        await q(`UPDATE lib_series SET cover_book_id = NULL WHERE id = $1`, [S]);
      }
    });

    await t.test('Updates count real chapters across a switch, in chapter rows on both sides', async () => {
      await q(`INSERT INTO favorites (user_id, series_id) VALUES ($1, $2)`, [uid, S]);
      const updates = async () => (await get('/api/updates', asUser)).json().content.map((u: any) => [u.series.id, u.newCount]);
      const markSeen = async () => assert.equal((await app.inject({ method: 'POST', url: '/api/updates/seen', headers: asUser })).statusCode, 200);
      try {
        // Seen with the type switched on, then switched off: the two-page 2.5 is old, not new. Reintroduce the
        // count a reader sees (booksCount) in series_seen: it is announced as one new chapter.
        await hide(['manhwa']);
        await markSeen();
        assert.deepEqual(await updates(), []);
        await hide([]);
        assert.deepEqual(await updates(), [], 'switching the hide off announced an old notice as new');
        // Seen with it off, then switched on: the favourite's next chapter is new. Reintroduced, the seen count stands
        // above what is left and swallows it -- the favourite drops out of Updates.
        await markSeen();
        await hide(['manhwa']);
        assert.deepEqual(await updates(), []);
        await land('b_nts_4', 4, 20);
        assert.deepEqual(await updates(), [[S, 1]], "the hide swallowed a favourite's next chapter");
        const home = (await get('/api/home', asUser)).json();
        assert.equal(home.updatesCount, 1, "Home's badge disagrees with Updates");
        assert.equal(home.favorites.find((f: any) => f.id === S)?.yomi?.newCount, 1, "the favourite's own new count disagrees");
        // A chapter numbered 4.5 lands before anyone has counted it: a chapter, and new, until it is counted at two
        // pages -- then a notice, and nothing new about it. Reintroduce a plain difference of rows: it stays new.
        await land('b_nts_45', 4.5, 0);
        assert.deepEqual(await updates(), [[S, 2]]);
        await q(`UPDATE lib_books SET pages = 2 WHERE id = 'b_nts_45'`);
        assert.deepEqual(await updates(), [[S, 1]], 'a notice counted at two pages is still announced as new');
        // Off again, nothing has been read: the uncounted 4.5 did come since, and is new again; the old 2.5 is not.
        await hide([]);
        assert.deepEqual(await updates(), [[S, 2]]);
      } finally {
        await hide([]);
        await unland(['b_nts_4', 'b_nts_45']);
        await q(`DELETE FROM favorites WHERE user_id = $1`, [uid]);
        await q(`DELETE FROM series_seen WHERE user_id = $1`, [uid]);
      }
    });

    await t.test('only short ones off: every fraction is a notice, and Updates and the counts agree with it (v0.55.3)', async () => {
      // TIGamingTV's switch (#147). A twenty-page 4.5 lands: by the page rule a chapter, and new; with the switch off a
      // notice like any fraction, and nothing new -- and the series' count and Home's badge say the same each way.
      // Reintroduce by dropping the `!shortOnly` branch from bookIsNotice (lib/noticeChapters.ts): the twenty-page 4.5 is
      // counted and announced while every fraction is meant to be hidden.
      const shortOnly = async (on: boolean) => {
        await q(`UPDATE server_settings SET hide_notice_short_only = $1 WHERE id = 1`, [on]);
        await refreshNoticesActive();
      };
      await q(`INSERT INTO favorites (user_id, series_id) VALUES ($1, $2)`, [uid, S]);
      const updates = async () => (await get('/api/updates', asUser)).json().content.map((u: any) => [u.series.id, u.newCount]);
      // Through the Komga-compatible API: opening the series page marks its chapters seen, which is not this test's.
      const count = async () => (await get(`/api/v1/series/${S}`, komgaKey)).json().booksCount;
      const badge = async () => (await get('/api/home', asUser)).json().updatesCount;
      try {
        await shortOnly(false);
        await hide(['manhwa']);
        assert.equal((await app.inject({ method: 'POST', url: '/api/updates/seen', headers: asUser })).statusCode, 200);
        assert.deepEqual(await updates(), []);
        assert.equal(await count(), 4, 'the two-page 2.5 is hidden either way');
        await land('b_nts_45l', 4.5, 20);
        assert.equal(await count(), 4, 'every fraction is a notice: the twenty-page 4.5 too');
        assert.deepEqual(await updates(), [], 'a hidden fraction is announced as new');
        assert.equal(await badge(), 0, "Home's badge disagrees with Updates");
        await shortOnly(true);
        assert.equal(await count(), 5, 'by the page rule the twenty-page 4.5 is a chapter');
        assert.deepEqual(await updates(), [[S, 1]], 'and it came since the last look: new');
        assert.equal(await badge(), 1, "Home's badge disagrees with Updates");
      } finally {
        await shortOnly(true);
        await hide([]);
        await unland(['b_nts_45l']);
        await q(`DELETE FROM favorites WHERE user_id = $1`, [uid]);
        await q(`DELETE FROM series_seen WHERE user_id = $1`, [uid]);
      }
    });
  } finally {
    await app.close();
    await cleanup();
    rmSync(TMP, { recursive: true, force: true });
  }
});
