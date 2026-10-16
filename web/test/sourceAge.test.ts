// A whole source's age rating on its sheet (v0.73.0, #256 from @Squeaks72): two choices, Automatic and Adult only, and
// nothing that rates a source below its extension's flag. The server half -- the permission and its by-id refusals --
// is bff/test/sourceAdultRating.int.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGE_CHOICES, ageChoice, ageRequest, ageWhy } from '../lib/sourceAge';

test('two choices, and the lit one follows the admin rating alone', () => {
  // Reintroduce the contributor's Mixed (a 0 that cancelled an extension's adult flag): the first match fails.
  assert.deepEqual([...AGE_CHOICES], ['default', 'adult']);
  assert.equal(ageChoice({ ageRating: null, defaultAgeRating: 18 }), 'default', "the extension's flag is not the admin's choice");
  assert.equal(ageChoice({ ageRating: 18, defaultAgeRating: null }), 'adult');
  assert.equal(ageChoice({}), 'default', 'an older server, which sends neither field');
});

test('the sentence says why the source is what it is', () => {
  assert.equal(ageWhy({ ageRating: 18, defaultAgeRating: 18 }), 'rated');
  assert.equal(ageWhy({ ageRating: null, defaultAgeRating: 18 }), 'flagged', 'a flagged source is adult with Automatic too');
  assert.equal(ageWhy({ ageRating: null, defaultAgeRating: null }), 'open');
});

test('a choice becomes the body of the PUT: 18 or null, never 0', () => {
  assert.deepEqual(ageRequest('adult'), { ageRating: 18 });
  assert.deepEqual(ageRequest('default'), { ageRating: null });
});

test('the sheet offers it on every source and sends it to the age-rating route, as squared keys', () => {
  // On every kind of source (`{s && (`), built-in and added sites included: they are the ones whose extension can never
  // say. Reintroduce a kind test around the section, or a round chip group (Segmented without `square`): it fails.
  const src = readFileSync(join(__dirname, '..', 'components', 'SourceSheet.tsx'), 'utf8');
  assert.match(src, /\{s && \(\n\s+<section aria-label=\{tr\('Age rating'\)\}/, 'the age rating is not offered on every source');
  assert.match(src, /<Segmented<AgeChoice> square label=\{tr\('Age rating'\)\}/);
  assert.match(src, /\/age-rating`, \{ method: 'PUT', json: ageRequest\(c\) \}\)/);
});
