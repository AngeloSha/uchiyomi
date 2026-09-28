// Connect sources against a real database: what the review of #119 asked for, each pinned.
//
//  - posting order (#116): a series numbered by posting order is left out when the batch is built, a hand
//    pick for it is refused before any lookup, and a follow re-reads `numbering` under the row lock;
//  - a follow is INSERT only: an old candidate never re-points a follower the series has since gained, and
//    the candidates whose source is already followed are closed;
//  - the search asks sources in scan order and stops once the series' free follower slots are filled;
//  - it waits while a sweep runs, and stops at a series boundary on shutdown;
//  - a run follows only `ok` candidates, and the listing refreshes after it are paced and dropped while a
//    sweep runs;
//  - an amber candidate is followed only one at a time, judged again first.
//
// Fake adapters, no network. Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const TITLE = 'Linked Tale';
const S = { main: 's_lb_main', po: 's_lb_po', full: 's_lb_full', few: 's_lb_few', gone: 's_lb_gone' } as const;
const ALL = Object.values(S);
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
/** How many searches each fake was asked: whether a source was ASKED at all. */
const searches: Record<string, number> = {};

function fake(id: string, nums: number[], title = TITLE) {
  searches[id] = 0;
  return {
    id, name: id, lang: 'en',
    async search() { searches[id]++; return [{ sourceId: `${id}-x`, source: id, title }]; },
    async getSeries(sid: string) { return { sourceId: sid, source: id, title }; },
    async listChapters() { return nums.map((n) => ({ sourceId: `${id}-${n}`, number: n })); },
    async getPageUrls() { return []; },
  };
}

let q: any, lb: typeof import('../src/lib/linkBatch'), runtime: typeof import('../src/lib/runtime').runtime;
let MAX_FOLLOWERS: number;
let admin = '';
const FAKES = ['lb-own', 'lb-a', 'lb-b', 'lb-c', 'lb-vol'];

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  lb = await import('../src/lib/linkBatch');
  ({ runtime } = await import('../src/lib/runtime'));
  ({ MAX_FOLLOWERS } = await import('../src/lib/autoFollow'));
  const { registerAdapter } = await import('../src/lib/sources');
  await migrate();
  registerAdapter(fake('lb-own', range(1, 20)) as any);
  registerAdapter(fake('lb-a', range(1, 20)) as any);
  registerAdapter(fake('lb-b', range(1, 20)) as any);
  registerAdapter(fake('lb-c', range(1, 20)) as any);
  registerAdapter(fake('lb-vol', range(1, 5)) as any);
  await q(`DELETE FROM users WHERE username = 'lb-admin'`);
  admin = (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind)
                     VALUES ('lb-admin','lb-admin','x','admin','password') RETURNING id`))[0].id;
});

beforeEach(async () => {
  if (!DSN) return;
  lb._resetLinkState();
  runtime.updating = false; runtime.repairing = false; runtime.stopping = false;
  await q(`DELETE FROM link_batches WHERE user_id = $1`, [admin]);
  await q(`DELETE FROM series_sources WHERE series_id = ANY($1)`, [ALL]);
  await q(`DELETE FROM series_listing WHERE series_id = ANY($1)`, [ALL]);
  await q(`DELETE FROM source_health WHERE source_id = ANY($1)`, [FAKES]);
  await q(`DELETE FROM lib_series WHERE id = ANY($1)`, [ALL]);
  for (const id of ALL) {
    await q(`INSERT INTO lib_series (id, source, title, folder, books_count, source_id, source_series_id, numbering, deleted_at)
             VALUES ($1,'T!lb',$2,$1,0,'lb-own',$1,$3,$4)`,
      [id, TITLE, id === S.po ? 'posting_order' : null, id === S.gone ? new Date().toISOString() : null]);
    for (const n of range(1, id === S.few ? 2 : 20)) {
      await q(`INSERT INTO series_listing (series_id, number, source_id, chosen) VALUES ($1,$2,'lb-own','{}'::jsonb)`, [id, n]);
    }
  }
  for (const src of ['lb-a', 'lb-b']) {
    await q(`INSERT INTO series_sources (series_id, source_id, source_series_id) VALUES ($1,$2,'old')`, [S.full, src]);
  }
  for (const k of Object.keys(searches)) searches[k] = 0;
});

after(async () => {
  if (!DSN) return;
  runtime.updating = false; runtime.stopping = false;
  await q(`DELETE FROM link_batches WHERE user_id = $1`, [admin]).catch(() => {});
  await q(`DELETE FROM lib_series WHERE id = ANY($1)`, [ALL]).catch(() => {});
  await q(`DELETE FROM users WHERE id = $1`, [admin]).catch(() => {});
});

/** Only the fakes, so a registry with other adapters in it cannot change what is asked. */
const fakes = async () => (await import('../src/lib/sources')).listSources().filter((s) => FAKES.includes(s.id));

test('a batch leaves out what cannot take a follower: posting order, full, gone', { skip }, async () => {
  const made = await lb.createLinkBatch(admin, [S.main, S.po, S.full, S.gone, S.few]);
  assert.ok(made.id);
  assert.equal(made.total, 2, 'main and few are kept (few is skipped at search time, with its reason)');
  assert.deepEqual(Object.fromEntries(made.skipped.map((s) => [s.id, s.why])), { [S.po]: 'posting_order', [S.full]: 'full', [S.gone]: 'gone' });
  const none = await lb.createLinkBatch(admin, [S.po]);
  assert.equal(none.id, null, 'a batch of nothing is not created');
});

test('a hand pick on a series numbered by posting order is refused before any lookup', { skip }, async () => {
  const r = await lb.judgeManualPick(S.po, { source: 'lb-a', sourceSeriesId: 'lb-a-x' });
  assert.deepEqual(r, { error: 'posting_order' });
  assert.deepEqual(await lb.judgeManualPick(S.main, { source: 'lb-own', sourceSeriesId: 'x' }), { error: 'already_followed' });
});

test('a follow is insert only, re-reads posting order under the lock, and keeps the cap', { skip }, async () => {
  const c = (source: string, sid = `${source}-x`) => ({ source, sourceSeriesId: sid, theirTitle: TITLE, coverage: 1 });
  assert.equal(await lb.followConfirmed(S.main, c('lb-a'), admin), 'inserted');
  // Reintroduce by dropping the already-followed check and upserting: this reads 'inserted' and the follower
  // points at another entry.
  assert.equal(await lb.followConfirmed(S.main, c('lb-a', 'another-entry'), admin), 'already_followed');
  const row = (await q(`SELECT source_series_id FROM series_sources WHERE series_id = $1 AND source_id = 'lb-a'`, [S.main]))[0];
  assert.equal(row.source_series_id, 'lb-a-x', 'an old candidate re-pointed an existing follower');
  assert.equal(await lb.followConfirmed(S.main, c('lb-own'), admin), 'primary');
  assert.equal(await lb.followConfirmed(S.main, c('lb-b'), admin), 'inserted');
  assert.equal(await lb.followConfirmed(S.main, c('lb-c'), admin), 'cap', `more than ${MAX_FOLLOWERS} followers`);
  // Renumbered after the review: the follow must still refuse.
  await q(`UPDATE lib_series SET numbering = 'posting_order' WHERE id = $1`, [S.few]);
  assert.equal(await lb.followConfirmed(S.few, c('lb-a'), admin), 'posting_order');
});

test('candidates whose source is followed since, or whose series went to posting order, are closed', { skip }, async () => {
  const made = await lb.createLinkBatch(admin, [S.main, S.few]);
  const items = await q(`SELECT id, series_id FROM link_items WHERE batch_id = $1`, [made.id]);
  const item = (sid: string) => items.find((i: any) => i.series_id === sid).id;
  const row = (source: string) => ({ source, sourceSeriesId: `${source}-x`, theirTitle: TITLE, cover: null, ourName: TITLE, theirName: TITLE, coverageFwd: 1, coverageBack: 1, verdict: 'ok' as const });
  const a = await lb.saveCandidate(item(S.main), row('lb-a'), false);
  const b = await lb.saveCandidate(item(S.main), row('lb-b'), false);
  const f = await lb.saveCandidate(item(S.few), row('lb-a'), false);
  await q(`INSERT INTO series_sources (series_id, source_id, source_series_id) VALUES ($1,'lb-a','elsewhere')`, [S.main]);
  await q(`UPDATE lib_series SET numbering = 'posting_order' WHERE id = $1`, [S.few]);
  await lb.closeStale(made.id!);
  const status = async (id: string) => (await q(`SELECT status FROM link_candidates WHERE id = $1`, [id]))[0].status;
  assert.equal(await status(a!.id), 'already_followed');
  assert.equal(await status(b!.id), null, 'an open candidate was closed');
  assert.equal(await status(f!.id), 'posting_order');
});

test('the search asks in scan order and stops once the free slots are filled', { skip }, async () => {
  const facts = (await lb.linkFactsFor(S.main, { learn: false }))!;
  assert.equal(lb.freeSlots(facts), MAX_FOLLOWERS);
  const r = await lb.findLinks(facts, { sources: await fakes(), health: new Map(), concurrency: 1 });
  // Reintroduce asking every source: lb-c is searched too, and three candidates come back for two slots.
  assert.deepEqual(r.found.map((j) => j.source).sort(), ['lb-a', 'lb-b']);
  assert.ok(r.found.every((j) => j.verdict === 'ok'));
  assert.equal(searches['lb-c'], 0, 'a third source was asked for a series with two free slots');
  assert.equal(searches['lb-own'], 0, 'the primary was asked');
  assert.equal(r.asked, 2);
});

test('the search waits while a sweep runs, and stops at a series boundary on shutdown', { skip }, async () => {
  const made = await lb.createLinkBatch(admin, [S.few]);
  runtime.updating = true;
  assert.ok(lb.claimSearch(made.id!));
  const run = lb.searchBatch(made.id!, { waitMs: 20, paceMs: 0 });
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(lb.searchWaitingOn(made.id!), 'sweep');
  assert.equal((await q(`SELECT state FROM link_items WHERE batch_id = $1`, [made.id]))[0].state, 'pending', 'searched beside a sweep');
  runtime.updating = false;
  await run;
  const it = (await q(`SELECT state, note FROM link_items WHERE batch_id = $1`, [made.id]))[0];
  assert.deepEqual({ state: it.state, note: it.note }, { state: 'skipped', note: 'too_few' });
  assert.equal((await q(`SELECT state FROM link_batches WHERE id = $1`, [made.id]))[0].state, 'review');

  const again = await lb.createLinkBatch(admin, [S.main]);
  runtime.stopping = true;
  assert.ok(lb.claimSearch(again.id!));
  await lb.searchBatch(again.id!, { waitMs: 20, paceMs: 0 });
  assert.equal((await q(`SELECT state FROM link_items WHERE batch_id = $1`, [again.id]))[0].state, 'pending', 'a shutdown marked the series searched');
  assert.equal((await q(`SELECT state FROM link_batches WHERE id = $1`, [again.id]))[0].state, 'searching', 'it must read as interrupted, to resume');
  runtime.stopping = false;
});

test('a run follows only ok candidates, then refreshes one series at a time; a sweep drops the refreshes', { skip }, async () => {
  const made = await lb.createLinkBatch(admin, [S.main]);
  const itemId = (await q(`SELECT id FROM link_items WHERE batch_id = $1`, [made.id]))[0].id;
  const row = (source: string, verdict: 'ok' | 'numbering_differs') =>
    ({ source, sourceSeriesId: `${source}-x`, theirTitle: TITLE, cover: null, ourName: TITLE, theirName: TITLE, coverageFwd: 1, coverageBack: verdict === 'ok' ? 1 : 0.25, verdict });
  await lb.saveCandidate(itemId, row('lb-a', 'ok'), false);
  await lb.saveCandidate(itemId, row('lb-vol', 'numbering_differs'), false);
  const rows = await q(`SELECT c.*, i.series_id, i.title AS series_title FROM link_candidates c JOIN link_items i ON i.id = c.item_id WHERE i.batch_id = $1`, [made.id]);
  await q(`UPDATE link_batches SET state = 'linking' WHERE id = $1`, [made.id]);
  const refreshed: string[] = [];
  await lb.runLinks(made.id!, rows, { userId: admin, refresh: async (id) => { refreshed.push(id); }, paceMs: 0 });
  const st = Object.fromEntries((await q(`SELECT source, status FROM link_candidates WHERE item_id = $1`, [itemId])).map((r: any) => [r.source, r.status]));
  assert.equal(st['lb-a'], 'linked');
  assert.equal(st['lb-vol'], null, 'a run followed an amber candidate');
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(refreshed, [S.main]);

  runtime.updating = true;
  const later: string[] = [];
  lb.queueRefresh([S.main, S.few], async (id) => { later.push(id); }, 0);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(later, [], 'a listing was refreshed beside a sweep');
  assert.deepEqual(lb.pendingRefreshes(), []);
  runtime.updating = false;
});

test('an amber candidate is followed one at a time, judged again first', { skip }, async () => {
  const made = await lb.createLinkBatch(admin, [S.main]);
  const itemId = (await q(`SELECT id FROM link_items WHERE batch_id = $1`, [made.id]))[0].id;
  await q(`UPDATE link_batches SET state = 'review' WHERE id = $1`, [made.id]);
  const c = await lb.saveCandidate(itemId, {
    source: 'lb-vol', sourceSeriesId: 'lb-vol-x', theirTitle: TITLE, cover: null, ourName: TITLE, theirName: TITLE,
    coverageFwd: 0.25, coverageBack: 1, verdict: 'numbering_differs',
  }, false);
  const refreshed: string[] = [];
  const r = await lb.followSingle(c!.id, admin, { refresh: async (id) => { refreshed.push(id); } });
  assert.deepEqual(r, { ok: true, status: 'linked' });
  assert.equal((await q(`SELECT count(*)::int AS n FROM series_sources WHERE series_id = $1 AND source_id = 'lb-vol'`, [S.main]))[0].n, 1);
  const audit = (await q(`SELECT detail FROM audit_log WHERE event = 'series.follow_source' AND detail->>'id' = $1 ORDER BY id DESC LIMIT 1`, [S.main]))[0];
  assert.equal(audit.detail.override, true, 'the audit does not say it was confirmed by hand');
  assert.equal(audit.detail.via, 'link_preview');
  const again = await lb.followSingle(c!.id, admin, { refresh: async () => {} });
  assert.deepEqual(again, { ok: false, error: 'closed', status: 'linked' });
});
