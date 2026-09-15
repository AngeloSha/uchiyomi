// Which sources actually get fetched for the Discover wall, and in what order.
//
// This file used to also cover language grouping: which sources landed in which language chip, and how the
// chips were counted. That whole dimension is gone. It was the trigger for a stall -- switching chip mid-load
// left the page counting sources it had just forgotten, so its skeleton tiles never resolved and infinite
// scroll died for the session -- and thrashing the chips fired abandoned scrapes that each cost the server a
// full eight-second budget and then wrote a five-to-thirty-minute cooldown against the source.
//
// The ranking survived, because ranking was the half that earned its keep.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { budgetFor, budgetForMode, noteFor, retryIn, aloneEmpty, iconTint, Src } from '../lib/sourceGroups';

const src = (p: Partial<Src> & { id: string }): Src =>
  ({ name: p.id, lang: null, latest: true, status: 'ok', ...p }) as Src;

test('the budget prefers healthy sources, then what the library actually came from', () => {
  // In the order the server actually returns them, which resolves alphabetically -- so only the `used`
  // comparator can lift Aqua Manga above "18 Porn Comic". A pool that already listed Aqua first would pass
  // with the ranking removed entirely, because Array.sort is stable.
  const pool = [
    src({ id: 'porn18', name: '18 Porn Comic', used: 0 }),
    src({ id: 'blocked', name: 'Blocked', status: 'blocked', used: 500 }),
    src({ id: 'aqua', name: 'Aqua Manga', used: 176 }),
    src({ id: 'off', name: 'Off', status: 'disabled', used: 999 }),
    src({ id: 'universal', name: 'Universal', used: 0 }),
  ];

  // A blocked source is a guaranteed timeout for a guaranteed nothing, so it sorts last however popular it
  // is -- which at a realistic budget means it is not fetched at all. A disabled one is never fetched.
  assert.deepEqual(
    budgetFor(pool, 9).map((s) => s.id),
    ['aqua', 'porn18', 'universal', 'blocked'],
    'a disabled source was fetched, or the ordering is wrong',
  );

  const three = budgetFor(pool, 3).map((s) => s.id);
  assert.equal(three[0], 'aqua', 'the most-used source was not fetched first');
  assert.equal(three.includes('blocked'), false, 'a blocked source displaced a healthy one');
});

test('THE REGRESSION: a source the reader actually uses outranks one they never have', () => {
  // Measured on production. With "declares the chosen language" ranked above "the library came from it", the
  // English chip fetched five adult extension sources and MangaDex, while Aqua Manga -- 189 of that library's
  // 214 series -- was never among the six, because it declared no language at all. The language half is gone
  // now, but `used` is still what has to win, and this pins it.
  const picked = budgetFor([
    src({ id: 'other-1', name: 'Other One', used: 0 }),
    src({ id: 'other-2', name: 'Other Two', used: 0 }),
    src({ id: 'aqua', name: 'Aqua Manga', used: 189 }),
  ], 2).map((s) => s.id);
  assert.equal(picked[0], 'aqua', 'the source with the whole library behind it was not fetched first');
});

test('a source that cannot browse newest is never budgeted', () => {
  assert.deepEqual(
    budgetFor([src({ id: 'no-latest', latest: false }), src({ id: 'yes' })]).map((s) => s.id),
    ['yes'],
  );
});

test('THE STALL: resetting the wall must remount its children, or settled counts go stale', () => {
  // The bug this page was fixed for. `SourceLatest` reports "I have settled" from an effect, so it only fires
  // when its query state changes identity. A source present both before and after a wall reset kept its React
  // key, so it never unmounted; its cached query kept the same `data`, so the effect never re-ran; and the
  // parent had just cleared the bookkeeping. `settled` could then never reach `budget.length`, which is what
  // put skeleton tiles on screen that never resolved.
  //
  // Static guard rather than a render test: the invariant is "if the parent clears settle state, the child
  // key must change too", and today the parent simply never clears it.
  const page = readFileSync(join(__dirname, '..', 'app', 'discover', 'page.tsx'), 'utf8');
  const clears = /setOrder\(\[\]\)|setStates\(\{\}\)|setById\(\{\}\)/.test(page);
  if (clears) {
    const key = page.match(/<SourceLatest[^>]*key=\{`([^`]+)`\}/)?.[1] ?? '';
    assert.ok(
      /gen|reset|lang|nonce/.test(key),
      `the wall clears its settle state but SourceLatest's key is \`${key}\` -- a source that survives the ` +
      'reset will keep its cached query, never re-report, and the wall will count it as never settled',
    );
  }
});

test('the wall consumes the abort signal, so abandoning a source does not cost a cooldown', () => {
  // Without reading react-query's signal, removeObserver takes its non-aborting branch: a source dropped from
  // the wall keeps scraping, the server spends its full budget on an answer nobody reads, and the resulting
  // timeout writes a multi-minute cooldown against that source. Abandoning a request made the wall worse.
  const picker = readFileSync(join(__dirname, '..', 'components', 'SourcePicker.tsx'), 'utf8');
  // Slice forward from queryFn, not to the first `enabled,` -- that matches the prop destructuring higher up
  // in the file, which made this slice run backwards and come back empty.
  const start = picker.indexOf('queryFn:');
  assert.ok(start > 0, 'SourceLatest no longer has a queryFn');
  const fn = picker.slice(start, start + 400);
  assert.match(fn, /\(\s*\{\s*signal\s*\}\s*\)\s*=>/, "queryFn does not accept react-query's signal");
  // Two mentions: once destructured from the context, once handed to api(). A regex trying to span the
  // argument list cannot -- the URL contains its own parentheses -- and a version that tried matched
  // nothing either way, which is a guard that tests nothing.
  const mentions = (fn.match(/signal/g) ?? []).length;
  assert.ok(mentions >= 2, `the signal is accepted but never passed through to api() (seen ${mentions}x)`);
});

test('THE REPORTED BUG: a broken source must not look like a quiet one', () => {
  // What prompted all of this: on Discover, "answered with nothing" and "is broken and could not answer"
  // were the same grey dot. Four of ten sources on a real install sat broken for weeks looking exactly like
  // sources that simply had no new chapters.
  //
  // Reintroduce by having `noteFor` return the same dot for `empty` whether or not a note is present.
  const broken = src({ id: 'broken', note: 'This source is blocking this server right now.' });
  const quiet = src({ id: 'quiet' });

  assert.equal(noteFor(broken, 'empty').dot, 'warn', 'a source with a reason must stand out');
  assert.equal(noteFor(quiet, 'empty').dot, 'quiet', 'a source with nothing new must not raise an alarm');
  assert.notEqual(noteFor(broken, 'empty').dot, noteFor(quiet, 'empty').dot);
  assert.equal(noteFor(broken, 'empty').note, broken.note);
  assert.equal(noteFor(quiet, 'empty').note, null);
});

test('a healthy or unasked source says nothing', () => {
  assert.deepEqual(noteFor(src({ id: 'a' }), 'ok'), { dot: 'ok', note: null });
  assert.deepEqual(noteFor(src({ id: 'a' }), 'idle'), { dot: 'idle', note: null });
});

test('a source that answers with nothing sorts below one that works', () => {
  // `quiet` is the server naming a state that used to be unrepresentable: no error was ever thrown, so no
  // cooldown was earned, so `status` stayed 'ok' and the wall kept fetching it first for weeks.
  //
  // Reintroduce by narrowing budgetFor's comparator from `status !== 'ok'` to `status === 'blocked'`:
  // 'quiet' then ties with healthy and its much larger `used` count lifts it back to the front.
  const picked = budgetFor([
    src({ id: 'drifted', status: 'quiet', used: 500 }),
    src({ id: 'works', used: 10 }),
  ], 2).map((x) => x.id);
  assert.deepEqual(picked, ['works', 'drifted'], 'a source that returns nothing was fetched first');
});

test('the cooldown is reported as a wait, not a timestamp', () => {
  const now = Date.parse('2026-08-27T09:00:00Z');
  assert.equal(retryIn(src({ id: 'a', blockedUntil: '2026-08-27T09:12:00Z' }), now), 'back in ~12 min');
  assert.equal(retryIn(src({ id: 'a', blockedUntil: '2026-08-27T08:50:00Z' }), now), null, 'an expired block is not a wait');
  assert.equal(retryIn(src({ id: 'a' }), now), null);
});

test('a source that cannot rank its own titles is not asked to', () => {
  // Popular is the source's OWN ranking, so a source without one has nothing to contribute and is dropped
  // entirely -- exactly as one without `latest` already is. Showing a chip that can never fill would be
  // worse than showing one chip fewer.
  //
  // Reintroduce by ignoring the mode in budgetForMode: 'no-pop' comes back and its column stays empty.
  const pool = [src({ id: 'both', popular: true, used: 5 }), src({ id: 'no-pop', used: 99 })];
  assert.deepEqual(budgetForMode(pool, 'newest', 9).map((s) => s.id), ['no-pop', 'both'], 'newest takes both');
  assert.deepEqual(budgetForMode(pool, 'popular', 9).map((s) => s.id), ['both'], 'popular takes only the one that can');
});

test('THE NAMESPACING: switching listing must remount the children', () => {
  // The wall keys everything by `${listMode}:${sourceId}` so the toggle never has to CLEAR anything -- and
  // clearing is the only thing that has ever broken this page. But the two halves are a pair: if the key
  // does not also change, a source present in both listings keeps its React key, keeps its cached query,
  // never re-reports, and the wall waits forever on a source it believes it has not heard from.
  //
  // Reintroduce by dropping `${listMode}` from SourceLatest's key.
  const page = readFileSync(join(__dirname, '..', 'app', 'discover', 'page.tsx'), 'utf8');
  const key = page.match(/<SourceLatest[^>]*key=\{`([^`]+)`\}/)?.[1] ?? '';
  assert.ok(key.includes('listMode'), `SourceLatest's key is \`${key}\` and does not carry the listing mode`);
});

test('filtering shows less, it never loads less', () => {
  // Tapping a chip is display-only: every budgeted source keeps loading and nothing is discarded, which is
  // what makes it instant and what keeps it from stranding the wall. If it ever starts clearing state, the
  // guard above about remounting applies to it too.
  //
  // Reintroduce by clearing byId/order/states when a source is selected.
  const page = readFileSync(join(__dirname, '..', 'app', 'discover', 'page.tsx'), 'utf8');
  assert.doesNotMatch(page, /setOrder\(\[\]\)|setStates\(\{\}\)|setById\(\{\}\)/,
    'the wall is being cleared somewhere; see the stall guard above');
  assert.match(page, /selected && key !== /, 'the wall no longer filters by the selected source');
});

test('a source with no icon still gets a stable, deliberate colour', () => {
  const a = iconTint('Aqua Manga');
  assert.equal(a, iconTint('Aqua Manga'), 'the tile must not change colour between renders');
  assert.notEqual(a, iconTint('MangaDex'), 'two sources should not collide on one colour');
  assert.match(a, /^linear-gradient\(/);
});

test('SourcePicker renders one chip and a sheet, not a chip wall', () => {
  // v0.34.0 replaced the wall of up to twelve source chips, plus the two note lines under it, with ONE chip
  // ("All sources · 8 sources · 1 with issues") and a sheet behind it. On a phone the wall was more words
  // than the covers it introduced, which is what the owner complained about; the sheet is where the health
  // and the server's reason went.
  //
  // Reintroduce by rendering a `<button` per source again inside SourcePicker (`{shown.map((s) => ... <button`,
  // `{shown.map((s, i) => ... <button` or `{ranked.slice(0, 12).map((s) => ... <button` -- the pattern below
  // accepts an index parameter, a slice and every name the list goes by, because the first version of this
  // guard took only `shown.map((s) =>` and a map with an index, the natural way to write a keyed chip row,
  // walked straight past it), by dropping `<SourceListSheet` from it, or by counting the chip from
  // `sources.length` instead of `count`.
  const picker = readFileSync(join(__dirname, '..', 'components', 'SourcePicker.tsx'), 'utf8');
  const body = picker.slice(picker.indexOf('export function SourcePicker('), picker.indexOf('export function SourceLatest('));
  assert.ok(body.length > 0, 'SourcePicker or SourceLatest is no longer exported from the file');
  assert.doesNotMatch(body, /(?:shown|sources|ranked|pool)(?:\.slice\([^)]*\))?\.map\(\s*\(\s*\w+(?:\s*,\s*\w+)?\s*\)\s*=>\s*\{?[\s\S]{0,400}?<button/,
    'SourcePicker renders a button per source again -- that is the chip wall');
  assert.match(body, /<SourceListSheet\b/, 'the list of sources no longer opens as a sheet');
  assert.match(body, /tr\('All sources'\)/, 'the one chip no longer says All sources');
  assert.match(body, /tr\('\{n\} sources', \{ n: count \}\)/, 'the chip no longer counts from the `count` prop -- it is reading its own list again');
  assert.match(body, /tr\('\{n\} with issues'/, 'the chip no longer says how many sources are unwell');
  // The parent's bookkeeping is read exactly as the chips read it. A bare id here finds nothing, and every
  // row in the sheet would sit permanently dimmed as "not asked yet".
  assert.match(body, /states\[`\$\{mode\}:\$\{id\}`\]/, 'stateOf no longer reads the mode-namespaced key');
  // The sheet lives in its own file and opens from the same page, so it must clear the bottom nav too.
  const sheet = readFileSync(join(__dirname, '..', 'components', 'SourceListSheet.tsx'), 'utf8');
  assert.match(sheet, /<Sheet[\s\S]{0,300}?overBottomNav/, 'the source sheet sits under the phone bottom nav');
  assert.match(sheet, /tr\('Tap a source to browse it alone\.'\)/, 'the sheet lost its one-line footer');
});

test('the chip counts the whole pool, and the sheet says how many of it are being asked', () => {
  // Three numbers for one pool, measured on a mocked 14-source install: 14 installed, "12 sources" on the
  // chip (the ranked list, which is capped at twelve as a FETCH budget) and nine rows in the sheet (the
  // budget, six widening to ten). The cap is not a fact about the install, and "12 sources" under a chip
  // labelled "All sources" on the owner's 14-source server is simply false. The chip now counts every
  // source that can answer this listing and is not disabled -- the uncapped `budgetForMode` -- and the
  // sheet's footer names both numbers ("Asking 9 of 14") so the two surfaces agree.
  //
  // Reintroduce by passing `count={ranked.length}` (or `budget.length`) from the page, by giving the pool a
  // finite cap, or by dropping `total` / the "Asking {n} of {m}" footer from SourceListSheet.
  const fourteen = Array.from({ length: 14 }, (_, i) => src({ id: `s${i}`, popular: i % 2 === 0, used: 14 - i }));
  assert.equal(budgetForMode(fourteen, 'newest', Infinity).length, 14, 'an uncapped pool does not count every source');
  assert.equal(budgetForMode(fourteen, 'popular', Infinity).length, 7, 'the pool for Popular counts a source that cannot rank');
  assert.equal(budgetForMode([...fourteen, src({ id: 'off', status: 'disabled' })], 'newest', Infinity).length, 14,
    'a disabled source is counted on the chip');

  const page = readFileSync(join(__dirname, '..', 'app', 'discover', 'page.tsx'), 'utf8');
  assert.match(page, /const pool = useMemo\(\(\) => budgetForMode\(sources, listMode, Infinity\)/,
    'the page no longer computes an uncapped pool');
  assert.match(page, /<SourcePicker[\s\S]{0,600}?count=\{pool\.length\}/,
    'the chip is not counted from the pool -- it will read the fetch cap or the growing budget again');
  const picker = readFileSync(join(__dirname, '..', 'components', 'SourcePicker.tsx'), 'utf8');
  assert.match(picker, /<SourceListSheet[^>]*total=\{count\}/, 'the sheet is not told the pool size');
  const sheet = readFileSync(join(__dirname, '..', 'components', 'SourceListSheet.tsx'), 'utf8');
  assert.match(sheet, /tr\('Asking \{n\} of \{m\} · tap a source to browse it alone', \{ n: sources\.length, m: total \}\)/,
    'the sheet footer no longer reconciles its row count with the chip');
});

test('every amber dot has a sentence, and the chip counts the dots', () => {
  // A request that FAILED with no server note -- a 429 written this minute has a cooldown but no note yet --
  // lit an amber dot in the sheet with nothing under it, and the chip's "{n} with issues" counted sentences,
  // so it said 2 while three rows glowed (measured: Weeb Central answering 429 without a note). The default
  // sentence is what makes the dot and the count agree.
  //
  // Reintroduce by returning `src.note ?? null` for `blocked` in noteFor, or by counting `.note` instead of
  // `.dot === 'warn'` in SourcePicker.
  const mute = src({ id: 'weeb', name: 'Weeb Central' });
  assert.deepEqual(noteFor(mute, 'blocked'), { dot: 'warn', note: 'Could not be reached right now.' },
    'a failure without a server note lights an amber dot with no sentence');
  const told = src({ id: 'kakalot', note: 'Rate-limited by the site; the wall will retry on its own.' });
  assert.equal(noteFor(told, 'blocked').note, told.note, "the server's own sentence must win over the default");
  // The default is for a FAILURE only: a source that answered with nothing and no note is quiet, not broken.
  assert.equal(noteFor(mute, 'empty').note, null);

  const picker = readFileSync(join(__dirname, '..', 'components', 'SourcePicker.tsx'), 'utf8');
  assert.match(picker, /const troubled = shown\.filter\(\(s\) => noteFor\(s, stateOf\(s\.id\)\)\.dot === 'warn'\)\.length/,
    'the chip counts something other than the amber dots the sheet lights');
});

test('one source browsed alone says its own reason, not "nothing new"', () => {
  // Before v0.34.0 the two note lines under the chip wall carried "Rate-limited … · back in ~12 min" on the
  // page. Those lines moved into the sheet, and browsing that source alone then read "Nothing new from these
  // sources right now" while the sheet, one tap away, said why. The empty card for a selected source now
  // says what its sheet row says, and `warn` is the page's cue to paint it amber.
  //
  // Reintroduce by having aloneEmpty ignore `noteFor` (always the quiet sentence), or by dropping the
  // `alone ? alone.text` branch from the empty card on the Discover page.
  const now = Date.parse('2026-09-15T09:00:00Z');
  const limited = src({ id: 'kakalot', note: 'Rate-limited by the site; the wall will retry on its own.', blockedUntil: '2026-09-15T09:12:00Z' });
  assert.deepEqual(aloneEmpty(limited, 'blocked', now),
    { text: 'Rate-limited by the site; the wall will retry on its own. · back in ~12 min', warn: true },
    'the selected source lost its reason and wait');
  // A failure with no note and no cooldown still reads as a failure -- via noteFor's default sentence today,
  // and via the reached-nothing branch should that default ever go.
  const mute = aloneEmpty(src({ id: 'weeb' }), 'blocked', now);
  assert.ok(mute.warn && mute.text !== 'Nothing new from these sources right now.',
    'a request that did not succeed reads as "nothing new"');
  // Answered empty WITH a note: the note, amber, no wait line because there is no cooldown.
  assert.deepEqual(aloneEmpty(src({ id: 'asura', note: 'The site answered but listed nothing; its layout may have changed.' }), 'empty', now),
    { text: 'The site answered but listed nothing; its layout may have changed.', warn: true });
  // Answered empty with nothing wrong: only now the quiet sentence, in the quiet colour.
  assert.deepEqual(aloneEmpty(src({ id: 'quiet' }), 'empty', now), { text: 'Nothing new from these sources right now.', warn: false });

  const page = readFileSync(join(__dirname, '..', 'app', 'discover', 'page.tsx'), 'utf8');
  assert.match(page, /aloneEmpty\(budget\.find\(\(s\) => s\.id === selected\)/, 'the page no longer asks aloneEmpty about the selected source');
  assert.match(page, /: alone \? alone\.text\s*\n?\s*: Object\.values\(states\)\.every/,
    'the empty card no longer puts the selected source\'s own sentence before the sentence about the whole wall');
  assert.match(page, /alone\?\.warn \? 'text-amber-300'/, 'the selected source\'s reason is not painted amber');
});

test('the explainer\'s Fetch-vs-Save line flows as one sentence at phone width', () => {
  // Each icon+sentence was an `inline-flex` span, and at 390px a span that does not fit the line wraps as one
  // block: the cloud floated centred beside two lines of text with "everyone." orphaned under an indent
  // (measured in the explainer opened from the Sources sheet). An inline-block icon sits in the line like a
  // letter and the sentence wraps like a sentence.
  //
  // Reintroduce by wrapping either icon and its sentence in `<span className="inline-flex …">` again.
  // Comments stripped first: the one above this <dd> quotes the `inline-flex` it forbids, to say what went wrong.
  const file = readFileSync(join(__dirname, '..', 'components', 'SourcesExplainer.tsx'), 'utf8').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
  const start = file.indexOf("tr('Fetch vs Save offline')");
  assert.ok(start > 0, 'the explainer lost its Fetch vs Save offline term');
  const dd = file.slice(start, file.indexOf('</dd>', start));
  assert.ok(dd.includes("tr('Save offline copies it to this device.')"), 'the Fetch-vs-Save definition is no longer one <dd>');
  assert.doesNotMatch(dd, /inline-flex/, 'an icon and its sentence are boxed together again, so they wrap as a block');
  for (const icon of ['IcCloudDownload', 'IcDownload']) {
    assert.match(dd, new RegExp(`<${icon}[^>]*className="[^"]*\\binline-block\\b[^"]*\\balign-text-bottom\\b`),
      `${icon} is not an inline-block icon sitting in the line`);
  }
});

test('the Providers (i) in Admin is a finger-sized target', () => {
  // The (i) beside "Add a site" measured 20 x 20 px at 390 px, a quarter of the 32-px (i) one tap away in
  // the Sources sheet. It keeps the eyebrow row 20 px tall with negative vertical margins so the label
  // does not drop. Reintroduce by writing `h-5 w-5` on it again, or by dropping the `-my-1.5`.
  const file = readFileSync(join(__dirname, '..', 'app', 'admin', 'page.tsx'), 'utf8');
  // The opening tag spans two lines and its onClick holds a `=>`, so "up to the next >" is not the tag:
  // take everything from `<button` to the icon it wraps.
  const at = file.indexOf("aria-label={tr('What are sources and extensions?')}");
  assert.ok(at > 0, 'the Admin → Providers (i) is gone');
  const btn = file.slice(file.lastIndexOf('<button', at), file.indexOf('<IcInfo', at));
  assert.match(btn, /\bh-8 w-8\b/, 'the (i) is smaller than the 32-px target the sheets give it');
  assert.match(btn, /-my-1\.5\b/, 'the (i) will change the eyebrow height without the negative margins');
});

test('the locale polish holds: one Arabic word for a translation group, German plural agreement', () => {
  // The v0.34.0 keys alternated between مجموعة and فريق for the same English "group" in Arabic; the
  // pre-existing keys ("فرق الترجمة") say فريق, so the explainer's Translated-by paragraph and the patience
  // helper were moved to it. In German the patience helper had a plural verb on a singular noun
  // ("Leseposition … können"). Reintroduce by writing either wording back.
  const dir = join(__dirname, '..', 'public', 'locales');
  const ar = JSON.parse(readFileSync(join(dir, 'ar.json'), 'utf8'));
  for (const key of [
    'The fan group that translated a chapter. A chapter often has several versions; the server keeps one, taking a preferred group first, never a blocked one, and waiting for a preferred group for the patience you set.',
    'Preferred groups are taken first, blocked groups never. New chapters wait for a preferred group for the patience below.',
    'A site added by pasting its address. Uchiyomi reads it with its built-in reader, so it cannot say which group translated a chapter.',
  ]) {
    assert.ok(key in ar, `ar.json lost "${key.slice(0, 40)}…"`);
    assert.doesNotMatch(ar[key], /مجموع/, `ar.json says مجموعة for a translation group in "${key.slice(0, 40)}…"; the rest of the file says فريق`);
    assert.match(ar[key], /فريق|فرق/, `ar.json names no group at all in "${key.slice(0, 40)}…"`);
  }
  const de = JSON.parse(readFileSync(join(dir, 'de.json'), 'utf8'));
  const patience = 'Each file is replaced with the copy the translation rules choose now. A different group’s copy may have a different page count, so reading positions inside the chapter may shift.';
  assert.ok(patience in de, 'de.json lost the replace-copies sentence');
  assert.match(de[patience], /Lesepositionen im Kapitel verschieben können/, 'de.json has a plural verb on a singular noun again');
});

test('the cooldown wait reaches the locale files', () => {
  // `back in ~12 min` was the one hardcoded English sentence on a translated page: a template literal the
  // string extractor cannot see. Now `tr()` with a key, and the English output is unchanged (the test
  // above pins it). Reintroduce by writing the template literal back into `retryIn`.
  const lib = readFileSync(join(__dirname, '..', 'lib', 'sourceGroups.ts'), 'utf8');
  assert.match(lib, /tr\('back in ~\{n\} min', \{ n: mins \}\)/, 'retryIn no longer translates its sentence');
  assert.doesNotMatch(lib, /`back in ~\$\{mins\} min`/, 'retryIn is back to a template literal the extractor cannot see');
});
