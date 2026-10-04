// The Cloudflare solvers (lane H: the backup) and the download pace (lane G), both v0.55.3, where they meet: the
// downloader's own image fetches.
//
// A chapter of a Cloudflare site is listed through a solver, and its images are fetched plainly with the cookie and the
// user agent a solver earned at the image server. Since lane H those are kept per (solver, origin), and the images must
// go out with the pair of the solver that solved that server -- the backup's, when the main could not. Since lane G a
// 429 from an image server raises the pace of every source whose pages come from it (one rate key per image server).
// A solver's own 429 is neither: it is the solver busy (H: SOLVER_BUSY), and it must never slow the site's key down nor
// cool the site down -- only the site's own image server saying 429 does that.
//
// Real fake solvers over HTTP, as in solverBackup.test.ts; the image servers are a stand-in for fetch. Skipped unless
// TEST_DATABASE_URL is set: whether a site was cooled down is its source_health row.
import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DSN = process.env.TEST_DATABASE_URL;
let ROOT = '';
if (DSN) {
  ROOT = mkdtempSync(join(tmpdir(), 'uy-sd-'));
  process.env.DATABASE_URL = DSN;
  process.env.DL_ROOT = ROOT;
  process.env.DOWNLOAD_MIN_GAP_MS = '0';
  process.env.DOWNLOAD_PAGE_GAP_MS = '0';
  // A 429's resume waits what the image server's Retry-After asks (1 s here), no longer.
  process.env.DOWNLOAD_RESUME_WAIT_MS = '0,0,0';
  process.env.MIN_FREE_GB = '0';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
}
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const PIXEL = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(400, 7)]);
const PAGES = 4;

/** Two sites on one image CDN (sd553cdn.com), one of them behind Cloudflare; another Cloudflare site on its own CDN. */
const CF = 'sd-cf', PLAIN = 'sd-plain', OTHER = 'sd-other';
/** For the busy solver: a site whose chapter pages are listed through the solver, and one whose images need its cookie. */
const LISTED = 'sd-listed', BUSY_IMG = 'sd-busyimg';
/** For the image server's own 429. */
const REFUSED = 'sd-refused';
const IDS = [CF, PLAIN, OTHER, LISTED, BUSY_IMG, REFUSED];
const HOST: Record<string, string> = {
  [CF]: 'img-a.sd553cdn.com', [PLAIN]: 'img-b.sd553cdn.com', [OTHER]: 'img-x.sdother553.com',
  [BUSY_IMG]: 'img.sdbusy553.com', [LISTED]: 'img.sdlisted553.com', [REFUSED]: 'img.sdrefused553.com',
};
const pagesOf = (id: string, ch: string) => Array.from({ length: PAGES }, (_, i) => `https://${HOST[id]}/${ch}/p${i}.png`);

let q: any, downloadChapter: any, pace: typeof import('../src/lib/pace'), solver: typeof import('../src/lib/sources/flaresolverr');

// ---- fake solvers ----------------------------------------------------------------------------------------------

type Reply = { status?: number; json?: unknown };
interface Fake { url: string; asked: string[]; reply: (body: any) => Reply; close: () => Promise<void> }
const fakes: Fake[] = [];
async function fakeSolver(name: string): Promise<Fake> {
  const fake: Fake = { url: '', asked: [], reply: (b) => ({ json: solved(b.url, name) }), close: async () => {} };
  const srv: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      fake.asked.push(body);
      const r = fake.reply(JSON.parse(body || '{}'));
      res.writeHead(r.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r.json));
    });
  });
  await new Promise<void>((go) => srv.listen(0, '127.0.0.1', go));
  fake.url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  fake.close = () => new Promise<void>((go) => srv.close(() => go()));
  fakes.push(fake);
  return fake;
}
/** A page solved by `name`: its own cf_clearance, and its own browser's user agent. */
const solved = (url: string, name: string) => ({
  status: 'ok', message: '',
  solution: { url, status: 200, response: `<html>${name}</html>`, cookies: [{ name: 'cf_clearance', value: name }], userAgent: `${name}-browser/1.0` },
});
const refused = (): Reply => ({ status: 500, json: { status: 'error', message: 'Error: Error solving the challenge. Timeout after 60.0 seconds.', solution: null } });
/** trawl 1.7.0's answer when no browser of its pool frees up in time: HTTP 429 from the SOLVER (apps/api/src/routes/v1.ts). */
const busy = (): Reply => ({ status: 429, json: { status: 'error', message: 'Browser pool exhausted: all browsers are busy', solution: { url: '', status: 0, headers: {}, response: '', cookies: [], userAgent: '' } } });
const use = (main: string, backup: string) => { process.env.FLARESOLVERR_URL = main; process.env.FLARESOLVERR_FALLBACK_URL = backup; };

// ---- image servers ---------------------------------------------------------------------------------------------

interface Seen { url: string; cookie: string; ua: string }
let seen: Seen[] = [];
/** What an image server answers instead of the page: null for the page itself. */
let answer: (url: string) => Response | null = () => null;
const realFetch = globalThis.fetch;

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  ({ downloadChapter } = (await import('../src/lib/downloader')) as any);
  pace = await import('../src/lib/pace');
  solver = await import('../src/lib/sources/flaresolverr');
  const { registerAdapter } = await import('../src/lib/sources/loader');
  await migrate();
  for (const id of IDS) {
    registerAdapter({
      id, name: id, pageConcurrency: 2, pageGapMs: 0,
      requiresCloudflare: id !== PLAIN,
      search: async () => [], getSeries: async () => null, listChapters: async () => [],
      // LISTED's chapter pages come through the solver, as a Madara site's do; the others list them directly.
      getPageUrls: id === LISTED
        ? async (ch: string) => { await solver.cfGet(`https://www.sdlisted553.com/chapter/${ch}/`); return pagesOf(id, ch); }
        : async (ch: string) => pagesOf(id, ch),
    } as any);
  }
  // Solvers are real HTTP on 127.0.0.1; every other address is an image server here.
  globalThis.fetch = (async (u: any, init?: any) => {
    const url = String(u instanceof Request ? u.url : u);
    if (url.startsWith('http://127.0.0.1')) return realFetch(u, init);
    const h = new Headers(init?.headers);
    seen.push({ url, cookie: h.get('cookie') ?? '', ua: h.get('user-agent') ?? '' });
    return answer(url) ?? new Response(PIXEL, { status: 200, headers: { 'content-type': 'image/png' } });
  }) as typeof fetch;
});

beforeEach(async () => {
  if (!DSN) return;
  seen = [];
  answer = () => null;
  pace.clearPace();
  solver.resetSolverSessions();
  solver.setSolverTiming({ attemptMs: 95_000, busyWaitMs: 3_000 });
  await q('DELETE FROM source_health WHERE source_id = ANY($1::text[])', [IDS]);
});

after(async () => {
  globalThis.fetch = realFetch;
  for (const f of fakes) await f.close();
  delete process.env.FLARESOLVERR_FALLBACK_URL;
  if (ROOT) rmSync(ROOT, { recursive: true, force: true });
  if (!DSN) return;
  pace.clearPace();
  await q('DELETE FROM source_health WHERE source_id = ANY($1::text[])', [IDS]).catch(() => {});
});

const dl = (sourceId: string, ch: string, n: number) =>
  downloadChapter({ sourceId, seriesFolder: `SD/${sourceId}`, chapter: { sourceId: ch, number: n } });
const requestsOf = (ch: string) => seen.filter((s) => s.url.includes(`/${ch}/`));
/** The source's health row, once its fire-and-forget stage note has landed. */
async function healthOf(id: string): Promise<any> {
  for (let i = 0; i < 40; i++) {
    const r = (await q('SELECT status, blocked_until, stages FROM source_health WHERE source_id = $1', [id]))[0];
    if (r?.stages && Object.keys(r.stages).length) return r;
    await new Promise((go) => setTimeout(go, 25));
  }
  return (await q('SELECT status, blocked_until, stages FROM source_health WHERE source_id = $1', [id]))[0] ?? null;
}

test("a chapter solved through the backup downloads with the backup's cookie and user agent, on its image server's shared key", { skip }, async () => {
  // Reintroduce by dropping `solvedBy.set(origin, solver)` in sources/flaresolverr.ts ask(): no origin has a solver whose
  // pair it sends, and the images go out with no cookie ("with the backup's cookie" fails). By dropping notePageHosts in
  // downloader.ts fetchPages: the two sites on one CDN keep a key each ("one image server, one key" fails).
  const main = await fakeSolver('main');
  const backup = await fakeSolver('backup');
  // The main solves the other site's image server and fails at this one's; the backup solves anything.
  main.reply = (b) => (new URL(b.url).host === HOST[OTHER] ? { json: solved(b.url, 'main') } : refused());
  use(main.url, backup.url);

  assert.equal((await dl(PLAIN, 'p1', 1))?.pages, PAGES, 'PREMISE: the site with no Cloudflare downloads');
  assert.equal((await dl(OTHER, 'x1', 1))?.pages, PAGES);
  assert.equal((await dl(CF, 'c1', 1))?.pages, PAGES);
  assert.ok(main.asked.some((b) => JSON.parse(b).url.includes(HOST[CF])), 'PREMISE: the main was asked for the image server first');
  assert.ok(backup.asked.some((b) => JSON.parse(b).url.includes(HOST[CF])), 'PREMISE: and the backup solved it');

  for (const r of requestsOf('c1')) {
    assert.equal(r.cookie, 'cf_clearance=backup', `with the backup's cookie: ${JSON.stringify(r)}`);
    assert.equal(r.ua, 'backup-browser/1.0', `and the backup's own user agent, never the main's: ${JSON.stringify(r)}`);
  }
  for (const r of requestsOf('x1')) {
    assert.deepEqual([r.cookie, r.ua], ['cf_clearance=main', 'main-browser/1.0'], 'the server the main solved gets the main\'s pair');
  }
  for (const r of requestsOf('p1')) assert.equal(r.cookie, '', 'a site with no Cloudflare sends no solver\'s cookie');
  assert.equal(requestsOf('c1').length, PAGES);

  // Lane G: the Cloudflare site and the plain one show their pages on one CDN -- one key, one pace.
  assert.equal(pace.rateKeyOf(CF), pace.rateKeyOf(PLAIN), 'one image server, one key');
  assert.notEqual(pace.rateKeyOf(OTHER), pace.rateKeyOf(CF), 'another CDN keeps its own');
  // The CDN refuses one page of the plain site's next chapter, the first time it is asked for.
  answer = (url) => (url.endsWith('/p2/p1.png') && seen.filter((r) => r.url === url).length === 1
    ? new Response('slow down', { status: 429, headers: { 'retry-after': '1' } }) : null);
  assert.equal((await dl(PLAIN, 'p2', 2))?.pages, PAGES, 'PREMISE: the plain site\'s chapter lands after its 429');
  assert.equal(pace.paceLevel(CF), 1, 'the CDN\'s 429 to the plain site slows the Cloudflare site on it too');
  answer = () => null;
  assert.equal((await dl(CF, 'c2', 2))?.pages, PAGES);
  for (const r of requestsOf('c2')) assert.equal(r.cookie, 'cf_clearance=backup', 'at the slower pace, still the backup\'s pair');
});

test("a solver's own 429 never slows the site's key nor cools the site down; the image server's own 429 does both", { skip }, async () => {
  // Reintroduce by wording SOLVER_BUSY with the status it came with ("flaresolverr: solver busy (HTTP 429)"): classify()
  // reads a rate limit, and the site whose chapter list the solver could not fetch is cooled down ("no cooldown for a
  // site the solver was too busy to ask" fails). By dropping `noteRateLimited(src.id, wait)` in fetchPages' resume (and
  // the one after it): the image server's 429 leaves the key at full speed ("the image server's own 429 slows its key"
  // fails).
  const main = await fakeSolver('main');
  const backup = await fakeSolver('backup');
  main.reply = () => busy();
  backup.reply = () => busy();
  use(main.url, backup.url);
  solver.setSolverTiming({ busyWaitMs: 5 });

  // The chapter's pages are listed through the solver, which stays busy through its tries and the backup's.
  await assert.rejects(dl(LISTED, 'l1', 1), (e: Error) => e.message === solver.SOLVER_BUSY, 'the solver was busy');
  // The images want the solver's cookie: asked, busy, and fetched without it -- this image server lets them through.
  assert.equal((await dl(BUSY_IMG, 'b1', 1))?.pages, PAGES);
  assert.ok(main.asked.length >= 6 && backup.asked.length >= 6, `PREMISE: both solvers answered 429: ${main.asked.length}, ${backup.asked.length}`);
  for (const id of [LISTED, BUSY_IMG]) {
    assert.equal(pace.paceLevel(id), 0, `${id}: a solver's 429 never raises the site's pace`);
    assert.equal(pace.restLeft(id), 0, `${id}: nor rests its key`);
    assert.equal(pace.refusedLately(id), false, `${id}: nor holds the slow archive back`);
  }
  const listed = await healthOf(LISTED);
  assert.ok(listed, 'PREMISE: the failed chapter list was noted');
  assert.notEqual(listed.status, 'rate_limited', `no cooldown for a site the solver was too busy to ask: ${JSON.stringify(listed)}`);
  assert.equal(listed.blocked_until, null, `nor any cooldown at all: ${JSON.stringify(listed)}`);
  assert.notEqual(listed.stages?.pages?.kind, 'rate_limited', `its evidence is no rate limit either: ${JSON.stringify(listed.stages)}`);
  const imgs = await healthOf(BUSY_IMG);
  assert.ok(!imgs || (imgs.status !== 'rate_limited' && imgs.blocked_until === null), `the site whose images landed is fine: ${JSON.stringify(imgs)}`);

  // The image server itself answers 429 to every page: that is the site, and it slows the key and cools the site down.
  main.reply = (b) => ({ json: solved(b.url, 'main') });
  answer = (url) => (url.includes('/r1/') ? new Response('slow down', { status: 429, headers: { 'retry-after': '1' } }) : null);
  await assert.rejects(dl(REFUSED, 'r1', 1), (e: any) => e.blockStatus === 'rate_limited', 'PREMISE: the chapter was refused');
  assert.ok(pace.paceLevel(REFUSED) >= 1, `the image server's own 429 slows its key: level ${pace.paceLevel(REFUSED)}`);
  assert.equal(pace.refusedLately(REFUSED), true);
  const refusedRow = await healthOf(REFUSED);
  assert.equal(refusedRow?.status, 'rate_limited', 'and cools the site down');
  assert.ok(refusedRow?.blocked_until && new Date(refusedRow.blocked_until).getTime() > Date.now(), 'for a while');
});
