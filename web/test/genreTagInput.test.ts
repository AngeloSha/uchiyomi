// The genre tag box shared by Edit details: what an entry becomes, what is offered while typing, and that the
// editor uses it. The rules are in lib/genreTags.ts (no React), the wiring is pinned as source, like the repo's
// other UI-shape tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_SUGGESTIONS, cleanGenre, suggestGenres, withGenre } from '../lib/genreTags';

const read = (f: string) => readFileSync(join(__dirname, '..', f), 'utf8');

test('an entry is trimmed and loses a trailing comma; empty adds nothing', () => {
  assert.equal(cleanGenre('  Action, '), 'Action');
  assert.equal(cleanGenre(' , '), '');
  assert.deepEqual(withGenre(['A'], '  '), ['A']);
  assert.deepEqual(withGenre(['A'], 'B,'), ['A', 'B']);
});

test('a genre already there is not added again, whatever its case', () => {
  const have = ['Action', 'Romance'];
  assert.equal(withGenre(have, 'action'), have, 'the same array comes back, so nothing is saved');
  assert.deepEqual(withGenre(have, 'Drama'), ['Action', 'Romance', 'Drama']);
});

test('a genre the library has, typed in another case, takes the library\'s spelling', () => {
  // Reintroduce `withGenre(genres, raw)` without the known list: 'slice of life' is added as typed, a new spelling.
  assert.deepEqual(withGenre(['Action'], 'slice of life', ['Slice of Life', 'Drama']), ['Action', 'Slice of Life']);
  assert.deepEqual(withGenre(['Action'], 'Isekai', ['Slice of Life']), ['Action', 'Isekai'], 'a new genre keeps its own spelling');
  assert.match(read('components/GenreTagInput.tsx'), /withGenre\(genres, raw, known\.data \?\? \[\]\)/, 'the box hands it the library\'s genres');
});

test('suggestions: prefix matches first, then the rest that contain it, none already chosen, capped', () => {
  const known = ['Slice of Life', 'Action', 'Sci-Fi', 'Supernatural', 'Historical', 'Psychological', 'Thriller', 'Sports'];
  assert.deepEqual(suggestGenres('', known, []), [], 'nothing typed, nothing offered');
  assert.deepEqual(suggestGenres('s', known, []).slice(0, 4), ['Slice of Life', 'Sci-Fi', 'Supernatural', 'Sports'], 'prefix matches, in order');
  assert.deepEqual(suggestGenres('ical', known, []), ['Historical', 'Psychological'], 'contained, not a prefix');
  assert.deepEqual(suggestGenres('SCI', known, ['sci-fi']), [], 'one already chosen is not offered again');
  assert.equal(suggestGenres('s', known, []).length <= MAX_SUGGESTIONS, true);
  assert.deepEqual(suggestGenres('a', [null, 3, '', ' ', 'Action'] as unknown[], []), ['Action'], 'a malformed answer is ignored');
});

test('Edit details uses the box for its Genres row and saves what it hands back', () => {
  const editor = read('components/SeriesEditor.tsx');
  assert.match(editor, /<GenreTagInput id=\{fid\} genres=\{genres\} onChange=\{\(next\) => \{ void run\(\(\) => onSave\(next\)\); \}\} \/>/);
  const box = read('components/GenreTagInput.tsx');
  assert.match(box, /api<\{ content: string\[\] \}>\('\/api\/genres'\)/, 'the suggestions are the genres the library already has');
  assert.match(box, /e\.key === 'Backspace' && !draft && genres\.length/, 'Backspace on an empty field removes the last chip');
  assert.match(box, /onBlur=\{\(\) => add\(draft\)\}/, 'leaving the field adds what was typed');
  assert.match(box, /role="combobox"/);
});
