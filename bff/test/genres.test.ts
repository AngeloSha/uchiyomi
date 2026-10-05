// cleanGenres (lib/genres.ts, v0.55.5): a series' genres without a site's whole genre menu, each once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanGenres } from '../src/lib/genres';

test("a site menu's run and everything after it go; the series' own genres stay, each once", () => {
  // Return of the War God on the owner's library: its five genres twice (the page's info panel and genre box), then
  // Natomanga's menu. Reintroduce by deduping without the cut: Adult and Hentai stay.
  const stored = 'Fantasy,Action,Adventure,Martial arts,Demons,Fantasy,Action,Adventure,Martial arts,Demons,All,Completed,Ongoing,'
    + 'Action,Adaptation,Adult,Adventure,Boys Love,Hentai,Smut,Yaoi,Yuri';
  assert.deepEqual(cleanGenres(stored.split(',')), ['Fantasy', 'Action', 'Adventure', 'Martial arts', 'Demons']);
  // Folded and trimmed as the scan splits a ComicInfo <Genre>: " all", "COMPLETED".
  assert.deepEqual(cleanGenres(['Drama', ' all', 'COMPLETED ', 'Ongoing', 'Hentai']), ['Drama']);
});

test('a list with no menu is kept, less repeats; the run must be whole, in order', () => {
  assert.deepEqual(cleanGenres(['Action', 'action ', 'Ecchi', 'Ecchi', 'Romance']), ['Action', 'Ecchi', 'Romance']);
  // One of the three, or the three out of order, is not a menu.
  assert.deepEqual(cleanGenres(['All', 'Action']), ['All', 'Action']);
  assert.deepEqual(cleanGenres(['Completed', 'Ongoing', 'All', 'Drama']), ['Completed', 'Ongoing', 'All', 'Drama']);
});

test('nothing usable is nothing', () => {
  assert.deepEqual(cleanGenres(null), []);
  assert.deepEqual(cleanGenres(undefined), []);
  assert.deepEqual(cleanGenres(['', '  ', 3, null, 'Drama'] as unknown[]), ['Drama']);
});
