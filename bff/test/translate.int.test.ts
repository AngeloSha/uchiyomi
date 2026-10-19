// Translated pages (v0.85.0) through the real routes, with an engine of fakes (lib/translate/engine.ts
// _setEngineForTests): no download, no model, no OCR process. What is checked is everything around them -- the switch
// and the downloaded engine as the two gates, the queue's order (the newest ask first, from the reader's page), what the
// model is told (the series' names, the lines before, the page only when the OCR looks unreliable), what is stored,
// what the reader is told, the translated picture served at ?tl=, and who may ask about a chapter at all.
//
// Skipped unless TEST_DATABASE_URL is set.
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DSN = process.env.TEST_DATABASE_URL;
let ROOT = '';
if (DSN) {
  ROOT = mkdtempSync(join(tmpdir(), 'yomi-translate-'));
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.CACHE_DIR = join(ROOT, 'cache');
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.LIBRARY_ROOT = join(ROOT, 'lib');
  process.env.DL_ROOT = join(ROOT, 'dl');
  process.env.TRANSLATE_DIR = join(ROOT, 'translate');
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const AdmZip = require('adm-zip');

const S = 's_tr_series', FOLDER = 'T!tr/Ribbon';
const A = 'b_tr_ch1', B = 'b_tr_ch2';
const USERS = ['tr-admin', 'tr-member', 'tr-walled'];
const ids: Record<string, string> = {};
/** Each page is a plain picture whose width says which page it is: 300 + 10 x chapter + page. */
const widthOf = (ch: number, page: number) => 300 + 10 * ch + page;

let q: any, app: any, sharp: any;
let engine: typeof import('../src/lib/translate/engine');
let queue: typeof import('../src/lib/translate/queue');
const as = (id: string, role = 'user') => ({ authorization: `Bearer ${app.jwt.sign({ sub: id, role })}` });
let imgCookie = '';

/** What the fakes saw, in order. */
const read: number[] = [];
const told: { system: string; content: any }[] = [];
let ocrGate: Promise<void> | null = null;
let ocrScore = 0.97;
let modelAnswer: (n: number) => string = (n) => JSON.stringify({ lines: Array.from({ length: n }, (_, i) => `Line ${i + 1}`), names: [{ source: '笛子', target: 'Fueko' }] });
let modelFails: string | null = null;
let vision = false;

const fakeEngine = () => ({
  ocr: {
    async read(bytes: Buffer) {
      const w = (await sharp(bytes).metadata()).width as number;
      read.push(w);
      if (ocrGate) await ocrGate;
      return { lines: [{ box: [20, 20, 200, 44] as [number, number, number, number], text: '笛子!', score: ocrScore, tall: false }], width: w, height: 400, ms: 1 };
    },
    stop() {},
    running: true,
  },
  model: {
    async chat(system: string, content: unknown) {
      told.push({ system, content });
      if (modelFails) throw new Error(modelFails);
      return { text: modelAnswer(1), timings: {} };
    },
    stop() {},
    running: true,
    get vision() { return vision; },
  },
  fontDir: '/nonexistent-fonts',
});

async function cbz(id: string, ch: number, pages: number) {
  const z = new AdmZip();
  for (let p = 1; p <= pages; p++) {
    z.addFile(`${String(p).padStart(3, '0')}.png`, await sharp({ create: { width: widthOf(ch, p), height: 400, channels: 3, background: '#ffffff' } }).png().toBuffer());
  }
  mkdirSync(join(ROOT, 'dl', FOLDER), { recursive: true });
  writeFileSync(join(ROOT, 'dl', FOLDER, `${id}.cbz`), z.toBuffer());
}

/** The engine as if Download had finished: what the queue and the routes read to call it installed. */
function installed(on: boolean) {
  const dir = process.env.TRANSLATE_DIR!;
  rmSync(dir, { recursive: true, force: true });
  if (!on) return;
  mkdirSync(dir, { recursive: true });
  const { PACK_TAG, platformKey } = require('../src/lib/translate/pin') as typeof import('../src/lib/translate/pin');
  writeFileSync(join(dir, 'installed.json'), JSON.stringify({ tag: PACK_TAG, platform: platformKey(), size: 'small', at: new Date().toISOString() }));
}
const setSwitch = (on: boolean) => q('UPDATE server_settings SET translate_pages = $1 WHERE id = 1', [on]);

before(async () => {
  if (!DSN) return;
  sharp = (await import('sharp')).default;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  await migrate();
  engine = await import('../src/lib/translate/engine');
  queue = await import('../src/lib/translate/queue');
  engine._setEngineForTests(fakeEngine() as any);

  await q('DELETE FROM lib_series WHERE id = $1', [S]);
  await q('DELETE FROM users WHERE username = ANY($1)', [USERS]);
  await cbz(A, 1, 3);
  await cbz(B, 2, 2);
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, lang) VALUES ($1,'T!tr','Ribbon',$2,2,'ja')`, [S, FOLDER]);
  for (const [id, n, pages] of [[A, 1, 3], [B, 2, 2]] as const) {
    await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, pages, root) VALUES ($1,$2,'T!tr',$3,$4,$5,$6,$7)`,
      [id, S, `${FOLDER}/${id}.cbz`, n, `Chapter ${n}`, pages, join(ROOT, 'dl')]);
  }
  for (const u of USERS) {
    ids[u] = (await q(`INSERT INTO users (display_name, username, role, password_hash, auth_kind) VALUES ($1,$1,$2,'x','password') RETURNING id`,
      [u, u === 'tr-admin' ? 'admin' : 'user']))[0].id;
  }
  const { NO_LIBRARIES } = await import('../src/lib/visibility');
  await q('INSERT INTO user_libraries (user_id, library_id) VALUES ($1, $2)', [ids['tr-walled'], NO_LIBRARIES]);

  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const cookie = (await import('@fastify/cookie')).default;
  app = Fastify();
  await app.register(cookie);
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/translate')).default);
  await app.register((await import('../src/routes/images')).default);
  await app.ready();
  const { IMG_COOKIE } = await import('../src/lib/auth');
  imgCookie = `${IMG_COOKIE}=${app.jwt.sign({ sub: ids['tr-member'], typ: 'img' })}`;
});

beforeEach(async () => {
  if (!DSN) return;
  await queue._queueSettled();
  queue.clearQueue();
  read.length = 0;
  told.length = 0;
  ocrGate = null; ocrScore = 0.97; modelFails = null; vision = false;
  await q('DELETE FROM page_translations WHERE book_id = ANY($1)', [[A, B]]);
  await q('DELETE FROM translate_names WHERE series_id = $1', [S]);
  installed(true);
  await setSwitch(true);
});

after(async () => {
  if (!DSN) return;
  await queue?._queueSettled();
  engine?._setEngineForTests(null);
  await setSwitch(false).catch(() => {});
  await app?.close();
  await q('DELETE FROM lib_series WHERE id = $1', [S]).catch(() => {});
  await q('DELETE FROM users WHERE username = ANY($1)', [USERS]).catch(() => {});
  rmSync(ROOT, { recursive: true, force: true });
});

const ask = (book: string, from: number, who = 'tr-member') =>
  app.inject({ method: 'POST', url: `/api/books/${book}/translations`, headers: as(ids[who]), payload: { lang: 'en', from } });
const status = async (book: string, who = 'tr-member') => {
  const r = await app.inject({ method: 'GET', url: `/api/books/${book}/translations?lang=en`, headers: as(ids[who]) });
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
};
/** The page number a fake OCR call was for. */
const pageOf = (w: number, ch: number) => w - 300 - 10 * ch;

test('off until the engine is downloaded AND the switch is on', { skip }, async () => {
  for (const [dl, on] of [[false, true], [true, false]] as const) {
    installed(dl);
    await setSwitch(on);
    const offer = await app.inject({ method: 'GET', url: '/api/translate', headers: as(ids['tr-member']) });
    assert.deepEqual(offer.json(), { available: false }, `downloaded ${dl}, on ${on}`);
    // Reintroduce by checking only the switch (or only the files): one of these two is 202 and queues pages.
    const r = await ask(A, 1);
    assert.equal(r.statusCode, 409, `downloaded ${dl}, on ${on}: ${r.body}`);
    assert.equal((await status(A)).available, false);
  }
  await queue._queueSettled();
  assert.deepEqual(read, [], 'nothing was read');
  installed(true);
  await setSwitch(true);
  assert.deepEqual((await app.inject({ method: 'GET', url: '/api/translate', headers: as(ids['tr-member']) })).json(), { available: true });
});

test('a chapter is translated from the reader\'s page on, and the reader is told each page\'s stamp', { skip }, async () => {
  const r = await ask(A, 2);
  assert.equal(r.statusCode, 202, r.body);
  assert.ok(r.json().pending >= 1, 'the reader keeps asking while pages wait');
  await queue._queueSettled();
  // Reintroduce by starting at page 1: page 1 is read first and the reader waits a page for nothing.
  assert.deepEqual(read.map((w) => pageOf(w, 1)), [2, 3]);
  const st = await status(A);
  assert.deepEqual(Object.keys(st.pages).sort(), ['2', '3']);
  // Reintroduce the time alone: a page drawn again by a new version keeps its address, and readers keep the old picture.
  assert.ok(Object.values(st.pages).every((v) => /^\d{13}\.\d+$/.test(v as string)), 'a stamp each, for the image URL: when, and drawn how');
  assert.equal(st.pending, 0);
  const row = (await q(`SELECT engine, status, regions FROM page_translations WHERE book_id = $1 AND page = 2`, [A]))[0];
  assert.equal(row.engine, 'small-v1', 'the model size and the pipeline version');
  assert.deepEqual(row.regions, [{ box: [20, 20, 200, 44], source: '笛子!', text: 'Line 1', letter: 24 }]);
});

test('the newest ask goes first: the chapter opened now jumps the one before', { skip }, async () => {
  let open!: () => void;
  ocrGate = new Promise<void>((r) => { open = r; });
  await ask(A, 1);
  // Page 1 of chapter 1 is being read; chapter 2 is opened meanwhile.
  while (!read.length) await new Promise((r) => setTimeout(r, 5));
  await ask(B, 1);
  ocrGate = null;
  open();
  await queue._queueSettled();
  // Reintroduce oldest-first: chapter 1's pages 2 and 3 come before chapter 2's.
  assert.deepEqual(read, [widthOf(1, 1), widthOf(2, 1), widthOf(2, 2), widthOf(1, 2), widthOf(1, 3)]);
});

test('the model is told the series\' names and the lines before, and is shown the page only when the OCR looks unreliable', { skip }, async () => {
  vision = true;
  await ask(A, 1);
  await queue._queueSettled();
  assert.equal(told.length, 3);
  // The first page knows nothing yet; its answer named 笛子 = Fueko, and the next pages are told so.
  assert.doesNotMatch(told[0].content, /Known names/);
  // Reintroduce by not storing the names (or not reading them back): "Known names" never appears.
  assert.match(told[1].content, /Known names: 笛子 = Fueko/);
  assert.match(told[2].content, /Earlier in this chapter:\n- 笛子! => Line 1\n- 笛子! => Line 1/);
  assert.match(told[0].content, /Comic: Ribbon \(Japanese\)/);
  assert.match(told[0].system, /natural English/);
  assert.equal(typeof told[0].content, 'string', 'clean OCR: text only');
  // Unreliable OCR: the page goes along, as a small JPEG.
  await q('DELETE FROM page_translations WHERE book_id = $1', [B]);
  ocrScore = 0.5;
  told.length = 0;
  await ask(B, 1);
  await queue._queueSettled();
  // Reintroduce by always sending text: the model never sees the page it is guessing about.
  assert.ok(Array.isArray(told[0].content), 'text and the page');
  assert.match(told[0].content[0].image_url.url, /^data:image\/jpeg;base64,/);
  // A model with no eyes is never sent a picture.
  vision = false;
  told.length = 0;
  await q('DELETE FROM page_translations WHERE book_id = $1', [B]);
  await ask(B, 1);
  await queue._queueSettled();
  assert.equal(typeof told[0].content, 'string');
});

test('a page that fails is kept as failed; an engine that cannot run stops the queue and says why', { skip }, async () => {
  modelAnswer = () => '{"lines": []}';
  try {
    await ask(B, 1);
    await queue._queueSettled();
  } finally {
    modelAnswer = (n) => JSON.stringify({ lines: Array.from({ length: n }, (_, i) => `Line ${i + 1}`), names: [{ source: '笛子', target: 'Fueko' }] });
  }
  let st = await status(B);
  assert.deepEqual(st.failed.sort(), [1, 2], 'every page tried, each failed on its own');
  assert.equal(st.problem, null);
  // Opened again, the chapter's failed pages are tried again, and a page done is not done twice.
  await q(`UPDATE page_translations SET status = 'done', regions = '[]', error = NULL WHERE book_id = $1 AND page = 2`, [B]);
  read.length = 0;
  // Held on the OCR, so the page cannot be done before the answer is read: the fakes answer at once (CI read 0).
  let release!: () => void;
  ocrGate = new Promise<void>((r) => { release = r; });
  const again = await ask(B, 1);
  assert.equal(again.json().pending, 1, 'only page 1 waits');
  ocrGate = null;
  release();
  await queue._queueSettled();
  // Reintroduce by queueing every page from `from`: page 2 is read again.
  assert.deepEqual(read, [widthOf(2, 1)]);
  st = await status(B);
  assert.deepEqual([Object.keys(st.pages).sort(), st.failed], [['1', '2'], []]);

  await q('DELETE FROM page_translations WHERE book_id = $1', [A]);
  modelFails = 'not enough free memory for the translation model (it needs about 4 GB)';
  read.length = 0;
  await ask(A, 1);
  await queue._queueSettled();
  // Reintroduce by recording it as one page's failure: all three pages are tried, each failing the same way.
  assert.equal(read.length, 1, 'stopped after the first page');
  st = await status(A);
  assert.match(st.problem, /not enough free memory/);
  assert.equal(st.pending, 0);
  const admin = await app.inject({ method: 'GET', url: '/api/admin/translate', headers: as(ids['tr-admin'], 'admin') });
  assert.match(admin.json().problem, /not enough free memory/, 'Settings says it too');
});

test('a translated page is served drawn at ?tl=, and a page not done yet is the original, never cached', { skip }, async () => {
  await ask(A, 3);
  await queue._queueSettled();
  const stamp = (await status(A)).pages['3'];
  const done = await app.inject({ method: 'GET', url: `/img/lib/books/${A}/page/3?tl=en&tv=${stamp}`, headers: { cookie: imgCookie } });
  assert.equal(done.statusCode, 200, done.body);
  assert.match(String(done.headers['cache-control']), /immutable/);
  const m = await sharp(done.rawPayload).metadata();
  assert.deepEqual([m.width, m.height], [widthOf(1, 3), 400], 'the page\'s own size');
  // The same page asked through /img/books (the reader's address) and fitted to a screen.
  const fit = await app.inject({ method: 'GET', url: `/img/books/${A}/page/3?tl=en&tv=${stamp}&fit=200`, headers: { cookie: imgCookie } });
  assert.equal(fit.statusCode, 200);
  assert.equal((await sharp(fit.rawPayload).metadata()).width, 200);

  // Page 1 was not asked for: the original, and `no-store` so the translated copy replaces it once there.
  const notYet = await app.inject({ method: 'GET', url: `/img/lib/books/${A}/page/1?tl=en&tv=0`, headers: { cookie: imgCookie } });
  assert.equal(notYet.statusCode, 200);
  // Reintroduce by serving it through the image cache: the original is cached for a year under the translated URL.
  assert.equal(notYet.headers['cache-control'], 'private, no-store');
  assert.equal((await sharp(notYet.rawPayload).metadata()).width, widthOf(1, 1));
  // Off: the original, whatever is stored.
  await setSwitch(false);
  const off = await app.inject({ method: 'GET', url: `/img/lib/books/${A}/page/3?tl=en&tv=${stamp}`, headers: { cookie: imgCookie } });
  assert.equal(off.headers['cache-control'], 'private, no-store');
  // A language that is not a language code is ignored, never put into a cache key.
  await setSwitch(true);
  const odd = await app.inject({ method: 'GET', url: `/img/lib/books/${A}/page/3?tl=../../x`, headers: { cookie: imgCookie } });
  assert.match(String(odd.headers['cache-control']), /immutable/, 'the plain page');
});

test('nothing about a chapter the account cannot open, and the admin routes are the admin\'s', { skip }, async () => {
  // Reintroduce by dropping visibleBookFile: the walled member queues pages of a series they cannot see.
  assert.equal((await ask(A, 1, 'tr-walled')).statusCode, 404);
  const r = await app.inject({ method: 'GET', url: `/api/books/${A}/translations?lang=en`, headers: as(ids['tr-walled']) });
  assert.equal(r.statusCode, 404);
  assert.equal((await ask('b_tr_nope', 1)).statusCode, 404, 'the same answer as no such chapter');
  assert.equal((await app.inject({ method: 'POST', url: `/api/books/${A}/translations`, headers: as(ids['tr-member']), payload: { lang: 'en<script>', from: 1 } })).statusCode, 400);
  await queue._queueSettled();
  assert.deepEqual(read, []);

  for (const [method, url] of [['GET', '/api/admin/translate'], ['PUT', '/api/admin/translate'], ['DELETE', '/api/admin/translate'], ['POST', '/api/admin/translate/download']]) {
    const res = await app.inject({ method, url, headers: as(ids['tr-member']), payload: method === 'PUT' ? { enabled: true } : undefined });
    assert.equal(res.statusCode, 403, `${method} ${url}`);
  }
  const admin = as(ids['tr-admin'], 'admin');
  const st = (await app.inject({ method: 'GET', url: '/api/admin/translate', headers: admin })).json();
  assert.deepEqual([st.enabled, st.state, st.size], [true, 'ready', 'small']);
  assert.equal((await app.inject({ method: 'POST', url: '/api/admin/translate/download', headers: admin, payload: { size: 'huge' } })).statusCode, 400);
  const off = await app.inject({ method: 'PUT', url: '/api/admin/translate', headers: admin, payload: { enabled: false } });
  assert.equal(off.json().enabled, false);
  const gone = await app.inject({ method: 'DELETE', url: '/api/admin/translate', headers: admin });
  assert.equal(gone.json().state, 'missing');
});

test('translations go with their chapter, and names with their series', { skip }, async () => {
  await ask(B, 1);
  await queue._queueSettled();
  assert.equal((await q('SELECT count(*)::int AS n FROM page_translations WHERE book_id = $1', [B]))[0].n, 2);
  assert.equal((await q('SELECT count(*)::int AS n FROM translate_names WHERE series_id = $1', [S]))[0].n, 1);
  await q('DELETE FROM lib_books WHERE id = $1', [B]);
  assert.equal((await q('SELECT count(*)::int AS n FROM page_translations WHERE book_id = $1', [B]))[0].n, 0);
  // Put chapter 2 back for any later run of this file.
  await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, pages, root) VALUES ($1,$2,'T!tr',$3,2,'Chapter 2',2,$4)`,
    [B, S, `${FOLDER}/${B}.cbz`, join(ROOT, 'dl')]);
});
