// The reader's pages fitted to a screen, through the real route (#234): GET /img/books/:id/page/:n?fit=<px> and its
// /img/lib twin answer a page at most that wide at the reading quality, the page exactly as it is where a copy would not
// be better, and nothing new for `?w=`, which the thumbnails keep.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const DSN = process.env.TEST_DATABASE_URL;
const TMP = join(tmpdir(), `uchiyomi-fit-${process.pid}`);
const DL = join(TMP, 'dl');

if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.CACHE_DIR = join(TMP, 'cache'); // serveImage writes here; never the live cache
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.LIBRARY_ROOT = join(TMP, 'lib');
  process.env.DL_ROOT = DL;
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const AdmZip = require('adm-zip');

const S = 's_fit_series';
const FOLDER = 'T!fit/Fit';
const BIG = 'b_fit_big', SMALL = 'b_fit_small';
const USER = 'fit-user';

let q: <T = any>(sql: string, params?: any[]) => Promise<T[]>;
let sharp: any;
let app: any;
let imgCookie = '';
/** Each chapter's one page, as stored in its file. */
const stored: Record<string, Buffer> = {};

before(async () => {
  if (!DSN) return;
  sharp = (await import('sharp')).default;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const cookie = (await import('@fastify/cookie')).default;
  const imageRoutes = (await import('../src/routes/images')).default;
  const { IMG_COOKIE } = await import('../src/lib/auth');
  await migrate();
  await rm(TMP, { recursive: true, force: true }).catch(() => {});
  await q('DELETE FROM lib_series WHERE id = $1', [S]).catch(() => {});
  await q('DELETE FROM users WHERE username = $1', [USER]).catch(() => {});

  // A 2,400 px scan, and a page already narrower than any screen asks for.
  for (const [id, w, h] of [[BIG, 2400, 3400], [SMALL, 600, 900]] as const) {
    stored[id] = await sharp({ create: { width: w, height: h, channels: 3, background: '#335577' } })
      .composite([{ input: Buffer.alloc(w * 30 * 3, 220), raw: { width: w, height: 30, channels: 3 }, top: 20, left: 0 }]).png().toBuffer();
    const z = new AdmZip();
    z.addFile('001.png', stored[id]);
    await mkdir(join(DL, FOLDER), { recursive: true });
    await writeFile(join(DL, FOLDER, `${id}.cbz`), z.toBuffer());
  }
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count) VALUES ($1,'T!fit','Fit Test',$2,2)`, [S, FOLDER]);
  for (const [id, n] of [[BIG, 1], [SMALL, 2]] as const) {
    await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, pages, root) VALUES ($1,$2,'T!fit',$3,$4,$5,1,$6)`,
      [id, S, `${FOLDER}/${id}.cbz`, n, `Chapter ${n}`, DL]);
  }
  const uid = (await q<{ id: string }>(
    `INSERT INTO users (display_name, username, role, password_hash, auth_kind) VALUES ($1,$1,'user','x','password') RETURNING id`, [USER],
  ))[0].id;

  app = Fastify();
  await app.register(cookie);
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register(imageRoutes);
  await app.ready();
  imgCookie = `${IMG_COOKIE}=${app.jwt.sign({ sub: uid, typ: 'img' })}`;
});

after(async () => {
  if (!DSN) return;
  await app?.close();
  await q('DELETE FROM lib_series WHERE id = $1', [S]).catch(() => {});
  await q('DELETE FROM users WHERE username = $1', [USER]).catch(() => {});
  await rm(TMP, { recursive: true, force: true }).catch(() => {});
});

async function get(url: string) {
  const r = await app.inject({ method: 'GET', url, headers: { cookie: imgCookie } });
  assert.equal(r.statusCode, 200, `${url}: ${r.body}`);
  const m = await sharp(r.rawPayload).metadata();
  return { type: String(r.headers['content-type']), width: m.width, bytes: r.rawPayload as Buffer };
}

test('a scan asked to fit a screen comes that wide, from both page routes', { skip }, async () => {
  for (const base of ['/img/books', '/img/lib/books']) {
    const fit = await get(`${base}/${BIG}/page/1?fit=1080`);
    assert.deepEqual([fit.type, fit.width], ['image/webp', 1080], base);
    assert.ok(fit.bytes.length < stored[BIG].length, 'smaller than the scan');
  }
});

test('a page that already fits comes exactly as stored, and a width out of range is the page as it is', { skip }, async () => {
  // Reintroduce `pageAtWidth` for `fit` (no pageForScreen): the 600 px page comes back as a softer WebP of itself.
  const small = await get(`/img/books/${SMALL}/page/1?fit=720`);
  assert.equal(small.type, 'image/png');
  assert.ok(small.bytes.equals(stored[SMALL]), 'the stored bytes');
  for (const bad of ['5000', '10', 'wide', '1080.5']) {
    const r = await get(`/img/books/${BIG}/page/1?fit=${bad}`);
    assert.deepEqual([r.type, r.width], ['image/png', 2400], `fit=${bad}`);
  }
});

test('the thumbnails\' ?w= is as it was: a WebP at 74, whatever the page', { skip }, async () => {
  // Even the page narrower than 720: ?w= never learned pageForScreen's rules (the page grid asks w=200).
  const thumb = await get(`/img/books/${SMALL}/page/1?w=200`);
  assert.deepEqual([thumb.type, thumb.width], ['image/webp', 200]);
  // `w` wins beside `fit`: a thumbnail request is never a reading copy.
  const both = await get(`/img/books/${BIG}/page/1?w=200&fit=1080`);
  assert.deepEqual([both.type, both.width], ['image/webp', 200]);
});
