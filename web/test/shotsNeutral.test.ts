// The screenshot rig keeps real site, group and repository names out of every image (owner, v0.45.0).
//
// The library shots and the tour are taken on a REAL library, and a real library names where its chapters came
// from: series.webp's supply line, the README's tour and the landing page's video all read "<a real site> ·
// Translated by <two real groups>" until the V2 review of v0.45.0, and the tour held a scanlator's credits page
// on camera. scripts/shots/fixtures.mjs neutralNames() now shows every such name as a made-up one; namesIn() is
// what decides which names those are, so it is pinned here on the response shapes the web app reads, and the two
// scripts are pinned to use it. The rig itself is never run by a test (it needs a server and a browser), which
// is exactly why a silent regression here would only show up in a published image.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';

const SHOTS = join(__dirname, '..', '..', 'scripts', 'shots');
const read = (f: string) => readFileSync(join(SHOTS, f), 'utf8');
type Pair = ['source' | 'group', string];
const load = async (): Promise<{ namesIn: (path: string, j: unknown) => Pair[] }> =>
  (await import(pathToFileURL(join(SHOTS, 'fixtures.mjs')).href)) as { namesIn: (path: string, j: unknown) => Pair[] };

test('namesIn finds every source and group name the library pages draw, and keeps MangaDex', async () => {
  // Reintroduce by dropping the `scanlator` rule from namesIn: a chapter row's group ("via" line, the chapter
  // list) is drawn under its real name -- "a book's scanlator is a group" fails.
  const { namesIn } = await load();
  const names = (path: string, j: unknown) => namesIn(path, j).map(([k, n]) => `${k}:${n}`).sort();
  // The series page: its sources (the supply line), MangaDex kept as the built-in source every guide names.
  assert.deepEqual(names('/api/series/s_1', { id: 's_1', title: 'Real Title', sources: [
    { sourceId: 'aqua', name: 'A Real Site', primary: true }, { sourceId: 'mangadex', name: 'MangaDex' },
  ] }), ['source:A Real Site'], 'a series\' sources are sources');
  // Its groups: the admin's route and a member's.
  assert.deepEqual(names('/api/admin/series/s_1/scanlators', { groups: [{ name: 'Real Scans' }, { name: 'Other Team' }] }), ['group:Other Team', 'group:Real Scans']);
  assert.deepEqual(names('/api/series/s_1/groups', { content: [{ name: 'Real Scans' }] }), ['group:Real Scans'], 'a member\'s groups route');
  // The chapter list and the versions sheet.
  assert.deepEqual(names('/api/series/s_1/books', { content: [{ id: 'b', scanlator: 'Real Scans' }] }), ['group:Real Scans'], 'a book\'s scanlator is a group');
  assert.deepEqual(names('/api/series/s_1/versions', { content: [{ number: 1, copies: [{ source: 'aqua', sourceName: 'A Real Site', groups: ['Real Scans', 'Other Team'], scanlator: 'Real Scans' }] }] }),
    ['group:Other Team', 'group:Real Scans', 'group:Real Scans', 'source:A Real Site']);
  assert.deepEqual(names('/api/series/s_1/listing', { sourceId: 'aqua', sourceName: 'A Real Site', content: [] }), ['source:A Real Site']);
  // Every source the server has (what meetNames() reads first), the sites added by URL, and Discover's results.
  assert.deepEqual(names('/api/sources', { content: [{ id: 'mangadex', name: 'MangaDex' }, { id: 'sw:1', name: 'A Real Extension (EN)' }] }), ['source:A Real Extension (EN)']);
  assert.deepEqual(names('/api/admin/sources/custom', { content: [{ id: 'custom:x', name: 'A Real Site', base: 'https://x.example' }] }), ['source:A Real Site']);
  assert.deepEqual(names('/api/sources/search', { content: [{ title: 'Real Title', providers: [{ source: 'aqua', sourceId: '1', name: 'A Real Site', title: 'Real Title' }] }] }), ['source:A Real Site']);
  // ...and nothing that is not a source or a group: titles, collections, libraries, members.
  assert.deepEqual(names('/api/collections', { content: [{ id: 'c', name: 'Favourites' }] }), []);
  assert.deepEqual(names('/api/admin/libraries', { content: [{ id: 'l', name: 'Family', path: 'x' }] }), []);
  assert.deepEqual(names('/api/series', { content: [{ id: 's', title: 'Real Title', name: 'Real Title' }] }), []);
  assert.deepEqual(names('/api/series/s_1', null), []);
});

test('the library shots and the tour are taken behind neutralNames, and the tour never films a first page', () => {
  // Reintroduce by deleting `await neutralNames(page);` from capture.mjs: series.webp shows a real site and its
  // groups again -- "the library shots are not neutralised" fails; by moving `paused = true;` below the reader's
  // goto in record.mjs: the credits page is on camera again -- "the tour films the reader opening" fails.
  const cap = read('capture.mjs');
  assert.match(cap, /from '\.\/fixtures\.mjs'/);
  const main = cap.slice(cap.indexOf('// ---- everything else, one login reused for every shot ----'));
  assert.match(main, /const page = await ctx\.newPage\(\);[\s\S]{0,400}await neutralNames\(page\);\s*await login\(page\);/, 'the library shots are not neutralised');
  assert.match(main, /await meetNames\(page, BASE\);/, 'the names are not met before the shots');
  assert.match(cap, /const ph = await ctx\.newPage\(\);\s*await neutralNames\(ph\);/, 'the phone shots are not neutralised');
  const rec = read('record.mjs');
  assert.match(rec, /await neutralNames\(page, \{ fixtures: \[extensionFixture\(\{ repos: \[FIXTURE_REPO_STORED\] \}\)\] \}\);/, 'the tour is not neutralised, or its extension catalogue is the real one');
  assert.ok(rec.indexOf('await meetNames(page, BASE);') > 0 && rec.indexOf('await meetNames(page, BASE);') < rec.indexOf("client.send('Page.startScreencast'"), 'the tour meets the names only after it starts filming');
  const reader = rec.slice(rec.indexOf('if (BOOK_ID) {'));
  assert.ok(reader.indexOf('paused = true;') >= 0 && reader.indexOf('paused = true;') < reader.indexOf('/reader/?book='), 'the tour films the reader opening');
  assert.ok(reader.indexOf('paused = false;') > reader.indexOf('el.scrollTop = Math.floor(el.scrollHeight * 0.2);'), 'the tour resumes before the jump past the first page');
  assert.match(rec, /if \(!paused\) frames\.push\(/, 'paused frames are kept');
});
