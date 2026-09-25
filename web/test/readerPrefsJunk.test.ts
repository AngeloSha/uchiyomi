// Upgrading the repeated-pages setting without changing anyone's mind for them.
//
// `skipJunk` (a boolean) became `junkPages` (show / collapse / hide). The whole risk of that swap is that
// stored preferences do not carry the new key, and the obvious implementation — spread the defaults over
// whatever was stored — silently hands everyone the new default, including the people who had deliberately
// switched the feature OFF.
import test from 'node:test';
import assert from 'node:assert/strict';
import { migratePrefs, DEFAULT_PREFS } from '../lib/readerPrefs';

test('someone who turned skipping off stays off', () => {
  // ⚠️ The one that matters. Reintroduce by asking the MERGED object whether `junkPages` is present instead
  // of the raw one: the defaults supply 'collapse', the branch never fires, and a reader who switched this
  // off finds it back on after an update.
  assert.equal(migratePrefs({ skipJunk: false }).junkPages, 'show');
});

test('someone who had skipping on gets the new default', () => {
  assert.equal(migratePrefs({ skipJunk: true }).junkPages, 'collapse');
});

test('a device that never chose anything gets the default', () => {
  assert.equal(migratePrefs({}).junkPages, DEFAULT_PREFS.junkPages);
  assert.equal(migratePrefs(null).junkPages, DEFAULT_PREFS.junkPages);
  assert.equal(migratePrefs(undefined).junkPages, DEFAULT_PREFS.junkPages);
});

test('an explicit choice always wins over the old boolean', () => {
  assert.equal(migratePrefs({ junkPages: 'hide', skipJunk: false }).junkPages, 'hide');
});

test('the old boolean is still written, every time', () => {
  // ⚠️ Not vestigial. `/api/settings` merges the reader object SHALLOWLY, so a second device on an older
  // build PUTs a `reader` with no `junkPages` in it and the choice is gone from the row. `skipJunk` is what
  // survives that, and what the old build reads to behave sensibly meanwhile.
  // Reintroduce by dropping the derivation: an old build reads `skipJunk` as absent, gets `true` from its own
  // defaults, and hides pages from someone who explicitly chose Show all.
  assert.equal(migratePrefs({ junkPages: 'show' }).skipJunk, false);
  assert.equal(migratePrefs({ junkPages: 'collapse' }).skipJunk, true);
  assert.equal(migratePrefs({ junkPages: 'hide' }).skipJunk, true);
});

test('a value that is not one of the three falls back through the boolean', () => {
  // Reachable from a hand-edited localStorage or a settings row written by something else. Nothing else in
  // this file validates what came out of storage either, so this is the guard for all of it.
  assert.equal(migratePrefs({ junkPages: 'nonsense', skipJunk: false } as never).junkPages, 'show');
  assert.equal(migratePrefs({ junkPages: 42 } as never).junkPages, DEFAULT_PREFS.junkPages);
});

test('everything else on the object is left alone', () => {
  const out = migratePrefs({ theme: 'sepia', gap: 12, brightness: 0.5 });
  assert.equal(out.theme, 'sepia');
  assert.equal(out.gap, 12);
  assert.equal(out.brightness, 0.5);
  assert.equal(out.mode, DEFAULT_PREFS.mode, 'and missing keys still come from the defaults');
});

// `pagedDirection` (paged mode laid out as the series says, or forced either way) arrived after everyone
// already had stored settings. It follows the series by default, which leaves every left-to-right series --
// every series on the built-in library, which answers WEBTOON -- exactly as it was; only a series that says
// RIGHT_TO_LEFT changes, and a deliberate 'ltr'/'rtl' always wins.
// Reintroduce by defaulting it to 'rtl': every stored reader without the key turns its pages the other way.
test('paged mode follows the series unless overridden', () => {
  assert.equal(DEFAULT_PREFS.pagedDirection, 'series');
  assert.equal(migratePrefs({ mode: 'paged', spread: true }).pagedDirection, 'series');
  assert.equal(migratePrefs({}).pagedDirection, 'series');
  assert.equal(migratePrefs({ pagedDirection: 'rtl' }).pagedDirection, 'rtl');
  assert.equal(migratePrefs({ pagedDirection: 'ltr' }).pagedDirection, 'ltr');
  // Anything else out of storage (a typo, a future value an older build does not know) is not trusted.
  assert.equal(migratePrefs({ pagedDirection: 'sideways' as never }).pagedDirection, 'series');
});
