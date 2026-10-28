import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const cards = readFileSync(new URL('../components/cards.tsx', import.meta.url), 'utf8');
const page = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');
const hidden = readFileSync(new URL('../components/KeepReadingHidden.tsx', import.meta.url), 'utf8');

test('only the Keep reading card offers "Remove from Keep reading"', () => {
  assert.match(cards, /tr\('Remove from Keep reading'\)/);
  assert.match(cards, /\/api\/keep-reading\/\$\{encodeURIComponent\(book\.seriesId\)\}[\s\S]{0,80}hidden: true/);
  // The menu is bound, and its ⋯ drawn, for Keep reading's card alone (Pick back up's has neither).
  assert.match(cards, /\{\.\.\.\(keepReading \? menu\.bind : \{\}\)\}/);
  assert.match(cards, /\{keepReading && <MoreKey /);
  assert.equal((page.match(/<ContinueCard[^>]*keepReading/g) ?? []).length, 1, 'only the Keep reading row passes it');
});

test('Home keeps the Keep reading title and its Hidden key when everything is hidden, so one can be put back', () => {
  assert.match(page, /keepReadingHidden \?\? 0\) > 0\) && \(/);
  assert.match(page, /<KeepReadingHidden count=\{data\?\.keepReadingHidden \?\? 0\} \/>/);
  assert.match(hidden, /\/api\/keep-reading\/\$\{encodeURIComponent\(h\.seriesId\)\}[\s\S]{0,80}hidden: false/);
  assert.match(hidden, /enabled: count > 0/, 'the list is not fetched when nothing is hidden');
});
