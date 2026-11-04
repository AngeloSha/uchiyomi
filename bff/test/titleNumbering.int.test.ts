// Specials that a source counts as chapters (#379, lib/titleNumbers.ts): Tapas numbers every post by its place in the
// list -- the extension's `chapter_number = scene` -- so a "Caption Contest!" or a "Q&A Announcement!" takes a number,
// and every chapter after it carries the number one higher than the one in its own title ("Ch. 27 · 24. The Other
// Side"). The series is numbered by the chapter titles instead: each chapter at the number its title gives, each
// special just after the chapter before it, where it was posted.
//
// The real Suwayomi adapter against the fake engine, with a Tapas-shaped source: 36 posts, 30 chapters and 6 specials,
// in the screenshot's order around chapter 24 (scene 27 "24. The Other Side", 28 "Caption Contest!", 29 "25. What's To
// Come", 30 "Q&A Announcement!").
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeSuwayomi, defaultSeed, type FakeSuwayomi } from './fixtures/fakeSuwayomi';

const DSN = process.env.TEST_DATABASE_URL;
let ROOT = '';
let DL = '';
if (DSN) {
  ROOT = mkdtempSync(join(tmpdir(), 'uchiyomi-tn-'));
  DL = join(ROOT, 'dl');
  mkdirSync(DL, { recursive: true });
  process.env.DL_ROOT = DL;
  process.env.LIBRARY_ROOT = join(ROOT, 'lib');
  process.env.CACHE_DIR = join(ROOT, 'cache');
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.MIN_FREE_GB = '0';
  process.env.DOWNLOAD_MIN_GAP_MS = '0';
  process.env.DOWNLOAD_PAGE_GAP_MS = '0';
  process.env.UPDATER_LIST_TIMEOUT_MS = '5000';
  process.env.UCHIYOMI_PING_URL = '';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const TAPAS_ID = '7000000000000037901';
const TAPAS = `sw:${TAPAS_ID}`;
/** A main source that numbers the same chapters by their own numbers, and lists no specials. */
const MAIN = 'tn-main';
const LIB = 'lib_tn';
const S = 's_tn_held', FOLDER = 'Tapas (test)/Lumen Street Held';
const S2 = 's_tn_kept', FOLDER2 = 'Tapas (test)/Lumen Street Kept';
const S3 = 's_tn_follow', FOLDER3 = 'Main (test)/Lumen Street';
// Added back over the files it left: the add's own folder, `<source name>/<title>`.
const S5 = 's_tn_revived', FOLDER5 = 'Tapas/Night Ferry';
const S6 = 's_tn_fill', FOLDER6 = 'Tapas (test)/Lumen Street Filled';
const ALL = [S, S2, S3, S5, S6];
const DAY = 86_400_000;
const EPOCH = Date.UTC(2022, 5, 1);

// The creator's chapters, and the specials posted between them: after chapter N, oldest first.
const NAMES = ['First Light', 'Lumen Street', 'Paper Moons', 'The Lamplighter', 'Under the Bridge', 'Rain Check', 'Old Friends', 'The Map',
  'Crossroads', 'Night Market', 'Glass House', 'Echoes', 'Signal', 'The Long Way', 'Small Hours', 'Harbor', 'Tides', 'Static',
  'Blue Hour', 'Matchsticks', 'The Ferry', 'Wires', 'Second Floor', 'The Other Side', 'What\'s To Come', 'Embers', 'Daybreak',
  'Loose Ends', 'The Return', 'Lights Out'];
const SPECIALS: Record<number, string[]> = {
  5: ['Character Sheet'], 12: ['Hiatus Announcement'], 18: ['Fan Art Corner'], 24: ['Caption Contest!'], 25: ['Q&A Announcement!'], 30: ['Q&A Answers!'],
};
/** The posts as the extension lists them, oldest first: every post numbered by its place (`scene`), specials too. */
function tapasPosts(base = 9000): Array<{ name: string; url: string; chapterNumber: number; uploadDate: number; pages: number }> {
  const out: Array<{ name: string; url: string; chapterNumber: number; uploadDate: number; pages: number }> = [];
  const add = (name: string, pages: number) => {
    const scene = out.length + 1;
    out.push({ name, url: `/episode/${base + scene}`, chapterNumber: scene, uploadDate: EPOCH + scene * DAY, pages });
  };
  NAMES.forEach((name, i) => {
    add(`${i + 1}. ${name}`, 4);
    for (const s of SPECIALS[i + 1] ?? []) add(s, 1);
  });
  return out;
}
const POSTS = tapasPosts();
/** The same series again, under its own urls: the one added back over its old files. */
const NIGHT = tapasPosts(19000);
const postsOf = (manga: string) => (manga === 'Night Ferry' ? NIGHT : POSTS);
/** The post the extension numbers `scene`. */
const scenePost = (scene: number, manga = 'Lumen Street') => postsOf(manga)[scene - 1];

let q: any, app: any, numbering: any, updater: any, token = '', adminId = '';
let fake: FakeSuwayomi | null = null;
const realFetch = globalThis.fetch;
const PIXEL = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(400, 7)]);

before(async () => {
  if (!DSN) return;
  globalThis.fetch = (async (u: any) =>
    String(u).includes('example.invalid') ? new Response(PIXEL, { status: 200, headers: { 'content-type': 'image/png' } }) : new Response('', { status: 404 })) as typeof fetch;
  const seed = defaultSeed();
  const pkgName = 'eu.kanade.tachiyomi.extension.en.tapastic';
  seed.sources.push({
    id: TAPAS_ID, name: 'Tapas', lang: 'en', pkgName, supportsLatest: true, isNsfw: false, baseUrl: 'https://tapas.example',
    mangas: [
      { title: 'Lumen Street', url: '/series/379', realUrl: 'https://tapas.example/series/379', genre: ['Drama'], status: 'ONGOING', chapters: [...POSTS].reverse() },
      { title: 'Night Ferry', url: '/series/380', realUrl: 'https://tapas.example/series/380', genre: ['Drama'], status: 'ONGOING', chapters: [...NIGHT].reverse() },
    ],
  } as any);
  seed.extensions.push({ pkgName, name: 'Tapas', lang: 'en', versionName: '1.4.40', installed: true, isNsfw: false, repo: 'https://repo.example/repo.json' } as any);
  fake = await startFakeSuwayomi({ seed: seed as any });
  process.env.SUWAYOMI_URL = fake.url;
  const { migrate } = await import('../src/lib/migrate');
  await migrate();
  ({ q } = (await import('../src/lib/db')) as any);
  numbering = await import('../src/lib/numbering');
  updater = await import('../src/lib/updater');
  const { registerAdapter } = await import('../src/lib/sources');
  const { makeSuwayomiAdapter } = await import('../src/lib/sources/suwayomi/sources');
  const run = (async (query: string, variables: Record<string, unknown> = {}) => {
    const r = await fake!.query(query, variables);
    if (r.errors?.length) throw new Error(`suwayomi: ${r.errors[0].message}`);
    return r.data;
  }) as any;
  registerAdapter(makeSuwayomiAdapter({ id: TAPAS_ID, name: 'Tapas', lang: 'en', supportsLatest: true }, run));
  registerAdapter({
    id: MAIN, name: 'Main (test)',
    async search() { return []; },
    async getSeries(sid: string) { return { sourceId: sid, source: MAIN, title: 'Lumen Street' }; },
    async listChapters() {
      return NAMES.map((name, i) => ({ sourceId: `main-${i + 1}`, number: i + 1, title: `Chapter ${i + 1}: ${name}`, publishedAt: new Date(EPOCH + i * DAY).toISOString() }));
    },
    async getPageUrls(id: string) { return [`https://example.invalid/${encodeURIComponent(id)}/p1.png`]; },
    async latest() { return []; },
  } as any);
  await q('DELETE FROM source_health WHERE source_id = ANY($1)', [[TAPAS, MAIN]]);
  await q(`INSERT INTO libraries (id, name, path) VALUES ($1,'Titles',$1) ON CONFLICT (id) DO NOTHING`, [LIB]);
  await q('DELETE FROM lib_series WHERE id = ANY($1) OR folder LIKE $2', [ALL, 'Tapas/%']);
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/sources')).default);
  await app.ready();
  await q(`DELETE FROM users WHERE username = 'tn-admin'`);
  adminId = (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind)
                      VALUES ('tn-admin','tn-admin','x','admin','password') RETURNING id`))[0].id;
  token = `Bearer ${app.jwt.sign({ sub: adminId, role: 'admin' })}`;
});

after(async () => {
  globalThis.fetch = realFetch;
  if (!DSN) return;
  await app?.close();
  await fake?.close();
  await q('DELETE FROM lib_series WHERE id = ANY($1) OR folder LIKE $2', [ALL, 'Tapas/%']).catch(() => {});
  await q('DELETE FROM libraries WHERE id = $1', [LIB]).catch(() => {});
  await q(`DELETE FROM users WHERE username = 'tn-admin'`).catch(() => {});
  rmSync(ROOT, { recursive: true, force: true });
});

/** The engine's chapter id of the post the extension numbers `scene`, as the adapter hands it over. */
async function postId(scene: number, manga = 'Lumen Street'): Promise<string> {
  const { getSource } = await import('../src/lib/sources');
  const list = await getSource(TAPAS)!.listChapters(String(fake!.manga(manga).id));
  const c = list.find((x: any) => x.url === scenePost(scene, manga).url);
  assert.ok(c, `post ${scene} is listed`);
  return c!.sourceId;
}

/** A v0.102 chapter on disk: `Chapter <scene>.cbz`, the post the extension numbered so, stamped as a landing stamps it. */
async function seedBook(series: string, folder: string, scene: number, stamped = true, manga = 'Lumen Street') {
  mkdirSync(join(DL, folder), { recursive: true });
  writeFileSync(join(DL, folder, `Chapter ${scene}.cbz`), 'x'.repeat(100));
  const { chapterName } = await import('../src/lib/naming');
  await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, root, chapter_name, source_id, source_chapter_id)
           VALUES ($1,$2,'Tapas',$3,$4,$5,$6,$7,$8,$9)`,
    [`${series}_b${scene}`, series, `${folder}/Chapter ${scene}.cbz`, scene, `Chapter ${scene}`, DL,
      chapterName(scenePost(scene, manga).name, scene), TAPAS, stamped ? await postId(scene, manga) : null]);
}
/** A series row on the Tapas source, with nothing decided about its numbering. */
async function seedSeries(id: string, folder: string, cols: Record<string, unknown> = {}) {
  const keys = ['id', 'source', 'title', 'folder', 'books_count', 'library_id', 'source_id', 'source_series_id', 'auto_update', ...Object.keys(cols)];
  const vals = [id, 'Tapas', 'Lumen Street', folder, 0, LIB, TAPAS, String(fake!.manga('Lumen Street').id), true, ...Object.values(cols)];
  await q(`INSERT INTO lib_series (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})`, vals);
}
const listingOf = async (series: string) => (await q('SELECT number::float8 AS n, chosen, copies FROM series_listing WHERE series_id = $1 ORDER BY number', [series]))
  .map((x: any) => ({ n: Math.round(Number(x.n) * 1000) / 1000, title: x.chosen?.title as string, copies: (x.copies ?? []) as Array<{ title: string; source: string }> }));
const booksOf = async (series: string) =>
  new Map<string, { number: number; file: string }>((await q('SELECT id, number::float8 AS number, file FROM lib_books WHERE series_id = $1', [series]))
    .map((r: any) => [r.id, { number: Math.round(Number(r.number) * 1000) / 1000, file: r.file }]));
const filesIn = (folder: string) => readdirSync(join(DL, folder)).sort();

test('an add keeps each chapter at its own number, and a special just after the chapter before it', { skip }, async () => {
  const sourceId = String(fake!.manga('Lumen Street').id);
  const d = await app.inject({ method: 'GET', url: `/api/sources/detail?source=${encodeURIComponent(TAPAS)}&sourceId=${sourceId}`, headers: { authorization: token } });
  assert.equal(d.statusCode, 200, d.body);
  const detail = d.json();
  assert.equal(detail.count, 36, 'every post is counted, the specials too');
  assert.deepEqual([detail.first, detail.last], [1, 30.01], 'the chapters run 1 to 30, the last special just after 30');

  const r = await app.inject({ method: 'POST', url: '/api/sources/add', headers: { authorization: token }, payload: { source: TAPAS, sourceId, chapterFrom: 'none' } });
  assert.equal(r.statusCode, 200, r.body);
  const id = r.json().seriesId;
  const l = await q('SELECT number::float8 AS n, chosen FROM series_listing WHERE series_id = $1 ORDER BY number', [id]);
  assert.equal(l.length, 36, 'the specials stay in the list');
  const at = new Map<string, number>(l.map((x: any) => [x.chosen.title, Math.round(Number(x.n) * 1000) / 1000]));
  assert.equal(at.get('24. The Other Side'), 24, 'the chapter the screenshot shows as 27');
  assert.equal(at.get('25. What\'s To Come'), 25);
  NAMES.forEach((name, i) => assert.equal(at.get(`${i + 1}. ${name}`), i + 1, `chapter ${i + 1} at its own number`));
  assert.equal(at.get('Caption Contest!'), 24.01, 'a special just after the chapter before it');
  assert.equal(at.get('Q&A Announcement!'), 25.01);
  assert.equal(at.get('Character Sheet'), 5.01);
});

test('an existing series is held for review, not renamed', { skip }, async () => {
  await seedSeries(S, FOLDER);
  // What v0.102 holds: the posts around the screenshot under the extension's numbers, one of them without its stamp.
  for (const scene of [26, 27, 28, 29, 30]) await seedBook(S, FOLDER, scene, scene !== 29);
  const before = await booksOf(S);
  const r = await updater.updateSeries(S, 1);
  assert.equal(r.outcome, 'renumber_pending', 'held, whatever the plan');
  assert.equal(r.added, 0, 'nothing downloads under numbers that are about to move');
  const row = (await q('SELECT numbering, numbering_pending, numbering_source FROM lib_series WHERE id = $1', [S]))[0];
  assert.deepEqual([row.numbering, row.numbering_pending, row.numbering_source], [null, 'titles', TAPAS]);
  assert.deepEqual(await booksOf(S), before, 'no row moved');
  assert.deepEqual(filesIn(FOLDER), [26, 27, 28, 29, 30].map((n) => `Chapter ${n}.cbz`).sort(), 'no file moved');
});

test('the plan, then an admin\'s confirmation: each file to its title\'s number, in place', { skip }, async () => {
  const before = await booksOf(S);
  // The plan an admin is shown, without changing anything.
  const p = await numbering.requestNumbering(S, 'titles', { userId: adminId });
  assert.equal(p.state, 'needs_confirm');
  const moves = new Map<string, any>(p.plan.moves.map((m: any) => [m.bookId, m]));
  const want: Array<[number, number, string]> = [[26, 23, 'id'], [27, 24, 'id'], [28, 24.01, 'id'], [29, 25, 'name'], [30, 25.01, 'id']];
  for (const [scene, to, how] of want) {
    assert.equal(moves.get(`${S}_b${scene}`)?.to, to, `Chapter ${scene}.cbz is ${scenePost(scene).name}, ${to}`);
    assert.equal(moves.get(`${S}_b${scene}`)?.how, how, `Chapter ${scene}.cbz matched by ${how}`);
  }
  assert.equal(p.plan.clean, true, 'every file matched by its own evidence');
  assert.deepEqual(filesIn(FOLDER), [26, 27, 28, 29, 30].map((n) => `Chapter ${n}.cbz`).sort(), 'nothing moved yet');

  const r = await numbering.requestNumbering(S, 'titles', { confirm: true, userId: adminId });
  assert.equal(r.state, 'applied');
  const after = await booksOf(S);
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), 'the same book ids, none minted, none lost');
  for (const [scene, to] of want) assert.deepEqual(after.get(`${S}_b${scene}`), { number: to, file: `${FOLDER}/Chapter ${to}.cbz` });
  assert.deepEqual(filesIn(FOLDER), ['Chapter 23.cbz', 'Chapter 24.01.cbz', 'Chapter 24.cbz', 'Chapter 25.01.cbz', 'Chapter 25.cbz']);
  const row = (await q('SELECT numbering, numbering_by, numbering_pending, renumber_plan FROM lib_series WHERE id = $1', [S]))[0];
  assert.deepEqual([row.numbering, row.numbering_by, row.numbering_pending, row.renumber_plan], ['titles', 'manual', null, null]);

  // The next check reads the source by its titles: nothing held, nothing moves, the listing at the titles' numbers.
  const up = await updater.updateSeries(S, 0);
  assert.equal(up.outcome, 'ok');
  const l = await listingOf(S);
  assert.equal(l.length, 36);
  assert.deepEqual(['24. The Other Side', 'Caption Contest!', '25. What\'s To Come', 'Q&A Announcement!'].map((t) => l.find((x: any) => x.title === t)?.n),
    [24, 24.01, 25, 25.01]);
  assert.deepEqual([...(await booksOf(S)).values()].map((b) => b.number).sort((a, b) => a - b), [23, 24, 24.01, 25, 25.01], 'no file moved');
});

test('the undo goes back to the source\'s numbers, every file kept', { skip }, async () => {
  const ids = [...(await booksOf(S)).keys()].sort();
  // A file with no stamp of the post it holds, as a scan takes in one copied there by hand: the titles' reading -- the
  // numbering the files are in -- says which post is at its number, one post to a number.
  await q('UPDATE lib_books SET source_chapter_id = NULL WHERE id = $1', [`${S}_b29`]);
  const p = await numbering.requestNumbering(S, 'source', { userId: adminId });
  assert.equal(p.plan.moves.find((m: any) => m.bookId === `${S}_b29`)?.how, 'stored', 'the unstamped file is matched through the titles\' reading');
  assert.equal(p.plan.clean, true);
  const r = await numbering.requestNumbering(S, 'source', { confirm: true, userId: adminId });
  assert.equal(r.state, 'applied');
  const after = await booksOf(S);
  assert.deepEqual([...after.keys()].sort(), ids, 'no book lost or minted');
  for (const scene of [26, 27, 28, 29, 30]) assert.deepEqual(after.get(`${S}_b${scene}`), { number: scene, file: `${FOLDER}/Chapter ${scene}.cbz` });
  const row = (await q('SELECT numbering, numbering_by, numbering_pending FROM lib_series WHERE id = $1', [S]))[0];
  assert.deepEqual([row.numbering, row.numbering_by, row.numbering_pending], ['source', 'manual', null]);
  // The detector still fires on the source, and the admin's choice stands.
  const up = await updater.updateSeries(S, 0);
  assert.equal(up.outcome, 'ok');
  assert.equal((await q('SELECT numbering_pending FROM lib_series WHERE id = $1', [S]))[0].numbering_pending, null);
  assert.equal((await listingOf(S)).find((x: any) => x.title === '24. The Other Side')?.n, 27, 'the source\'s numbers again');
});

test('Health names the review, and Keep the source\'s numbers ends it: nothing renamed, nothing held', { skip }, async () => {
  await seedSeries(S2, FOLDER2);
  for (const scene of [27, 28]) await seedBook(S2, FOLDER2, scene);
  assert.equal((await updater.updateSeries(S2, 0)).outcome, 'renumber_pending');
  const { runHealthChecks } = await import('../src/lib/health');
  const item = (await runHealthChecks()).checks.find((c: any) => c.id === 'numbering')?.items.find((i: any) => i.seriesId === S2);
  assert.equal(item?.detail, 'Tapas counts its specials as chapters, so its chapter numbers run ahead of their titles (it numbers “30. Lights Out” 35); '
    + 'numbering them by their titles waits for your review. Nothing downloads for this series until then.');
  assert.deepEqual(item?.actions, ['renumber', 'keep_numbers']);
  assert.equal(item?.detailSaid?.[0]?.code, 'numbering.titles', 'in codes, so the page words it in the reader\'s language');

  const r = await numbering.requestNumbering(S2, 'source', { userId: adminId });
  assert.equal(r.state, 'unchanged');
  const row = (await q('SELECT numbering, numbering_by, numbering_pending FROM lib_series WHERE id = $1', [S2]))[0];
  assert.deepEqual([row.numbering, row.numbering_by, row.numbering_pending], ['source', 'manual', null]);
  assert.equal((await updater.updateSeries(S2, 0)).outcome, 'ok', 'not held, and not asked again');
  assert.equal((await q('SELECT numbering_pending FROM lib_series WHERE id = $1', [S2]))[0].numbering_pending, null);
  assert.deepEqual(filesIn(FOLDER2), ['Chapter 27.cbz', 'Chapter 28.cbz'], 'nothing renamed');
});

test('a follower that counts its specials lines up with a main that numbers its chapters', { skip }, async () => {
  // The reporter's "via Tapas (EN)": the series' main source numbers the chapters as their creator does, and a
  // followed Tapas counts its specials. Its copies are read by their titles, so its "24. The Other Side" is a version
  // of chapter 24, never of chapter 27, and its specials are listed between the chapters.
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, source_id, source_series_id, auto_update)
           VALUES ($1, 'Main (test)', 'Lumen Street', $2, 0, $3, $4, 'lumen', true)`, [S3, FOLDER3, LIB, MAIN]);
  await q('INSERT INTO series_sources (series_id, source_id, source_series_id) VALUES ($1, $2, $3)', [S3, TAPAS, String(fake!.manga('Lumen Street').id)]);
  const r = await updater.updateSeries(S3, 0);
  assert.equal(r.outcome, 'ok');
  const l = await listingOf(S3);
  const titlesAt = (n: number) => (l.find((x: any) => x.n === n)?.copies ?? []).map((c) => c.title).sort();
  assert.deepEqual(titlesAt(24), ['24. The Other Side', 'Chapter 24: The Other Side']);
  assert.deepEqual(titlesAt(27), ['27. Daybreak', 'Chapter 27: Daybreak']);
  assert.deepEqual(titlesAt(24.01), ['Caption Contest!']);
  assert.equal((await q('SELECT numbering, numbering_pending FROM lib_series WHERE id = $1', [S3]))[0].numbering_pending, null, 'nothing to review: the main\'s numbers are the chapters\'');
});

test('added back over its old files, a series is added for review, never numbered blind', { skip }, async () => {
  // Removed from the library with its files left at the extension's numbers: numbering the listing by the titles over
  // them would file post 28 (Caption Contest!) as chapter 28.
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, source_id, source_series_id, auto_update, deleted_at)
           VALUES ($1, 'Tapas', 'Night Ferry', $2, 0, $3, $4, $5, true, now())`, [S5, FOLDER5, LIB, TAPAS, String(fake!.manga('Night Ferry').id)]);
  for (const scene of [27, 28]) await seedBook(S5, FOLDER5, scene, true, 'Night Ferry');
  const r = await app.inject({ method: 'POST', url: '/api/sources/add', headers: { authorization: token },
    payload: { source: TAPAS, sourceId: String(fake!.manga('Night Ferry').id), chapterFrom: 'none' } });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().seriesId, S5, 'the row is revived');
  const row = (await q('SELECT numbering, numbering_pending, numbering_source FROM lib_series WHERE id = $1', [S5]))[0];
  assert.deepEqual([row.numbering, row.numbering_pending, row.numbering_source], [null, 'titles', TAPAS], 'added for review');
  assert.equal((await listingOf(S5)).find((x: any) => x.title === 'Caption Contest!')?.n, 28, 'the listing in the source\'s numbers, as the files are');
  assert.deepEqual(filesIn(FOLDER5), ['Chapter 27.cbz', 'Chapter 28.cbz'], 'nothing renamed');
});

test('a proposal whose verdict has gone is withdrawn', { skip }, async () => {
  // The specials deleted at the source: it counts only chapters now, and there is nothing left to review.
  const plain = NAMES.map((name, i) => ({ sourceId: `p${i + 1}`, number: i + 1, title: `${i + 1}. ${name}`, order: i + 1 }));
  const row = { id: 's_tn_none', numbering: null, numbering_by: null, numbering_source: TAPAS, numbering_pending: 'titles', numbering_note: null };
  assert.equal((await numbering.decideNumbering(row, TAPAS, plain)).numbering_pending, null);
  // One an admin asked for stays.
  assert.equal((await numbering.decideNumbering({ ...row, numbering_by: 'manual' }, TAPAS, plain)).numbering_pending, 'titles');
  // And one still standing stays.
  const { getSource } = await import('../src/lib/sources');
  const live = await getSource(TAPAS)!.listChapters(String(fake!.manga('Lumen Street').id));
  assert.equal((await numbering.decideNumbering(row, TAPAS, live)).numbering_pending, 'titles');
});

test('Find missing reads a source by its titles, as the check does', { skip }, async () => {
  // A series numbered by its titles that holds chapters 1 to 30. Its own source, read as it comes, lists 36 numbers, and
  // Find missing offered 31 to 36 -- chapters 26 to 30 and a special, under numbers that are not theirs.
  await seedSeries(S6, FOLDER6, { numbering: 'titles', numbering_by: 'auto', numbering_source: TAPAS });
  mkdirSync(join(DL, FOLDER6), { recursive: true });
  for (let n = 1; n <= 30; n++) {
    writeFileSync(join(DL, FOLDER6, `Chapter ${n}.cbz`), 'x'.repeat(100));
    await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, root, source_id) VALUES ($1,$2,'Tapas',$3,$4,$5,$6,$7)`,
      [`${S6}_c${n}`, S6, `${FOLDER6}/Chapter ${n}.cbz`, n, `Chapter ${n}`, DL, TAPAS]);
  }
  const r = await app.inject({ method: 'POST', url: '/api/sources/fill/scan', headers: { authorization: token }, payload: { seriesId: S6 } });
  assert.equal(r.statusCode, 200, r.body);
  let plan = r.json();
  for (let i = 0; !plan.done && i < 100; i++) {
    await new Promise((res) => setTimeout(res, 50));
    plan = (await app.inject({ method: 'GET', url: `/api/sources/fill/scan/${plan.scanId ?? plan.id}`, headers: { authorization: token } })).json();
  }
  const own = plan.candidates.find((c: any) => c.pinned);
  assert.deepEqual([own?.count, own?.first, own?.last], [36, 1, 30.01], 'its own source in the numbers the series keeps');
  // Find missing counts whole chapters: the special after 30 is no chapter it lacks.
  assert.deepEqual(own?.newer, [], 'nothing new: every chapter it lists is held');
});
