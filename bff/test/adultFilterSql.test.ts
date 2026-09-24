// The 18+ filter's genre list is interpolated into SQL, so its sanitiser is a security boundary.
//
// `browsable()` cannot bind parameters (25 call sites interpolate its result into queries with hand-written
// parameter arrays), so the admin-configured genre names reach SQL as literals. What keeps that safe is
// `sanitiseAdultList` -- a strict character shape, applied again at the interpolation -- plus quote
// doubling. This pins both without a database: adultFilter.int.test.ts runs the same values through real
// Postgres.
//
// Reintroduce by dropping the `sanitiseAdultList(...)` call inside `browsable()`: "a hand-built context
// cannot smuggle a value past the sanitiser" fails. By dropping the `''` doubling in `sqlLiterals`: "an
// apostrophe is doubled" fails.
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

test('sanitiseAdultList keeps real genre names and drops anything that could escape a literal', () => {
  assert.deepEqual(
    V.sanitiseAdultList(['Ecchi', ' Sci-Fi ', "Boys' Love", 'Shoujo Ai (GL)', '4-Koma', 'Ecchi', 'エッチ', 'sw:1234']),
    ['ecchi', 'sci-fi', "boys' love", 'shoujo ai (gl)', '4-koma', 'エッチ', 'sw:1234'],
  );
  for (const bad of ['a;b', 'x = 1', '$1', '$$x$$', 'back\\slash', 'nul\u0000', 'line\nbreak', 'a"b', 'line\u2028sep', 'x'.repeat(61), '', '   ']) {
    assert.deepEqual(V.sanitiseAdultList([bad]), [], `kept ${JSON.stringify(bad)}`);
  }
  // Only arrays of strings (or numbers) count; anything else is an empty list, not a crash.
  for (const notList of [null, undefined, 'ecchi', { 0: 'ecchi' }, 42]) assert.deepEqual(V.sanitiseAdultList(notList), []);
  assert.deepEqual(V.sanitiseAdultList([{ toString: () => "x'); DROP TABLE t; --" }, ['nested']]), []);
});

test('browsable() adds no genre clause, and binds nothing, when no genre is named', () => {
  const p = new V.Params();
  const sql = V.browsable('s', ctx([]), p);
  assert.doesNotMatch(sql, /g_ad/);
  assert.deepEqual(p.values, [], 'browsable() bound a parameter, which its 25 call sites cannot carry');
});

test('an apostrophe is doubled, so a legitimate name stays one literal', () => {
  const p = new V.Params();
  const sql = V.browsable('s', ctx(["boys' love"]), p);
  assert.match(sql, /IN \('boys'' love'\)/);
  assert.deepEqual(p.values, []);
});

test('a hand-built context cannot smuggle a value past the sanitiser', () => {
  // `viewCtxFor` sanitises on load, but ViewCtx is a plain interface: the check has to hold at the one
  // place the value meets SQL, not only at the place it usually comes from.
  const hostile = ["x') OR true --", "'; DROP TABLE lib_series; --", 'e\\\' OR 1=1 --', '$1'];
  const sql = V.browsable('s', ctx([...hostile, 'ecchi']), new V.Params());
  const inList = sql.slice(sql.indexOf('IN (') + 4, sql.indexOf(')\n', sql.indexOf('IN (')));
  // The first value is made only of allowed characters, so it survives -- as ONE literal with its quote
  // doubled. The `;`, `=`, `$` and backslash ones never arrive at all.
  assert.equal(inList, "'x'') or true --', 'ecchi'");
  // And, whatever the list holds, every quote in it is a delimiter or a doubled pair inside a literal.
  assert.equal(inList.replace(/'(?:[^']|'')*'/g, '').replace(/[\s,]/g, ''), '', `stray SQL in the IN list: ${inList}`);
});

test('the reveal switches the genre clause off entirely', () => {
  assert.doesNotMatch(V.browsable('s', ctx(['ecchi'], { hideAdultLibraries: false }), new V.Params()), /g_ad/);
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
