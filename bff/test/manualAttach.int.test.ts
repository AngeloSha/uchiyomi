// Attaching a source by hand (lib/manualAttach.ts, #243), through the real routes: a series with one chapter -- or none --
// has nothing for the overlap gates to judge, so a person's pick is taken; the pair is still checked with the source
// (its own title must be ours, else the person must insist), and the gates that are not opinion still hold.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DSN = process.env.TEST_DATABASE_URL;
let ROOT = '';
if (DSN) {
  ROOT = mkdtempSync(join(tmpdir(), 'yomi-attach-'));
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.DL_ROOT = ROOT;
  process.env.DOWNLOAD_MIN_GAP_MS = '0';
  process.env.DOWNLOAD_PAGE_GAP_MS = '0';
  process.env.MIN_FREE_GB = '0';
  process.env.UCHIYOMI_PING_URL = '';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const LIB = 'lib_attach', ADMIN = 'attach-admin';
const S = (k: string) => `s_attach_${k}`;
/** Every source the fixtures use; `at-gone` is followed and never registered. */
const SOURCES = ['at-a', 'at-b', 'at-c', 'at-d', 'at-es', 'at-all', 'at-gone'];
/** When set, every fake source's listing waits on it: a refresh -- or a check -- that stays inside its series. */
let hold: Promise<void> | null = null;
let release: () => void = () => {};
const realFetch = globalThis.fetch;
/** What a fake source says a pick is: its title is the id unless named here; `null` answers with no title. */
const said = new Map<string, { title?: string | null; contentRating?: string } | 'throw'>();
/** Every getSeries a fake source was asked, as `source:id`. */
const asked: string[] = [];
/** Run while a getSeries is answered: what happens between the server's checks and the write. */
let duringLookup: (() => Promise<void>) | null = null;

function fake(id: string, lang?: string) {
  return {
    id, name: `Name ${id}`, ...(lang ? { lang } : {}),
    async search() { return []; },
    async getSeries(sid: string) {
      asked.push(`${id}:${sid}`);
      if (duringLookup) await duringLookup();
      const s = said.get(sid);
      if (s === 'throw') throw new Error('unreachable');
      return { sourceId: sid, source: id, title: s?.title === undefined ? sid : s.title, ...(s?.contentRating ? { contentRating: s.contentRating } : {}) };
    },
    async listChapters() {
      if (hold) await hold;
      return [1, 2, 3, 4, 5, 6, 7].map((n) => ({ number: n, title: `Chapter ${n}`, sourceId: `${id}:${n}` }));
    },
    async getPageUrls(chId: string) { return [`https://ms.invalid/${chId}.png`]; },
    async latest() { return []; },
  };
}

let q: any, app: any, auth: Record<string, string>, adminId = '';
let runsInside: (id: string) => number, updateSeries: any;

/** A series on `main`, following `followers` in that order, each a minute apart so the follow order is the order given. */
async function series(key: string, main: string, followers: string[] = []) {
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, source_id, source_series_id, auto_update)
           VALUES ($1,'T!main',$1,$1,0,$2,$3,$4,true)`, [S(key), LIB, main, `${main}|${key}`]);
  for (const [i, f] of followers.entries()) {
    await q(`INSERT INTO series_sources (series_id, source_id, source_series_id, created_at)
             VALUES ($1, $2, $3, now() - interval '1 hour' + $4 * interval '1 minute')`, [S(key), f, `${f}|${key}`, i]);
  }
}
const post = (id: string, payload: unknown) =>
  app.inject({ method: 'POST', url: `/api/admin/series/${id}/attach-source`, headers: auth, payload });
const followers = async (id: string) =>
  (await q('SELECT source_id FROM series_sources WHERE series_id = $1 ORDER BY created_at, source_id', [id])).map((r: any) => r.source_id);
const mainOf = async (id: string) => (await q('SELECT source_id FROM lib_series WHERE id = $1', [id]))[0]?.source_id;
const until = async (cond: () => boolean, what: string, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};
/** Hold every listing, so a refresh the route starts cannot touch what a test reads. */
const holdListings = () => { hold = new Promise<void>((r) => { release = r; }); };
/** Let it go, and wait until no run is inside the series. */
const settle = async (id: string) => { release(); hold = null; await until(() => runsInside(id) === 0, `the runs inside ${id}`); };

before(async () => {
  if (!DSN) return;
  const sharp = (await import('sharp')).default;
  const PIXEL = await sharp({ create: { width: 4, height: 6, channels: 3, background: '#5a7fa2' } }).png().toBuffer();
  globalThis.fetch = (async (url: any) => (String(url).startsWith('https://ms.invalid/')
    ? new Response(PIXEL, { status: 200, headers: { 'content-type': 'image/png' } })
    : realFetch(url))) as typeof fetch;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  await migrate();
  ({ runsInside, updateSeries } = (await import('../src/lib/updater')) as any);
  const { registerAdapter } = await import('../src/lib/sources');
  for (const id of ['at-a', 'at-b', 'at-c', 'at-d']) registerAdapter(fake(id) as any);
  registerAdapter(fake('at-es', 'es') as any);
  // Every language: it says nothing about which one a series is in (lib/seriesLang.ts).
  registerAdapter(fake('at-all', 'all') as any);
  (await import('../src/lib/healthSummary')).setSummaryRefresh(async () => {}, { everyMs: 1 });

  await q(`INSERT INTO libraries (id, name, path) VALUES ($1,'Main',$1) ON CONFLICT (id) DO NOTHING`, [LIB]);
  await q('DELETE FROM users WHERE username = $1', [ADMIN]);
  adminId = (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ($1,$1,'x','admin','password') RETURNING id`, [ADMIN]))[0].id;
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/admin')).default);
  await app.register((await import('../src/routes/catalog')).default);
  await app.ready();
  auth = { authorization: `Bearer ${app.jwt.sign({ sub: adminId, role: 'admin' })}` };
});

beforeEach(async () => {
  if (!DSN) return;
  hold = null;
  said.clear();
  asked.length = 0;
  duringLookup = null;
  await q('DELETE FROM lib_series WHERE library_id = $1', [LIB]);
  await q('DELETE FROM source_health WHERE source_id = ANY($1::text[])', [SOURCES]);
  await q(`DELETE FROM audit_log WHERE event = 'series.attach_source'`);
});

after(async () => {
  globalThis.fetch = realFetch;
  if (ROOT) rmSync(ROOT, { recursive: true, force: true });
  if (!DSN) return;
  release();
  (await import('../src/lib/healthSummary')).setSummaryRefresh();
  await app?.close();
  await q('DELETE FROM lib_series WHERE library_id = $1', [LIB]).catch(() => {});
  await q('DELETE FROM libraries WHERE id = $1', [LIB]).catch(() => {});
  await q('DELETE FROM users WHERE username = $1', [ADMIN]).catch(() => {});
  await q('DELETE FROM source_health WHERE source_id = ANY($1::text[])', [SOURCES]).catch(() => {});
  await (await import('../src/lib/db')).pool.end().catch(() => {});
});

const detach = (id: string, sourceId: string) =>
  app.inject({ method: 'DELETE', url: `/api/admin/series/${id}/sources/${sourceId}`, headers: auth });

test('a pick is followed with no chapter overlap, and it is a person\'s follow', { skip }, async () => {
  await series('one', 'at-a');
  holdListings();
  try {
    const r = await post(S('one'), { source: 'at-b', sourceSeriesId: S('one'), as: 'follower' });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(await followers(S('one')), ['at-b']);
    assert.notEqual((await q('SELECT added_by FROM series_sources WHERE series_id = $1', [S('one')]))[0].added_by, null);
    assert.equal(await mainOf(S('one')), 'at-a');
  } finally { await settle(S('one')); }
});

test('the follower cap holds for a follow, and the main can still be moved past it', { skip }, async () => {
  await series('cap', 'at-a', ['at-b', 'at-c']);
  holdListings();
  try {
    const full = await post(S('cap'), { source: 'at-d', sourceSeriesId: S('cap'), as: 'follower' });
    assert.equal(full.statusCode, 409);
    assert.equal(full.json().error, 'cap');
    assert.equal(full.json().messageSaid.code, 'attach.cap', 'the refusal is not said in the reader\'s language');
    const moved = await post(S('cap'), { source: 'at-d', sourceSeriesId: S('cap'), as: 'main' });
    assert.equal(moved.statusCode, 200, moved.body);
    assert.equal(await mainOf(S('cap')), 'at-d');
    assert.equal((await q('SELECT source_series_id FROM lib_series WHERE id = $1', [S('cap')]))[0].source_series_id, S('cap'));
    assert.ok(!(await followers(S('cap'))).includes('at-a'), 'the old main is dropped by default');
  } finally { await settle(S('cap')); }
});

test('a series with no source takes the pick as its main, whichever is asked', { skip }, async () => {
  await series('none', 'at-a');
  await q('UPDATE lib_series SET source_id = NULL, source_series_id = NULL WHERE id = $1', [S('none')]);
  holdListings();
  try {
    const r = await post(S('none'), { source: 'at-b', sourceSeriesId: S('none'), as: 'follower' });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(await mainOf(S('none')), 'at-b');
  } finally { await settle(S('none')); }
});

test('refusals that are not opinion still hold: the main itself, another language, posting order', { skip }, async () => {
  await series('ref', 'at-a');
  assert.equal((await post(S('ref'), { source: 'at-a', sourceSeriesId: 'x', as: 'follower' })).json().error, 'is_main');
  assert.equal((await post(S('ref'), { source: 'at-es', sourceSeriesId: 'x', as: 'follower' })).json().error, 'language_differs');
  await q(`UPDATE lib_series SET numbering = 'posting_order' WHERE id = $1`, [S('ref')]);
  assert.equal((await post(S('ref'), { source: 'at-b', sourceSeriesId: 'x', as: 'follower' })).json().error, 'posting_order');
});

test('detaching the main promotes a follower; with none, the series is left without a source', { skip }, async () => {
  await series('det', 'at-a', ['at-b']);
  holdListings();
  try {
    const r = await detach(S('det'), 'at-a');
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(await mainOf(S('det')), 'at-b');
    assert.deepEqual(await followers(S('det')), []);
    // The promotion starts a check of the series; a second detach while it runs is refused as busy, so let it finish.
    await settle(S('det'));
    holdListings();
    const r2 = await detach(S('det'), 'at-b');
    assert.equal(r2.statusCode, 200, r2.body);
    assert.equal(await mainOf(S('det')), null);
  } finally { await settle(S('det')); }
});

test('a pick whose own title is another work is refused until the person insists, and the source\'s title is stored', { skip }, async () => {
  // The pair is never taken on trust: the server asks the source, and "Other Work" is not this series or another name.
  // Reintroduce by storing the request's title and skipping the lookup: the first assertion reads 200.
  await series('tit', 'at-a');
  said.set('tit-1', { title: 'Other Work' });
  const r = await post(S('tit'), { source: 'at-b', sourceSeriesId: 'tit-1', as: 'follower' });
  assert.equal(r.statusCode, 409, r.body);
  assert.equal(r.json().error, 'title_differs');
  assert.equal(r.json().theirTitle, 'Other Work');
  assert.equal(r.json().messageSaid.code, 'attach.titleDiffers');
  assert.deepEqual(await followers(S('tit')), [], 'a refused pick was followed');
  assert.ok(asked.includes('at-b:tit-1'), 'the source was never asked what the pick is');
  // The request no longer carries a title of its own: the strict body refuses one.
  assert.equal((await post(S('tit'), { source: 'at-b', sourceSeriesId: 'tit-1', as: 'follower', title: S('tit') })).statusCode, 400);
  holdListings();
  try {
    const forced = await post(S('tit'), { source: 'at-b', sourceSeriesId: 'tit-1', as: 'follower', force: true });
    assert.equal(forced.statusCode, 200, forced.body);
    assert.equal(forced.json().theirTitle, 'Other Work');
    assert.equal((await q('SELECT title FROM series_sources WHERE series_id = $1 AND source_id = $2', [S('tit'), 'at-b']))[0].title, 'Other Work');
    const audit = (await q(`SELECT detail FROM audit_log WHERE event = 'series.attach_source' ORDER BY at DESC LIMIT 1`))[0]?.detail;
    assert.equal(audit?.forced, true, 'an insisted attach is not marked as one');
  } finally { await settle(S('tit')); }
});

test('an other name the series goes by is its title too', { skip }, async () => {
  await series('alt', 'at-a');
  const { recordAltTitles, altTitlesFor } = await import('../src/lib/altTitles');
  await recordAltTitles(S('alt'), ['Walk Tale Original'], 'admin');
  assert.deepEqual(await altTitlesFor(S('alt')), ['Walk Tale Original'], 'the premise: the series goes by that name');
  said.set('alt-1', { title: 'Walk Tale Original' });
  holdListings();
  try {
    const r = await post(S('alt'), { source: 'at-b', sourceSeriesId: 'alt-1', as: 'follower' });
    assert.equal(r.statusCode, 200, r.body);
  } finally { await settle(S('alt')); }
});

test('a source that cannot say what the pick is, or is cooling down, is not attached', { skip }, async () => {
  await series('unr', 'at-a');
  said.set('unr-1', 'throw');
  const r = await post(S('unr'), { source: 'at-b', sourceSeriesId: 'unr-1', as: 'main', force: true });
  assert.equal(r.statusCode, 409, r.body);
  assert.equal(r.json().error, 'unreachable', 'force attaches a pair nobody could confirm exists');
  said.set('unr-2', { title: null });
  assert.equal((await post(S('unr'), { source: 'at-b', sourceSeriesId: 'unr-2', as: 'follower' })).json().error, 'unreachable');
  // A cooldown is the site asking for room: it is not asked anything, by hand or not.
  await q(`INSERT INTO source_health (source_id, blocked_until) VALUES ('at-c', now() + interval '1 hour')
           ON CONFLICT (source_id) DO UPDATE SET blocked_until = EXCLUDED.blocked_until`);
  asked.length = 0;
  const cool = await post(S('unr'), { source: 'at-c', sourceSeriesId: S('unr'), as: 'follower' });
  assert.equal(cool.json().error, 'cooling', cool.body);
  assert.deepEqual(asked, [], 'a cooling source was asked');
  assert.equal(await mainOf(S('unr')), 'at-a');
});

test('a refused move writes nothing: the follower row it would have replaced stays as it was', { skip }, async () => {
  // The series follows at-b at an old id. A move to at-b at a NEW id is checked, and while the source is being asked a
  // renumber arrives, so the switch refuses. The follower row must still name the old id and title.
  // Reintroduce by upserting the follower row before the switch (#243 as opened): the row reads the new id.
  await series('row', 'at-a', ['at-b']);
  await q(`UPDATE series_sources SET source_series_id = 'b-old', title = 'Old Title' WHERE series_id = $1 AND source_id = 'at-b'`, [S('row')]);
  said.set('b-new', { title: S('row') });
  duringLookup = async () => { await q(`UPDATE lib_series SET numbering_pending = 'posting_order' WHERE id = $1`, [S('row')]); };
  const r = await post(S('row'), { source: 'at-b', sourceSeriesId: 'b-new', as: 'main' });
  duringLookup = null;
  assert.equal(r.statusCode, 409, r.body);
  assert.equal(r.json().error, 'renumber_pending');
  const row = (await q('SELECT source_series_id, title FROM series_sources WHERE series_id = $1 AND source_id = $2', [S('row'), 'at-b']))[0];
  assert.deepEqual([row?.source_series_id, row?.title], ['b-old', 'Old Title'], 'the refused move overwrote the follower row');
  assert.equal(await mainOf(S('row')), 'at-a');
});

test('a title its source rates adults-only makes the series 18+', { skip }, async () => {
  await series('adl', 'at-a');
  said.set('adl-1', { title: S('adl'), contentRating: 'erotica' });
  holdListings();
  try {
    const r = await post(S('adl'), { source: 'at-b', sourceSeriesId: 'adl-1', as: 'main' });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal((await q('SELECT age_rating FROM lib_series WHERE id = $1', [S('adl')]))[0].age_rating, 18);
  } finally { await settle(S('adl')); }
});

test('a series numbered by posting order keeps its main source: detaching it is refused', { skip }, async () => {
  // Detached to no source, nothing could attach a new main to it again: every attach refuses posting order.
  // Reintroduce by dropping the posting-order check from detachMain: the DELETE answers 200 and the main is gone.
  await series('pdt', 'at-a');
  await q(`UPDATE lib_series SET numbering = 'posting_order' WHERE id = $1`, [S('pdt')]);
  const r = await detach(S('pdt'), 'at-a');
  assert.equal(r.statusCode, 409, r.body);
  assert.equal(r.json().error, 'posting_order');
  assert.equal(await mainOf(S('pdt')), 'at-a');
});
