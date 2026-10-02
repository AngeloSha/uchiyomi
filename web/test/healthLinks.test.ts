// Where a Health finding's Open goes (lib/healthLinks.ts), and how the series page lands on a chapter.
//
// Open used to go to the home screen (a /series/<id> path the static export does not have), and even pointed
// right it only ever named the series. The owner's words: "when i click open it does not take me to that
// chapter". So a short chapter opens in the reader, and a gap or an impossible number opens the series turned to
// that chapter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { chParam, healthLinks, landingNumber, numberingHref, readerHref, seriesHref, INSTALL_VOLUMES } from '../lib/healthLinks';
import { extSourceIdOf } from '../lib/sourcePrefs';

test('links are the query shape, encoded, with ?ch= only for a real number', () => {
  assert.equal(seriesHref('s 1'), '/series/?id=s%201');
  assert.equal(seriesHref('s1', 12.5), '/series/?id=s1&ch=12.5');
  assert.equal(seriesHref('s1', 0), '/series/?id=s1&ch=0', 'chapter 0 is a chapter');
  assert.equal(seriesHref('s1', null), '/series/?id=s1');
  assert.equal(seriesHref('s1', Number.NaN), '/series/?id=s1');
  assert.equal(readerHref('b/1'), '/reader/?book=b%2F1');
});

test('each finding opens the chapter it is about', () => {
  // Reintroduce by returning the series for every check: a short chapter opens the series, not the chapter.
  assert.deepEqual(healthLinks('short-chapters', { title: 't', detail: 'd', seriesId: 's1', bookId: 'b9', number: 4 }), [{ href: '/reader/?book=b9' }]);
  assert.deepEqual(healthLinks('chapter-gaps', { title: 't', detail: 'd', seriesId: 's1', numbers: [14, 12, 13] }), [{ href: '/series/?id=s1&ch=12' }],
    'a gap opens at its first missing number');
  assert.deepEqual(healthLinks('outliers', { title: 't', detail: 'd', seriesId: 's1', numbers: [9001, 5000] }), [{ href: '/series/?id=s1&ch=9001' }]);
  assert.deepEqual(healthLinks('duplicates', { title: 'A + B', detail: 'd', seriesId: 'a', seriesIds: ['a', 'b'], titles: ['A', 'B'] }),
    [{ href: '/series/?id=a', label: 'A' }, { href: '/series/?id=b', label: 'B' }], 'both copies, not only the first');
  assert.deepEqual(healthLinks('frozen-series', { title: 't', detail: 'd', seriesId: 's1' }), [{ href: '/series/?id=s1' }]);
  assert.deepEqual(healthLinks('chapter-failures', { title: 'MangaDex', detail: 'd', sourceId: 'mangadex' }), [], 'a source is not a series');
  // A gap with no numbers falls back to the series rather than to nothing.
  assert.deepEqual(healthLinks('chapter-gaps', { title: 't', detail: 'd', seriesId: 's1' }), [{ href: '/series/?id=s1' }]);
});

test('#116: a numbering finding opens its plan, and an extension source its own settings', () => {
  // The finding is about a plan, so Open is the plan on the series page (it reads ?numbering=review once). The
  // Webtoons extension's own "sequential chapter numbering" switch -- the fix #116's reporter needed -- is one
  // link further. Reintroduce the plain series link: "Open does not open the plan" fails.
  assert.equal(numberingHref('s 1'), '/series/?id=s%201&numbering=review');
  assert.deepEqual(healthLinks('numbering', { title: 't', detail: 'd', seriesId: 's1', sourceId: 'sw:2522335540328470744', actions: ['renumber', 'keep_numbers'] }),
    [{ href: '/series/?id=s1&numbering=review' }, { href: '/admin/?tab=Extensions&settings=2522335540328470744', label: 'Source settings' }],
    'Open does not open the plan');
  assert.deepEqual(healthLinks('numbering', { title: 't', detail: 'd', seriesId: 's1', sourceId: 'mangadex', actions: ['renumber'] }), [{ href: '/series/?id=s1&numbering=review' }],
    'a built-in source is sent to extension settings');
  assert.equal(extSourceIdOf('sw:-12345'), '-12345');
  assert.equal(extSourceIdOf('sw:abc'), null, 'an adapter id that is not an extension source id');
  assert.equal(extSourceIdOf(undefined), null);
});

test('#116: a numbering row with nothing to review opens the series, not a plan nobody asked for', () => {
  // The page opens the route's `next` plan, the other numbering when nothing waits: "numbered by posting order lately"
  // (info, Keep only) opened "Use the source's numbers" with a Rename key, and an interrupted renumber (no key: the
  // next check finishes it) a Confirm over its journal (web2 review). Reintroduce the plan for every numbering row:
  // each assertion below names its row.
  const ext = { href: '/admin/?tab=Extensions&settings=2522335540328470744', label: 'Source settings' };
  assert.deepEqual(healthLinks('numbering', { title: 't', detail: 'd', seriesId: 's1', sourceId: 'sw:2522335540328470744', actions: ['keep_numbers'], info: true }),
    [{ href: '/series/?id=s1' }, ext], 'a series numbered by posting order lately opens a rename plan');
  assert.deepEqual(healthLinks('numbering', { title: 't', detail: 'd', seriesId: 's1', sourceId: 'sw:2522335540328470744' }),
    [{ href: '/series/?id=s1' }, ext], 'an interrupted renumber opens a fresh plan over its journal');
  // A kept choice is info too, even with Review on it: Open is the series, Review is the key.
  assert.deepEqual(healthLinks('numbering', { title: 't', detail: 'd', seriesId: 's1', sourceId: 'mangadex', actions: ['renumber'], info: true }),
    [{ href: '/series/?id=s1' }], 'a kept choice opens the plan');
});

test('?ch= lands on that chapter, or on the one just before a gap', () => {
  const held = [1, 2, 3, 7, 8, 8.5, 10];
  assert.equal(landingNumber(held, 7), 7);
  assert.equal(landingNumber(held, 7.0000001), 7, 'stored numbers are floats');
  assert.equal(landingNumber(held, 4), 3, 'a missing number lands where its gap begins');
  assert.equal(landingNumber(held, 9), 8.5);
  assert.equal(landingNumber(held, 0.5), 1, 'nothing below: the first one above');
  assert.equal(landingNumber([], 3), null);
});

test('an absent ?ch= is absent, not chapter 0', () => {
  // Reintroduce by `Number(params.get('ch'))`: every series link would jump to chapter 0.
  assert.equal(chParam(null), null);
  assert.equal(chParam(''), null);
  assert.equal(chParam('  '), null);
  assert.equal(chParam('abc'), null);
  assert.equal(chParam('0'), 0);
  assert.equal(chParam('12.5'), 12.5);
});

test('the series page reads ?ch= and lights the row it lands on', () => {
  const page = readFileSync(join(__dirname, '..', 'app', 'series', 'page.tsx'), 'utf8');
  assert.match(page, /chParam\(useSearchParams\(\)\.get\('ch'\)\)/);
  assert.match(page, /landingNumber\(held, wantCh\)/);
  assert.match(page, /lit=\{litCh === b\.number\}/);
  // Taken off the URL with the router's history state kept: dropping it makes Next reload the page on Back.
  assert.match(page, /replaceState\(window\.history\.state,/);
});

test('the series page opens the plan Health links to, once, for an admin', () => {
  // Reintroduce by dropping the effect: Health's Open lands on the series with no plan in sight.
  const page = readFileSync(join(__dirname, '..', 'app', 'series', 'page.tsx'), 'utf8');
  assert.match(page, /const wantPlan = useSearchParams\(\)\.get\('numbering'\) === 'review';/, 'the page does not read ?numbering=');
  const fx = page.slice(page.indexOf('const openedPlan = useRef'), page.indexOf('}, [wantPlan, isAdmin, id]);'));
  assert.match(fx, /if \(!wantPlan \|\| !isAdmin \|\| openedPlan\.current === id\) return;/, 'the plan opens for a member, or on every render');
  assert.match(fx, /u\.searchParams\.delete\('numbering'\);/, 'a reload opens the plan again');
  assert.match(fx, /setNumberingSheet\('next'\);/, 'the plan opened is not the one waiting');
  // After the reset on a new series, which would otherwise close it straight away.
  assert.ok(page.indexOf('useEffect(() => { setNumberingSheet(null); }, [id]);') < page.indexOf('const openedPlan = useRef'), 'the reset closes the plan it opened');
});

test("Health's Open links wrap onto a second line rather than being cut", () => {
  // 390-de-health-numbering-row.png: "Öffnen · Einstellungen der Q…" -- which settings, the link no longer said.
  // Reintroduce `max-w-[11rem] truncate` on the link: "a Health link is cut to one line" fails by name.
  const page = readFileSync(join(__dirname, '..', 'app', 'admin', 'page.tsx'), 'utf8');
  const links = page.slice(page.indexOf('links={healthLinks(c.id, it).map((l) => ('), page.indexOf('))}>', page.indexOf('links={healthLinks(c.id, it).map((l) => (')));
  const cls = /<Link key=\{l\.href\} href=\{l\.href\} className="([^"]*)"/.exec(links)?.[1];
  assert.ok(cls, "Health's links moved -- update this test");
  assert.doesNotMatch(cls!, /\btruncate\b/, 'a Health link is cut to one line');
  assert.match(cls!, /\bline-clamp-2\b/, 'a Health link can grow past two lines, or is cut to one');
  assert.match(cls!, /\bbreak-words\b/);
  assert.match(cls!, /\bmax-w-\[11rem\]/, 'the links column can take the finding\'s words\' width');
  // The arrow stays with the last word: a no-break space, so "›" never starts the second line on its own.
  assert.match(links, /\{'\\u00a0'\}›/, 'the arrow can wrap onto a line of its own');
});

test('a folder scanned twice links to the install guide\'s Volumes section, which opens beside the app (v0.52.0, #134)', () => {
  // Reintroduce by dropping the case in healthLinks: the row has no way to the fix.
  assert.deepEqual(healthLinks('folders-twice', { title: 'Library / uchiyomi_manga', detail: '' }),
    [{ href: INSTALL_VOLUMES, label: 'Volumes, in the install guide' }], 'a folder scanned twice links to the install guide');
  assert.match(INSTALL_VOLUMES, /\/docs\/INSTALL\.md#volumes$/);
  // The section is there, under that anchor.
  assert.match(readFileSync(join(__dirname, '..', '..', 'docs', 'INSTALL.md'), 'utf8'), /^## Volumes$/m, 'INSTALL.md has no Volumes section');
  // A link off the app opens beside it, never in its place.
  assert.match(readFileSync(join(__dirname, '..', 'app', 'admin', 'page.tsx'), 'utf8'),
    /\{\.\.\.\(\/\^https\?:\\\/\\\/\/\.test\(l\.href\) \? \{ target: '_blank', rel: 'noopener noreferrer' \} : \{\}\)\}/, 'the install guide opens in place of the app');
});
