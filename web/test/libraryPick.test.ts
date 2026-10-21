// The Library's select mode: Shift with a click picks the run between the last series clicked and this one (v0.96.0,
// #333, @TIGamingTV), as a file manager does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pickWith } from '../lib/libraryPick';

const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
const sorted = (s: Set<string>) => [...s].sort();

test('Shift-click picks every series between the last one clicked and this one, either way round', () => {
  // Reintroduce the plain toggle for a Shift-click: only the series clicked is picked.
  assert.deepEqual(sorted(pickWith(new Set(['b']), ids, 'e', 'b', true)), ['b', 'c', 'd', 'e']);
  assert.deepEqual(sorted(pickWith(new Set(['e']), ids, 'b', 'e', true)), ['b', 'c', 'd', 'e'], 'upwards too');
  assert.deepEqual(sorted(pickWith(new Set(['a', 'f']), ids, 'd', 'b', true)), ['a', 'b', 'c', 'd', 'f'], 'what was picked outside the run stays');
});

test("on a picked series a Shift-click unpicks the run: the run takes the clicked series' new state", () => {
  // Reintroduce a range that always picks: Shift-clicking a picked series to drop a run picks it again.
  assert.deepEqual(sorted(pickWith(new Set(['a', 'b', 'c', 'd', 'e']), ids, 'b', 'e', true)), ['a']);
});

test('without Shift, or with no anchor on the shelf, a click toggles the one series', () => {
  assert.deepEqual(sorted(pickWith(new Set(['b']), ids, 'e', 'b', false)), ['b', 'e']);
  assert.deepEqual(sorted(pickWith(new Set(['b']), ids, 'b', 'b', false)), []);
  assert.deepEqual(sorted(pickWith(new Set(), ids, 'c', null, true)), ['c'], 'no anchor yet');
  assert.deepEqual(sorted(pickWith(new Set(), ids, 'c', 'gone', true)), ['c'], 'an anchor the filters took off the shelf');
});

test('the Library passes the click on, and the anchor is forgotten with the selection', () => {
  // Reintroduce `onToggle={() => togglePick(s.id)}`: Shift never reaches pickWith.
  const page = readFileSync(join(__dirname, '../app/library/page.tsx'), 'utf8');
  assert.equal((page.match(/onToggle=\{\(e\) => togglePick\(s\.id, e\)\}/g) ?? []).length, 2, 'both layouts pass the click');
  assert.match(page, /setPicked\(\(p\) => pickWith\(p, items\.map\(\(s\) => s\.id\), id, anchor\.current, shift\)\)/);
  assert.match(page, /onSelecting=\{\(\) => \{ setSelecting\(\(v\) => !v\); setPicked\(new Set\(\)\); anchor\.current = null; \}\}/, 'a new selection keeps an old anchor');
  const cards = readFileSync(join(__dirname, '../components/cards.tsx'), 'utf8');
  assert.equal((cards.match(/onClick=\{onToggle\} onMouseDown=\{noShiftSelect\}/g) ?? []).length, 2, 'Shift-press selects page text across the grid');
});
