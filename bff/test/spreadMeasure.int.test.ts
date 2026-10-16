// Spread joining's background measure (#229, lib/spreadMeasure.ts) against real rows and real archives: the page list
// only ever READS the answer, a chapter not measured yet is queued and answered at once, and every chapter looked at --
// nothing found or unreadable alike -- is looked at once per file and detector, never again on every request.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const DSN = process.env.TEST_DATABASE_URL;
const TMP = join(tmpdir(), `uchiyomi-spr-${process.pid}`);
const ROOT = join(TMP, 'lib');
const DL = join(TMP, 'dl');

if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.CACHE_DIR = join(TMP, 'cache');
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.LIBRARY_ROOT = ROOT;
  process.env.DL_ROOT = DL;
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const AdmZip = require('adm-zip');

let q: <T = any>(sql: string, params?: any[]) => Promise<T[]>;
let spreadsIdle: () => Promise<void>;
let JOIN_VERSION: number;
let tombstoneBooks: (ids: string[]) => Promise<void>;
let app: any;
let uid: string;
let headers: Record<string, string>;

const S = 's_spr_series';
const FOLDER = 'T!spr/Spreads';
const B = { spread: 'b_spr_spread', plain: 'b_spr_plain', broken: 'b_spr_broken' };
const USER = 'spr-user';

/** A drawn page `w` x `h`: grey bands at many heights over a fine diagonal tone (as bff/test/spreadJoin.test.ts). */
async function picture(w: number, h: number, seed: number): Promise<Buffer> {
  const sharp = (await import('sharp')).default;
  const stripes = Array.from({ length: 60 }, (_, i) => {
    const y = Math.round(((i * 37 + seed * 11) % 100) / 100 * h);
    const g = 30 + ((i * 53 + seed * 29) % 190);
    return `<rect x="${(i * 173 + seed * 7) % Math.round(w * 0.7)}" y="${y}" width="${Math.round(w * 0.5 + ((i * 61) % Math.round(w * 0.5)))}" height="${Math.round(h / 60)}" fill="rgb(${g},${g},${g})"/>`;
  }).join('');
  const tone = `<pattern id="t" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(${30 + seed * 7})"><rect width="6" height="6" fill="#d8d8d8"/><rect width="3" height="6" fill="#a8a8a8"/></pattern>`;
  return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs>${tone}</defs><rect width="${w}" height="${h}" fill="url(#t)"/>${stripes}</svg>`)).jpeg({ quality: 92 }).toBuffer();
}

/** Five pages: two of their own, then a spread cut in two (its right half first, as a right-to-left book runs), then one more. */
async function spreadChapter(abs: string) {
  const sharp = (await import('sharp')).default;
  const w = 400, h = 600;
  const spread = await picture(2 * w, h, 3);
  const half = (left: number) => sharp(spread).extract({ left, top: 0, width: w, height: h }).jpeg({ quality: 92 }).toBuffer();
  const z = new AdmZip();
  z.addFile('001.jpg', await picture(w, h, 1));
  z.addFile('002.jpg', await half(w));
  z.addFile('003.jpg', await half(0));
  z.addFile('004.jpg', await picture(w, h, 7));
  z.addFile('005.jpg', await picture(w, h, 9));
  await mkdir(join(abs, '..'), { recursive: true });
  await writeFile(abs, z.toBuffer());
}

async function plainChapter(abs: string) {
  const z = new AdmZip();
  for (const [i, seed] of [1, 7, 9].entries()) z.addFile(`00${i + 1}.jpg`, await picture(400, 600, seed));
  await mkdir(join(abs, '..'), { recursive: true });
  await writeFile(abs, z.toBuffer());
}

async function seed() {
  await spreadChapter(join(DL, FOLDER, 'ch1.cbz'));
  await plainChapter(join(DL, FOLDER, 'ch2.cbz'));
  // Not an archive at all: the measure cannot open it.
  await mkdir(join(DL, FOLDER), { recursive: true });
  await writeFile(join(DL, FOLDER, 'ch3.cbz'), Buffer.from('this is not a zip'));
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count) VALUES ($1,'T!spr','Spread Test',$2,3)`, [S, FOLDER]);
  const book = (id: string, n: number, file: string, pages: number) =>
    q(`INSERT INTO lib_books (id, series_id, source, file, number, title, pages, root, mtime) VALUES ($1,$2,'T!spr',$3,$4,$5,$6,$7,1000)`,
      [id, S, file, n, `Chapter ${n}`, pages, DL]);
  await book(B.spread, 1, `${FOLDER}/ch1.cbz`, 5);
  await book(B.plain, 2, `${FOLDER}/ch2.cbz`, 3);
  await book(B.broken, 3, `${FOLDER}/ch3.cbz`, 0);
  // The broken one's page list must still have two pages for the measure to be asked about: its cached sizes say so.
  await q(`UPDATE lib_books SET page_dims = $2 WHERE id = $1`, [B.broken, JSON.stringify([
    { name: '001.jpg', width: 400, height: 600 }, { name: '002.jpg', width: 400, height: 600 }])]);
  await q('UPDATE lib_series SET cover_book_id = $2 WHERE id = $1', [S, B.spread]);
}

const pages = (id: string, spreads = true) => app.inject({ method: 'GET', url: `/api/books/${id}/pages${spreads ? '?spreads=1' : ''}`, headers });
const stored = async (id: string) => (await q<{ spreads: any }>('SELECT spreads FROM lib_books WHERE id = $1', [id]))[0]?.spreads ?? null;

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  ({ spreadsIdle } = await import('../src/lib/spreadMeasure'));
  ({ JOIN_VERSION } = await import('../src/lib/spreadJoin'));
  ({ tombstoneBooks } = await import('../src/lib/chapterCleanup'));
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const catalogRoutes = (await import('../src/routes/catalog')).default;
  const downloadRoutes = (await import('../src/routes/downloads')).default;
  await migrate();
  await q('DELETE FROM users WHERE username = $1', [USER]).catch(() => {});
  uid = (await q<{ id: string }>(
    `INSERT INTO users (display_name, username, role, password_hash, auth_kind) VALUES ($1,$1,'user','x','password') RETURNING id`, [USER]))[0].id;
  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register(catalogRoutes);
  await app.register(downloadRoutes);
  await app.ready();
  headers = { authorization: `Bearer ${app.jwt.sign({ sub: uid, role: 'user' })}` };
});

beforeEach(async () => {
  if (!DSN) return;
  await spreadsIdle();
  await q('DELETE FROM lib_books WHERE series_id = $1', [S]).catch(() => {});
  await q('DELETE FROM lib_series WHERE id = $1', [S]).catch(() => {});
  await rm(TMP, { recursive: true, force: true }).catch(() => {});
  await seed();
});

after(async () => {
  if (!DSN) return;
  await spreadsIdle();
  await app?.close();
  await q('DELETE FROM lib_books WHERE series_id = $1', [S]).catch(() => {});
  await q('DELETE FROM lib_series WHERE id = $1', [S]).catch(() => {});
  await q('DELETE FROM users WHERE username = $1', [USER]).catch(() => {});
  await rm(TMP, { recursive: true, force: true }).catch(() => {});
});

test('without ?spreads=1 the page list is what it was, and nothing is measured', { skip }, async () => {
  const r = await pages(B.spread, false);
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers['x-spreads'], undefined);
  assert.ok((r.json() as any[]).every((p) => !('join' in p)));
  await spreadsIdle();
  assert.equal(await stored(B.spread), null, 'a reader who never turned joining on had a chapter measured');
});

test('with ?spreads=1 a chapter is answered at once, measured in the background, and joined after', { skip }, async () => {
  // Reintroduce by measuring inside the route (await measureBook before answering): the first answer is 'done'.
  const first = await pages(B.spread);
  assert.equal(first.statusCode, 200);
  assert.equal(first.headers['x-spreads'], 'pending');
  assert.equal((first.json() as any[]).length, 5);
  assert.ok((first.json() as any[]).every((p) => !p.join), 'nothing is joined before it is measured');
  await spreadsIdle();
  const answer = await stored(B.spread);
  assert.equal(answer.v, JOIN_VERSION);
  assert.equal(answer.mtime, 1000);
  assert.equal(answer.pages, 5);
  assert.deepEqual(answer.joins, [[2, 'rtl']]);
  const again = await pages(B.spread);
  assert.equal(again.headers['x-spreads'], 'done');
  assert.deepEqual((again.json() as any[]).map((p) => p.join ?? null), [null, 'rtl', null, null, null]);
});

test('a chapter with no spread is looked at once, and an unreadable chapter too', { skip }, async () => {
  // The loop #229 had: a chapter it could not re-read wrote nothing and was measured on every request. The answer is
  // written whatever happened, and the next ask finds it. Reintroduce by writing only when the measure read the file:
  // the broken chapter's second answer is 'pending' again.
  for (const id of [B.plain, B.broken]) assert.equal((await pages(id)).headers['x-spreads'], 'pending');
  await spreadsIdle();
  assert.deepEqual((await stored(B.plain)).joins, []);
  const broken = await stored(B.broken);
  assert.equal(broken.unreadable, true);
  assert.equal(broken.v, JOIN_VERSION);
  for (const id of [B.plain, B.broken]) assert.equal((await pages(id)).headers['x-spreads'], 'done', `${id} was queued again`);
});

test('a page count that disagrees with the file keeps the answer and joins nothing, without measuring again', { skip }, async () => {
  await pages(B.spread);
  await spreadsIdle();
  // The sizes cached for the page list are older than the file: six pages listed, five in the archive.
  const six = Array.from({ length: 6 }, (_, i) => ({ name: `00${i + 1}.jpg`, width: 400, height: 600 }));
  await q('UPDATE lib_books SET page_dims = $2 WHERE id = $1', [B.spread, JSON.stringify(six)]);
  const r = await pages(B.spread);
  assert.equal(r.headers['x-spreads'], 'done', 'a count that disagrees put the chapter back on the queue');
  assert.ok((r.json() as any[]).every((p) => !p.join), 'a join on a list of another length would sit on the wrong pages');
});

test('a replaced file, or a newer detector, is measured again', { skip }, async () => {
  await pages(B.spread);
  await spreadsIdle();
  await q('UPDATE lib_books SET mtime = 2000 WHERE id = $1', [B.spread]);
  assert.equal((await pages(B.spread)).headers['x-spreads'], 'pending');
  await spreadsIdle();
  assert.equal((await stored(B.spread)).mtime, 2000);
  await q(`UPDATE lib_books SET spreads = jsonb_set(spreads, '{v}', to_jsonb($2::int)) WHERE id = $1`, [B.spread, JOIN_VERSION - 1]);
  assert.equal((await pages(B.spread)).headers['x-spreads'], 'pending', 'an answer an older detector gave was trusted');
});

test('a deleted chapter has nothing to measure', { skip }, async () => {
  await tombstoneBooks([B.spread]);
  const r = await pages(B.spread);
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json(), []);
  assert.equal(r.headers['x-spreads'], 'none');
});

test('the offline manifest carries the joins found, and never queues a measure', { skip }, async () => {
  const before0 = await app.inject({ method: 'GET', url: `/api/books/${B.spread}/download-manifest`, headers });
  assert.equal(before0.statusCode, 200);
  assert.ok((before0.json().pages as any[]).every((p) => !p.join));
  await spreadsIdle();
  assert.equal(await stored(B.spread), null, 'a download queued a measure');
  await pages(B.spread);
  await spreadsIdle();
  const m = await app.inject({ method: 'GET', url: `/api/books/${B.spread}/download-manifest`, headers });
  assert.deepEqual((m.json().pages as any[]).map((p) => p.join ?? null), [null, 'rtl', null, null, null]);
});
