// The browser rig's source is present only under its explicit environment gate, and speaks the same small
// HTTP contract as web/test/e2e/fakeSource.mjs. No database is needed for this guard.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
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
