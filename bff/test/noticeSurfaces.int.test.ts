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
  await app.ready();
  const opds = { authorization: basic(USER, await auth.issueOpdsToken(uid)) };
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
  } finally {
    await app.close();
    await cleanup();
    rmSync(TMP, { recursive: true, force: true });
  }
});
