// The known-group chips under the Settings blocklist and priority, tested away from React.
import test from 'node:test';
import assert from 'node:assert/strict';
import { suggestGroups } from '../lib/groupSuggest';
import type { KnownGroup } from '../lib/types';

const g = (name: string, onDisk = 0, listed = 0): KnownGroup => ({ name, onDisk, listed, series: 1 });
const names = (xs: KnownGroup[]) => xs.map((x) => x.name);

test("matches by the server's equality", () => {
  // The server folds case, width and punctuation (normGroup); a suggestion list that compared raw strings
  // would not find "Asura Scans" for "asura-" and would offer a spelling the server then folds away.
  // Reintroduce by matching on `g.name.toLowerCase().includes(draft)` instead of normGroup: "punctuation
  // is not a letter" fails.
  const known = [g('Asura Scans', 10), g('Flame Comics', 5), g('Ｒｅａｐｅｒ Scans', 3)];
  assert.deepEqual(names(suggestGroups(known, 'asura-', [])), ['Asura Scans'], 'punctuation is not a letter');
  assert.deepEqual(names(suggestGroups(known, 'REAPER', [])), ['Ｒｅａｐｅｒ Scans'], 'full-width letters are letters');
  assert.deepEqual(names(suggestGroups(known, 'scans', [])), ['Asura Scans', 'Ｒｅａｐｅｒ Scans'], 'a substring anywhere');
  assert.deepEqual(names(suggestGroups(known, 'zzz', [])), [], 'no match is an empty list, not everything');
});

test('never offers a chip already placed', () => {
  // Reintroduce by dropping the `placed.has(k)` term: "the placed group is not offered again" fails.
  const known = [g('Asura Scans', 10), g('Flame Comics', 5)];
  assert.deepEqual(names(suggestGroups(known, '', ['asura-scans'])), ['Flame Comics'], 'the placed group is not offered again');
  assert.deepEqual(names(suggestGroups(known, 'asura', ['Asura Scans'])), [], 'not even when it is the only match');
});

test('busiest first when nothing is typed', () => {
  // Busiest is on disk PLUS listed: a group with no chapters on disk yet that every source lists is the one
  // an admin is about to meet. Reintroduce by sorting on `onDisk` alone: "listed counts" fails.
  const known = [g('Quiet', 1, 0), g('Loud', 3, 0), g('Listed', 0, 5), g('Both', 2, 2)];
  assert.deepEqual(names(suggestGroups(known, '', [])), ['Listed', 'Both', 'Loud', 'Quiet'], 'listed counts');
  // The limit holds, and holds from the top.
  const many = Array.from({ length: 20 }, (_, i) => g(`G${i}`, i));
  const top = suggestGroups(many, '', []);
  assert.equal(top.length, 8, 'eight by default');
  assert.deepEqual(names(top), ['G19', 'G18', 'G17', 'G16', 'G15', 'G14', 'G13', 'G12']);
  assert.equal(suggestGroups(many, '', [], 3).length, 3);
  // A name that folds to nothing ("---") can never be a chip, so it is never a suggestion.
  assert.deepEqual(names(suggestGroups([g('---', 99)], '', [])), []);
});
