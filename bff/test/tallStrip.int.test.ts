// A chapter stitched into long strips can be far taller than WebP holds (16,383 px). Eleceed 215 on the live server is
// two 689 x 54,000 images: 31,350 px tall even at 400 wide, and sharp's WebP encoder threw on it, so the page grid, the
// strip thumbnails, the chapter's thumbnail and a series cover drawn from such a first page all answered 500 (v0.60.1,
// from Squeaks72's fork). A page now comes as JPEG when it is that tall, a thumbnail is the strip's top, and every other
// image comes out exactly as before.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const DSN = process.env.TEST_DATABASE_URL;
const TMP = join(tmpdir(), `uchiyomi-tall-${process.pid}`);
const ROOT = join(TMP, 'lib');
const DL = join(TMP, 'dl');

if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.CACHE_DIR = join(TMP, 'cache'); // serveImage writes here; never the live cache
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.LIBRARY_ROOT = ROOT;
  process.env.DL_ROOT = DL;
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const AdmZip = require('adm-zip');

const S = 's_tall_series';
const FOLDER = 'T!tall/Tall';
const STRIP = 'b_tall_strip';
const PAGE = 'b_tall_page';
const USER = 'tall-user';

let q: <T = any>(sql: string, params?: any[]) => Promise<T[]>;
let sharp: any;
let app: any;
let imgCookie = '';

/** A one-page chapter whose page is `width` x `height`. */
async function cbz(abs: string, width: number, height: number) {
  const png = await sharp({ create: { width, height, channels: 3, background: '#335577' } }).png().toBuffer();
  const z = new AdmZip();
  z.addFile('001.png', png);
  await mkdir(join(abs, '..'), { recursive: true });
  await writeFile(abs, z.toBuffer());
}

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
  await q('DELETE FROM lib_books WHERE series_id = $1', [S]).catch(() => {});
  await q('DELETE FROM lib_series WHERE id = $1', [S]).catch(() => {});
  await q('DELETE FROM users WHERE username = $1', [USER]).catch(() => {});

  // A strip 400 x 20,000: taller than WebP holds at its own width, inside it at half that.
  await cbz(join(DL, FOLDER, 'Chapter 1.cbz'), 400, 20000);
  await cbz(join(DL, FOLDER, 'Chapter 2.cbz'), 300, 400);
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count) VALUES ($1,'T!tall','Tall Test',$2,2)`, [S, FOLDER]);
  for (const [id, n] of [[STRIP, 1], [PAGE, 2]] as const) {
    await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, pages, root) VALUES ($1,$2,'T!tall',$3,$4,$5,1,$6)`,
      [id, S, `${FOLDER}/Chapter ${n}.cbz`, n, `Chapter ${n}`, DL]);
  }
  await q('UPDATE lib_series SET cover_book_id = $2 WHERE id = $1', [S, STRIP]);
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
  await q('UPDATE lib_series SET cover_book_id = NULL WHERE id = $1', [S]).catch(() => {});
  await q('DELETE FROM lib_books WHERE series_id = $1', [S]).catch(() => {});
  await q('DELETE FROM lib_series WHERE id = $1', [S]).catch(() => {});
  await q('DELETE FROM users WHERE username = $1', [USER]).catch(() => {});
  await rm(TMP, { recursive: true, force: true }).catch(() => {});
});

async function image(url: string): Promise<{ status: number; type: string; width?: number; height?: number; format?: string }> {
  const r = await app.inject({ method: 'GET', url, headers: { cookie: imgCookie } });
  if (r.statusCode !== 200) return { status: r.statusCode, type: String(r.headers['content-type'] ?? '') };
  const m = await sharp(r.rawPayload).metadata();
  return { status: 200, type: String(r.headers['content-type']), width: m.width, height: m.height, format: m.format };
}

test("a long strip's page comes at any width: JPEG when WebP cannot hold it, WebP when it can", { skip }, async () => {
  // Reintroduce by encoding WebP whatever the height (routes/images.ts pageAtWidth): the first request answers 500.
  const tall = await image(`/img/books/${STRIP}/page/1?w=400`);
  assert.equal(tall.status, 200, 'a strip too tall for WebP is still served');
  assert.equal(tall.type, 'image/jpeg');
  assert.deepEqual([tall.width, tall.height], [400, 20000], 'the whole strip, at the width asked');
  const half = await image(`/img/books/${STRIP}/page/1?w=200`);
  assert.deepEqual([half.status, half.type, half.width, half.height], [200, 'image/webp', 200, 10000], 'inside the limit it is WebP as before');
  const normal = await image(`/img/books/${PAGE}/page/1?w=200`);
  assert.deepEqual([normal.status, normal.type, normal.width, normal.height], [200, 'image/webp', 200, 267], 'an ordinary page is untouched');
});

test("a long strip's thumbnail is its top, and so is a series cover drawn from it", { skip }, async () => {
  // Reintroduce by encoding the whole strip (routes/images.ts thumbWebp): both answer 500.
  const thumb = await image(`/img/books/${STRIP}/thumb`);
  assert.deepEqual([thumb.status, thumb.format, thumb.width, thumb.height], [200, 'webp', 400, 1600], "the chapter's thumbnail is the strip's top four widths");
  const cover = await image(`/img/series/${S}/thumb`);
  assert.deepEqual([cover.status, cover.format, cover.width, cover.height], [200, 'webp', 400, 1600], 'the series cover drawn from that first page too');
  const normal = await image(`/img/books/${PAGE}/thumb`);
  assert.deepEqual([normal.status, normal.format, normal.width, normal.height], [200, 'webp', 300, 400], 'an ordinary thumbnail is untouched');
});
