// The reviewable import (issue #48): parse → resolve matches in the background → let the admin correct or
// skip a row → add only what was accepted. Driven through the real routes end to end, not read as text.
//
// Three things this proves that the plain one-shot /api/admin/import cannot even be asked about, because it
// has no per-row state:
//
//  1. A title the resolve pass gets right is not silently taken -- it is offered, as `decision: 'auto'`,
//     and can still be overridden before /run ever touches it.
//  2. A title the resolve pass gets WRONG (or gets nothing for) does not get added anyway. `unresolved`
//     rows are excluded from /run outright, and a manual override on any row sticks until the admin changes
//     it again, including reverting to what the resolve pass originally found.
//  3. A backup entry that names its OWN Mihon source id, and that source is installed here under the same
//     id (Suwayomi extensions), is matched against THAT source first -- `same_source` confidence -- rather
//     than the first cross-source hit above a similarity threshold, which is the actual "wrong manga" bug
//     issue #48 is about.
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

let q: any;
const PIXEL = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(400, 7)]);
const realFetch = globalThis.fetch;

/** Set by the busy-guard test to widen the race window; every other test leaves this at 0. */
let searchDelayMs = 0;

function fakeAdapter() {
  return {
    id: FAKE, name: 'Fake Source', preferredOrder: 0,
    async search(term: string) {
      if (searchDelayMs) await new Promise((res) => setTimeout(res, searchDelayMs));
      return term.toLowerCase().includes('fake manga')
        ? [{ sourceId: 'fm-1', source: FAKE, title: 'Fake Manga', coverUrl: 'https://example.invalid/cover.jpg' }]
        : [];
    },
    async getSeries(sid: string) { return { sourceId: sid, source: FAKE, title: 'Fake Manga', summary: '' }; },
    async listChapters() { return [{ number: 1, title: 'Chapter 1', sourceId: 'c1', pages: 1 }]; },
    async getPageUrls() { return ['https://example.invalid/p1.png']; },
    async latest() { return []; },
  };
}

/** Only reachable via a backup entry whose source id resolves to it -- never wins a bare title search. */
function swAdapter() {
  return {
    id: SW_ADAPTER, name: 'Suwayomi Fake', preferredOrder: 999,
    async search(term: string) {
      return term.toLowerCase().includes('sw match')
        ? [{ sourceId: 'sw-1', source: SW_ADAPTER, title: 'Sw Match Title', coverUrl: 'https://example.invalid/sw.jpg' }]
        : [];
    },
    async getSeries(sid: string) { return { sourceId: sid, source: SW_ADAPTER, title: 'Sw Match Title', summary: '' }; },
    async listChapters() { return [{ number: 1, title: 'Chapter 1', sourceId: 'c1', pages: 1 }]; },
    async getPageUrls() { return ['https://example.invalid/p1.png']; },
    async latest() { return []; },
  };
}

// --- minimal protobuf writer, just the fields entriesFromBackup reads (see tachibk.test.ts for the exhaustive version) ---
const varint = (n: number): Buffer => { const out: number[] = []; while (n > 127) { out.push((n & 127) | 128); n = Math.floor(n / 128); } out.push(n); return Buffer.from(out); };
const tag = (field: number, wire: number) => varint((field << 3) | wire);
const lenField = (field: number, payload: Buffer) => Buffer.concat([tag(field, 2), varint(payload.length), payload]);
const strField = (field: number, s: string) => lenField(field, Buffer.from(s, 'utf8'));
const varField = (field: number, n: number) => Buffer.concat([tag(field, 0), varint(n)]);
const mangaEntry = (title: string, sourceId: number) => Buffer.concat([varField(1, sourceId), strField(3, title)]);
const backupOf = (...m: Buffer[]) => Buffer.concat(m.map((x) => lenField(1, x)));
const dataUrlOf = (buf: Buffer) => `data:application/octet-stream;base64,${buf.toString('base64')}`;

before(async () => {
  if (!DSN) return;
  ({ q } = await import('../src/lib/db'));
  const { migrate } = await import('../src/lib/migrate');
  await migrate();
  // Idempotent pre-cleanup: the '/run' test below adds a REAL lib_series row (source_series_id 'fm-1'),
  // which nothing here can DELETE-cascade from import_batches — a crashed or interrupted previous run of
  // this file leaves it behind, and the next run then finds "Fake Manga" already in the library, skips it
  // by default, and every test downstream of that fails with no_auto_match / nothing_to_import for reasons
  // that have nothing to do with the assertion that trips first. Self-heals rather than trusting `after()`.
  await q(`DELETE FROM lib_series WHERE source_series_id IN ('fm-1','sw-1')`);
  const { registerAdapter } = await import('../src/lib/sources');
  registerAdapter(fakeAdapter() as any);
  registerAdapter(swAdapter() as any);
  await q('INSERT INTO suwayomi_sources (source_id, name, lang, nsfw, enabled) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (source_id) DO UPDATE SET enabled = true',
    [SW_ID, 'Suwayomi Fake', 'en', false, true]);
});

after(async () => {
  if (!DSN) return;
  globalThis.fetch = realFetch;
  await q(`DELETE FROM lib_series WHERE source_series_id IN ('fm-1','sw-1')`);
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
  return { app, headers };
}

async function waitForState(app: any, headers: any, id: string, states: string[], timeoutMs = 8000) {
  const start = Date.now();
  for (;;) {
    const r = await app.inject({ method: 'GET', url: `/api/admin/import/batches/${id}`, headers });
    assert.equal(r.statusCode, 200, r.body);
    const body = r.json();
    if (states.includes(body.batch.state)) return body;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for state in [${states}], last was ${body.batch.state}: ${JSON.stringify(body.items.map((i: any) => [i.backup_title, i.decision]))}`);
    await new Promise((res) => setTimeout(res, 40));
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
      const r = await app.inject({ method: 'POST', url: '/api/admin/import/batches', headers, payload: { titles: ['Fake Manga', 'Totally Unknown Title'] } });
      assert.equal(r.statusCode, 200, r.body);
      assert.equal(r.json().total, 2);
      batchId = r.json().batchId;
      const b = await q('SELECT state, total FROM import_batches WHERE id = $1', [batchId]);
      assert.equal(b[0].state, 'resolving');
      assert.equal(Number(b[0].total), 2);
    });

    await t.test('nothing is added while it resolves', async () => {
      assert.equal((await q(`SELECT count(*)::int AS n FROM lib_series WHERE source_series_id = 'fm-1'`))[0].n, 0);
    });

    await t.test('the resolve pass finds the real match and leaves the unmatched title alone', async () => {
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
      const r = await app.inject({ method: 'PATCH', url: `/api/admin/import/candidates/${unknownCandidateId}`, headers, payload: { decision: 'auto' } });
      assert.equal(r.statusCode, 409, r.body);
      assert.equal(r.json().error, 'no_auto_match');
    });

    await t.test('skip, then "use the auto match" restores the frozen suggestion exactly', async () => {
      const skipped = await app.inject({ method: 'PATCH', url: `/api/admin/import/candidates/${fakeCandidateId}`, headers, payload: { decision: 'skip' } });
      assert.equal(skipped.statusCode, 200, skipped.body);
      assert.equal((await q('SELECT decision FROM import_candidates WHERE id = $1', [fakeCandidateId]))[0].decision, 'skip');

      const restored = await app.inject({ method: 'PATCH', url: `/api/admin/import/candidates/${fakeCandidateId}`, headers, payload: { decision: 'auto' } });
      assert.equal(restored.statusCode, 200, restored.body);
      const row = (await q('SELECT decision, confidence, match_source_id, match_title FROM import_candidates WHERE id = $1', [fakeCandidateId]))[0];
      assert.deepEqual([row.decision, row.confidence, row.match_source_id, row.match_title], ['auto', 'exact', 'fm-1', 'Fake Manga']);
    });

    await t.test('/run adds exactly the accepted rows and skips nobody who was not accepted', async () => {
      // Undo the manual override so this batch adds two DIFFERENT series, not the same one twice.
      await q(`UPDATE import_candidates SET decision = 'skip' WHERE id = $1`, [unknownCandidateId]);
      const r = await app.inject({ method: 'POST', url: `/api/admin/import/batches/${batchId}/run`, headers });
      assert.equal(r.statusCode, 200, r.body);
      assert.equal(r.json().total, 1, 'only the fake-manga row is auto/manual now');
      const body = await waitForState(app, headers, batchId, ['done']);
      assert.equal(body.batch.added, 1);
      const fake = body.items.find((i: any) => i.id === fakeCandidateId);
      assert.equal(fake.status, 'added');
      assert.equal((await q(`SELECT count(*)::int AS n FROM lib_series WHERE source_series_id = 'fm-1'`))[0].n, 1);
    });

    await t.test('running an already-done batch again is refused', async () => {
      const r = await app.inject({ method: 'POST', url: `/api/admin/import/batches/${batchId}/run`, headers });
      assert.equal(r.statusCode, 409, r.body);
      assert.equal(r.json().error, 'already_done');
    });
  } finally {
    if (batchId) await q('DELETE FROM import_batches WHERE id = $1', [batchId]);
    await app.close();
  }
});

test('a title already in the library defaults to skipped, visibly, and never enters the resolve queue', { skip }, async (t) => {
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
    // FAKE also runs and is registered ahead of SW_ADAPTER (lower preferredOrder), so this is the actual
    // proof: without the source-id shortcut, an unscoped title search would try FAKE first, find nothing
    // for "Sw Match Title", and eventually land on SW_ADAPTER by title alone at a lower confidence tier —
    // not `same_source`.
    assert.deepEqual([item.decision, item.confidence, item.match_source, item.match_source_id], ['auto', 'same_source', SW_ADAPTER, 'sw-1']);
  } finally {
    if (batchId) await q('DELETE FROM import_batches WHERE id = $1', [batchId]);
    await app.close();
  }
});

test('DELETE removes the batch and every candidate row with it', { skip }, async (t) => {
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
