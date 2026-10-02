// The 18+ filter's genre list never reaches SQL as text.
//
// `browsable()` cannot bind parameters (25 call sites interpolate its result into queries with hand-written
// parameter arrays), and the first version of the configurable filter therefore pasted the admin's genre names
// into the query as literals, behind a strict character whitelist -- the one place in the codebase admin-entered
// data met a query string. The list now stays in the database: `browsable()` names the column and reads it with
// jsonb_array_elements_text, so no value can escape anything, the whitelist is gone (it was also rejecting real
// genres: "Boys’ Love", Thai, Devanagari), and the rule holds for a context built without the lists at all --
// which is how the notification digest builds its own.
//
// adultFilter.int.test.ts runs the clause against real Postgres. This pins the string without a database.
process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import type { ViewCtx } from '../src/lib/visibility';

// Imported after the environment is set: a static import is hoisted above the assignments, and env.ts
// validates DATABASE_URL on load. Nothing here connects -- `browsable()` only builds a string.
let V: typeof import('../src/lib/visibility');
before(async () => { V = await import('../src/lib/visibility'); });

const ctx = (adultGenres: string[], extra: Partial<ViewCtx> = {}): ViewCtx =>
  ({ ...V.SYSTEM_CTX, hideAdultLibraries: true, adultGenres, adultSources: [], ...extra });

test('no configured value ever appears in the SQL, whatever the context holds', () => {
  // Reintroduce by interpolating ctx.adultGenres into the IN list: the hostile strings appear in the query.
  const hostile = ["x') OR true --", "'; DROP TABLE lib_series; --", 'e\\\' OR 1=1 --', '$1', 'ecchi'];
  const p = new V.Params();
  const sql = V.browsable('s', ctx(hostile), p);
  for (const h of hostile) assert.ok(!sql.includes(h), `the value ${JSON.stringify(h)} reached the query`);
  assert.match(sql, /jsonb_array_elements_text\(s2_ad\.adult_genres\)/, 'the list is read from the column');
  assert.deepEqual(p.values, [], 'browsable() bound a parameter, which its 25 call sites cannot carry');
});

test('the genre rule holds for a context that carries no lists, like the digest builds', () => {
  // notify/index.ts takes a viewer's context and switches hideAdultLibraries on for a target that excludes 18+,
  // without loading the lists. With the list read in SQL, that is enough.
  const sql = V.browsable('s', ctx([]), new V.Params());
  assert.match(sql, /adult_genres/);
  assert.match(sql, /adult_exempt/, 'the per-series exemption is part of the clause');
});

test('the reveal switches the genre clause off entirely', () => {
  assert.doesNotMatch(V.browsable('s', ctx(['ecchi'], { hideAdultLibraries: false }), new V.Params()), /adult_genres/);
});

test('sanitiseAdultList keeps genres as typed, tidies them, and refuses only what is not a label', () => {
  assert.deepEqual(
    V.sanitiseAdultList(['Ecchi', ' Sci-Fi ', 'Boys’ Love', "Girls' Love", 'ecchi', 'エッチ', 'อีโรติก', 'रोमांस', '18+ (R)']),
    ['Ecchi', 'Sci-Fi', 'Boys’ Love', "Girls' Love", 'エッチ', 'อีโรติก', 'रोमांस', '18+ (R)'],
    'kept as typed, de-duplicated case-blind (the second "ecchi" goes)',
  );
  for (const bad of ['nul\u0000', 'line\nbreak', 'tab\there', 'x'.repeat(61), '', '   '])
    assert.deepEqual(V.sanitiseAdultList([bad]), [], `kept ${JSON.stringify(bad)}`);
  for (const notList of [null, undefined, 'ecchi', { 0: 'ecchi' }, 42]) assert.deepEqual(V.sanitiseAdultList(notList), []);
  assert.deepEqual(V.sanitiseAdultList([{ toString: () => 'x' }, ['nested']]), []);
});

test('sanitiseSourceIds keeps real source ids, which the genre shape used to drop', () => {
  // `_` and anything past 60 characters were lost between saving and the next read: the chip lit, then went dark.
  assert.deepEqual(
    V.sanitiseSourceIds(['aqua', 'SW:8683375824843625513', 'my_site.v2', 'a'.repeat(120), 'aqua']),
    ['aqua', 'sw:8683375824843625513', 'my_site.v2', 'a'.repeat(120)],
  );
  for (const bad of ['has space', "quo'te", 'a'.repeat(121), '', 'semi;colon'])
    assert.deepEqual(V.sanitiseSourceIds([bad]), [], `kept ${JSON.stringify(bad)}`);
});

test('sourceBrowsableFor: named sources hide only while the switch is on, case-insensitively', () => {
  const on = ctx([], { adultSources: ['sw:99'] });
  assert.equal(V.sourceBrowsableFor({ id: 'SW:99' }, on), false);
  assert.equal(V.sourceBrowsableFor({ id: 'sw:100' }, on), true);
  assert.equal(V.sourceBrowsableFor({ id: 'sw:100', isNsfw: true }, on), false, 'the extension flag stopped counting');
  assert.equal(V.sourceBrowsableFor({ id: 'sw:99' }, { ...on, hideAdultLibraries: false }), true);
  // The permission still wins over the reveal: an account capped below 18 never reaches an NSFW source.
  assert.equal(V.sourceBrowsableFor({ id: 'x', isNsfw: true }, { ...on, hideAdultLibraries: false, maxAgeRating: 16 }), false);
});

test("a series' own 18+ rating leaves the listing, without binding a parameter", () => {
  // Reintroduce by dropping the series clause from browsable(): a series rated 18+ inside an ordinary library
  // stayed on Home's Continue Reading with "Show 18+" off, because only the library's rating was checked.
  const p = new V.Params();
  const sql = V.browsable('s', ctx([]), p);
  assert.match(sql, /o_ar\.age_rating FROM series_overrides o_ar WHERE o_ar\.series_id = s\.id/, 'the override is consulted');
  assert.match(sql, /s\.age_rating, 0\) < 18/, 'and what the scan read, against the adult rating');
  assert.deepEqual(p.values, []);
  assert.doesNotMatch(V.browsable('s', ctx([], { hideAdultLibraries: false }), new V.Params()), /o_ar/, 'the reveal switches it off');
});

test('"Always show" outranks the library rating and the series rating, not just the genres', () => {
  // Reintroduce by leaving the exemption off either clause: an exempt series in an 18+ library, or rated 18+
  // itself, vanishes from the shelf despite its checkbox.
  const sql = V.browsable('s', ctx([]), new V.Params());
  const guarded = (needle: RegExp) => sql.split(/\n/).join(' ').match(needle);
  assert.ok(guarded(/o_ex0\.adult_exempt[^]*?\) OR NOT EXISTS \(\s*SELECT 1 FROM libraries l_ad/), 'library clause is exemptable');
  assert.ok(guarded(/\) OR COALESCE\(\s*\(SELECT o_ar\.age_rating/), 'series rating clause is exemptable');
  assert.match(V.browsable('s', ctx([], { maxAgeRating: 12 }), new V.Params()), /age_rating IS NULL OR|<= \$/, 'the age cap is still applied');
});

test('"Always show" also lifts the age cap for its series, and needs no second flag', () => {
  // Reintroduce by dropping the exemption from visible(): a capped account is refused a title an admin let in.
  // Or from browsable(): the title is readable by id but never appears on a shelf, since a capped account
  // always browses with the switch off.
  const capped = { maxAgeRating: 12 };
  const v = V.visible('s', ctx([], capped), new V.Params());
  assert.match(v, /o3\.adult_exempt FROM series_overrides o3 WHERE o3\.series_id = s\.id/);
  assert.match(v, /OR .*<= \$1/s, 'the cap itself is still bound');
  assert.doesNotMatch(V.visible('s', ctx([]), new V.Params()), /adult_exempt/, 'an uncapped account pays nothing');
  assert.doesNotMatch(v + V.browsable('s', ctx([], capped), new V.Params()), /age_cap_exempt/);
});
