// The product smoke's MangaDex title (scripts/ci/mangadex-pick.mjs): only one whose newest English chapter -- the one its
// add takes -- MangaDex hosts itself, so "a MangaDex series is added and its chapter downloads" goes red when the app's add
// or download is broken, not when MangaDex hands the smoke licensed titles. Desktop run 39342059609 (main, 2026-10-19,
// mac-arm64) was red on three of them, each refused by the app with "No downloadable chapters here", rightly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { addFirstHosted, newestFeedUrl, newestHosted, titleFeedUrl, titlesOf } from '../scripts/ci/mangadex-pick.mjs';

const NOW = Date.parse('2026-10-22T12:00:00Z');
let ids = 0;
/** A feed row as MangaDex answers one: a hosted English chapter unless told otherwise. */
const row = (chapter, a = {}) => ({
  id: `c${++ids}`, type: 'chapter',
  attributes: { chapter, pages: 18, externalUrl: null, isUnavailable: false, translatedLanguage: 'en', readableAt: '2026-10-19T15:00:00+00:00', ...a },
});
/** A chapter that is only a link to the publisher's site. */
const link = (chapter, a = {}) => row(chapter, { pages: 0, externalUrl: 'https://publisher.example/viewer/1', ...a });

test('a licensed title whose English chapters are links to the publisher is never added', () => {
  // Dandadan in the 10-19 run, as MangaDex lists it: every English chapter a link, 242 and 243 saying 1 page.
  const licensed = [link('249'), link('248'), link('243', { pages: 1 }), link('242', { pages: 1 })];
  assert.deepEqual(newestHosted(licensed, NOW), { ok: false, chapter: 249, why: 'its newest chapter (249) is only a link to another site' });
  // A link that says 1 page passes the app's own test (bff/src/lib/releases.ts: pages === 0 is external), and is still a
  // link. Reintroduce by holding a copy to `pages > 0` alone: this reads hosted.
  assert.deepEqual(newestHosted([link('243', { pages: 1 }), link('242', { pages: 1 })], NOW), { ok: false, chapter: 243, why: 'its newest chapter (243) is only a link to another site' });
});

test('the highest NUMBER decides, as the add takes it, wherever it is in the answer', () => {
  // Newest lists a title by the chapter uploaded last; `chapterFrom: 'newest'` takes the highest number. A scan of chapter
  // 5 uploaded today does not make the publisher's chapter 120 downloadable. Reintroduce by judging the first row: this
  // reads hosted.
  const rows = [row('5', { readableAt: '2026-10-22T09:00:00+00:00' }), link('120', { readableAt: '2026-10-01T00:00:00+00:00' })];
  assert.deepEqual(newestHosted(rows, NOW), { ok: false, chapter: 120, why: 'its newest chapter (120) is only a link to another site' });
  // Read as numbers, as the adapter reads them: 100 is above 99, and 12.5 is between 12 and 13.
  assert.deepEqual(newestHosted([row('99'), row('100'), row('12.5')], NOW), { ok: true, chapter: 100 });
});

test('a hosted copy of the newest chapter is enough beside a link to the same chapter', () => {
  // The chooser takes a number's hosted copy over its link, so the add downloads it. Reintroduce by requiring every copy
  // hosted: this reads not hosted.
  assert.deepEqual(newestHosted([link('57'), row('57'), row('56')], NOW), { ok: true, chapter: 57 });
});

test('a copy that only looks hosted keeps the title out: not out yet, taken down, a link that says 1 page', () => {
  // The chooser passes over a copy only for pages === 0, so any of these could be the copy it takes, and fail.
  const later = row('31', { readableAt: '2026-10-29T00:00:00+00:00' });
  assert.deepEqual(newestHosted([later], NOW), { ok: false, chapter: 31, why: 'its newest chapter (31) is not readable on MangaDex' });
  assert.deepEqual(newestHosted([row('31'), later], NOW), { ok: false, chapter: 31, why: 'its newest chapter (31) also has a copy that only looks hosted' });
  assert.equal(newestHosted([row('31'), row('31', { isUnavailable: true })], NOW).ok, false);
  assert.equal(newestHosted([row('31'), link('31', { pages: 1 })], NOW).ok, false);
});

test("a title with no numbered English chapter is the add's no_chapters, and is not added", () => {
  // Run 39289988723 (10-19): Newest's first title answered 404 no_chapters, and the next one was tried.
  assert.deepEqual(newestHosted([row(null), row('Oneshot')], NOW), { ok: false, why: 'no numbered English chapter' });
  assert.deepEqual(newestHosted([], NOW), { ok: false, why: 'no numbered English chapter' });
  // A oneshot beside numbered chapters is no chapter to the adapter: the numbered ones decide.
  assert.equal(newestHosted([row(null, { readableAt: '2026-10-22T08:00:00+00:00' }), link('9')], NOW).ok, false);
});

test("MangaDex's newest chapters name their titles once each, in order, by the name the app shows", () => {
  const ch = (manga, title) => ({ type: 'chapter', relationships: [{ id: 'g', type: 'scanlation_group' }, { id: manga, type: 'manga', ...(title ? { attributes: { title } } : {}) }] });
  const feed = { data: [ch('m1', { en: 'First Title' }), ch('m2', { 'ja-ro': 'Niban-me' }), ch('m1', { en: 'First Title' }), ch('m3', { ko: 'Third' }), { type: 'chapter', relationships: [] }, ch('m4')] };
  assert.deepEqual(titlesOf(feed), [
    { sourceId: 'm1', title: 'First Title' }, { sourceId: 'm2', title: 'Niban-me' }, { sourceId: 'm3', title: 'Third' }, { sourceId: 'm4', title: 'm4' },
  ]);
  assert.deepEqual(titlesOf(null), []);
  assert.deepEqual(titlesOf({ result: 'error', errors: [] }), []);
});

test("the smoke asks MangaDex what the app's adapter asks", () => {
  const adapter = readFileSync(join(import.meta.dirname, '..', '..', 'bff', 'src', 'lib', 'sources', 'mangadex.ts'), 'utf8');
  assert.match(adapter, /const RATINGS = \['safe', 'suggestive', 'erotica'\]/, "the adapter's ratings changed: change mangadex-pick.mjs RATINGS with them");
  const newest = newestFeedUrl('https://api.example');
  for (const f of ['translatedLanguage[]=', 'order[readableAt]=desc', 'includeExternalUrl=0', 'includeFuturePublishAt=0', 'includeEmptyPages=0']) {
    assert.ok(adapter.includes(f), `the adapter's Newest no longer asks ${f}`);
    assert.ok(newest.includes(f), `the smoke's newest chapters do not ask ${f}`);
  }
  for (const url of [newest, titleFeedUrl('https://api.example', 'abc')]) {
    assert.match(url, /translatedLanguage\[\]=en&/);
    assert.match(url, /contentRating\[\]=safe&contentRating\[\]=suggestive&contentRating\[\]=erotica/);
  }
  assert.equal(titleFeedUrl('https://api.example', 'a b').split('?')[0], 'https://api.example/manga/a%20b/feed');
  assert.match(titleFeedUrl('https://api.example', 'abc'), /order\[chapter\]=desc/);
});

/** What the smoke's add answers: the app's step, and `added` once its chapter landed. */
const landed = (t) => ({ step: { add: 200, job: { status: 'done', done: 1, seriesId: `s_${t.sourceId}` } }, added: { title: t.title, folder: `MangaDex/${t.title}` } });
const refused = { step: { add: 200, job: { status: 'error', done: 0, reason: 'No downloadable chapters here — this title may be licensed or hosted externally on this source.' } }, added: null };
const title = (id) => ({ sourceId: id, title: `Title ${id}` });

test("the 10-19 run again: Newest empty, a licensed title skipped, MangaDex's own newest asked, its hosted title added", async () => {
  const asked = [];
  const adds = [];
  const verdicts = { L: { ok: false, chapter: 249, why: 'its newest chapter (249) is only a link to another site' }, H: { ok: true, chapter: 12 } };
  const r = await addFirstHosted({
    lists: [
      async () => { asked.push('app'); return { note: { latest: 200, candidates: 0 }, titles: [] }; },
      async () => { asked.push('mangadex'); return { note: { mangadex: 200, candidates: 2, ms: 9100 }, titles: [title('L'), title('H')] }; },
    ],
    hosted: async (t) => verdicts[t.sourceId],
    add: async (t) => { adds.push(t.sourceId); return landed(t); },
  });
  assert.deepEqual(asked, ['app', 'mangadex']);
  // Reintroduce by adding every title (no hold): L goes first, and its job says "No downloadable chapters here".
  assert.deepEqual(adds, ['H']);
  assert.deepEqual(r.added, { title: 'Title H', folder: 'MangaDex/Title H' });
  assert.equal(r.step.job.seriesId, 's_H');
  assert.deepEqual(r.tried, [
    { latest: 200, candidates: 0 },
    { mangadex: 200, candidates: 2, ms: 9100 },
    { title: 'Title L', skipped: 'its newest chapter (249) is only a link to another site' },
    { title: 'Title H', newest: 12, add: 200, job: { status: 'done', done: 1, seriesId: 's_H' } },
  ]);
});

test("MangaDex is asked directly only once the app's own Newest has run out", async () => {
  let direct = 0;
  const r = await addFirstHosted({
    lists: [async () => ({ note: { latest: 200, candidates: 1 }, titles: [title('A')] }), async () => { direct++; return { note: {}, titles: [] }; }],
    hosted: async () => ({ ok: true, chapter: 3 }),
    add: async (t) => landed(t),
  });
  assert.equal(direct, 0);
  assert.equal(r.added.title, 'Title A');
});

test('nothing lands: added stays null with every step in the evidence, never a pass for want of a title', async () => {
  const titles = Array.from({ length: 9 }, (_, i) => title(`T${i}`));
  let adds = 0;
  const r = await addFirstHosted({
    lists: [async () => ({ note: { latest: 200, candidates: 9 }, titles })],
    hosted: async () => ({ ok: true, chapter: 1 }),
    add: async () => { adds++; return refused; },
  });
  // The check is `!!added`: null is its FAIL. At most six adds, as many as the old candidate list held from Newest.
  assert.equal(r.added, null);
  assert.equal(adds, 6);
  assert.equal(r.tried.length, 1 + 6);
  assert.equal(r.tried[6].job.reason, refused.step.job.reason);
  // MangaDex answering a runner nothing at all (10-21, run 39612192984): no hold, no add, and what each list answered.
  const none = await addFirstHosted({
    lists: [async () => ({ note: { latest: 200, candidates: 0 }, titles: [] }), async () => ({ note: { mangadex: 200, candidates: 0, ms: 140 }, titles: [] })],
    hosted: async () => assert.fail('nothing to hold'),
    add: async () => assert.fail('nothing to add'),
  });
  assert.deepEqual(none, { added: null, step: null, tried: [{ latest: 200, candidates: 0 }, { mangadex: 200, candidates: 0, ms: 140 }] });
  // An answer that is no list at all is no titles, not a TypeError that ends the smoke before its other checks.
  const odd = await addFirstHosted({ lists: [async () => ({ note: { latest: 500, candidates: 0 }, titles: { error: 'x' } })], hosted: async () => ({ ok: true }), add: async () => refused });
  assert.deepEqual(odd.tried, [{ latest: 500, candidates: 0 }]);
});

test('a title MangaDex could not answer for is still added: the app judges it, as before the hold', async () => {
  // Reintroduce by skipping an unknown title: a runner whose own requests to MangaDex fail would add nothing, although
  // the app could.
  const r = await addFirstHosted({
    lists: [async () => ({ note: { latest: 200, candidates: 1 }, titles: [title('A')] })],
    hosted: async () => ({ ok: null, why: 'MangaDex answered 503' }),
    add: async (t) => landed(t),
  });
  assert.equal(r.added.title, 'Title A');
  assert.equal(r.tried[1].newest, 'unknown: MangaDex answered 503');
});

test('a title both lists name is held and added once', async () => {
  const held = [];
  const adds = [];
  const r = await addFirstHosted({
    lists: [
      async () => ({ note: { latest: 200, candidates: 2 }, titles: [title('A'), title('B')] }),
      async () => ({ note: { mangadex: 200, candidates: 3 }, titles: [title('B'), title('A'), title('C')] }),
    ],
    hosted: async (t) => { held.push(t.sourceId); return t.sourceId === 'A' ? { ok: false, why: 'a link' } : { ok: true, chapter: 1 }; },
    add: async (t) => { adds.push(t.sourceId); return t.sourceId === 'C' ? landed(t) : refused; },
  });
  assert.deepEqual(held, ['A', 'B', 'C']);
  assert.deepEqual(adds, ['B', 'C']);
  assert.equal(r.added.title, 'Title C');
});

test('the time budget ends the tries', async () => {
  let now = 0;
  const r = await addFirstHosted({
    lists: [async () => ({ note: { latest: 200, candidates: 2 }, titles: [title('A'), title('B')] })],
    hosted: async () => ({ ok: true, chapter: 1 }),
    add: async () => { now += 9 * 60_000; return refused; },
    clock: () => now,
  });
  assert.equal(r.added, null);
  assert.deepEqual(r.tried.map((t) => t.title ?? 'note'), ['note', 'Title A']);
});

test("the standalone check adds through the hold, and names no title of its own", () => {
  // The 10-19 fallback searched "Solo Leveling" and "Dandadan" -- licensed, links only. Reintroduce a named search: the
  // second assertion fails.
  const src = readFileSync(join(import.meta.dirname, '..', 'scripts', 'ci', 'product-smoke.mjs'), 'utf8');
  const leg = src.slice(src.indexOf('// ---------------------------------------------------------------- a MangaDex series'), src.indexOf("check('a MangaDex series is added"));
  assert.match(leg, /await addFirstHosted\(\{/, 'the MangaDex title is not chosen through the hold');
  assert.doesNotMatch(leg, /\/api\/sources\/search/, 'the smoke searches named titles again');
});
