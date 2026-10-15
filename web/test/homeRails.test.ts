// Home's rails, the reader's way round (Look settings, UI refresh phase 3): lib/homeRails.ts and the Customize sheet.
//
// The rules are run as functions; the wiring a function cannot reach -- Home drawing its rails by key in the reader's
// order, the requests a hidden rail does not make, the sheet's one-at-a-time save, the Lists page staying the one place
// that picks lists -- is read from source.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  HOME_RAILS, HOME_RAIL_KEYS, LISTS_RAIL, moveRail, orderRails, railsSetting, setRailHidden, shownRails,
} from '../lib/homeRails';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const code = (src: string): string => src.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const keysOf = (slots: ReadonlyArray<{ key: string }>) => slots.map((s) => s.key);
const D = HOME_RAIL_KEYS;

test("the registry is the owner's order, one entry per rail Home draws", () => {
  // Moved here from v610Small.test.ts (and v580Ratings.test.ts), which read the order off app/page.tsx: Home now draws
  // its rails in the reader's order, and THIS is the order everybody who never chose gets. Reorder it and this fails.
  assert.deepEqual(keysOf(HOME_RAILS), [
    'continue', 'forYou', 'because', 'newEpisodes', 'favorites', 'lists', 'pickUp', 'recentlyAdded', 'popular', 'gems', 'top10',
  ]);
  assert.deepEqual(HOME_RAILS.map((r) => r.label), [
    'Keep reading', 'For you', 'Because you read…', 'New episodes', 'Your favorites', 'Your lists', 'Pick back up',
    'Recently added', 'Most popular in your library', 'Hidden gems', 'Top 10 in your library',
  ]);
  assert.equal(new Set(D).size, D.length, 'a key is in the registry twice');
  assert.equal(LISTS_RAIL, 'lists');
  // Every key Home's switch draws is a registry key, and every registry key has a case: a rail added to one and not the
  // other is a rail that never shows, or a case nobody can reach.
  const home = code(read('app/page.tsx'));
  const cases = [...home.matchAll(/^\s*case '([A-Za-z0-9]+)':/gm)].map((m) => m[1]);
  assert.deepEqual([...cases].sort(), [...D].sort(), 'Home\'s rail switch and HOME_RAILS name different rails');
});

test('nothing saved, or something that is not an arrangement, is the default order with every rail shown', () => {
  for (const saved of [undefined, null, 0, 'x', true, [], ['top10'], { order: 'top10' }, { order: null, hidden: 'gems' }]) {
    const slots = orderRails(saved, D);
    assert.deepEqual(keysOf(slots), [...D], JSON.stringify(saved));
    assert.ok(slots.every((s) => !s.hidden), JSON.stringify(saved));
  }
});

test('a saved order is followed; an unknown key or a second copy is dropped', () => {
  const slots = orderRails({ order: ['top10', 'nope', 'continue', 'top10', 42, 'gems'], hidden: ['gems', 'nope', 7] }, D);
  // The saved ones keep their order among themselves (the rest fill in by their default neighbours, below).
  const keys = keysOf(slots);
  assert.ok(keys.indexOf('top10') < keys.indexOf('continue') && keys.indexOf('continue') < keys.indexOf('gems'), keys.join());
  assert.equal(keys[0], 'top10');
  assert.equal(slots.length, D.length, 'every rail once');
  assert.deepEqual(slots.filter((s) => s.hidden).map((s) => s.key), ['gems']);
});

test('a rail the saved order has never heard of goes where the defaults put it, shown', () => {
  // A later release adds a rail: a reader who arranged Home before it existed gets it beside its default neighbour, not
  // at the end and not hidden. Reintroduce "append the missing ones": `newEpisodes` lands last and this fails.
  const saved = { order: D.filter((k) => k !== 'newEpisodes').reverse(), hidden: [] };
  const keys = keysOf(orderRails(saved, D));
  // Reversed, its default predecessor `because` is near the end, and it goes right after that.
  assert.equal(keys.indexOf('newEpisodes'), keys.indexOf('because') + 1);
  // With no placed predecessor at all, it goes first.
  assert.deepEqual(keysOf(orderRails({ order: ['gems'] }, ['a', 'gems', 'b'] as const)), ['a', 'gems', 'b']);
  assert.deepEqual(keysOf(orderRails({ order: ['b', 'gems'] }, ['a', 'gems', 'b'] as const)), ['a', 'b', 'gems']);
  // Several missing ones keep their own order between them.
  assert.deepEqual(keysOf(orderRails({ order: ['d'] }, ['a', 'b', 'c', 'd'] as const)), ['a', 'b', 'c', 'd']);
  assert.deepEqual(keysOf(orderRails({ order: ['d', 'a'] }, ['a', 'b', 'c', 'd'] as const)), ['d', 'a', 'b', 'c']);
});

test('moving, hiding, and what is stored', () => {
  const start = orderRails(null, D);
  assert.deepEqual(keysOf(moveRail(start, 'forYou', -1)).slice(0, 2), ['forYou', 'continue']);
  assert.deepEqual(keysOf(moveRail(start, 'continue', -1)), [...D], 'the first rail does not move up');
  assert.deepEqual(keysOf(moveRail(start, 'top10', 1)), [...D], 'the last rail does not move down');
  assert.deepEqual(keysOf(moveRail(start, 'nope' as never, 1)), [...D]);
  const hidden = setRailHidden(start, 'gems', true);
  assert.deepEqual(hidden.filter((s) => s.hidden).map((s) => s.key), ['gems']);
  assert.ok(start.every((s) => !s.hidden), 'the arrangement it was given is not changed');
  // The default arrangement is stored as nothing, so a rail added later lands in its own place; anything else whole.
  assert.equal(railsSetting(start, D), null);
  assert.equal(railsSetting(setRailHidden(hidden, 'gems', false), D), null, 'putting everything back is "never chose"');
  const moved = moveRail(hidden, 'top10', -1);
  assert.deepEqual(railsSetting(moved, D), { order: keysOf(moved), hidden: ['gems'] });
  // A round trip through the stored form is the same arrangement.
  assert.deepEqual(orderRails(railsSetting(moved, D), D), moved);
  assert.deepEqual(shownRails(railsSetting(moved, D), D), keysOf(moved).filter((k) => k !== 'gems'));
});

test('Home draws its rails by key, in the reader\'s order, and a hidden rail asks for nothing', () => {
  const home = code(read('app/page.tsx'));
  assert.match(home, /const shown = shownRails\(user\?\.settings\?\.homeRails, HOME_RAIL_KEYS\);/);
  assert.match(home, /\{shown\.map\(\(k\) => <Fragment key=\{k\}>\{rail\(k\)\}<\/Fragment>\)\}/, 'the rails are not drawn in the reader\'s order');
  // Reintroduce a rail drawn outside the switch: it shows whatever the reader chose.
  for (const s of ["tr('Keep reading')}</SectionTitle>", "tr('Top 10 in your library')}</SectionTitle>", '<CollectionRails />']) {
    const at = home.indexOf(s);
    assert.ok(at > home.indexOf('const rail = (key: HomeRailKey)') && at < home.indexOf('return (\n    <PullToRefresh'), `${s} is drawn outside the rails' switch`);
  }
  // The three rails with a request of their own: hidden, the request is not made.
  assert.match(home, /queryKey: \['foryou'\][^\n]*enabled: on\('forYou'\) \}\);/);
  assert.match(home, /queryKey: \['trending'\][^\n]*enabled: on\('top10'\) \}\);/);
  assert.match(home, /enabled: !!seed\?\.id && on\('because'\),/);
  // Whichever rail is first sits closer to the greeting, as Keep reading always did.
  assert.match(home, /<div className="\[&>section:first-child\]:pt-4">/);
  assert.doesNotMatch(home.slice(home.indexOf('const rail ='), home.indexOf('return (\n    <PullToRefresh')), /<section className="pt-4"/,
    'one rail still says pt-4 for itself, wherever it is moved');
  // The key is on the greeting's line, beside the 18+ reveal.
  assert.match(home, /<AdultToggle className="shrink-0" alsoWhen=\{adultFilter\} \/>\s*<HomeCustomize \/>/);
});

test('the Customize sheet: one place for rails, the Lists page still the one place for lists', () => {
  const src = code(read('components/HomeCustomize.tsx'));
  // A Sheet (its own dialog layer, Escape, and the data-lenis-prevent scroller), clear of the phone's bottom bar.
  assert.match(src, /<Sheet title=\{tr\('Customize Home'\)\} onClose=\{onClose\} overBottomNav/);
  // Squared keys, never a capsule: the opening key, the move keys, Reset and Done.
  assert.match(src, /className="btn-key" data-home-customize>/);
  assert.match(src, /aria-label=\{tr\('Move up'\)\} aria-describedby=\{id\}\s*className="btn-key w-8 px-0"/);
  assert.match(src, /aria-label=\{tr\('Move down'\)\} aria-describedby=\{id\}\s*className="btn-key w-8 px-0"/);
  assert.doesNotMatch(src, /rounded-full/);
  // Saved as `homeRails` on the account, and NOTHING else: reintroduce a list picker here that writes homeCollections
  // and Home has two places that choose its lists.
  assert.match(src, /api\('\/api\/settings', \{ method: 'PUT', json: \{ homeRails: want \} \}\)/);
  assert.doesNotMatch(src, /homeCollections:/, 'the sheet writes the Lists page\'s choice');
  assert.match(src, /<Link href="\/collections" onClick=\{onClose\} className="shrink-0 text-accent" data-home-rails-lists>\{tr\('Choose lists'\)\}<\/Link>/);
  // The lists rail has no switch: reintroduce one and a hidden lists rail sits beside a Lists page saying "Home 1".
  assert.match(src, /\{lists \? <span aria-hidden className="w-12 shrink-0" \/> : <Switch on=\{!slot\.hidden\} onChange=\{onShow\} label=\{label\} \/>\}/);
  // One request at a time, always the newest; a refusal puts back what the server last accepted.
  assert.match(src, /q\.next = \{ v \};\s*if \(q\.busy\) return;/, 'a second change starts a second request beside the first');
  assert.match(src, /catch \{\s*q\.next = undefined;\s*setSettings\(\{ homeRails: q\.good \}\);\s*toast\(tr\('Could not save'\), 'error'\);/);
  // Reset stores nothing, the default.
  assert.match(src, /onClick=\{\(\) => change\(orderRails\(null, HOME_RAIL_KEYS\)\)\} disabled=\{plain\}/);
});

test('the account keeps homeRails: the settings PUT stores any key a newer client writes', () => {
  // No bff change for this: PUT /api/settings validates the keys that steer a query or name a row and merges the rest
  // (`app_settings.data || EXCLUDED.data`). If that ever narrows to a list of known keys, homeRails stops saving.
  const route = read('../bff/src/routes/personal.ts');
  assert.match(route, /const body = settingsBody\.safeParse\(req\.body \?\? \{\}\);/);
  // The schema lives in lib/accountSettings.ts. Still a free-form record -- only its two boolean account switches
  // are refined -- so a key a newer client writes (homeRails, tone) is still kept.
  assert.match(read('../bff/src/lib/accountSettings.ts'), /z\.record\(z\.string\(\), z\.any\(\)\)\.superRefine\(/);
  assert.match(route, /ON CONFLICT \(user_id\) DO UPDATE SET data = app_settings\.data \|\| EXCLUDED\.data/);
});
