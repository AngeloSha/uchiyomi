// The reviewable import (issue #48): parse → resolve matches in the background → let the admin correct or
// skip a row → add only what was accepted. Driven through the real routes end to end, not read as text.
//
// Four things this proves that the plain one-shot /api/admin/import cannot even be asked about, because it
// has no per-row state and no selection:
//
//  1. A title the resolve pass gets right is not silently taken -- it is offered, as `decision: 'auto'`,
//     and can still be overridden before /run ever touches it.
//  2. A title the resolve pass gets WRONG (or gets nothing for) does not get added anyway. `unresolved`
//     rows are excluded from /run outright, and a manual override on any row sticks until the admin changes
//     it again, including reverting to what the resolve pass originally found.
//  3. A backup entry that names its OWN Mihon source id, and that source is installed here under the same
//     id (Suwayomi extensions), is matched against THAT source first. Its stored url is the proof of
//     identity: a hit whose extension-relative path equals it is `same_source` whatever the title says, and
//     WITHOUT that proof the home source's first result is never taken -- that is the "wrong manga" bug
//     issue #48 is about, and it must not come back at the green tier.
//  4. /run never downloads a chapter, and can be called more than once on the same batch: `candidateIds`
//     scopes one call to a bulk selection, a row it already imported is never re-added, and the batch stays
//     `review` (not `done`) while an unresolved row -- fixable by hand later, the "second import try" -- is
//     still sitting there unselected.
//
// And the lifecycle a human-paced flow needs: a batch stranded `importing` by a restart reads back as
// reviewable, Discard stops a loop already running, two starts at once become one, a resumed pass does not
// count rows twice, and forgotten batches are swept.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DSN = process.env.TEST_DATABASE_URL;
let root = '';
if (DSN) {
  root = mkdtempSync(join(tmpdir(), 'yomi-importbatch-'));
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.DL_ROOT = root;
  process.env.DOWNLOAD_PAGE_GAP_MS = '0';
  process.env.DOWNLOAD_MIN_GAP_MS = '0';
  process.env.MIN_FREE_GB = '0';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const FAKE = 'importbatch-fake';       // an ordinary registered source
const SW_ID = '5551234500000000';      // fits well under 2^53, so the plain float varint writer is exact
const SW_ADAPTER = `sw:${SW_ID}`;      // the id a Suwayomi-backed adapter registers under
const USER = 'importbatch-user';
const RESOLVE_CONCURRENCY = 3;         // routes/admin.ts -- how many searches can be in flight at once

let q: any;
const PIXEL = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(400, 7)]);
const realFetch = globalThis.fetch;
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

/** Set by the busy-guard and discard tests to widen the race window; every other test leaves this at 0. */
let searchDelayMs = 0;
/** Slows every add (getSeries) so a GET or a DELETE can land while /run is mid-loop. */
let seriesDelayMs = 0;
/** Counts every getPageUrls call across all adapters -- chapterFrom:'none' must never make one. */
let pageCalls = 0;
/** Counts FAKE's searches, so a discarded batch can be shown to stop searching. */
let searchCalls = 0;
/** Counts FAKE's getSeries calls, so a test can wait until /run is genuinely inside an add. */
let seriesCalls = 0;

/** Distinct titles behind one adapter, so a candidateIds-scoped /run has real rows to tell apart. */
const FAKE_TITLES: Record<string, { sourceId: string; title: string }> = {
  'fake manga seven': { sourceId: 'fm-7', title: 'Fake Manga Seven' },
  'fake manga six': { sourceId: 'fm-6', title: 'Fake Manga Six' },
  'fake manga five': { sourceId: 'fm-5', title: 'Fake Manga Five' },
  'fake manga four': { sourceId: 'fm-4', title: 'Fake Manga Four' },
  'fake manga three': { sourceId: 'fm-3', title: 'Fake Manga Three' },
  'fake manga two': { sourceId: 'fm-2', title: 'Fake Manga Two' },
  'fake manga': { sourceId: 'fm-1', title: 'Fake Manga' },
  // FAKE carries the Suwayomi fake's title too, and runs FIRST in preferred order: that is what makes the
  // source-id shortcut test below a real proof (an unscoped title search would land here, not there).
  'sw match title': { sourceId: 'fm-sw', title: 'Sw Match Title' },
};
/** Every source_series_id a test here can create, for the before/after cleanup. */
const FAKE_IDS = [...Object.values(FAKE_TITLES).map((v) => v.sourceId), 'sw-1'];
function fakeAdapter() {
  return {
    id: FAKE, name: 'Fake Source', preferredOrder: 0,
    async search(term: string) {
      searchCalls++;
      if (searchDelayMs) await sleep(searchDelayMs);
      const t = term.toLowerCase();
      const hit = Object.keys(FAKE_TITLES).find((k) => t === k) ?? Object.keys(FAKE_TITLES).find((k) => t.includes(k));
      return hit ? [{ sourceId: FAKE_TITLES[hit].sourceId, source: FAKE, title: FAKE_TITLES[hit].title, coverUrl: 'https://example.invalid/cover.jpg' }] : [];
    },
    async getSeries(sid: string) {
      seriesCalls++;
      if (seriesDelayMs) await sleep(seriesDelayMs);
      const title = Object.values(FAKE_TITLES).find((v) => v.sourceId === sid)?.title ?? 'Fake Manga';
      return { sourceId: sid, source: FAKE, title, summary: '' };
    },
    async listChapters() { return [{ number: 1, title: 'Chapter 1', sourceId: 'c1', pages: 1 }]; },
    async getPageUrls() { pageCalls++; return ['https://example.invalid/p1.png']; },
    async latest() { return [] as any[]; },
  };
}

/**
 * Only reachable via a backup entry whose source id resolves to it -- never wins a bare title search
 * (preferredOrder 999, and FAKE answers first). Every result carries `path`, the extension-relative url a
 * real Suwayomi adapter exposes, because that is what the backup's url is compared against.
 */
function swAdapter() {
  return {
    id: SW_ADAPTER, name: 'Suwayomi Fake', preferredOrder: 999,
    async search(term: string) {
      const t = term.toLowerCase();
      if (t.includes('sw match')) return [{ sourceId: 'sw-1', source: SW_ADAPTER, title: 'Sw Match Title', path: '/manga/sw-1', coverUrl: 'https://example.invalid/sw.jpg' }];
      // The site retitled this entry: nothing in the title relates to the query, only the path does.
      if (t.includes('renamed')) return [{ sourceId: 'sw-2', source: SW_ADAPTER, title: 'Completely Different Name', path: '/manga/sw-2/' }];
      // A search the source answers with something unrelated, as sites do for a title they lack.
      if (t.includes('unrelated')) return [{ sourceId: 'sw-9', source: SW_ADAPTER, title: 'Something Else Entirely', path: '/manga/sw-9' }];
      return [];
    },
    async getSeries(sid: string) { return { sourceId: sid, source: SW_ADAPTER, title: 'Sw Match Title', summary: '' }; },
    async listChapters() { return [{ number: 1, title: 'Chapter 1', sourceId: 'c1', pages: 1 }]; },
    async getPageUrls() { pageCalls++; return ['https://example.invalid/p1.png']; },
    async latest() { return [] as any[]; },
  };
}

// --- minimal protobuf writer, just the fields entriesFromBackup reads (see tachibk.test.ts for the exhaustive version) ---
const varint = (n: number): Buffer => { const out: number[] = []; while (n > 127) { out.push((n & 127) | 128); n = Math.floor(n / 128); } out.push(n); return Buffer.from(out); };
const tag = (field: number, wire: number) => varint((field << 3) | wire);
const lenField = (field: number, payload: Buffer) => Buffer.concat([tag(field, 2), varint(payload.length), payload]);
const strField = (field: number, s: string) => lenField(field, Buffer.from(s, 'utf8'));
const varField = (field: number, n: number) => Buffer.concat([tag(field, 0), varint(n)]);
/** source = 1, url = 2, title = 3 -- the url is optional because Mihon always writes one but the proof must be shown to depend on it. */
const mangaEntry = (title: string, sourceId: number, url?: string) =>
  Buffer.concat([varField(1, sourceId), url ? strField(2, url) : Buffer.alloc(0), strField(3, title)]);
const backupOf = (...m: Buffer[]) => Buffer.concat(m.map((x) => lenField(1, x)));
const dataUrlOf = (buf: Buffer) => `data:application/octet-stream;base64,${buf.toString('base64')}`;

before(async () => {
  if (!DSN) return;
  ({ q } = await import('../src/lib/db'));
  const { migrate } = await import('../src/lib/migrate');
  await migrate();
  // Idempotent pre-cleanup: the '/run' tests below add REAL lib_series rows (source_series_id 'fm-1' and
  // friends), which nothing here can DELETE-cascade from import_batches — a crashed or interrupted previous
  // run of this file leaves them behind, and the next run then finds "Fake Manga" already in the library,
  // skips it by default, and every test downstream of that fails with no_auto_match / nothing_to_import for
  // reasons that have nothing to do with the assertion that trips first. Self-heals rather than trusting
  // `after()`.
  await q(`DELETE FROM lib_series WHERE source_series_id = ANY($1)`, [FAKE_IDS]);
  const { registerAdapter } = await import('../src/lib/sources');
  registerAdapter(fakeAdapter() as any);
  registerAdapter(swAdapter() as any);
  await q('INSERT INTO suwayomi_sources (source_id, name, lang, nsfw, enabled) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (source_id) DO UPDATE SET enabled = true',
    [SW_ID, 'Suwayomi Fake', 'en', false, true]);
});

after(async () => {
  if (!DSN) return;
  globalThis.fetch = realFetch;
  await q(`DELETE FROM lib_series WHERE source_series_id = ANY($1)`, [FAKE_IDS]);
  // The fake extension row would otherwise outlive the run and show up as an installed source to anything
  // else reading suwayomi_sources on this database.
  await q('DELETE FROM suwayomi_sources WHERE source_id = $1', [SW_ID]);
  if (root) rmSync(root, { recursive: true, force: true });
});

async function boot() {
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const adminRoutes = (await import('../src/routes/admin')).default;
  const sourceRoutes = (await import('../src/routes/sources')).default;
  const catalogRoutes = (await import('../src/routes/catalog')).default;
  await q('DELETE FROM users WHERE username = $1', [USER]);
  const uid = (await q<{ id: string }>(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind, perms, max_age_rating)
     VALUES ($1,$1,'x','admin','password','{}',NULL) RETURNING id`, [USER]))[0].id;
  const app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register(adminRoutes);
  await app.register(sourceRoutes);
  await app.register(catalogRoutes);
  await app.ready();
  const headers = { authorization: `Bearer ${app.jwt.sign({ sub: uid, role: 'admin' })}` };
  return { app, headers, uid };
}

async function waitForState(app: any, headers: any, id: string, states: string[], timeoutMs = 8000) {
  const start = Date.now();
  for (;;) {
    const r = await app.inject({ method: 'GET', url: `/api/admin/import/batches/${id}`, headers });
    assert.equal(r.statusCode, 200, r.body);
    const body = r.json();
    if (states.includes(body.batch.state)) return body;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for state in [${states}], last was ${body.batch.state}: ${JSON.stringify(body.items.map((i: any) => [i.backup_title, i.decision]))}`);
    await sleep(40);
  }
}

/** Poll a counter until it passes `above`, so a test acts while a loop is genuinely mid-flight. */
async function waitUntil(cond: () => boolean, what: string, timeoutMs = 4000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(15);
  }
}

test('a batch resolves each title on its own, offers the pick, and only /run adds anything', { skip }, async (t) => {
  globalThis.fetch = (async () => new Response(PIXEL, { status: 200, headers: { 'content-type': 'image/png' } })) as typeof fetch;
  const { app, headers } = await boot();
  let batchId = '';
  let fakeCandidateId = '';
  let unknownCandidateId = '';

  try {
    await t.test('POST /batches parses the titles and starts resolving immediately', async () => {
      // Reintroduce by inserting the batch with state 'review' instead of 'resolving' in POST /batches.
      const r = await app.inject({ method: 'POST', url: '/api/admin/import/batches', headers, payload: { titles: ['Fake Manga', 'Totally Unknown Title'] } });
      assert.equal(r.statusCode, 200, r.body);
      assert.equal(r.json().total, 2);
      batchId = r.json().batchId;
      const b = await q('SELECT state, total FROM import_batches WHERE id = $1', [batchId]);
      assert.equal(b[0].state, 'resolving');
      assert.equal(Number(b[0].total), 2);
    });

    await t.test('nothing is added while it resolves', async () => {
      // Reintroduce by calling addSeriesFromSource from the resolve loop as soon as a row matches.
      assert.equal((await q(`SELECT count(*)::int AS n FROM lib_series WHERE source_series_id = 'fm-1'`))[0].n, 0);
    });

    await t.test('the resolve pass finds the real match and leaves the unmatched title alone', async () => {
      // Reintroduce by taking the first search result in resolveCandidate's cross-source pass when
      // pickBestScored finds nothing (`best?.item ?? raw[0]`).
      const body = await waitForState(app, headers, batchId, ['review']);
      const fake = body.items.find((i: any) => i.backup_title === 'Fake Manga');
      const unknown = body.items.find((i: any) => i.backup_title === 'Totally Unknown Title');
      fakeCandidateId = fake.id;
      unknownCandidateId = unknown.id;
      assert.deepEqual([fake.decision, fake.confidence, fake.match_source, fake.match_source_id], ['auto', 'exact', FAKE, 'fm-1']);
      assert.equal(fake.auto_source_id, 'fm-1', 'the auto suggestion is frozen alongside the current pick');
      assert.deepEqual([unknown.decision, unknown.match_source_id], ['unresolved', null], 'no match found, not silently taken');
    });

    await t.test('PATCH decision:manual overrides the pick without touching the frozen auto suggestion', async () => {
      // Reintroduce by also writing auto_source_id = $3 in the manual branch of PATCH /candidates/:cid.
      const r = await app.inject({
        method: 'PATCH', url: `/api/admin/import/candidates/${unknownCandidateId}`, headers,
        payload: { decision: 'manual', source: FAKE, sourceId: 'fm-1', title: 'Fake Manga (manual)' },
      });
      assert.equal(r.statusCode, 200, r.body);
      const row = (await q('SELECT decision, match_source_id, match_title, auto_source_id FROM import_candidates WHERE id = $1', [unknownCandidateId]))[0];
      assert.deepEqual([row.decision, row.match_source_id, row.match_title], ['manual', 'fm-1', 'Fake Manga (manual)']);
      assert.equal(row.auto_source_id, null, 'still no auto match for this row -- the override does not manufacture one');
    });

    await t.test('decision:auto without an auto match is refused, not silently accepted', async () => {
      // Reintroduce by dropping the `if (!row.auto_source_id)` check in the auto branch of the PATCH route.
      const r = await app.inject({ method: 'PATCH', url: `/api/admin/import/candidates/${unknownCandidateId}`, headers, payload: { decision: 'auto' } });
      assert.equal(r.statusCode, 409, r.body);
      assert.equal(r.json().error, 'no_auto_match');
    });

    await t.test('skip, then "use the auto match" restores the frozen suggestion exactly', async () => {
      // Reintroduce by restoring match_* from match_* (a no-op) instead of from the auto_* columns.
      const skipped = await app.inject({ method: 'PATCH', url: `/api/admin/import/candidates/${fakeCandidateId}`, headers, payload: { decision: 'skip' } });
      assert.equal(skipped.statusCode, 200, skipped.body);
      assert.equal((await q('SELECT decision FROM import_candidates WHERE id = $1', [fakeCandidateId]))[0].decision, 'skip');

      const restored = await app.inject({ method: 'PATCH', url: `/api/admin/import/candidates/${fakeCandidateId}`, headers, payload: { decision: 'auto' } });
      assert.equal(restored.statusCode, 200, restored.body);
      const row = (await q('SELECT decision, confidence, match_source_id, match_title FROM import_candidates WHERE id = $1', [fakeCandidateId]))[0];
      assert.deepEqual([row.decision, row.confidence, row.match_source_id, row.match_title], ['auto', 'exact', 'fm-1', 'Fake Manga']);
    });

    await t.test('/run adds exactly the accepted rows, and never downloads a chapter', async () => {
      // Reintroduce by passing chapterFrom: 'oldest' instead of 'none' to addSeriesFromSource in the run loop.
      // Undo the manual override so this batch adds two DIFFERENT series, not the same one twice.
      await q(`UPDATE import_candidates SET decision = 'skip' WHERE id = $1`, [unknownCandidateId]);
      const before = pageCalls;
      const r = await app.inject({ method: 'POST', url: `/api/admin/import/batches/${batchId}/run`, headers });
      assert.equal(r.statusCode, 200, r.body);
      assert.equal(r.json().total, 1, 'only the fake-manga row is auto/manual now');
      const body = await waitForState(app, headers, batchId, ['done']);
      assert.equal(body.batch.added, 1);
      const fake = body.items.find((i: any) => i.id === fakeCandidateId);
      assert.equal(fake.status, 'added');
      const row = (await q(`SELECT id, books_count FROM lib_series WHERE source_series_id = 'fm-1'`))[0];
      assert.ok(row, 'the series was added');
      assert.equal(Number(row.books_count), 0, 'chapterFrom is forced to none: added to the library, nothing fetched');
      assert.equal(pageCalls, before, 'getPageUrls was never called -- a bulk import adds, it does not download');
    });

    await t.test('a batch with nothing left ready answers nothing_to_import, not a hard error', async () => {
      // Reintroduce by answering 409 already_done from /run when the batch state is 'done'.
      // The old one-shot importer's 409 already_done doesn't apply here: a "second import try" against rows
      // found by hand later has to be able to call /run again on a batch that already finished a round.
      const r = await app.inject({ method: 'POST', url: `/api/admin/import/batches/${batchId}/run`, headers });
      assert.equal(r.statusCode, 400, r.body);
      assert.equal(r.json().error, 'nothing_to_import');
    });
  } finally {
    if (batchId) await q('DELETE FROM import_batches WHERE id = $1', [batchId]);
    // This test's /run step actually adds "Fake Manga" to the library (that is what it proves) -- clean it
    // up so a later test in the same run does not find it already owned and default it to skipped.
    await q(`DELETE FROM lib_series WHERE source_series_id = 'fm-1'`);
    await app.close();
  }
});

test('candidateIds scopes /run to a bulk selection, and a second call picks up what is newly ready', { skip }, async (t) => {
  globalThis.fetch = (async () => new Response(PIXEL, { status: 200, headers: { 'content-type': 'image/png' } })) as typeof fetch;
  const { app, headers } = await boot();
  let batchId = '';
  try {
    const r = await app.inject({
      method: 'POST', url: '/api/admin/import/batches', headers,
      payload: { titles: ['Fake Manga', 'Fake Manga Two', 'Nobody Has This One'] },
    });
    assert.equal(r.statusCode, 200, r.body);
    batchId = r.json().batchId;
    const body = await waitForState(app, headers, batchId, ['review']);
    const a = body.items.find((i: any) => i.backup_title === 'Fake Manga');
    const b = body.items.find((i: any) => i.backup_title === 'Fake Manga Two');
    const unresolved = body.items.find((i: any) => i.backup_title === 'Nobody Has This One');
    assert.deepEqual([a.decision, a.match_source_id], ['auto', 'fm-1'], 'PREMISE: both titles matched');
    assert.deepEqual([b.decision, b.match_source_id], ['auto', 'fm-2']);
    assert.equal(unresolved.decision, 'unresolved', 'PREMISE: the third title matched nowhere');

    await t.test('running with candidateIds imports only the named row', async () => {
      // Reintroduce by ignoring candidateIds in /run (always the whole-batch SELECT).
      const run = await app.inject({ method: 'POST', url: `/api/admin/import/batches/${batchId}/run`, headers, payload: { candidateIds: [a.id] } });
      assert.equal(run.statusCode, 200, run.body);
      assert.equal(run.json().total, 1);
      // 'review', not 'done': row b is still ready and unselected, and the unresolved row is still sitting
      // there for a person to go find by hand -- neither is reason to call the batch finished.
      const after = await waitForState(app, headers, batchId, ['review']);
      const aAfter = after.items.find((i: any) => i.id === a.id);
      const bAfter = after.items.find((i: any) => i.id === b.id);
      assert.equal(aAfter.status, 'added');
      assert.equal(bAfter.status, null, 'not selected, so not touched');
      assert.equal((await q(`SELECT count(*)::int AS n FROM lib_series WHERE source_series_id = 'fm-1'`))[0].n, 1);
      assert.equal((await q(`SELECT count(*)::int AS n FROM lib_series WHERE source_series_id = 'fm-2'`))[0].n, 0, 'not imported yet');
    });

    await t.test('an id already imported is silently excluded from a later run, even if selected again', async () => {
      // Reintroduce by dropping `AND status IS NULL` from /run's candidate SELECT.
      // Stands in for "Select all" including a row Import already finished: the request must not double-add
      // it or error the whole call over one stale id.
      const run = await app.inject({ method: 'POST', url: `/api/admin/import/batches/${batchId}/run`, headers, payload: { candidateIds: [a.id, b.id] } });
      assert.equal(run.statusCode, 200, run.body);
      assert.equal(run.json().total, 1, 'only b -- a is already imported and excluded, not re-run');
      const after = await waitForState(app, headers, batchId, ['review']);
      assert.equal(after.items.find((i: any) => i.id === b.id).status, 'added');
      assert.equal((await q(`SELECT count(*)::int AS n FROM lib_series WHERE source_series_id = 'fm-2'`))[0].n, 1);
    });

    await t.test('the batch stays in review while the unresolved row is still unhandled', async () => {
      // Reintroduce by counting `remaining` over decision IN ('auto','manual') only, so an unresolved row
      // no longer holds the batch open.
      const final = await app.inject({ method: 'GET', url: `/api/admin/import/batches/${batchId}`, headers });
      assert.equal(final.json().batch.state, 'review', 'both matches are imported, but the unresolved row means there is still a "second try" to have');
    });

    await t.test('skipping the last open row and running again reports nothing left, not an error', async () => {
      // Reintroduce by answering 409 already_done from /run when every non-skipped row has a status.
      await app.inject({ method: 'PATCH', url: `/api/admin/import/candidates/${unresolved.id}`, headers, payload: { decision: 'skip' } });
      const run = await app.inject({ method: 'POST', url: `/api/admin/import/batches/${batchId}/run`, headers });
      assert.equal(run.statusCode, 400);
      assert.equal(run.json().error, 'nothing_to_import');
    });
  } finally {
    if (batchId) await q('DELETE FROM import_batches WHERE id = $1', [batchId]);
    await q(`DELETE FROM lib_series WHERE source_series_id IN ('fm-1','fm-2')`);
    await app.close();
  }
});

test('a title already in the library defaults to skipped, visibly, and never enters the resolve queue', { skip }, async (t) => {
  // Reintroduce by inserting every candidate as 'unresolved' regardless of in_library in POST /batches.
  const { app, headers } = await boot();
  const { newSeriesId } = await import('../src/lib/ids');
  const owned = newSeriesId();
  let batchId = '';
  try {
    await q(`INSERT INTO lib_series (id, source, title, folder, books_count) VALUES ($1,'test','Already Owned Series',$1,1)`, [owned]);

    const r = await app.inject({ method: 'POST', url: '/api/admin/import/batches', headers, payload: { titles: ['Already Owned Series'] } });
    assert.equal(r.statusCode, 200, r.body);
    batchId = r.json().batchId;

    const body = await waitForState(app, headers, batchId, ['review']);
    assert.equal(body.items.length, 1);
    assert.deepEqual([body.items[0].in_library, body.items[0].decision], [true, 'skip']);
    assert.equal(body.batch.resolved, body.batch.total, 'already-owned rows count as resolved immediately, so the bar does not hang at 0');
  } finally {
    if (batchId) await q('DELETE FROM import_batches WHERE id = $1', [batchId]);
    await q('DELETE FROM lib_series WHERE id = $1', [owned]);
    await app.close();
  }
});

test('a backup entry carrying its own Mihon source id is matched against that installed source first', { skip }, async (t) => {
  // Reintroduce by returning null from mihonSourceToAdapter (or dropping the `home` search in
  // resolveCandidate): the match lands on FAKE, which runs first and carries the same title.
  const { app, headers } = await boot();
  let batchId = '';
  try {
    const backup = backupOf(mangaEntry('Sw Match Title', Number(SW_ID)));
    const r = await app.inject({ method: 'POST', url: '/api/admin/import/batches', headers, payload: { dataUrl: dataUrlOf(backup) } });
    assert.equal(r.statusCode, 200, r.body);
    batchId = r.json().batchId;

    const body = await waitForState(app, headers, batchId, ['review']);
    assert.equal(body.items.length, 1);
    const item = body.items[0];
    // FAKE carries "Sw Match Title" too (as fm-sw) and is registered ahead of SW_ADAPTER (lower
    // preferredOrder), so this is the actual proof: without the source-id shortcut, an unscoped title
    // search would take FAKE's copy. And it is `exact`, not `same_source`: the entry carries no url, and
    // only the url proves identity -- a title hit on the home source is judged like any other title hit.
    assert.deepEqual([item.decision, item.confidence, item.match_source, item.match_source_id], ['auto', 'exact', SW_ADAPTER, 'sw-1']);
  } finally {
    if (batchId) await q('DELETE FROM import_batches WHERE id = $1', [batchId]);
    await app.close();
  }
});

test('the backup url proves a same-source match even when the title differs', { skip }, async (t) => {
  // Reintroduce by dropping the `byUrl` comparison in resolveCandidate (title tiers only): the retitled
  // entry then matches nothing and the row stays unresolved.
  const { app, headers } = await boot();
  let batchId = '';
  try {
    // Mihon stored `manga/sw-2` (no leading slash); the source now serves it as `/manga/sw-2/` under a title
    // that shares not one word with what the backup remembers. The path is the only link between the two.
    const backup = backupOf(mangaEntry('Renamed Entry', Number(SW_ID), 'manga/sw-2'));
    const r = await app.inject({ method: 'POST', url: '/api/admin/import/batches', headers, payload: { dataUrl: dataUrlOf(backup) } });
    assert.equal(r.statusCode, 200, r.body);
    batchId = r.json().batchId;

    const body = await waitForState(app, headers, batchId, ['review']);
    const item = body.items[0];
    assert.equal(item.backup_url, 'manga/sw-2', 'PREMISE: the url was read out of the backup and stored');
    assert.deepEqual([item.decision, item.confidence, item.match_source, item.match_source_id, item.match_title],
      ['auto', 'same_source', SW_ADAPTER, 'sw-2', 'Completely Different Name']);
  } finally {
    if (batchId) await q('DELETE FROM import_batches WHERE id = $1', [batchId]);
    await app.close();
  }
});

test('a home-source search whose first result is unrelated leaves the row unresolved', { skip }, async (t) => {
  // Reintroduce by restoring the first-result fallback in resolveCandidate's home-source branch
  // (`const pick = best?.item ?? raw[0]` returned at 'same_source'): the unrelated hit comes back green.
  const { app, headers } = await boot();
  let batchId = '';
  try {
    // The source answers the search with a manga that has nothing to do with the query, and the path the
    // backup remembers is not among the results. That is not a match at any tier -- least of all the top one.
    const backup = backupOf(mangaEntry('Unrelated Query', Number(SW_ID), '/manga/does-not-exist'));
    const r = await app.inject({ method: 'POST', url: '/api/admin/import/batches', headers, payload: { dataUrl: dataUrlOf(backup) } });
    assert.equal(r.statusCode, 200, r.body);
    batchId = r.json().batchId;

    const body = await waitForState(app, headers, batchId, ['review']);
    const item = body.items[0];
    assert.deepEqual([item.decision, item.confidence, item.match_source_id], ['unresolved', null, null],
      'no confident hit anywhere: the row is left for a person, not handed the first result at same_source');
  } finally {
    if (batchId) await q('DELETE FROM import_batches WHERE id = $1', [batchId]);
    await app.close();
  }
});

test('DELETE removes the batch and every candidate row with it', { skip }, async (t) => {
  // Reintroduce by dropping ON DELETE CASCADE from import_candidates.batch_id in migrate.ts.
  const { app, headers } = await boot();
  try {
    const r = await app.inject({ method: 'POST', url: '/api/admin/import/batches', headers, payload: { titles: ['Whatever Title'] } });
    const batchId = r.json().batchId;
    await waitForState(app, headers, batchId, ['review']);
    const del = await app.inject({ method: 'DELETE', url: `/api/admin/import/batches/${batchId}`, headers });
    assert.equal(del.statusCode, 200, del.body);
    assert.equal((await q('SELECT count(*)::int AS n FROM import_batches WHERE id = $1', [batchId]))[0].n, 0);
    assert.equal((await q('SELECT count(*)::int AS n FROM import_candidates WHERE batch_id = $1', [batchId]))[0].n, 0, 'cascaded');
    const getAfter = await app.inject({ method: 'GET', url: `/api/admin/import/batches/${batchId}`, headers });
    assert.equal(getAfter.statusCode, 404);
  } finally {
    await app.close();
  }
});

test('a second batch cannot start resolving while one is already in flight', { skip }, async (t) => {
  // Reintroduce by dropping the `if (resolvingBatch)` check at the top of POST /batches.
  const { app, headers } = await boot();
  let first = '';
  searchDelayMs = 150; // wide enough that 20 titles at RESOLVE_CONCURRENCY=3 keeps `first` resolving well past the second POST
  try {
    const r1 = await app.inject({ method: 'POST', url: '/api/admin/import/batches', headers, payload: { titles: Array.from({ length: 20 }, (_, i) => `Slow Title ${i}`) } });
    assert.equal(r1.statusCode, 200, r1.body);
    first = r1.json().batchId;

    const r2 = await app.inject({ method: 'POST', url: '/api/admin/import/batches', headers, payload: { titles: ['Another Title'] } });
    assert.equal(r2.statusCode, 409, r2.body);
    assert.equal(r2.json().error, 'busy');

    await waitForState(app, headers, first, ['review'], 20_000);
  } finally {
    searchDelayMs = 0;
    if (first) await q('DELETE FROM import_batches WHERE id = $1', [first]);
    await app.close();
  }
});

test('two POSTs inside the same setup window start one batch, not two', { skip }, async (t) => {
  // Reintroduce by deleting `resolvingBatch = 'pending'` in POST /batches: both requests pass the check
  // before either reaches resolveBatch (four awaits later), and both answer 200.
  const { app, headers } = await boot();
  const ids: string[] = [];
  try {
    const post = (titles: string[]) => app.inject({ method: 'POST', url: '/api/admin/import/batches', headers, payload: { titles } });
    // A double-tap on "Start matching": both requests are in the handler before either has written a row.
    const [r1, r2] = await Promise.all([post(['Fake Manga']), post(['Fake Manga Two'])]);
    for (const r of [r1, r2]) if (r.statusCode === 200) ids.push(r.json().batchId);
    assert.deepEqual([r1.statusCode, r2.statusCode].sort(), [200, 409], `${r1.body} / ${r2.body}`);
    assert.equal(ids.length, 1);
    assert.equal((await q(`SELECT count(*)::int AS n FROM import_batches WHERE id = ANY($1)`, [ids]))[0].n, 1);
    await waitForState(app, headers, ids[0], ['review']);
  } finally {
    for (const id of ids) await q('DELETE FROM import_batches WHERE id = $1', [id]);
    await app.close();
  }
});

test('a discarded batch stops searching sources at the next row', { skip }, async (t) => {
  // Reintroduce by dropping the `if (aborted.has(batchId)) return` check at the top of the resolve worker:
  // DELETE cascades the rows away but the loop keeps searching every remaining title.
  const { app, headers } = await boot();
  searchDelayMs = 150;
  let batchId = '';
  try {
    const before = searchCalls;
    const r = await app.inject({ method: 'POST', url: '/api/admin/import/batches', headers, payload: { titles: Array.from({ length: 20 }, (_, i) => `Discard Title ${i}`) } });
    assert.equal(r.statusCode, 200, r.body);
    batchId = r.json().batchId;
    await waitUntil(() => searchCalls >= before + RESOLVE_CONCURRENCY, 'every worker to be inside a search');
    const del = await app.inject({ method: 'DELETE', url: `/api/admin/import/batches/${batchId}`, headers });
    assert.equal(del.statusCode, 200, del.body);
    const atDelete = searchCalls;
    // Long enough for the whole batch to finish if nothing stopped it: 17 remaining titles at 150 ms, three at a time.
    await sleep(1500);
    // Each worker may already be past the check and inside resolveCandidate for ONE more row when DELETE
    // lands, so up to RESOLVE_CONCURRENCY further searches are the row-in-flight allowance; 17 is the bug.
    assert.ok(searchCalls - atDelete <= RESOLVE_CONCURRENCY, `${searchCalls - atDelete} searches were started after the batch was discarded`);
    // And the guard is free again straight away -- the admin does not wait out the abandoned loop.
    const next = await app.inject({ method: 'POST', url: '/api/admin/import/batches', headers, payload: { titles: ['After Discard'] } });
    assert.equal(next.statusCode, 200, next.body);
    searchDelayMs = 0;
    await waitForState(app, headers, next.json().batchId, ['review']);
    await q('DELETE FROM import_batches WHERE id = $1', [next.json().batchId]);
  } finally {
    searchDelayMs = 0;
    if (batchId) await q('DELETE FROM import_batches WHERE id = $1', [batchId]);
    await app.close();
  }
});

test('a discarded batch stops adding series at the next row', { skip }, async (t) => {
  // Reintroduce by dropping the `if (aborted.has(id)) return` check at the top of the /run loop: every
  // remaining row is still added for a batch that no longer exists.
  globalThis.fetch = (async () => new Response(PIXEL, { status: 200, headers: { 'content-type': 'image/png' } })) as typeof fetch;
  const { app, headers } = await boot();
  let batchId = '';
  try {
    const r = await app.inject({ method: 'POST', url: '/api/admin/import/batches', headers, payload: { titles: ['Fake Manga Five', 'Fake Manga Six', 'Fake Manga Seven'] } });
    assert.equal(r.statusCode, 200, r.body);
    batchId = r.json().batchId;
    const body = await waitForState(app, headers, batchId, ['review']);
    assert.equal(body.items.filter((i: any) => i.decision === 'auto').length, 3, 'PREMISE: all three matched');

    seriesDelayMs = 300;
    const before = seriesCalls;
    const run = await app.inject({ method: 'POST', url: `/api/admin/import/batches/${batchId}/run`, headers });
    assert.equal(run.statusCode, 200, run.body);
    await waitUntil(() => seriesCalls > before, 'the first add to start');
    const del = await app.inject({ method: 'DELETE', url: `/api/admin/import/batches/${batchId}`, headers });
    assert.equal(del.statusCode, 200, del.body);
    await sleep(1500); // three adds at 300 ms would long be finished if nothing stopped the loop
    const n = (await q(`SELECT count(*)::int AS n FROM lib_series WHERE source_series_id IN ('fm-5','fm-6','fm-7')`))[0].n;
    assert.ok(n <= 1, `${n} series were added for a discarded batch (only the add in flight may finish)`);
  } finally {
    seriesDelayMs = 0;
    if (batchId) await q('DELETE FROM import_batches WHERE id = $1', [batchId]);
    await q(`DELETE FROM lib_series WHERE source_series_id IN ('fm-5','fm-6','fm-7')`);
    await app.close();
  }
});

test('an importing batch nobody is running was stranded by a restart: GET hands it back, a live run is left alone', { skip }, async (t) => {
  // Reintroduce by dropping the `state === 'importing' && !importingBatches.has(id)` flip in GET
  // /batches/:id: the stranded batch reads 'importing' for ever.
  globalThis.fetch = (async () => new Response(PIXEL, { status: 200, headers: { 'content-type': 'image/png' } })) as typeof fetch;
  const { app, headers } = await boot();
  let batchId = '';
  try {
    const r = await app.inject({ method: 'POST', url: '/api/admin/import/batches', headers, payload: { titles: ['Fake Manga Three', 'Fake Manga Four'] } });
    assert.equal(r.statusCode, 200, r.body);
    batchId = r.json().batchId;
    const body = await waitForState(app, headers, batchId, ['review']);
    const three = body.items.find((i: any) => i.backup_title === 'Fake Manga Three');
    const four = body.items.find((i: any) => i.backup_title === 'Fake Manga Four');
    assert.deepEqual([three.decision, four.decision], ['auto', 'auto'], 'PREMISE: both matched');

    await t.test('while this process is running the add loop, GET reports importing', async () => {
      seriesDelayMs = 300;
      const before = seriesCalls;
      const run = await app.inject({ method: 'POST', url: `/api/admin/import/batches/${batchId}/run`, headers, payload: { candidateIds: [three.id] } });
      assert.equal(run.statusCode, 200, run.body);
      await waitUntil(() => seriesCalls > before, 'the add to start');
      const mid = await app.inject({ method: 'GET', url: `/api/admin/import/batches/${batchId}`, headers });
      assert.equal(mid.json().batch.state, 'importing', 'a run this process owns is not mistaken for a stranded one');
      await waitForState(app, headers, batchId, ['review']); // row four is still ready, so not 'done'
      seriesDelayMs = 0;
    });

    await t.test('a stranded batch with rows still ready reads back as review, in the database too', async () => {
      // What a restart mid-run leaves behind: the database says importing, no loop in this process does.
      await q(`UPDATE import_batches SET state = 'importing' WHERE id = $1`, [batchId]);
      const g = await app.inject({ method: 'GET', url: `/api/admin/import/batches/${batchId}`, headers });
      assert.equal(g.statusCode, 200, g.body);
      assert.equal(g.json().batch.state, 'review');
      assert.equal((await q('SELECT state FROM import_batches WHERE id = $1', [batchId]))[0].state, 'review', 'persisted, so /run agrees with the page');
      // ...and Import works again on what was never reached.
      const run = await app.inject({ method: 'POST', url: `/api/admin/import/batches/${batchId}/run`, headers });
      assert.equal(run.statusCode, 200, run.body);
      assert.equal(run.json().total, 1, 'only row four -- row three was already added before the "restart"');
      await waitForState(app, headers, batchId, ['done']);
    });

    await t.test('a stranded batch with nothing left reads back as done, not as an empty review', async () => {
      await q(`UPDATE import_batches SET state = 'importing' WHERE id = $1`, [batchId]);
      const g = await app.inject({ method: 'GET', url: `/api/admin/import/batches/${batchId}`, headers });
      assert.equal(g.json().batch.state, 'done');
    });
  } finally {
    seriesDelayMs = 0;
    if (batchId) await q('DELETE FROM import_batches WHERE id = $1', [batchId]);
    await q(`DELETE FROM lib_series WHERE source_series_id IN ('fm-3','fm-4')`);
    await app.close();
  }
});

test('a second batch importing at the same time does not make the first look stranded', { skip }, async (t) => {
  // Reintroduce by tracking only the latest run (`importingBatches.clear()` before `.add(id)` in /run):
  // starting batch B's run makes GET flip batch A, still mid-loop, back to review.
  globalThis.fetch = (async () => new Response(PIXEL, { status: 200, headers: { 'content-type': 'image/png' } })) as typeof fetch;
  const { app, headers } = await boot();
  const ids: string[] = [];
  try {
    for (const titles of [['Fake Manga Six'], ['Fake Manga Seven']]) {
      const r = await app.inject({ method: 'POST', url: '/api/admin/import/batches', headers, payload: { titles } });
      assert.equal(r.statusCode, 200, r.body);
      ids.push(r.json().batchId);
      await waitForState(app, headers, r.json().batchId, ['review']);
    }
    const [a, b] = ids;
    seriesDelayMs = 400;
    const before = seriesCalls;
    assert.equal((await app.inject({ method: 'POST', url: `/api/admin/import/batches/${a}/run`, headers })).statusCode, 200);
    await waitUntil(() => seriesCalls > before, "batch A's add to start");
    assert.equal((await app.inject({ method: 'POST', url: `/api/admin/import/batches/${b}/run`, headers })).statusCode, 200, 'runs are not serialised across batches');
    const mid = await app.inject({ method: 'GET', url: `/api/admin/import/batches/${a}`, headers });
    assert.equal(mid.json().batch.state, 'importing', 'A is still being imported by this process');
    await waitForState(app, headers, a, ['done']);
    await waitForState(app, headers, b, ['done']);
  } finally {
    seriesDelayMs = 0;
    for (const id of ids) await q('DELETE FROM import_batches WHERE id = $1', [id]);
    await q(`DELETE FROM lib_series WHERE source_series_id IN ('fm-6','fm-7')`);
    await app.close();
  }
});

test('two /run calls at once import the batch once', { skip }, async (t) => {
  // Reintroduce by dropping `AND state NOT IN ('importing','resolving')` from /run's claiming UPDATE: both
  // requests read 'review', both claim, both loops add the same rows.
  globalThis.fetch = (async () => new Response(PIXEL, { status: 200, headers: { 'content-type': 'image/png' } })) as typeof fetch;
  const { app, headers } = await boot();
  let batchId = '';
  try {
    const r = await app.inject({ method: 'POST', url: '/api/admin/import/batches', headers, payload: { titles: ['Fake Manga', 'Fake Manga Two'] } });
    assert.equal(r.statusCode, 200, r.body);
    batchId = r.json().batchId;
    await waitForState(app, headers, batchId, ['review']);

    const run = () => app.inject({ method: 'POST', url: `/api/admin/import/batches/${batchId}/run`, headers });
    const [r1, r2] = await Promise.all([run(), run()]);
    assert.deepEqual([r1.statusCode, r2.statusCode].sort(), [200, 409], `${r1.body} / ${r2.body}`);
    assert.equal([r1, r2].find((x) => x.statusCode === 409)!.json().error, 'busy');
    const body = await waitForState(app, headers, batchId, ['done']);
    assert.deepEqual([body.batch.added, body.batch.already], [2, 0], 'each row was added exactly once');
    assert.equal((await q(`SELECT count(*)::int AS n FROM lib_series WHERE source_series_id IN ('fm-1','fm-2')`))[0].n, 2);
  } finally {
    if (batchId) await q('DELETE FROM import_batches WHERE id = $1', [batchId]);
    await q(`DELETE FROM lib_series WHERE source_series_id IN ('fm-1','fm-2')`);
    await app.close();
  }
});

test('a resumed pass does not count already-settled rows a second time', { skip }, async (t) => {
  // Reintroduce by dropping the `resolved = total - $2` reset at the top of resolveBatch: the row that got
  // no match the first time is retried and counted again, and the bar reads 3 of 2.
  const { app, headers } = await boot();
  let batchId = '';
  try {
    const r = await app.inject({ method: 'POST', url: '/api/admin/import/batches', headers, payload: { titles: ['Fake Manga', 'Nobody Has This One'] } });
    assert.equal(r.statusCode, 200, r.body);
    batchId = r.json().batchId;
    const first = await waitForState(app, headers, batchId, ['review']);
    assert.equal(first.batch.resolved, 2, 'PREMISE: a full pass ends at total');

    // A restart mid-pass: the state is back to resolving, the counter is wherever it was.
    await q(`UPDATE import_batches SET state = 'resolving' WHERE id = $1`, [batchId]);
    const g = await app.inject({ method: 'GET', url: `/api/admin/import/batches/${batchId}`, headers });
    assert.equal(g.json().batch.stale, true, 'PREMISE: nobody in this process is resolving it');
    const resume = await app.inject({ method: 'POST', url: `/api/admin/import/batches/${batchId}/resume`, headers });
    assert.equal(resume.statusCode, 200, resume.body);
    const again = await waitForState(app, headers, batchId, ['review']);
    assert.equal(again.batch.resolved, again.batch.total, `resolved ${again.batch.resolved} of ${again.batch.total}`);
    assert.equal(again.items.find((i: any) => i.backup_title === 'Fake Manga').decision, 'auto', 'the settled row was left alone');
  } finally {
    if (batchId) await q('DELETE FROM import_batches WHERE id = $1', [batchId]);
    await app.close();
  }
});

test('GET /batches lists every batch newest first, with its counts and without its rows', { skip }, async (t) => {
  // Reintroduce by deleting the GET /api/admin/import/batches route.
  const { app, headers } = await boot();
  const ids: string[] = [];
  try {
    for (const titles of [['Fake Manga'], ['Fake Manga Two']]) {
      const r = await app.inject({ method: 'POST', url: '/api/admin/import/batches', headers, payload: { titles } });
      assert.equal(r.statusCode, 200, r.body);
      ids.push(r.json().batchId);
      await waitForState(app, headers, r.json().batchId, ['review']);
    }
    const list = await app.inject({ method: 'GET', url: '/api/admin/import/batches', headers });
    assert.equal(list.statusCode, 200, list.body);
    const content = list.json().content as any[];
    const mine = content.filter((b) => ids.includes(b.id));
    assert.deepEqual(mine.map((b) => b.id), [ids[1], ids[0]], 'newest first');
    const row = mine[0];
    assert.deepEqual([row.origin, row.state, row.total, row.resolved, row.added, row.already, row.failed], ['paste', 'review', 1, 1, 0, 0, 0]);
    assert.ok(row.created_at && row.updated_at, 'timestamps for the "Open imports" list');
    assert.equal(row.items, undefined, 'a summary, not 500 candidate rows per batch');
  } finally {
    for (const id of ids) await q('DELETE FROM import_batches WHERE id = $1', [id]);
    await app.close();
  }
});

test('a malformed batch or candidate id is not found, not a server error', { skip }, async (t) => {
  // Reintroduce by removing the uuid check (`batchIdOf` / `uuidParam`) from the routes: Postgres raises
  // 22P02 on `WHERE id = 'not-a-uuid'` and the error handler answers 500.
  const { app, headers } = await boot();
  try {
    const calls: Array<[string, string, unknown?]> = [
      ['GET', '/api/admin/import/batches/not-a-uuid'],
      ['DELETE', '/api/admin/import/batches/not-a-uuid'],
      ['POST', '/api/admin/import/batches/not-a-uuid/resume'],
      ['POST', '/api/admin/import/batches/not-a-uuid/run', {}],
      ['PATCH', '/api/admin/import/candidates/not-a-uuid', { decision: 'skip' }],
    ];
    for (const [method, url, payload] of calls) {
      const r = await app.inject({ method: method as any, url, headers, payload });
      assert.equal(r.statusCode, 404, `${method} ${url}: ${r.body}`);
      assert.equal(r.json().error, 'not_found');
    }
  } finally {
    await app.close();
  }
});

test('the sweep drops finished batches after a week and forgotten open ones after a month', { skip }, async (t) => {
  // Reintroduce by dropping the `state IN ('resolving','review','importing')` branch from
  // sweepImportBatches: the two forgotten batches survive and the count reads 1.
  const { app, uid } = await boot();
  const { sweepImportBatches } = await import('../src/routes/admin');
  const mk = async (state: string, daysAgo: number) => (await q<{ id: string }>(
    `INSERT INTO import_batches (user_id, origin, state, total, resolved, updated_at)
     VALUES ($1, 'paste', $2, 1, 1, now() - make_interval(days => $3)) RETURNING id`, [uid, state, daysAgo]))[0].id;
  const ids: string[] = [];
  try {
    const doneOld = await mk('done', 8);
    const reviewFresh = await mk('review', 8);
    const reviewOld = await mk('review', 31);
    const resolvingOld = await mk('resolving', 31);
    const importingFresh = await mk('importing', 1);
    ids.push(doneOld, reviewFresh, reviewOld, resolvingOld, importingFresh);
    const swept = await sweepImportBatches();
    const left = new Set((await q<{ id: string }>('SELECT id FROM import_batches WHERE id = ANY($1)', [ids])).map((r) => r.id));
    assert.equal(swept.removed, 3, 'the finished one at eight days and both forgotten ones at a month');
    assert.deepEqual([left.has(doneOld), left.has(reviewOld), left.has(resolvingOld)], [false, false, false]);
    assert.deepEqual([left.has(reviewFresh), left.has(importingFresh)], [true, true], 'a batch someone touched this month is still theirs');
  } finally {
    await q('DELETE FROM import_batches WHERE id = ANY($1)', [ids]);
    await app.close();
  }
});

test('a malformed candidateIds entry is a bad request, not a server error', { skip }, async (t) => {
  // Reintroduce by dropping `.uuid()` from `candidateIds` in /run's body schema: `id = ANY($2)` on a uuid
  // column makes Postgres raise 22P02 and the error handler answers 500 with the raw database message.
  const { app, headers } = await boot();
  let batchId = '';
  try {
    const r = await app.inject({ method: 'POST', url: '/api/admin/import/batches', headers, payload: { titles: ['Fake Manga'] } });
    assert.equal(r.statusCode, 200, r.body);
    batchId = r.json().batchId;
    await waitForState(app, headers, batchId, ['review']);
    const run = await app.inject({ method: 'POST', url: `/api/admin/import/batches/${batchId}/run`, headers, payload: { candidateIds: ['not-a-uuid'] } });
    assert.equal(run.statusCode, 400, run.body);
    assert.equal(run.json().error, 'bad_request');
    assert.equal((await q('SELECT state FROM import_batches WHERE id = $1', [batchId]))[0].state, 'review', 'nothing was claimed or run');
  } finally {
    if (batchId) await q('DELETE FROM import_batches WHERE id = $1', [batchId]);
    await app.close();
  }
});

test('a batch whose leftovers are skipped after a partial run closes on its own', { skip }, async (t) => {
  globalThis.fetch = (async () => new Response(PIXEL, { status: 200, headers: { 'content-type': 'image/png' } })) as typeof fetch;
  const { app, headers } = await boot();
  let batchId = '';
  try {
    const r = await app.inject({ method: 'POST', url: '/api/admin/import/batches', headers, payload: { titles: ['Fake Manga', 'Fake Manga Two', 'Nobody Has This One'] } });
    assert.equal(r.statusCode, 200, r.body);
    batchId = r.json().batchId;
    const body = await waitForState(app, headers, batchId, ['review']);
    const a = body.items.find((i: any) => i.backup_title === 'Fake Manga');
    const b = body.items.find((i: any) => i.backup_title === 'Fake Manga Two');
    const unresolved = body.items.find((i: any) => i.backup_title === 'Nobody Has This One');
    assert.deepEqual([a.decision, b.decision, unresolved.decision], ['auto', 'auto', 'unresolved'], 'PREMISE');

    const run = await app.inject({ method: 'POST', url: `/api/admin/import/batches/${batchId}/run`, headers, payload: { candidateIds: [a.id] } });
    assert.equal(run.statusCode, 200, run.body);
    // The run's tail is waited out through the database, not through GET: the first GET this batch sees
    // after its run is the one inside the first subtest, so a GET that closes too eagerly fails THERE.
    const stateOf = async () => (await q('SELECT state FROM import_batches WHERE id = $1', [batchId]))[0].state as string;
    for (let i = 0; i < 200 && (await stateOf()) === 'importing'; i++) await sleep(40);
    assert.equal(await stateOf(), 'review', 'PREMISE: the run\'s own tail left the batch open, two rows still waiting');

    await t.test('skipping one leftover while another is still open leaves the batch in review', async () => {
      // Reintroduce by dropping `AND NOT EXISTS (... status IS NULL AND decision <> 'skip')` from
      // closeBatchIfSettled: the first GET after the run, and the first skip, each close a batch that still
      // has an unresolved row to find by hand.
      const first = await app.inject({ method: 'GET', url: `/api/admin/import/batches/${batchId}`, headers });
      assert.equal(first.json().batch.state, 'review', 'viewing a batch with rows still waiting does not close it');
      const skipB = await app.inject({ method: 'PATCH', url: `/api/admin/import/candidates/${b.id}`, headers, payload: { decision: 'skip' } });
      assert.equal(skipB.statusCode, 200, skipB.body);
      const g = await app.inject({ method: 'GET', url: `/api/admin/import/batches/${batchId}`, headers });
      assert.equal(g.json().batch.state, 'review', 'the unresolved row is still waiting for a person');
    });

    await t.test('skipping the last open row finishes the batch, in the database too', async () => {
      // Reintroduce by dropping the `closeBatchIfSettled` call from PATCH's skip branch AND the one in GET
      // /batches/:id: nothing re-evaluates the batch after the run's tail, so it reads `review` for ever --
      // the state the sweep keeps for thirty days and the review card cannot leave except by Discard.
      const skipLast = await app.inject({ method: 'PATCH', url: `/api/admin/import/candidates/${unresolved.id}`, headers, payload: { decision: 'skip' } });
      assert.equal(skipLast.statusCode, 200, skipLast.body);
      assert.equal((await q('SELECT state FROM import_batches WHERE id = $1', [batchId]))[0].state, 'done', 'closed by the skip itself, before any GET');
      const g = await app.inject({ method: 'GET', url: `/api/admin/import/batches/${batchId}`, headers });
      assert.equal(g.json().batch.state, 'done');
      assert.deepEqual([g.json().batch.added, g.json().batch.already, g.json().batch.failed], [1, 0, 0], 'the counts are the run\'s, untouched by closing');
    });

    await t.test('a leftover-free batch left in review by an older version is closed on the next GET', async () => {
      // Reintroduce by dropping the `closeBatchIfSettled` call from GET /batches/:id (keeping PATCH's): the
      // batch below was skipped clean under a version without the PATCH-side close, and stays `review`.
      await q(`UPDATE import_batches SET state = 'review' WHERE id = $1`, [batchId]);
      const g = await app.inject({ method: 'GET', url: `/api/admin/import/batches/${batchId}`, headers });
      assert.equal(g.statusCode, 200, g.body);
      assert.equal(g.json().batch.state, 'done');
      assert.equal((await q('SELECT state FROM import_batches WHERE id = $1', [batchId]))[0].state, 'done', 'persisted, so the Open imports list agrees with the page');
    });
  } finally {
    if (batchId) await q('DELETE FROM import_batches WHERE id = $1', [batchId]);
    await q(`DELETE FROM lib_series WHERE source_series_id IN ('fm-1','fm-2')`);
    await app.close();
  }
});

test('a batch nothing was ever imported through is not closed on view', { skip }, async (t) => {
  // Reintroduce by dropping `AND EXISTS (... status IS NOT NULL)` from closeBatchIfSettled: a backup whose
  // every title is already in the library is leftover-free from its first second and would answer `done`
  // on its first GET -- "Done — 0 added · 0 already had" in place of the list saying every row is owned.
  const { app, headers } = await boot();
  const { newSeriesId } = await import('../src/lib/ids');
  const owned = newSeriesId();
  let batchId = '';
  try {
    await q(`INSERT INTO lib_series (id, source, title, folder, books_count) VALUES ($1,'test','Owned Before Import',$1,1)`, [owned]);
    const r = await app.inject({ method: 'POST', url: '/api/admin/import/batches', headers, payload: { titles: ['Owned Before Import'] } });
    assert.equal(r.statusCode, 200, r.body);
    batchId = r.json().batchId;
    const body = await waitForState(app, headers, batchId, ['review', 'done']);
    assert.deepEqual([body.items[0].in_library, body.items[0].decision, body.items[0].status], [true, 'skip', null], 'PREMISE: skipped up front, never run');
    for (let i = 0; i < 3; i++) {
      const g = await app.inject({ method: 'GET', url: `/api/admin/import/batches/${batchId}`, headers });
      assert.equal(g.json().batch.state, 'review', `GET #${i + 1}: nothing ran, so there is nothing to call finished`);
    }
    // ...and a skip on such a batch does not close it either: the rule is one rule, not one per route.
    const skip1 = await app.inject({ method: 'PATCH', url: `/api/admin/import/candidates/${body.items[0].id}`, headers, payload: { decision: 'skip' } });
    assert.equal(skip1.statusCode, 200, skip1.body);
    assert.equal((await q('SELECT state FROM import_batches WHERE id = $1', [batchId]))[0].state, 'review');
  } finally {
    if (batchId) await q('DELETE FROM import_batches WHERE id = $1', [batchId]);
    await q('DELETE FROM lib_series WHERE id = $1', [owned]);
    await app.close();
  }
});

test('a /resume and a POST inside the same window start one resolve loop, not two', { skip }, async (t) => {
  const { app, headers } = await boot();
  const ids: string[] = [];
  try {
    const r = await app.inject({ method: 'POST', url: '/api/admin/import/batches', headers, payload: { titles: ['Fake Manga', 'Nobody Has This One'] } });
    assert.equal(r.statusCode, 200, r.body);
    ids.push(r.json().batchId);
    await waitForState(app, headers, ids[0], ['review']);
    // A restart mid-pass: the batch reads resolving, nobody in this process is resolving it.
    await q(`UPDATE import_batches SET state = 'resolving' WHERE id = $1`, [ids[0]]);
    searchDelayMs = 200; // so whichever loop starts is still searching when the other request is judged

    await t.test('the loser answers busy', async () => {
      // Reintroduce by deleting `resolvingBatch = id` in /resume (checking the guard, then awaiting the
      // SELECT): both requests pass their checks before either loop starts, and both answer 200 -- two
      // search loops at once, which the docs call impossible.
      const [resume, post] = await Promise.all([
        app.inject({ method: 'POST', url: `/api/admin/import/batches/${ids[0]}/resume`, headers }),
        app.inject({ method: 'POST', url: '/api/admin/import/batches', headers, payload: { titles: ['Fake Manga Two', 'Nobody Has This Either'] } }),
      ]);
      if (post.statusCode === 200) ids.push(post.json().batchId);
      assert.deepEqual([resume.statusCode, post.statusCode].sort(), [200, 409], `${resume.body} / ${post.body}`);
      assert.equal([resume, post].find((x) => x.statusCode === 409)!.json().error, 'busy');
    });

    searchDelayMs = 0;
    for (const id of ids) await waitForState(app, headers, id, ['review'], 10_000);

    await t.test('two Resume taps on the same stale batch both answer ok, and start one loop', async () => {
      // Reintroduce by claiming `'pending'` in /resume instead of the batch's own id: the second tap sees a
      // guard that is not its id and answers 409 "another import is already resolving" about itself.
      await q(`UPDATE import_batches SET state = 'resolving' WHERE id = $1`, [ids[0]]);
      searchDelayMs = 200;
      const before = searchCalls;
      const [r1, r2] = await Promise.all([
        app.inject({ method: 'POST', url: `/api/admin/import/batches/${ids[0]}/resume`, headers }),
        app.inject({ method: 'POST', url: `/api/admin/import/batches/${ids[0]}/resume`, headers }),
      ]);
      assert.deepEqual([r1.statusCode, r2.statusCode], [200, 200], `${r1.body} / ${r2.body}`);
      searchDelayMs = 0;
      await waitForState(app, headers, ids[0], ['review'], 10_000);
      assert.equal(searchCalls - before, 1, 'the one unresolved title was searched once, not once per tap');
    });
  } finally {
    searchDelayMs = 0;
    for (const id of ids) await q('DELETE FROM import_batches WHERE id = $1', [id]);
    await app.close();
  }
});

test('a title the library already has under another spelling counts as already had, not failed', { skip }, async (t) => {
  // Reintroduce by dropping `|| r.error === 'duplicate'` from the run loop's `already` branch: the row's
  // status becomes the raw code 'duplicate', the batch counts it as failed, and the page paints it red.
  globalThis.fetch = (async () => new Response(PIXEL, { status: 200, headers: { 'content-type': 'image/png' } })) as typeof fetch;
  const { app, headers } = await boot();
  const { newSeriesId } = await import('../src/lib/ids');
  const owned = newSeriesId();
  let batchId = '';
  try {
    // The library has the title from ANOTHER source, under a folder the matched source would never use;
    // the backup spells it with a suffix, so the up-front in_library check (exact normalised title) misses
    // it, the resolve pass matches it by `contains`, and only addSeriesFromSource's duplicate check sees it.
    await q(`INSERT INTO lib_series (id, source, title, folder, books_count) VALUES ($1,'Other','Fake Manga Two',$1,1)`, [owned]);
    const r = await app.inject({ method: 'POST', url: '/api/admin/import/batches', headers, payload: { titles: ['Fake Manga Two dup'] } });
    assert.equal(r.statusCode, 200, r.body);
    batchId = r.json().batchId;
    const body = await waitForState(app, headers, batchId, ['review']);
    const item = body.items[0];
    assert.deepEqual([item.in_library, item.decision, item.confidence, item.match_source_id], [false, 'auto', 'contains', 'fm-2'], 'PREMISE: not caught up front, matched by the pass');

    const run = await app.inject({ method: 'POST', url: `/api/admin/import/batches/${batchId}/run`, headers });
    assert.equal(run.statusCode, 200, run.body);
    const fin = await waitForState(app, headers, batchId, ['done']);
    assert.equal(fin.items[0].status, 'already', 'the library has this title -- that is what the row says');
    assert.deepEqual([fin.batch.added, fin.batch.already, fin.batch.failed], [0, 1, 0]);
    assert.equal((await q(`SELECT count(*)::int AS n FROM lib_series WHERE source_series_id = 'fm-2'`))[0].n, 0, 'and no second copy was added');
  } finally {
    if (batchId) await q('DELETE FROM import_batches WHERE id = $1', [batchId]);
    await q('DELETE FROM lib_series WHERE id = $1', [owned]);
    await q(`DELETE FROM lib_series WHERE source_series_id = 'fm-2'`);
    await app.close();
  }
});

test('the list marks a batch left resolving by a restart as stale, and a live one as not', { skip }, async (t) => {
  // Reintroduce by returning the raw rows from GET /api/admin/import/batches (no `stale`): the Open imports
  // card reads "Matching… 1/2" for a batch nobody is matching, and only opening it reveals Resume.
  const { app, headers } = await boot();
  const ids: string[] = [];
  try {
    const r = await app.inject({ method: 'POST', url: '/api/admin/import/batches', headers, payload: { titles: ['Fake Manga', 'Nobody Has This One'] } });
    assert.equal(r.statusCode, 200, r.body);
    ids.push(r.json().batchId);
    await waitForState(app, headers, ids[0], ['review']);
    await q(`UPDATE import_batches SET state = 'resolving' WHERE id = $1`, [ids[0]]);

    // A second batch genuinely mid-pass in this process, so the field is shown to read the guard, not the state.
    searchDelayMs = 150;
    const live = await app.inject({ method: 'POST', url: '/api/admin/import/batches', headers, payload: { titles: Array.from({ length: 12 }, (_, i) => `Live Title ${i}`) } });
    assert.equal(live.statusCode, 200, live.body);
    ids.push(live.json().batchId);

    const list = await app.inject({ method: 'GET', url: '/api/admin/import/batches', headers });
    assert.equal(list.statusCode, 200, list.body);
    const rows = list.json().content as any[];
    const stranded = rows.find((b) => b.id === ids[0]);
    const running = rows.find((b) => b.id === ids[1]);
    assert.deepEqual([stranded.state, stranded.stale], ['resolving', true], 'resolving in the database, nobody resolving it here');
    assert.deepEqual([running.state, running.stale], ['resolving', false], 'resolving, and this process is doing it');

    searchDelayMs = 0;
    await waitForState(app, headers, ids[1], ['review'], 10_000);
    const after = (await app.inject({ method: 'GET', url: '/api/admin/import/batches', headers })).json().content as any[];
    assert.equal(after.find((b) => b.id === ids[1]).stale, false, 'a batch past resolving is never stale');
  } finally {
    searchDelayMs = 0;
    for (const id of ids) await q('DELETE FROM import_batches WHERE id = $1', [id]);
    await app.close();
  }
});
