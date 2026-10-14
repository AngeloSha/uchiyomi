// The wrong-language notice (v0.62.0, components/LanguageNotice.tsx): its words, from GET /api/series/:id/versions
// `otherLanguage`, and where the series page mounts it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';

import { otherLanguageWords } from '../lib/versions';

test('the notice counts the chapters, names their languages and the series\'', () => {
  const many = otherLanguageWords({ series: 'en', langs: ['es-419', 'pt-BR'], bookIds: ['a', 'b', 'c'] });
  assert.match(many.heading, /^3 chapters here are in Latin American Spanish and Brazilian Portuguese$/);
  assert.match(many.body, /The series is in English, and each of them has come out in English too\./);
  assert.equal(many.key, 'Fetch them again in English');
  // One chapter is "it", in the singular.
  const one = otherLanguageWords({ series: 'en', langs: ['es'], bookIds: ['a'] });
  assert.equal(one.heading, '1 chapter here is in Spanish');
  assert.equal(one.key, 'Fetch it again in English');
});

test('the series page shows the notice to an admin, above the chapter list, and fetches again in chunks', () => {
  const page = readFileSync(join(__dirname, '..', 'app/series/page.tsx'), 'utf8');
  // An admin's: the refetch route is admin-only, and a member could only read about chapters they cannot fix.
  // Reintroduce by dropping `isAdmin &&`: a member gets a key that answers 403.
  assert.match(page, /\{isAdmin && <LanguageNotice notice=\{versionsData\?\.otherLanguage\} busy=\{acting \|\| !!started\} onFetch=\{\(ids\) => void refetchMany\(ids\)\} \/>\}/);
  const chapters = page.slice(page.indexOf('const Chapters = ('));
  assert.ok(chapters.indexOf('<LanguageNotice') >= 0 && chapters.indexOf('<LanguageNotice') < chapters.indexOf("{tr('Chapters')}"),
    'the notice is not above the chapter list');
});
