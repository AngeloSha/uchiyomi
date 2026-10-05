// The browser rig's source is present only under its explicit environment gate, and speaks the same small
// HTTP contract as web/test/e2e/fakeSource.mjs. No database is needed for this guard.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';

const realFetch = globalThis.fetch;
const dirs: string[] = [];

afterEach(async () => {
  globalThis.fetch = realFetch;
  delete process.env.FAKE_SOURCE_URLS;
  delete process.env.FAKE_SOURCE_NSFW;
  delete process.env.FAKE_SOURCE_CLOUDFLARE;
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function cleanRegistry() {
  const dir = mkdtempSync(join(tmpdir(), 'uy-fake-source-'));
  dirs.push(dir);
  const { reloadSources } = await import('../src/lib/sources/loader');
  reloadSources(dir);
}

test('an ordinary install never registers the e2e sources', async () => {
  // Reintroduce by registering a default fake adapter in builtins.ts: the registry then contains an id
  // that only a test host can serve, and this exact assertion names it.
  delete process.env.FAKE_SOURCE_URLS;
  await cleanRegistry();
  const { loadBuiltins } = await import('../src/lib/sources/builtins');
  const { sourceIds } = await import('../src/lib/sources/loader');
  loadBuiltins();
  assert.deepEqual(sourceIds(), ['mangadex'], 'FAKE_SOURCE_URLS is unset, so no fake source may exist');
});

test('only the stub named in FAKE_SOURCE_NSFW declares itself adult', async () => {
  // The v0.42.0 walk needs one adult PROVIDER to prove the "Show 18+" reveal hides it from Discover (#64),
  // and `isNsfw` is otherwise only ever set by a Suwayomi extension. The marking has to stay per id: the
  // v0.41 walk's hunt skips an adult source (lib/sourceHunt.ts), so marking both stubs would break a walk
  // that has nothing to do with this release.
  // Reintroduce by marking every fake adapter instead of the named ones: `fake-a` comes back adult and
  // this assertion names it.
  process.env.FAKE_SOURCE_URLS = 'fake-a=http://127.0.0.1:18150,fake-b=http://127.0.0.1:18151';
  process.env.FAKE_SOURCE_NSFW = 'fake-b';
  await cleanRegistry();
  const { loadBuiltins } = await import('../src/lib/sources/builtins');
  const { getSource } = await import('../src/lib/sources/loader');
  loadBuiltins();
  assert.equal(getSource('fake-b')?.isNsfw, true, 'the stub named in FAKE_SOURCE_NSFW is not adult');
  assert.equal(getSource('fake-a')?.isNsfw, undefined, 'a stub nobody named was marked adult');
  // Unset is the ordinary install, where no fake source exists at all and none of this can be reached.
  const { fakeNsfwIds } = await import('../src/lib/sources/fake');
  assert.equal(fakeNsfwIds('').size, 0, 'an unset knob still named something adult');
});

test('the gated adapters call the stub contract and keep the downloader defaults', async () => {
  // Reintroduce by declaring pageConcurrency/pageGapMs on makeFakeSource: this fixture stops exercising
  // the engine defaults whose 429 slowdown the v0.40 browser walk is meant to prove.
  process.env.FAKE_SOURCE_URLS = 'fake-a=http://127.0.0.1:18150/,fake-b=http://127.0.0.1:18151,bad';
  await cleanRegistry();
  const { loadBuiltins } = await import('../src/lib/sources/builtins');
  const { getSource, sourceIds } = await import('../src/lib/sources/loader');
  assert.equal(loadBuiltins(), 3);
  assert.deepEqual(sourceIds(), ['mangadex', 'fake-a', 'fake-b']);
  const a = getSource('fake-a')!;
  assert.equal(Object.hasOwn(a, 'pageConcurrency'), false, 'the fake uses the engine page-pool default');
  assert.equal(Object.hasOwn(a, 'pageGapMs'), false, 'the fake uses DOWNLOAD_PAGE_GAP_MS');
  assert.equal(a.requiresCloudflare, false);

  const asked: string[] = [];
  globalThis.fetch = (async (input: any) => {
    const url = String(input);
    asked.push(url);
    if (url.endsWith('/search?q=Walk%20Tale')) return Response.json([{ sourceId: 'walk-tale', source: 'wrong', title: 'Walk Tale' }]);
    if (url.endsWith('/series/walk-tale')) return Response.json({ sourceId: 'walk-tale', source: 'wrong', title: 'Walk Tale' });
    if (url.endsWith('/chapters/walk-tale')) return Response.json([{ sourceId: 'walk-tale-1', number: 1, pages: 12 }]);
    if (url.endsWith('/pages/walk-tale-1')) return Response.json(['http://127.0.0.1:18150/img/walk-tale-1/1']);
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  assert.deepEqual(await a.search('Walk Tale'), [{ sourceId: 'walk-tale', source: 'fake-a', title: 'Walk Tale' }]);
  assert.equal((await a.getSeries('walk-tale'))?.source, 'fake-a');
  assert.deepEqual(await a.listChapters('walk-tale'), [{ sourceId: 'walk-tale-1', number: 1, pages: 12 }]);
  assert.deepEqual(await a.getPageUrls('walk-tale-1'), ['http://127.0.0.1:18150/img/walk-tale-1/1']);
  assert.equal(asked.length, 4);
});

test('the e2e adapter carries a posting order only when the stub states one', async () => {
  // #116's Istrevelia-shaped stub series lists `order` on each post. Reintroduce by passing the stub's value
  // through untouched (the plain spread): the string '7' stays a string and the junk values survive.
  process.env.FAKE_SOURCE_URLS = 'fake-a=http://127.0.0.1:18150';
  await cleanRegistry();
  const { loadBuiltins } = await import('../src/lib/sources/builtins');
  const { getSource } = await import('../src/lib/sources/loader');
  loadBuiltins();
  globalThis.fetch = (async () => Response.json([
    { sourceId: 'p1', number: 1, order: 1 },
    { sourceId: 'p2', number: 1, order: '7' },
    { sourceId: 'p3', number: 1, order: 'soon' },
    { sourceId: 'p4', number: 1, order: 0 },
    { sourceId: 'p5', number: 1, order: null },
    { sourceId: 'p6', number: 1 },
  ])) as typeof fetch;
  const listed = await getSource('fake-a')!.listChapters('walk-istrevelia');
  assert.deepEqual(listed.map((c) => c.order), [1, 7, undefined, undefined, undefined, undefined]);
  assert.deepEqual(listed.map((c) => Object.hasOwn(c, 'order')), [true, true, false, false, false, false], 'no order is no key');
});

/** A small HTML page the way a site's notice is shaped: its title, a card with the same words and a Discord link. */
const htmlPage = (title: string, extra = '') => new Response(
  `<!doctype html><html lang="en"><head><title>${title}</title></head><body><div class="card"><h1>${title}</h1>`
    + `<p><a href="https://discord.gg/fake-a">Join us on Discord</a></p>${extra}</div></body></html>`,
  { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
);

test('an offline notice from the stub is the site saying it is offline, on every route, by the product\'s own rule', async () => {
  // v0.49.1: the walk (walk491.mjs) scripts `offline` on the stub, which then answers every route with aqua's kind of
  // page -- HTTP 200, HTML. The adapter hands it to lib/sources/offline.ts offlineNotice, as an engine does, so
  // Health's "The site says it is offline" is the product's own path. Reintroduce by dropping the text/html branch in
  // fake.ts json(): r.json() throws a SyntaxError, no classified error, and "…is read as the site saying it is
  // offline" fails for search first.
  process.env.FAKE_SOURCE_URLS = 'fake-a=http://127.0.0.1:18150';
  await cleanRegistry();
  const { loadBuiltins } = await import('../src/lib/sources/builtins');
  const { getSource } = await import('../src/lib/sources/loader');
  const { isSiteOffline, SITE_OFFLINE } = await import('../src/lib/sources/offline');
  loadBuiltins();
  const a = getSource('fake-a')!;
  let answer = () => htmlPage('Fake A is temporarily offline');
  globalThis.fetch = (async () => answer()) as typeof fetch;
  const failure = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as Error & { kind?: string; said?: string });

  const routes: Array<[string, () => Promise<unknown>]> = [
    ['search', () => a.search('Walk Tale')],
    ['series', () => a.getSeries('walk-tale')],
    ['chapters', () => a.listChapters('walk-tale')],
    ['pages', () => a.getPageUrls('walk-tale-1')],
  ];
  for (const [route, call] of routes) {
    const e = await failure(call());
    assert.ok(isSiteOffline(e), `${route}: the notice is read as the site saying it is offline (${e})`);
    assert.equal(e?.kind, SITE_OFFLINE, route);
    assert.equal(e?.said, 'Fake A is temporarily offline', route);
  }

  // The same page shapes that are NOT a notice stay plain failures: an HTML page whose title says nothing of the kind,
  // and one carrying the stub's own JSON (FAKE_MARKUP), which is the site working whatever its title says.
  answer = () => htmlPage('Fake A');
  let e = await failure(a.search('Walk Tale'));
  assert.ok(e && !isSiteOffline(e), `a page that is no notice read as one (${e})`);
  assert.match(String(e?.message), /answered HTML, not JSON/);
  answer = () => htmlPage('Fake A is temporarily offline', '<pre>{"sourceId": "walk-tale", "title": "Walk Tale"}</pre>');
  e = await failure(a.search('Walk Tale'));
  assert.ok(e && !isSiteOffline(e), `a page with the stub's own markup read as a notice (${e})`);
});

test('the stub\'s own `offline` page is one the adapter reads as the site saying it is offline', async () => {
  // The two halves of the rig must agree: web/test/e2e/fakeSource.mjs writes the page, the adapter above reads it. A
  // page grown past offlineNotice's 8 KB, or a title reworded, would leave the walk's Health row saying something
  // else, and the walk would fail far from the cause; this fails here first. Reintroduce by retitling the stub's page
  // "Fake A": the search comes back a plain failure.
  const script = join(__dirname, '..', '..', 'web', 'test', 'e2e', 'fakeSource.mjs');
  const port = await new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port: p } = srv.address() as AddressInfo; srv.close(() => resolve(p)); });
  });
  const child = spawn(process.execPath, [script, '--name', 'fake-a', '--port', String(port)], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise<void>((resolve, reject) => {
      let out = '';
      const timer = setTimeout(() => reject(new Error(`the stub did not start: ${out}`)), 10_000);
      child.stdout!.on('data', (c) => { out += c; if (/listening on/.test(out)) { clearTimeout(timer); resolve(); } });
      child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`the stub exited (${code}): ${out}`)); });
    });
    const base = `http://127.0.0.1:${port}`;
    const set = (behaviour: string) => realFetch(`${base}/__script`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chapter: 'site', page: 0, behaviour }),
    });
    process.env.FAKE_SOURCE_URLS = `fake-a=${base}`;
    await cleanRegistry();
    const { loadBuiltins } = await import('../src/lib/sources/builtins');
    const { getSource } = await import('../src/lib/sources/loader');
    const { isSiteOffline } = await import('../src/lib/sources/offline');
    loadBuiltins();
    const a = getSource('fake-a')!;
    assert.equal((await a.search('Walk Tale'))[0]?.title, 'Walk Tale', 'the stub answers normally before it is scripted');
    assert.equal((await set('offline')).status, 200);
    const e = await a.listChapters('walk-tale').then(() => null, (err: Error & { said?: string }) => err);
    assert.ok(isSiteOffline(e), `the stub's offline page was not read as the site saying it is offline (${e})`);
    assert.equal(e?.said, 'Fake A is temporarily offline');
    assert.equal((await set('ok')).status, 200);
    assert.equal((await a.listChapters('walk-tale')).length, 12, '`ok` on "site" brings the site back');
  } finally {
    child.kill('SIGTERM');
  }
});

/** A free port on 127.0.0.1, and one of the rig's scripts started on it, once it says it is listening. */
async function startRig(script: string, args: string[]): Promise<{ base: string; stop: () => void }> {
  const port = await new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port: p } = srv.address() as AddressInfo; srv.close(() => resolve(p)); });
  });
  const child = spawn(process.execPath, [join(__dirname, '..', '..', 'web', 'test', 'e2e', script), ...args, '--port', String(port)],
    { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise<void>((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`${script} did not start: ${out}`)), 10_000);
    child.stdout!.on('data', (c) => { out += c; if (/listening on/.test(out)) { clearTimeout(timer); resolve(); } });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`${script} exited (${code}): ${out}`)); });
  });
  return { base: `http://127.0.0.1:${port}`, stop: () => { child.kill('SIGTERM'); } };
}

test('a stub behind the fake Cloudflare answers only through a solver, and its images take the solver\'s pair (v0.55.3)', async () => {
  // The backup solver's walk (web/test/e2e/solverWalk.mjs) drives the product's own solver client through these two:
  // fakeSource.mjs --cloudflare yes refuses every request without a solver's cf_clearance, and fakeSolver.mjs fetches
  // the page with its own and hands it back. FAKE_SOURCE_CLOUDFLARE names the adapter that asks the solver for every
  // page (lib/sources/fake.ts). Reintroduce by building every adapter plain (`makeFakeSource(id, base)` in fakeSources):
  // "the stub named in FAKE_SOURCE_CLOUDFLARE is behind Cloudflare" fails, and its search would reach the stub with no
  // clearance and meet the challenge.
  const site = await startRig('fakeSource.mjs', ['--name', 'fake-b', '--cloudflare', 'yes']);
  const solver = await startRig('fakeSolver.mjs', ['--name', 'main', '--greeting', 'trawl']);
  const was = { main: process.env.FLARESOLVERR_URL, backup: process.env.FLARESOLVERR_FALLBACK_URL };
  try {
    process.env.FLARESOLVERR_URL = solver.base;
    delete process.env.FLARESOLVERR_FALLBACK_URL;
    process.env.FAKE_SOURCE_URLS = `fake-a=http://127.0.0.1:1,fake-b=${site.base}`;
    process.env.FAKE_SOURCE_CLOUDFLARE = 'fake-b';
    await cleanRegistry();
    const { loadBuiltins } = await import('../src/lib/sources/builtins');
    const { getSource } = await import('../src/lib/sources/loader');
    const { cfSession, resetSolverSessions } = await import('../src/lib/sources/flaresolverr');
    resetSolverSessions();
    loadBuiltins();
    assert.equal(getSource('fake-a')?.requiresCloudflare, false, 'a stub nobody named is plain');
    const b = getSource('fake-b')!;
    assert.equal(b.requiresCloudflare, true, 'the stub named in FAKE_SOURCE_CLOUDFLARE is behind Cloudflare');

    const plain = await realFetch(`${site.base}/search?q=Walk`);
    assert.equal(plain.status, 403, 'PREMISE: without a clearance the stub answers its challenge');
    assert.match(await plain.text(), /Just a moment/);
    assert.equal((await b.search('Walk Tale'))[0]?.title, 'Walk Tale', 'the search comes through the solver');
    assert.equal((await b.getSeries('walk-tale'))?.title, 'Walk Tale');
    assert.equal(await b.getSeries('no-such-series'), null, 'the stub\'s own "not found" is no series, through the solver too');
    assert.equal((await b.listChapters('walk-tale')).length, 12);
    const urls = await b.getPageUrls('walk-tale-1');
    assert.equal(urls.length, 12);

    // The images, as the downloader fetches them: plainly, with the pair of the solver that solved their server.
    const pair = await cfSession(urls[0]);
    assert.deepEqual(pair, { cookie: 'cf_clearance=main', userAgent: 'main-browser/1.0' }, 'the solver\'s own cookie and user agent');
    const img = await realFetch(urls[0], { headers: { cookie: pair.cookie, 'user-agent': pair.userAgent } });
    assert.equal(img.status, 200, 'with them, the image comes');
    const log = (await (await realFetch(`${site.base}/__log`)).json()).content as Array<{ route: string; clearance?: string; ua?: string }>;
    const seen = log.filter((r) => r.route !== 'challenge');
    assert.ok(seen.length >= 6 && seen.every((r) => r.clearance === 'main' && r.ua === 'main-browser/1.0'),
      `every request the stub answered carried the solver's pair: ${JSON.stringify(seen)}`);
    const asked = (await (await realFetch(`${solver.base}/__log`)).json()).content as Array<{ cmd: string; url: string }>;
    assert.ok(asked.some((r) => r.cmd === 'request.get' && r.url === `${site.base}/search?q=Walk%20Tale`), JSON.stringify(asked));
  } finally {
    if (was.main === undefined) delete process.env.FLARESOLVERR_URL; else process.env.FLARESOLVERR_URL = was.main;
    if (was.backup !== undefined) process.env.FLARESOLVERR_FALLBACK_URL = was.backup;
    site.stop();
    solver.stop();
  }
});
