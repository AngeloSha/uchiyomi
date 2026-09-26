// Find missing chapters, answered as it goes (v0.48.4): POST /api/sources/fill/scan starts the scan and answers
// with what has arrived; GET /api/sources/fill/scan/:id answers with the rest.
//
// The owner's scans failed every other time. Most of their series come from a Cloudflare-fronted source that
// takes about a minute to answer; the scan was one request that waited for the slowest source (84 s when it
// worked), and the reverse proxy in front gave up at 90 s -- "The scan failed.", while the ☁ on one ghost
// chapter, which asks only the series' own sources, worked.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.SCAN_FIRST_ANSWER_MS = '300';
  process.env.SCAN_SEARCH_MS = '10000';
  process.env.SCAN_ENOUGH = '5';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const S = 's_fsp_series';
const OWN = 'fsp-own', FAST = 'fsp-fast', SLOW = 'fsp-slow';
/** The series' own source lists slowly (a solver), another source searches even more slowly. */
const OWN_LIST_MS = 1500, SLOW_SEARCH_MS = 3000;
let q: any, app: any, auth: Record<string, string>, otherAuth: Record<string, string>;
let getPlan: any, authorise: any;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const chs = (to: number) => Array.from({ length: to }, (_, i) => ({ sourceId: `c/${i + 1}`, number: i + 1, title: `Chapter ${i + 1}` }));
const adapter = (id: string, o: { searchMs?: number; listMs?: number; has: number }) => ({
  id, name: id,
  async search() { if (o.searchMs) await sleep(o.searchMs); return [{ sourceId: `${id}-1`, source: id, title: 'Progress Series' }]; },
  async getSeries(sid: string) { return { sourceId: sid, source: id, title: 'Progress Series' }; },
  async listChapters() { if (o.listMs) await sleep(o.listMs); return chs(o.has); },
  async getPageUrls() { return []; },
  async latest() { return []; },
});

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  await migrate();
  ({ q } = (await import('../src/lib/db')) as any);
  ({ getPlan, authorise } = (await import('../src/lib/fill')) as any);
  const { registerAdapter } = await import('../src/lib/sources');
  registerAdapter(adapter(OWN, { listMs: OWN_LIST_MS, has: 8 }) as any);
  registerAdapter(adapter(FAST, { has: 10 }) as any);
  registerAdapter(adapter(SLOW, { searchMs: SLOW_SEARCH_MS, has: 12 }) as any);
  await q(`DELETE FROM lib_books WHERE series_id = $1`, [S]);
  await q(`DELETE FROM lib_series WHERE id = $1`, [S]);
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, source_id, source_series_id)
           VALUES ($1,'fsp','Progress Series','fsp/Progress Series',5,$2,'fsp-own-1')`, [S, OWN]);
  // 1-3, 5, 6: a gap at 4, and every source has chapters past 6.
  for (const n of [1, 2, 3, 5, 6]) {
    await q(`INSERT INTO lib_books (id, series_id, source, file, title, number, pages) VALUES ($1,$2,'fsp',$3,$4,$5,20)`,
      [`b_fsp_${n}`, S, `fsp/Progress Series/Chapter ${n}.cbz`, `Chapter ${n}`, n]);
  }
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/sources')).default);
  await app.ready();
  await q(`DELETE FROM users WHERE username IN ('fsp-admin','fsp-other')`);
  const mk = async (u: string) => (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind)
                                             VALUES ($1,$1,'x','admin','password') RETURNING id`, [u]))[0].id;
  auth = { authorization: `Bearer ${app.jwt.sign({ sub: await mk('fsp-admin'), role: 'admin' })}` };
  otherAuth = { authorization: `Bearer ${app.jwt.sign({ sub: await mk('fsp-other'), role: 'admin' })}` };
});

after(async () => {
  if (!DSN) return;
  await app?.close();
  await q(`DELETE FROM lib_books WHERE series_id = $1`, [S]).catch(() => {});
  await q(`DELETE FROM series_listing WHERE series_id = $1`, [S]).catch(() => {});
  await q(`DELETE FROM lib_series WHERE id = $1`, [S]).catch(() => {});
  await q(`DELETE FROM users WHERE username IN ('fsp-admin','fsp-other')`).catch(() => {});
});

const start = (h = auth, altTitle?: string) =>
  app.inject({ method: 'POST', url: '/api/sources/fill/scan', headers: h, payload: { seriesId: S, ...(altTitle ? { altTitle } : {}) } });
const read = (id: string, h = auth) => app.inject({ method: 'GET', url: `/api/sources/fill/scan/${id}`, headers: h });

test('the scan answers at once, then card by card as each source answers', { skip }, async () => {
  const t0 = Date.now();
  const r = await start();
  const took = Date.now() - t0;
  assert.equal(r.statusCode, 200, r.body);
  const first = r.json();
  // Reintroduce by awaiting the whole scan in POST: this answer takes as long as the slowest source.
  assert.ok(took < OWN_LIST_MS, `the first answer took ${took} ms, as long as a slow source`);
  assert.equal(first.done, false, 'a scan with a slow source is already done');
  assert.ok(first.scanId && first.planId, JSON.stringify(first));
  const asking = first.asking.map((a: any) => a.source).sort();
  assert.deepEqual(asking, [OWN, SLOW].sort(), 'the dialog is not told which sources it is still waiting for');
  const fast = first.candidates.find((c: any) => c.source === FAST);
  assert.equal(fast?.why, 'ok', `the quick source's card is not there yet: ${JSON.stringify(first.candidates)}`);
  // Usable the moment it shows: the plan already holds its chapters.
  const auth1 = authorise(getPlan(first.planId), FAST, `${FAST}-1`, [4], 300);
  assert.equal(auth1.ok, true, `a card shown mid-scan cannot be filled: ${JSON.stringify(auth1)}`);

  // The same person asking again while it runs joins it; someone else cannot read it.
  assert.equal((await start()).json().scanId, first.scanId, 'a second POST started a second scan');
  assert.equal((await read(first.scanId, otherAuth)).statusCode, 404, 'another account read the scan');

  const seen: Record<string, number> = {};
  let last: any = first;
  while (!last.done && Date.now() - t0 < 20_000) {
    await sleep(100);
    last = (await read(first.scanId)).json();
    for (const c of last.candidates) seen[c.source] ??= Date.now() - t0;
  }
  assert.equal(last.done, true, 'the scan never finished');
  assert.deepEqual(last.asking, []);
  assert.deepEqual(last.candidates.map((c: any) => c.source).sort(), [FAST, OWN, SLOW].sort());
  // Reintroduce by listing the series' own source only after every search: its card waits for the slow search.
  assert.ok(seen[OWN] < seen[SLOW], `the series' own source (${seen[OWN]} ms) waited for another source's search (${seen[SLOW]} ms)`);
  assert.equal(last.refusal, null, 'newer chapters on every source, yet a refusal');
  assert.deepEqual(last.candidates.find((c: any) => c.source === OWN)?.newer, [7, 8]);
});

test('a finished scan is not joined: asking again asks the sources again', { skip }, async () => {
  const a = (await start()).json();
  let d = a;
  const t0 = Date.now();
  while (!d.done && Date.now() - t0 < 20_000) { await sleep(100); d = (await read(a.scanId)).json(); }
  let b = (await start()).json();
  assert.notEqual(b.scanId, a.scanId, 'a fresh request was answered from a finished scan, plan and all');
  const t1 = Date.now();
  while (!b.done && Date.now() - t1 < 20_000) { await sleep(100); b = (await read(b.scanId)).json(); }
});

test('three scans at once per person, and a fourth is refused rather than queued behind them', { skip }, async () => {
  const ids = [];
  for (const t of ['alt one', 'alt two', 'alt three']) ids.push((await start(auth, t)).json().scanId);
  assert.equal(new Set(ids).size, 3);
  const fourth = await start(auth, 'alt four');
  assert.equal(fourth.statusCode, 429, fourth.body);
  // Someone else is not held back by them.
  assert.equal((await start(otherAuth, 'alt four')).statusCode, 200);
  await sleep(SLOW_SEARCH_MS + OWN_LIST_MS + 500); // let them finish before the process ends
});
