// A Fetch all spread over the sites that carry it (v0.55.4, DannyDynamite39's discussion #158), driven through the real
// route against fake sources whose pages come from fake image servers.
//
// "If the user has multiple extensions/sources that contain the same order of chapters (most of the time multiple
// aggregators offer the same scanlation) then the downloading process should round-robin the sources in order to
// decrease fetch time and decrease the chance of a cloudflare block. Mass download should also work the same."
//
// What is pinned, one behaviour per test:
//   - a Fetch whose chapters are one release on two followed sources takes them from both, two at a time, one at a
//     time on each image server, and its card counts them as one job;
//   - two sources whose pages come from one image server are one site: one chapter at a time there;
//   - a copy a person picked is never switched, nor a number they once picked a version of; a slowed site gives way to
//     one at full speed;
//   - a source the job may not ask is never taken in turn: switched off, cooling down, or past the viewer's age cap;
//   - a series with its own source order, and a job that is not a Fetch, take every chapter from the chosen copy.
//
// The image servers are PUBLIC names (img.alpha-rot.com, img.beta-rot.com): lib/pace.ts joins sources by registrable
// domain and never joins a test domain. The fetch below answers them without a network. Skipped unless
// TEST_DATABASE_URL is set.
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DSN = process.env.TEST_DATABASE_URL;
let ROOT = '';
if (DSN) {
  ROOT = mkdtempSync(join(tmpdir(), 'yomi-rot-'));
  process.env.DL_ROOT = join(ROOT, 'dl');
  process.env.LIBRARY_ROOT = join(ROOT, 'lib');
  process.env.CACHE_DIR = join(ROOT, 'cache');
  process.env.DOWNLOAD_MIN_GAP_MS = '0';
  process.env.DOWNLOAD_PAGE_GAP_MS = '0';
  process.env.DOWNLOAD_RESUME_WAIT_MS = '0,0,0';
  process.env.MIN_FREE_GB = '0';
  process.env.UPDATER_LIST_TIMEOUT_MS = '3000';
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const LIB = 'lib_rot';
const ALPHA = 'rot-alpha', BETA = 'rot-beta', GAMMA = 'rot-gamma', ADULT = 'rot-adult';
/** Where each source's pages are: GAMMA shares ALPHA's image server, as Mangakakalot shares Natomanga's. */
const HOST: Record<string, string> = {
  [ALPHA]: 'img.alpha-rot.com', [BETA]: 'img.beta-rot.com', [GAMMA]: 'img2.alpha-rot.com', [ADULT]: 'img.adult-rot.com',
};
const USERS = ['rot-admin', 'rot-capped'];
const S = (k: string) => `s_rot_${k}`;
const PIXEL = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(400, 7)]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** How long each page takes: long enough that two chapters on two servers are seen side by side. */
const HOLD = 60;

/** What each series lists on each source, by its source_series_id. */
const listed = new Map<string, number[]>();
/** Every chapter a source was asked pages for: which series (its key), which number, from which source. */
const asked: Array<{ key: string; n: number; source: string }> = [];
/** Pages in flight per image server (its registrable domain), and the most there ever were at once. */
const inFlight = new Map<string, number>();
const peak = new Map<string, number>();
/** The most pages in flight at once on all servers together. */
let peakAll = 0;

const realFetch = globalThis.fetch;
globalThis.fetch = (async (u: any, init?: any) => {
  const url = String(u);
  if (!/-rot\.com\//.test(url)) return realFetch(u, init);
  const server = new URL(url).hostname.split('.').slice(-2).join('.');
  inFlight.set(server, (inFlight.get(server) ?? 0) + 1);
  peak.set(server, Math.max(peak.get(server) ?? 0, inFlight.get(server)!));
  peakAll = Math.max(peakAll, [...inFlight.values()].reduce((a, b) => a + b, 0));
  try {
    await sleep(HOLD);
    return new Response(PIXEL, { status: 200, headers: { 'content-type': 'image/png' } });
  } finally {
    inFlight.set(server, inFlight.get(server)! - 1);
  }
}) as typeof fetch;

function adapter(id: string, extra: Record<string, unknown> = {}) {
  return {
    id, name: `Rot ${id}`, ...extra,
    async search() { return []; },
    async getSeries(sid: string) { return { sourceId: sid, source: id, title: sid }; },
    async listChapters(sid: string) {
      return (listed.get(sid) ?? []).map((n) => ({ number: n, title: `Chapter ${n}`, sourceId: `${sid}/c${n}` }));
    },
    async getPageUrls(chId: string) {
      asked.push({ key: chId.slice(0, chId.lastIndexOf(`-${id}/`)), n: Number(chId.split('/c').pop()), source: id });
      return [0, 1].map((i) => `https://${HOST[id]}/${encodeURIComponent(chId)}/${i}.png`);
    },
    async latest() { return []; },
  };
}

let q: any, app: any, adminTok = '', cappedTok = '';
let clearPace: () => void, noteRateLimited: (id: string, ms?: number) => void, notePageHosts: typeof import('../src/lib/pace')['notePageHosts'];
let rateKeyOf: (id: string) => string, setDisabled: any, startDownloadJob: typeof import('../src/routes/sources')['startDownloadJob'];

/** A series on `src` that follows `also` too, every source listing `numbers`: one release (no group named) on each. */
async function series(key: string, src: string, also: string[], numbers: number[]) {
  const id = S(key);
  const folder = `T!rot/${key}`;
  await q('DELETE FROM lib_series WHERE id = $1 OR folder = $2', [id, folder]);
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, source_id, source_series_id, auto_update)
           VALUES ($1, 'T!rot', $2, $3, 0, $4, $5, $6, true)`, [id, `Rot ${key}`, folder, LIB, src, `${key}-${src}`]);
  listed.set(`${key}-${src}`, numbers);
  for (const [i, other] of also.entries()) {
    listed.set(`${key}-${other}`, numbers);
    await q(`INSERT INTO series_sources (series_id, source_id, source_series_id, created_at) VALUES ($1, $2, $3, now() + $4 * interval '1 second')`,
      [id, other, `${key}-${other}`, i]);
  }
  const { updateSeries } = await import('../src/lib/updater');
  assert.equal((await updateSeries(id, 0)).outcome, 'ok', `the listing of ${key} was written`);
  return { id, folder };
}

const fetchNums = (seriesId: string, numbers: number[], tok = adminTok) =>
  app.inject({ method: 'POST', url: '/api/sources/fetch', headers: { authorization: tok }, payload: { seriesId, numbers } });
/** The job card once it has stopped downloading. */
async function jobDone(folder: string): Promise<any> {
  let job: any = null;
  for (let i = 0; i < 300; i++) {
    await sleep(50);
    job = (await app.inject({ method: 'GET', url: '/api/sources/jobs', headers: { authorization: adminTok } })).json().content.find((x: any) => x.folder === folder);
    if (job && job.status !== 'downloading') return job;
  }
  return job;
}
/** Which source served each of a series' chapters (two joined by `+` if two were asked). */
const servedBy = (key: string, numbers: number[]) => numbers.map((n) => asked.filter((a) => a.key === key && a.n === n).map((a) => a.source).join('+'));
/** A job started straight from the listing, as the route would start it, without the route's listing refresh. */
async function jobFromListing(seriesId: string, folder: string, numbers: number[], origin: 'fetch' | 'fill') {
  const rows = await q('SELECT chosen, source_id FROM series_listing WHERE series_id = $1 AND number = ANY($2::real[]) ORDER BY number', [seriesId, numbers]);
  startDownloadJob({ origin, folder, title: folder, seriesId, meta: { series: folder }, chapters: rows.map((x: any) => ({ ...x.chosen, source: x.source_id })) });
  return jobDone(folder);
}

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  await migrate();
  ({ clearPace, noteRateLimited, notePageHosts, rateKeyOf } = (await import('../src/lib/pace')) as any);
  ({ setDisabled } = (await import('../src/lib/sourceHealth')) as any);
  const routes = await import('../src/routes/sources');
  startDownloadJob = routes.startDownloadJob;
  const { registerAdapter } = await import('../src/lib/sources');
  for (const id of [ALPHA, BETA, GAMMA]) registerAdapter(adapter(id) as any);
  registerAdapter(adapter(ADULT, { isNsfw: true }) as any);
  await q(`INSERT INTO libraries (id, name, path) VALUES ($1, 'Rot', $1) ON CONFLICT (id) DO NOTHING`, [LIB]);
  await q('DELETE FROM users WHERE username = ANY($1)', [USERS]);
  const mk = async (name: string, role: string, cap: number | null) =>
    (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind, max_age_rating) VALUES ($1, $1, 'x', $2, 'password', $3) RETURNING id`,
      [name, role, cap]))[0].id;
  const adminId = await mk('rot-admin', 'admin', null);
  const cappedId = await mk('rot-capped', 'user', 16);
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register(routes.default);
  await app.ready();
  adminTok = `Bearer ${app.jwt.sign({ sub: adminId, role: 'admin' })}`;
  cappedTok = `Bearer ${app.jwt.sign({ sub: cappedId, role: 'user' })}`;
});

beforeEach(async () => {
  if (!DSN) return;
  clearPace();
  await q(`DELETE FROM source_health WHERE source_id LIKE 'rot-%'`);
  asked.length = 0;
  inFlight.clear();
  peak.clear();
  peakAll = 0;
});

after(async () => {
  if (!DSN) return;
  await app?.close();
  await q(`DELETE FROM lib_series WHERE id LIKE 's_rot_%'`).catch(() => {});
  await q(`DELETE FROM source_health WHERE source_id LIKE 'rot-%'`).catch(() => {});
  await q('DELETE FROM users WHERE username = ANY($1)', [USERS]).catch(() => {});
  await q('DELETE FROM libraries WHERE id = $1', [LIB]).catch(() => {});
  rmSync(ROOT, { recursive: true, force: true });
});

test('a Fetch all is spread over two image servers, two chapters at a time, and counted as one job', { skip }, async () => {
  // Reintroduce by leaving `copiesOf` empty in startDownloadJob: every chapter comes from ALPHA, one at a time ("both
  // sites served it"). Reintroduce `const lanes = 1`: they alternate but never overlap ("two image servers at once").
  const s = await series('spread', ALPHA, [BETA], [1, 2, 3, 4, 5, 6]);
  const r = await fetchNums(s.id, [1, 2, 3, 4, 5, 6]);
  assert.equal(r.statusCode, 200, r.body);
  const job = await jobDone(s.folder);
  assert.equal(job?.status, 'done', JSON.stringify(job));
  assert.deepEqual([job.done, job.total], [6, 6], 'the card counts the chapters of both sites as one job');
  const by = servedBy('spread', [1, 2, 3, 4, 5, 6]);
  assert.ok(by.every((x) => x === ALPHA || x === BETA), `each chapter came from one site, once: ${by}`);
  assert.ok(by.includes(ALPHA) && by.includes(BETA), `both sites served it: ${by}`);
  assert.ok(Math.abs(by.filter((x) => x === ALPHA).length - by.filter((x) => x === BETA).length) <= 2, `taken in turn: ${by}`);
  assert.equal(peakAll, 2, 'two image servers at once');
  assert.deepEqual([peak.get('alpha-rot.com'), peak.get('beta-rot.com')], [1, 1], 'one chapter at a time on each server');
  const books = await q('SELECT number, source_id FROM lib_books WHERE series_id = $1 ORDER BY number', [s.id]);
  assert.deepEqual(books.map((b: any) => Number(b.number)), [1, 2, 3, 4, 5, 6], 'every chapter is in the library');
  assert.deepEqual(books.map((b: any) => b.source_id), by, 'each stamped with the site it came from');
});

test('two sources on one image server are one site: one chapter at a time there', { skip }, async () => {
  // GAMMA's pages are on ALPHA's server. Joined (as they are once both have shown their pages), the job has one lane
  // for the two. Reintroduce by keying the lanes by source (laneOn: `l.source === src`): two chapters at once there.
  notePageHosts({ id: ALPHA }, [`https://${HOST[ALPHA]}/x/0.png`]);
  notePageHosts({ id: GAMMA }, [`https://${HOST[GAMMA]}/x/0.png`]);
  assert.equal(rateKeyOf(GAMMA), rateKeyOf(ALPHA), 'PREMISE: one image server, one key');
  const s = await series('onecdn', ALPHA, [GAMMA], [1, 2, 3, 4]);
  assert.equal((await fetchNums(s.id, [1, 2, 3, 4])).statusCode, 200);
  const job = await jobDone(s.folder);
  assert.equal(job?.status, 'done', JSON.stringify(job));
  assert.equal(peak.get('alpha-rot.com'), 1, 'two sources on one image server downloaded two chapters at once');
  assert.deepEqual(servedBy('onecdn', [1, 2, 3, 4]), [ALPHA, ALPHA, ALPHA, ALPHA], 'taking turns between two sources on one server gains nothing');
});

test('a pick never switches, nor a number once picked; a slowed site gives way to one at full speed', { skip }, async () => {
  const s = await series('picks', ALPHA, [BETA], [1, 2, 3, 4]);
  // A slowed site (a 429 earlier).
  noteRateLimited(ALPHA);
  // Picks: what the person named, from where they named it. Reintroduce by rotating pinned copies (drop `!c.pinned`
  // from `loose`): one comes from BETA, the site at full speed.
  const picks = [1, 2].map((n) => ({ number: n, source: ALPHA, sourceId: `picks-${ALPHA}/c${n}` }));
  const r = await app.inject({ method: 'POST', url: '/api/sources/fetch', headers: { authorization: adminTok }, payload: { seriesId: s.id, picks } });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal((await jobDone(s.folder))?.status, 'done');
  assert.deepEqual(servedBy('picks', [1, 2]), [ALPHA, ALPHA], 'a pick never switches');
  // A chapter that may rotate is taken from the site at full speed. Reintroduce by dropping the pace preference
  // (`slow` in pickCopy): it comes from the slowed ALPHA, the chosen copy, on a tie.
  assert.equal((await fetchNums(s.id, [4])).statusCode, 200);
  assert.equal((await jobDone(s.folder))?.status, 'done');
  assert.deepEqual(servedBy('picks', [4]), [BETA], 'a slowed site did not give way to one at full speed');
  // Chapter 3 was once picked (its file let go since): fetched again, it is not rotated. Reintroduce by dropping the
  // picked_at read: it comes from BETA.
  await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, pages, picked_at, pruned_at)
           VALUES ('b_rot_3', $1, 'T!rot', $2, 3, 'Chapter 3', 1, now(), now())`, [s.id, `${s.folder}/Chapter 3.cbz`]);
  assert.equal((await fetchNums(s.id, [3])).statusCode, 200);
  assert.equal((await jobDone(s.folder))?.status, 'done');
  assert.deepEqual(servedBy('picks', [3]), [ALPHA], 'a number once picked was rotated');
});

test('never a source the job may not ask: switched off, cooling down, or past the viewer\'s cap', { skip }, async () => {
  // Switched off or in a cooldown since the listing was read (the route's refresh drops such a source's copies, so the
  // job is started from the listing as it stands). Switched off, the helper would refuse the copy and switch back, which
  // the card shows; in a cooldown nothing else stops a chosen copy. Reintroduce by dropping isDisabled from `may`: the
  // card lists switches from BETA; by dropping blockedNow: BETA is asked.
  const s = await series('may', ALPHA, [BETA], [1, 2, 3]);
  await setDisabled(BETA, true);
  try {
    const job = await jobFromListing(s.id, s.folder, [1, 2, 3], 'fetch');
    assert.equal(job?.status, 'done', JSON.stringify(job));
    assert.equal(job.switched, undefined, `a switched-off source was taken in turn: ${JSON.stringify(job.switched)}`);
    assert.deepEqual(servedBy('may', [1, 2, 3]), [ALPHA, ALPHA, ALPHA]);
  } finally {
    await setDisabled(BETA, false);
  }
  const c = await series('cool', ALPHA, [BETA], [1, 2, 3]);
  await q(`INSERT INTO source_health (source_id, status, blocked_until) VALUES ($1, 'rate_limited', now() + interval '10 minutes')
           ON CONFLICT (source_id) DO UPDATE SET blocked_until = EXCLUDED.blocked_until`, [BETA]);
  assert.equal((await jobFromListing(c.id, c.folder, [1, 2, 3], 'fetch'))?.status, 'done');
  assert.deepEqual(servedBy('cool', [1, 2, 3]), [ALPHA, ALPHA, ALPHA], 'a source in a cooldown was taken in turn');
  await q(`DELETE FROM source_health WHERE source_id LIKE 'rot-%'`);
  // A member capped below 18 fetches a series that also follows an adult site: the chosen copies are on a clean one,
  // and the adult site is never asked on their behalf. Reintroduce by dropping `input.allowed` from `may`.
  const a = await series('cap', ALPHA, [ADULT], [1, 2, 3]);
  assert.equal((await fetchNums(a.id, [1, 2, 3], cappedTok)).statusCode, 200);
  assert.equal((await jobDone(a.folder))?.status, 'done');
  assert.deepEqual(servedBy('cap', [1, 2, 3]), [ALPHA, ALPHA, ALPHA], "a capped member's Fetch took a chapter from an adult source");
});

test('a series with its own source order, and a job that is not a Fetch, take every chapter from the chosen copy', { skip }, async () => {
  // "Take this series from that site" is an explicit preference. Reintroduce by dropping the source_prefs test from
  // `loose`: BETA serves some.
  const s = await series('own', ALPHA, [BETA], [1, 2, 3, 4]);
  await q(`UPDATE lib_series SET source_prefs = '{"priority":["rot-alpha"]}'::jsonb WHERE id = $1`, [s.id]);
  assert.equal((await fetchNums(s.id, [1, 2, 3, 4])).statusCode, 200);
  assert.equal((await jobDone(s.folder))?.status, 'done');
  assert.deepEqual(servedBy('own', [1, 2, 3, 4]), [ALPHA, ALPHA, ALPHA, ALPHA], 'a series with its own source order rotated');
  // A fill's chapters come from the plan's source and nowhere else, a refetch's from the copy the rules chose; neither
  // rotates. Reintroduce by rotating every origin (`origin === 'fetch'` dropped from `loose`): BETA serves some.
  const f = await series('fill', ALPHA, [BETA], [1, 2, 3, 4]);
  assert.equal((await jobFromListing(f.id, f.folder, [1, 2, 3, 4], 'fill'))?.status, 'done');
  assert.deepEqual(servedBy('fill', [1, 2, 3, 4]), [ALPHA, ALPHA, ALPHA, ALPHA], 'a fill was rotated');
});
