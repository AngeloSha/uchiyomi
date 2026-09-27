// The numbering routes an admin drives from the series page and Health (#116, routes/numbering.ts): the plan,
// shown before anything moves; the change, carried out only with `confirm`; "Keep the source's numbers", which
// renames nothing; the remap an extension setting queued; and the listing route's `numbering`, which every viewer
// of the series reads.
//
// The source is a plain test adapter serving Istrevelia's 226 posts the way the Webtoons extension numbers them
// -- episode numbers, or 1..226 once its "sequential chapter numbering" switch is on (`sequential` below).
// Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { istreveliaPosts, webtoonsNumbers } from './fixtures/fakeSuwayomi';

const DSN = process.env.TEST_DATABASE_URL;
let ROOT = '';
let DL = '';
if (DSN) {
  ROOT = mkdtempSync(join(tmpdir(), 'uchiyomi-nr-'));
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
  process.env.UPDATER_LIST_TIMEOUT_MS = '5000';
  process.env.UCHIYOMI_PING_URL = '';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const LIB = 'lib_nr';
const WEB = 'nr-web';
const HELD = 's_nr_held', FHELD = 'Webtoons (nr)/Held';
const KEEP = 's_nr_keep', FKEEP = 'Webtoons (nr)/Keep';
const REMAP = 's_nr_remap', FREMAP = 'Webtoons (nr)/Remap';
const ALL = [HELD, KEEP, REMAP];

const POSTS = DSN ? istreveliaPosts() : [];
const EPISODES = DSN ? webtoonsNumbers(POSTS, false) : [];
const SEQUENTIAL = DSN ? webtoonsNumbers(POSTS, true) : [];
/** The extension's "Use sequential chapter numbering" switch, as this test adapter models it. */
let sequential = false;
const post = (k: number, seq = sequential) => {
  const n = (seq ? SEQUENTIAL : EPISODES)[k - 1];
  return { sourceId: `nr-${k}`, number: n.chapterNumber, title: n.name, publishedAt: new Date(POSTS[k - 1].uploadDate).toISOString(), order: k, pages: 1 };
};

let q: any, app: any, busyFolders: Set<string>, admin = '', member = '';

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  await migrate();
  ({ q } = (await import('../src/lib/db')) as any);
  ({ busyFolders } = (await import('../src/lib/bulkNewest')) as any);
  const { registerAdapter } = await import('../src/lib/sources');
  registerAdapter({
    id: WEB, name: 'Webtoons (nr)',
    async search() { return []; },
    async getSeries(sid: string) { return { sourceId: sid, source: WEB, title: 'Istrevelia' }; },
    async listChapters() { return POSTS.map((_: unknown, i: number) => post(i + 1)); },
    async getPageUrls() { return []; },
    async latest() { return []; },
  } as any);
  await q('DELETE FROM source_health WHERE source_id = $1', [WEB]);
  await q(`INSERT INTO libraries (id, name, path) VALUES ($1,'Numbered routes',$1) ON CONFLICT (id) DO NOTHING`, [LIB]);
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [ALL]);

  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/admin')).default);
  await app.register((await import('../src/routes/catalog')).default);
  await app.ready();
  await q(`DELETE FROM users WHERE username = ANY($1)`, [['nr-admin', 'nr-member']]);
  const mk = async (name: string, role: string) => (await q(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ($1,$1,'x',$2,'password') RETURNING id`, [name, role]))[0].id;
  admin = `Bearer ${app.jwt.sign({ sub: await mk('nr-admin', 'admin'), role: 'admin' })}`;
  member = `Bearer ${app.jwt.sign({ sub: await mk('nr-member', 'user'), role: 'user' })}`;
});

after(async () => {
  if (!DSN) return;
  await app?.close();
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [ALL]).catch(() => {});
  await q('DELETE FROM libraries WHERE id = $1', [LIB]).catch(() => {});
  await q(`DELETE FROM users WHERE username = ANY($1)`, [['nr-admin', 'nr-member']]).catch(() => {});
  rmSync(ROOT, { recursive: true, force: true });
});

async function seedSeries(id: string, folder: string, extra: Record<string, unknown> = {}) {
  const cols = ['id', 'source', 'title', 'folder', 'books_count', 'library_id', 'source_id', 'source_series_id', 'auto_update', ...Object.keys(extra)];
  const vals = [id, 'Webtoons (nr)', 'Istrevelia', folder, 0, LIB, WEB, 'istrevelia', true, ...Object.values(extra)];
  await q(`INSERT INTO lib_series (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`, vals);
}
/** A chapter on disk at `Chapter <raw>.cbz` holding post k, named as setBookMeta named it under episode numbers. */
async function seedBook(series: string, folder: string, raw: number, k: number) {
  mkdirSync(join(DL, folder), { recursive: true });
  writeFileSync(join(DL, folder, `Chapter ${raw}.cbz`), 'x'.repeat(100));
  const { chapterName } = await import('../src/lib/naming');
  const p = post(k, false);
  await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, root, chapter_name, source_id)
           VALUES ($1,$2,'Webtoons (nr)',$3,$4,$5,$6,$7,$8)`,
    [`${series}_b${raw}`, series, `${folder}/Chapter ${raw}.cbz`, raw, `Chapter ${raw}`, DL, chapterName(p.title, p.number), WEB]);
}
const filesIn = (folder: string) => readdirSync(join(DL, folder)).sort();
const numbers = async (series: string) =>
  Object.fromEntries((await q('SELECT id, number::float8 AS n FROM lib_books WHERE series_id = $1', [series])).map((r: any) => [r.id, Number(r.n)]));
const rowOf = async (id: string) => (await q('SELECT numbering, numbering_by, numbering_pending FROM lib_series WHERE id = $1', [id]))[0];
const inject = (method: string, url: string, payload?: unknown, auth = admin) => app.inject({ method, url, headers: { authorization: auth }, ...(payload ? { payload } : {}) });

/** Raw number -> the post whose file it is: the first posts of episodes 1, 2 and 3 (posts 1, 21 and 42). */
const HELD_BOOKS: Array<[number, number]> = [[1, 1], [2, 21], [3, 42]];

test('the plan is shown before anything moves, and applied only on confirm', { skip }, async () => {
  sequential = false;
  await seedSeries(HELD, FHELD, { numbering_pending: 'posting_order', numbering_source: WEB });
  for (const [raw, k] of HELD_BOOKS) await seedBook(HELD, FHELD, raw, k);

  // Reintroduce by mounting routes/numbering.ts beside admin.ts instead of inside it (drop its register line
  // there, and register it on this app next to admin.ts): a member reads the plan -- 200.
  assert.equal((await inject('GET', `/api/admin/series/${HELD}/numbering`, undefined, member)).statusCode, 403, 'admins only: a member reads no plan');
  assert.equal((await inject('POST', `/api/admin/series/${HELD}/numbering`, { mode: 'posting_order', confirm: true }, member)).statusCode, 403);
  assert.equal((await inject('GET', `/api/admin/series/${HELD}/numbering?mode=sideways`)).statusCode, 400);
  assert.equal((await inject('GET', '/api/admin/series/s_nr_nobody/numbering')).statusCode, 404);

  const g = await inject('GET', `/api/admin/series/${HELD}/numbering`);
  assert.equal(g.statusCode, 200, g.body);
  assert.equal(g.json().mode, 'posting_order', 'the change waiting for review, by default');
  const moves = Object.fromEntries(g.json().plan.moves.map((m: any) => [m.bookId, [m.from, m.to]]));
  assert.deepEqual(moves, { [`${HELD}_b1`]: [1, 1], [`${HELD}_b2`]: [2, 21], [`${HELD}_b3`]: [3, 42] }, 'each file to its own post');
  assert.equal(g.json().numbering.pending, 'posting_order');

  const ask = await inject('POST', `/api/admin/series/${HELD}/numbering`, { mode: 'posting_order' });
  assert.equal(ask.statusCode, 200, ask.body);
  assert.equal(ask.json().state, 'needs_confirm', 'without confirm, only the plan');
  assert.deepEqual(filesIn(FHELD), ['Chapter 1.cbz', 'Chapter 2.cbz', 'Chapter 3.cbz'], 'nothing moved');

  // A download writing into the folder: a rename now would race it.
  busyFolders.add(FHELD);
  try {
    const busy = await inject('POST', `/api/admin/series/${HELD}/numbering`, { mode: 'posting_order', confirm: true });
    assert.equal(busy.statusCode, 409, busy.body);
    assert.equal(busy.json().error, 'busy');
  } finally {
    busyFolders.delete(FHELD);
  }
  assert.deepEqual(filesIn(FHELD), ['Chapter 1.cbz', 'Chapter 2.cbz', 'Chapter 3.cbz']);

  const ok = await inject('POST', `/api/admin/series/${HELD}/numbering`, { mode: 'posting_order', confirm: true });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().state, 'applied');
  assert.equal(ok.json().numbering.mode, 'posting_order', 'the answer carries the series\' numbering as it now is');
  assert.deepEqual(filesIn(FHELD), ['Chapter 1.cbz', 'Chapter 21.cbz', 'Chapter 42.cbz']);
  assert.deepEqual(await numbers(HELD), { [`${HELD}_b1`]: 1, [`${HELD}_b2`]: 21, [`${HELD}_b3`]: 42 });
  assert.deepEqual(await rowOf(HELD), { numbering: 'posting_order', numbering_by: 'manual', numbering_pending: null });

  // What the series page reads, for any viewer of it.
  const l = await inject('GET', `/api/series/${HELD}/listing`);
  assert.equal(l.statusCode, 200, l.body);
  // Reintroduce by answering listingFor alone in GET /api/series/:id/listing: `numbering` is undefined.
  assert.deepEqual([l.json().numbering?.mode, l.json().numbering?.pending, l.json().numbering?.sourceName], ['posting_order', null, 'Webtoons (nr)']);
  assert.equal(l.json().content.length, 223, 'the listing is in posting numbers: 226 posts, 3 on disk');
});

test('"Keep the source\'s numbers" renames nothing and is not asked again', { skip }, async () => {
  sequential = false;
  await seedSeries(KEEP, FKEEP, { numbering_pending: 'posting_order', numbering_source: WEB });
  for (const [raw, k] of HELD_BOOKS) await seedBook(KEEP, FKEEP, raw, k);
  const r = await inject('POST', `/api/admin/series/${KEEP}/numbering`, { mode: 'source' });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().state, 'unchanged', 'already numbered that way: no plan, no confirm');
  assert.deepEqual(await rowOf(KEEP), { numbering: 'source', numbering_by: 'manual', numbering_pending: null }, 'the proposal is dropped, as the admin\'s choice');
  assert.deepEqual(filesIn(FKEEP), ['Chapter 1.cbz', 'Chapter 2.cbz', 'Chapter 3.cbz']);
  const { updateSeries } = await import('../src/lib/updater');
  const up = await updateSeries(KEEP, 0);
  assert.equal(up.outcome, 'ok', 'the detector still fires, and the choice stands');
  assert.equal((await rowOf(KEEP)).numbering_pending, null);
});

test('a remap queued by an extension setting is planned by name and applied on confirm', { skip }, async () => {
  // Files named under episode numbers, and the extension switched to sequential numbering since.
  sequential = false;
  await seedSeries(REMAP, FREMAP, { numbering_pending: 'remap' });
  for (const [raw, k] of HELD_BOOKS) await seedBook(REMAP, FREMAP, raw, k);
  sequential = true;

  const g = await inject('GET', `/api/admin/series/${REMAP}/numbering`);
  assert.equal(g.statusCode, 200, g.body);
  assert.equal(g.json().mode, 'remap');
  const moves = Object.fromEntries(g.json().plan.moves.map((m: any) => [m.bookId, [m.to, m.how]]));
  assert.deepEqual(moves, { [`${REMAP}_b1`]: [1, 'name'], [`${REMAP}_b2`]: [21, 'name'], [`${REMAP}_b3`]: [42, 'name'] });

  const ask = await inject('POST', `/api/admin/series/${REMAP}/numbering`, { mode: 'remap' });
  assert.equal(ask.json().state, 'needs_confirm', ask.body);
  // Reintroduce by dropping the `remap` branch of requestNumbering: the request is taken as an admin CHOOSING a
  // numbering called 'remap' -- the series is marked a manual choice ("still the source's numbers, and nothing
  // left to review" reads numbering_by 'manual'), and a remap nobody queued is queued and run by asking.
  const ok = await inject('POST', `/api/admin/series/${REMAP}/numbering`, { mode: 'remap', confirm: true });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().state, 'applied');
  assert.deepEqual(filesIn(FREMAP), ['Chapter 1.cbz', 'Chapter 21.cbz', 'Chapter 42.cbz'], 'each file under its post\'s new number');
  const row = await rowOf(REMAP);
  assert.deepEqual([row.numbering, row.numbering_by, row.numbering_pending], [null, null, null], 'still the source\'s numbers, and nothing left to review');
  const again = await inject('POST', `/api/admin/series/${REMAP}/numbering`, { mode: 'remap', confirm: true });
  assert.equal(again.json().state, 'unchanged', 'a remap with nothing queued does nothing');
});
