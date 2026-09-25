// Discover's half of the "Show 18+" chip (v0.42.0, issue #64), read from source like wall.test.ts.
//
// The server now hides adult PROVIDERS from Discover's listings, not just 18+ libraries from the library.
// That filter needs an off switch on the one screen it changes, and three client rules make it one rather
// than a trapdoor. None of them can be seen in a unit test of a function, because each is a decision about
// where a component is mounted and what it is mounted with, so each is asserted against the page's text and
// each names the edit that puts the bug back.
//
//  1. The chip must stay mounted while the reveal is ON. `hiddenAdult` is 0 once nothing is hidden, so a
//     chip rendered on `hiddenAdult > 0` alone would vanish the moment it was pressed and strand the
//     session with adult sources showing and no way to hide them again.
//  2. It must be anchored where searching does not unmount it. SourcePicker — the obvious home, it is the
//     chip row — is mounted only while `mode === 'newest'`, and the cross-source search is one of the
//     surfaces the reveal changes.
//  3. The ADMIN console must not inherit the hide. Providers is where a source is tested, unblocked or
//     switched off, and an admin cannot act on a row that is not on the page; on the install this was
//     written against twelve of fourteen sources are adult.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
/** The file with its comments removed -- the comments below quote the code they forbid. */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

test('the reveal chip stays on screen while the reveal is on', () => {
  // Reintroduce by writing `const showAdultChip = (sourcesData?.hiddenAdult ?? 0) > 0;`: the first
  // assertion fails, because with the reveal on the server hides nothing and the chip would disappear.
  const page = code(read('app/discover/page.tsx'));
  assert.match(page, /const showAdultChip = adultOn \|\| \(sourcesData\?\.hiddenAdult \?\? 0\) > 0;/,
    'the chip no longer stays mounted while the reveal is on, so pressing it strands the session');
  assert.match(page, /const adultOn = useAdultShown\(\);/, 'the page no longer knows whether the reveal is on');
  assert.match(page, /api<\{ content: Src\[\]; hiddenAdult\?: number \}>\('\/api\/sources'\)/,
    'the /api/sources type no longer carries hiddenAdult, so the chip has nothing to appear for');
});

test('the chip is anchored where a search cannot unmount it', () => {
  // Reintroduce by moving `<AdultToggle .../>` into the SourcePicker chip row: the header is the one place
  // that is the same in both modes, and the picker's row is a browse control whose mounting has changed
  // before. SourcePicker used to be newest-only, which is why this anchor exists; it now stays mounted
  // while searching too, because a search made with a source chosen is narrowed to that source and the
  // picker is where that filter is shown and cleared. Reintroduce the old gating by wrapping it in
  // `{mode === 'newest' && (...)}` again: "SourcePicker is gated on the mode" fails, and a narrowed search
  // loses the only thing on screen that says it is narrowed.
  const page = code(read('app/discover/page.tsx'));
  const header = page.slice(page.indexOf('<header'), page.indexOf('</header>'));
  assert.ok(header.includes('<AdultToggle alsoWhen={showAdultChip}'),
    'the reveal chip is not in the Discover header any more');
  assert.ok(page.includes('<SourcePicker'), 'SourcePicker is gone from Discover');
  assert.doesNotMatch(page, /mode === '(?:newest|search)'[^\n]*&& \(\s*<SourcePicker/,
    'SourcePicker is gated on the mode, so a search hides the source filter it is narrowed to');
  assert.ok(page.indexOf('<AdultToggle alsoWhen={showAdultChip}') < page.indexOf('<SourcePicker'),
    'the chip is rendered inside the picker region rather than the header');
});

test('AdultToggle renders for a second reason, and still for its first', () => {
  // Reintroduce by restoring `if (!(libs ?? []).some((l) => l.adult)) return null;`: an install with adult
  // sources and no 18+ library gets a filter with no off switch anywhere.
  const c = code(read('components/AdultToggle.tsx'));
  assert.match(c, /if \(!alsoWhen && !\(libs \?\? \[\]\)\.some\(\(l\) => l\.adult\)\) return null;/,
    'the toggle ignores alsoWhen, so Discover cannot offer the reveal without an 18+ library');
  assert.match(c, /alsoWhen = false/, 'alsoWhen no longer defaults to false, so every other render site changed meaning');
});

test('the admin console lists every source, including the ones Discover hides', () => {
  // Reintroduce by putting `queryKey: ['sources'], queryFn: () => api(\'/api/sources\')` back on either
  // admin query: the Providers tab and its count tile drop to the non-adult sources and an admin can no
  // longer test, unblock or disable the rest.
  const admin = code(read('app/admin/page.tsx'));
  assert.match(admin, /const allSourcesUrl = \(\) => \(adultShown\(\) \? '\/api\/sources' : '\/api\/sources\?adult=1'\);/,
    'the admin console no longer asks for the full source list');
  // ⚠️ Never an unconditional `?adult=1`: lib/api.ts appends its own when the reveal is on, and two copies
  // of the parameter arrive as an array, which the server reads as "not 1" -- i.e. hidden.
  assert.doesNotMatch(admin, /api<[^>]*>\('\/api\/sources\?adult=1'\)/,
    'the admin console hardcodes adult=1, which doubles the parameter once the reveal is on');
  // Its own key: `['sources']` is the browsing list several screens share, and two shapes under one key is
  // how a revealed answer gets replayed to a screen that asked for a hidden one.
  assert.equal((admin.match(/queryKey: ALL_SOURCES_KEY/g) ?? []).length, 2,
    'the two admin source queries are not both on the console key');
  assert.doesNotMatch(admin, /queryKey: \['sources'\], queryFn: \(\) => api<\{ content: any\[\] \}>\('\/api\/sources'\)/,
    'an admin source query is back on the shared browsing key');
});
