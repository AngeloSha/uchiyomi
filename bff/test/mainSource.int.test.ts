// Making a followed source a series' main source (lib/mainSource.ts, v0.54.0), through the real route.
//
// aqua went offline and stayed the main source of 195 series: nothing could move a series off it, so every count,
// filter, queue and Health row kept naming it. These pin what a switch moves and what it keeps: the pair moves and the
// promoted row leaves the followers; a working old main stays as the last follower, a dead one goes with its listing
// rows and its chapters capped against it get another try; the language a series reads as does not change by the way;
// the follower cap holds; and every refusal leaves the main source as it was.
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
  ROOT = mkdtempSync(join(tmpdir(), 'yomi-main-'));
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

const LIB = 'lib_main', ADMIN = 'main-admin';
const S = (k: string) => `s_main_${k}`;
/** Every source the fixtures use; `ms-gone` is followed and never registered. */
const SOURCES = ['ms-a', 'ms-b', 'ms-c', 'ms-d', 'ms-es', 'ms-all', 'ms-gone'];
/** When set, every fake source's listing waits on it: a refresh -- or a check -- that stays inside its series. */
let hold: Promise<void> | null = null;
let release: () => void = () => {};
const realFetch = globalThis.fetch;

function fake(id: string, lang?: string) {
  return {
    id, name: `Name ${id}`, ...(lang ? { lang } : {}),
    async search() { return []; },
    async getSeries(sid: string) { return { sourceId: sid, source: id, title: sid }; },
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
  app.inject({ method: 'POST', url: `/api/admin/series/${id}/main-source`, headers: auth, payload });
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
  for (const id of ['ms-a', 'ms-b', 'ms-c', 'ms-d']) registerAdapter(fake(id) as any);
  registerAdapter(fake('ms-es', 'es') as any);
  // Every language: it says nothing about which one a series is in (lib/seriesLang.ts).
  registerAdapter(fake('ms-all', 'all') as any);
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
  await q('DELETE FROM lib_series WHERE library_id = $1', [LIB]);
  await q('DELETE FROM source_health WHERE source_id = ANY($1::text[])', [SOURCES]);
  await q(`DELETE FROM audit_log WHERE event = 'series.main_source'`);
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

test('a follower becomes the main source, and a working old main stays as the last follower', { skip }, async () => {
  // Reintroduce by dropping the DELETE of the promoted row: ms-b is still followed. By dropping the INSERT that keeps
  // the old main: ms-a is gone.
  await series('one', 'ms-a', ['ms-c', 'ms-b']);
  await q(`UPDATE lib_series SET source_checked_at = '2026-09-01T00:00:00Z', source_chapters = 7, source_missing = 0 WHERE id = $1`, [S('one')]);
  holdListings();
  try {
    const r = await post(S('one'), { sourceId: 'ms-b' });
    assert.equal(r.statusCode, 200, r.body);
    const j = r.json();
    assert.deepEqual([j.ok, j.from, j.to, j.old], [true, 'ms-a', 'ms-b', 'kept'], 'the old main is kept: it still carries the series, and promoting a follower made room');
    assert.equal('langPinned' in j, false, 'both declare nothing: the series reads as it did');
    assert.deepEqual(j.sources.map((s: any) => [s.sourceId, s.primary, s.standing]),
      [['ms-b', true, 'usable'], ['ms-c', false, 'usable'], ['ms-a', false, 'usable']], 'the answer is the list as the switch left it');
    const row = (await q('SELECT source_id, source_series_id, source_checked_at, source_chapters FROM lib_series WHERE id = $1', [S('one')]))[0];
    assert.deepEqual([row.source_id, row.source_series_id], ['ms-b', 'ms-b|one'], 'the pair moved');
    assert.equal(new Date(row.source_checked_at).toISOString(), '2026-09-01T00:00:00.000Z', 'the series\' last check is not the old main\'s: it stays');
    assert.equal(row.source_chapters, 7);
    assert.deepEqual(await followers(S('one')), ['ms-c', 'ms-a'], 'the new main is no longer followed, and the old one is the last follower');
    const demoted = (await q('SELECT source_series_id, added_by, coverage FROM series_sources WHERE series_id = $1 AND source_id = $2', [S('one'), 'ms-a']))[0];
    assert.deepEqual([demoted.source_series_id, demoted.added_by, demoted.coverage], ['ms-a|one', adminId, null], 'kept with its ref, as the admin\'s follow');
    const audit = (await q(`SELECT user_id, detail FROM audit_log WHERE event = 'series.main_source' AND detail->>'id' = $1`, [S('one')]));
    assert.equal(audit.length, 1, 'one audit line');
    assert.equal(audit[0].user_id, adminId);
    const d = audit[0].detail;
    assert.deepEqual([d.from, d.fromRef, d.to, d.toRef, d.old, d.via], ['ms-a', 'ms-a|one', 'ms-b', 'ms-b|one', 'kept', 'manual']);
    // The series page reads the same list, primary first.
    const page = await app.inject({ method: 'GET', url: `/api/series/${S('one')}`, headers: auth });
    assert.deepEqual(page.json().sources.map((s: any) => s.sourceId), ['ms-b', 'ms-c', 'ms-a']);
  } finally {
    await settle(S('one'));
  }
});

test('a switched-off old main is dropped with its listing rows, and its capped chapters get another try', { skip }, async () => {
  // Reintroduce by dropping the listing DELETE: ms-a's rows remain. By dropping the ledger reset: chapter 7 stays capped
  // against the source the series no longer reads, and is not fetched.
  const { setDisabled } = await import('../src/lib/sourceHealth');
  const { CHAPTER_RETRY_CAP } = await import('../src/lib/updater');
  await series('two', 'ms-a', ['ms-b']);
  for (const n of [1, 2, 3, 4, 5, 6]) {
    await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, pages) VALUES ($1, $2, 'T!main', $3, $4, $5, 1)`,
      [`${S('two')}_b${n}`, S('two'), `${S('two')}/Chapter ${n}.cbz`, n, `Chapter ${n}`]);
  }
  for (const n of [1, 2, 3, 4, 5, 6, 7]) {
    await q(`INSERT INTO series_listing (series_id, number, source_id, chosen) VALUES ($1, $2, 'ms-a', $3::jsonb)`,
      [S('two'), n, JSON.stringify({ sourceId: `ms-a:${n}`, number: n, source: 'ms-a' })]);
  }
  await q(`INSERT INTO chapter_failures (series_id, number, source_id, status, reason, attempts, at, first_at)
           VALUES ($1, 7, 'ms-a', 'incomplete', '3 of 9 pages', $2, now() - interval '1 day', now() - interval '3 days')`, [S('two'), CHAPTER_RETRY_CAP]);
  await setDisabled('ms-a', true);
  holdListings();
  try {
    const r = await post(S('two'), { sourceId: 'ms-b' });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().old, 'dropped', 'a switched-off old main is not kept: it would carry nothing');
    assert.deepEqual(await followers(S('two')), [], 'it is no longer followed');
    assert.equal((await q(`SELECT count(*)::int AS n FROM series_listing WHERE series_id = $1 AND source_id = 'ms-a'`, [S('two')]))[0].n, 0,
      'its listing rows went with it, as an unfollow takes them');
    await settle(S('two'));

    const up = await updateSeries(S('two'), 5);
    assert.equal(up.capped ?? 0, 0, 'its capped chapter gets another try');
    assert.equal(up.added, 1);
    assert.ok(existsSync(join(ROOT, S('two'), 'Chapter 7.cbz')), 'chapter 7 came from the new main');
    assert.equal(up.landed[0].source, 'ms-b');
    // The repair's reset shape: the tries start again, and when it first failed is kept, for Health's "failing since".
    const ledger = (await q(`SELECT attempts, first_at < now() - interval '2 days' AS old FROM chapter_failures WHERE series_id = $1`, [S('two')]))[0];
    assert.deepEqual([ledger?.attempts, ledger?.old], [0, true], 'the ledger row was reset, its first failure kept');
  } finally {
    await settle(S('two'));
    await setDisabled('ms-a', false);
  }
});

test('the refusals: not followed, the main itself, posting order, a pending renumber, a check inside the series, a target off or not loaded, another language, a hidden series', { skip }, async () => {
  // Reintroduce by removing any one guard from lib/mainSource.ts: its request answers 200 and the main moves.
  // Steps, not subtests: this file's beforeEach would clear the fixture before every subtest.
  const step = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); } catch (e) { (e as Error).message = `${name}: ${(e as Error).message}`; throw e; }
  };
  const { setDisabled } = await import('../src/lib/sourceHealth');
  await series('ref', 'ms-a', ['ms-b', 'ms-es', 'ms-gone']);
  const refused = async (body: unknown, code: string, status = 409) => {
    const r = await post(S('ref'), body);
    assert.equal(r.statusCode, status, `${code}: ${r.body}`);
    assert.equal(r.json().error, code);
    assert.equal(await mainOf(S('ref')), 'ms-a', `${code}: the main source is unchanged`);
    assert.deepEqual(await followers(S('ref')), ['ms-b', 'ms-es', 'ms-gone'], `${code}: and so are the followers`);
    return r.json();
  };
  await step('not followed', async () => {
    const j = await refused({ sourceId: 'ms-c' }, 'not_followed');
    assert.equal(j.messageSaid.code, 'main.notFollowed', 'said as a code the page words');
    assert.match(j.message, /does not follow that source/);
  });
  await step('the main itself', async () => {
    assert.equal((await refused({ sourceId: 'ms-a' }, 'is_main')).messageSaid.code, 'main.isMain');
  });
  await step('posting order', async () => {
    await q(`UPDATE lib_series SET numbering = 'posting_order' WHERE id = $1`, [S('ref')]);
    try {
      const { POSTING_ORDER_REFUSAL } = await import('../src/lib/numbering');
      const j = await refused({ sourceId: 'ms-b' }, 'posting_order');
      assert.equal(j.message, POSTING_ORDER_REFUSAL);
      assert.equal(j.messageSaid.code, 'numbering.postingRefusal');
    } finally { await q('UPDATE lib_series SET numbering = NULL WHERE id = $1', [S('ref')]); }
  });
  await step('a pending renumber', async () => {
    await q(`UPDATE lib_series SET numbering_pending = 'posting_order' WHERE id = $1`, [S('ref')]);
    try {
      await refused({ sourceId: 'ms-b' }, 'renumber_pending');
    } finally { await q('UPDATE lib_series SET numbering_pending = NULL WHERE id = $1', [S('ref')]); }
  });
  await step('a check inside the series', async () => {
    holdListings();
    const check = updateSeries(S('ref'), 0);
    try {
      await until(() => runsInside(S('ref')) > 0, 'the check to be inside the series');
      assert.equal((await refused({ sourceId: 'ms-b' }, 'busy')).messageSaid.code, 'renumber.checking');
    } finally {
      release(); hold = null;
      await check;
    }
  });
  await step('a target switched off, or not loaded', async () => {
    await setDisabled('ms-b', true);
    try {
      assert.equal((await refused({ sourceId: 'ms-b' }, 'source_unavailable')).messageSaid.code, 'main.unavailable');
    } finally { await setDisabled('ms-b', false); }
    await refused({ sourceId: 'ms-gone' }, 'source_unavailable');
  });
  await step('another language', async () => {
    const j = await refused({ sourceId: 'ms-es' }, 'language_differs');
    assert.deepEqual(j.edition, { of: S('ref'), lang: 'es' }, 'the follow route\'s edition to add instead');
    assert.equal(j.messageSaid.code, 'follow.languageDiffers');
  });
  await step('a hidden series', async () => {
    await q('UPDATE lib_series SET deleted_at = now() WHERE id = $1', [S('ref')]);
    try {
      await refused({ sourceId: 'ms-b' }, 'not_found', 404);
    } finally { await q('UPDATE lib_series SET deleted_at = NULL WHERE id = $1', [S('ref')]); }
  });
  await step('a body that names no source', async () => {
    assert.equal((await post(S('ref'), {})).statusCode, 400);
    assert.equal((await post(S('ref'), { sourceId: 'ms-b', old: 'maybe' })).statusCode, 400);
  });
  assert.equal((await q(`SELECT count(*)::int AS n FROM audit_log WHERE event = 'series.main_source'`))[0].n, 0, 'nothing was switched');
});

test('the series keeps its language when its main source is the only thing that said it', { skip }, async () => {
  // Old main in Spanish, the follower in every language, the series stating nothing: after the switch it would read as
  // the server's unstated language (English). Reintroduce by dropping the pin: the page reads en.
  await series('lang', 'ms-es', ['ms-all']);
  const lang = async () => (await app.inject({ method: 'GET', url: `/api/series/${S('lang')}`, headers: auth })).json().lang;
  assert.equal(await lang(), 'es', 'PREMISE: Spanish, from its main source');
  holdListings();
  try {
    const r = await post(S('lang'), { sourceId: 'ms-all' });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().langPinned, 'es', 'the answer says it was pinned');
    assert.equal(await lang(), 'es', 'the series keeps its language');
    assert.equal((await q('SELECT lang FROM lib_series WHERE id = $1', [S('lang')]))[0].lang, 'es', 'stated now');
    assert.equal((await q(`SELECT detail->>'langPinned' AS l FROM audit_log WHERE event = 'series.main_source' AND detail->>'id' = $1`, [S('lang')]))[0].l, 'es');
  } finally {
    await settle(S('lang'));
  }
  // A series that states its language is left alone.
  await series('stated', 'ms-es', ['ms-all']);
  await q(`UPDATE lib_series SET lang = 'es' WHERE id = $1`, [S('stated')]);
  holdListings();
  try {
    const r = await post(S('stated'), { sourceId: 'ms-all' });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal('langPinned' in r.json(), false);
  } finally {
    await settle(S('stated'));
  }
});

test('the demotion never takes a series past the follower cap; keep and drop decide', { skip }, async () => {
  // A series from before the cap follows three sources. Promoting one leaves two, and the old main has no room.
  // Reintroduce by dropping the count clause from the old main's INSERT: three followers.
  const { setDisabled } = await import('../src/lib/sourceHealth');
  await series('cap', 'ms-a', ['ms-b', 'ms-c', 'ms-d']);
  holdListings();
  try {
    const r = await post(S('cap'), { sourceId: 'ms-b' });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().old, 'dropped', 'no room under the cap: reported as dropped');
    assert.deepEqual(await followers(S('cap')), ['ms-c', 'ms-d'], 'the demotion never takes a series past the follower cap');
  } finally {
    await settle(S('cap'));
  }
  // `keep` keeps an old main that carries nothing; `drop` drops one that works.
  await series('keep', 'ms-a', ['ms-b']);
  await series('drop', 'ms-a', ['ms-b']);
  await setDisabled('ms-a', true);
  holdListings();
  try {
    const kept = await post(S('keep'), { sourceId: 'ms-b', old: 'keep' });
    assert.equal(kept.json().old, 'kept');
    assert.deepEqual(await followers(S('keep')), ['ms-a']);
    await setDisabled('ms-a', false);
    const dropped = await post(S('drop'), { sourceId: 'ms-b', old: 'drop' });
    assert.equal(dropped.json().old, 'dropped');
    assert.deepEqual(await followers(S('drop')), []);
  } finally {
    await setDisabled('ms-a', false);
    await settle(S('keep'));
    await settle(S('drop'));
  }
});
