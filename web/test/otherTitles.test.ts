// The series page's AniList names: which of English / romanised / Japanese are listed beside the title it shows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { otherTitleLines } from '../lib/otherTitles';

test('lists the names in order, English then romanised then Japanese', () => {
  const l = otherTitleLines({ english: 'Frieren: Beyond Journey’s End', romaji: 'Sousou no Frieren', native: '葬送のフリーレン' }, 'Frieren');
  assert.deepEqual(l.map((x) => x.kind), ['english', 'romaji', 'native']);
  assert.equal(l[2].name, '葬送のフリーレン');
});

test('leaves out the title already shown, however it is spaced or punctuated', () => {
  const l = otherTitleLines({ english: 'One-Punch Man', romaji: 'ONE PUNCH-MAN', native: 'ワンパンマン' }, 'one punch man');
  assert.deepEqual(l.map((x) => x.kind), ['native']);
});

test('a name an earlier line already says is not repeated; blanks and null are dropped', () => {
  assert.deepEqual(otherTitleLines({ english: 'Berserk', romaji: 'Berserk', native: ' ' }, 'Kentaro Miura'), [{ kind: 'english', name: 'Berserk' }]);
  assert.deepEqual(otherTitleLines(null, 'x'), []);
  assert.deepEqual(otherTitleLines({ english: null, romaji: null, native: null }, 'x'), []);
});

test('the series page mounts the names between the genres and the summary', () => {
  const page = readFileSync(join(__dirname, '..', 'app/series/page.tsx'), 'utf8');
  assert.match(page, /\{Genres\}\s*\{series && <OtherTitles seriesId=\{id\} shown=\{title\} \/>\}\s*\{Summary\}/);
});
