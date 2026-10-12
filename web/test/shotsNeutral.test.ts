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
  // v0.54.0: Admin → Sources lists every source of every kind from one answer, the one meetNames() now reads.
  assert.deepEqual(names('/api/admin/sources/overview', { sources: [
    { id: 'mangadex', name: 'MangaDex', kind: 'mangadex' }, { id: 'aqua', name: 'A Real Site', kind: 'site' },
    { id: 'sw:1', name: 'A Real Extension (EN)', kind: 'extension', pkgName: 'x' },
  ], attention: { replace: ['aqua'], failingUnused: [], updates: 0 } }), ['source:A Real Extension (EN)', 'source:A Real Site'], 'the sources overview\'s names are drawn as they are');
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
  assert.match(main, /const page = await ctx\.newPage\(\);[\s\S]{0,400}await neutralNames\(page, \{ fixtures: \[people, librariesFixture\(\)\] \}\);\s*await login\(page\);/, 'the library shots are not neutralised, or Admin → Library shows its real names');
  assert.match(main, /const people = peopleFixture\(me\.user\.id\);/, 'the people on the shots are the real ones');
  assert.match(main, /await meetNames\(page, BASE\);/, 'the names are not met before the shots');
  assert.match(cap, /const ph = await ctx\.newPage\(\);\s*await neutralNames\(ph, \{ fixtures: \[people, librariesFixture\(\)\] \}\);/, 'the phone shots are not neutralised');
  const rec = read('record.mjs');
  assert.match(rec, /await neutralNames\(page, \{ fixtures: \[extensionFixture\(\{ repos: \[FIXTURE_REPO_STORED\] \}\), peopleFixture\(me\.user\.id\)\] \}\);/, 'the tour is not neutralised, its extension catalogue is the real one, or its people are');
  assert.ok(rec.indexOf('await meetNames(page, BASE);') > 0 && rec.indexOf('await meetNames(page, BASE);') < rec.indexOf("client.send('Page.startScreencast'"), 'the tour meets the names only after it starts filming');
  const reader = rec.slice(rec.indexOf('if (BOOK_ID) {'));
  assert.ok(reader.indexOf('paused = true;') >= 0 && reader.indexOf('paused = true;') < reader.indexOf('/reader/?book='), 'the tour films the reader opening');
  assert.ok(reader.indexOf('paused = false;') > reader.indexOf('el.scrollTop = Math.floor(el.scrollHeight * 0.2);'), 'the tour resumes before the jump past the first page');
  assert.match(rec, /if \(!paused\) frames\.push\(/, 'paused frames are kept');
});

test('the people on a real server are shown with sample names: the same person the same name, the capture account its own', async () => {
  // Admin → Members and the profile's household board showed the household's real names and usernames until v0.60.1,
  // in the repo and on the marketing site. Reintroduce by answering the members list as it is (dropping the rewrite
  // loop in fixtures.mjs peopleFixture): every assertion below on a real name fails.
  const { peopleFixture, SAMPLE_PEOPLE } = (await import(pathToFileURL(join(SHOTS, 'fixtures.mjs')).href)) as {
    peopleFixture: (meId: string) => (url: URL, req: unknown) => Promise<{ status: number; json?: any } | null>;
    SAMPLE_PEOPLE: string[];
  };
  const answers: Record<string, unknown> = {
    '/api/admin/users': { content: [
      { id: 'u-me', username: 'shotbot', display_name: 'Admin', avatar: null, role: 'admin' },
      { id: 'u-1', username: 'realperson', display_name: 'Real Person', avatar: { emoji: 'x', color: 'red' }, role: 'user', disabled: true },
      { id: 'u-2', username: 'another', display_name: 'Another One', avatar: null, role: 'admin' },
    ] },
    '/api/leaderboard': { content: [
      { id: 'u-2', display_name: 'Another One', avatar: null, week: 3, total: 40 },
      { id: 'u-me', display_name: 'Admin', avatar: null, week: 1, total: 2 },
    ] },
  };
  const seen: Array<{ url: string; auth?: string }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: URL, init: { headers: Record<string, string> }) => {
    seen.push({ url: String(url), auth: init.headers.authorization });
    return new Response(JSON.stringify(answers[new URL(String(url)).pathname]), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  try {
    const fixture = peopleFixture('u-me');
    const req = (method = 'GET') => ({ method: () => method, headers: () => ({ authorization: 'Bearer t', cookie: 'not=forwarded' }) });
    const members = (await fixture(new URL('http://app/api/admin/users'), req()))!.json.content;
    assert.deepEqual(members.map((m: any) => [m.display_name, m.username]), [
      ['Admin', 'shotbot'], [SAMPLE_PEOPLE[0], SAMPLE_PEOPLE[0].toLowerCase()], [SAMPLE_PEOPLE[1], SAMPLE_PEOPLE[1].toLowerCase()],
    ], 'everyone but the capture account has a sample name');
    assert.equal(members[1].avatar, null, 'and no avatar');
    assert.equal(members[1].disabled, true, 'the rest of the row is the real one');
    const board = (await fixture(new URL('http://app/api/leaderboard'), req()))!.json.content;
    assert.deepEqual(board.map((m: any) => m.display_name), [SAMPLE_PEOPLE[1], 'Admin'], 'the same person keeps the same sample name');
    assert.equal(seen[0].auth, 'Bearer t', 'the app\'s own token is sent');
    assert.equal(await fixture(new URL('http://app/api/series'), req()), null, 'other answers are left alone');
    assert.equal(await fixture(new URL('http://app/api/admin/users'), req('POST')), null, 'and so is anything but a read');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Admin → Library is shown with sample libraries, people and folders, and the default library as it is", async () => {
  // Admin → Library on the live server named an 18+ library after the site it came from, its folders after sites, and
  // who may open each by their real names. Reintroduce by answering /api/admin/libraries as it is (dropping the
  // rewrite in fixtures.mjs librariesFixture): every assertion below on a real name fails.
  const { librariesFixture, SAMPLE_LIBRARIES, SAMPLE_PEOPLE, NEUTRAL_SOURCE_NAMES } = (await import(pathToFileURL(join(SHOTS, 'fixtures.mjs')).href)) as any;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    content: [
      { id: 'lib', name: 'Library', path: '', paths: [], n: 300, age_rating: null, members: ['Admin', 'Real Person'] },
      { id: 'lib_x', name: 'A Real Adult Site (ALL)', path: 'A Real Adult Site (ALL)', paths: ['A Real Adult Site (ALL)'], n: 2, age_rating: 18, members: ['Real Person'] },
    ],
    candidates: [{ path: 'A Real Site (EN)', series: 12, looksLikeSource: true }, { path: 'Another Real Site', series: 3, looksLikeSource: true }],
  }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
  try {
    const req = { method: () => 'GET', headers: () => ({ authorization: 'Bearer t' }) };
    const j = (await librariesFixture('Admin')(new URL('http://app/api/admin/libraries'), req))!.json;
    assert.deepEqual(j.content.map((l: any) => [l.name, l.path, l.age_rating]), [['Library', '', null], [SAMPLE_LIBRARIES[0], SAMPLE_LIBRARIES[0], 18]]);
    assert.deepEqual(j.content[1].paths, [SAMPLE_LIBRARIES[0]]);
    assert.deepEqual(j.content[0].members, ['Admin', SAMPLE_PEOPLE[0]], 'the capture account keeps its name; everyone else is a sample');
    assert.deepEqual(j.content[1].members, [SAMPLE_PEOPLE[0]], 'the same person, the same sample name');
    assert.deepEqual(j.candidates.map((c: any) => [c.path, c.series]), [[NEUTRAL_SOURCE_NAMES[0], 12], [NEUTRAL_SOURCE_NAMES[1], 3]]);
    assert.equal(JSON.stringify(j).includes('Real'), false, 'no real name is left');
  } finally {
    globalThis.fetch = realFetch;
  }
});
