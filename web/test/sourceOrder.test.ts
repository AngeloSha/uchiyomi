// The source order's editing rules (lib/sourceOrder.ts), and the one property the admin section must keep:
// every save is built from the STORED order, never from the list of sources that happen to be loaded.
//
// #93 built its admin list as `order.filter((id) => all.some(...))` and saved that. The list of sources is the
// registry's, which holds no extension source while the extension engine restarts -- so one arrow pressed at
// the wrong moment saved an order with every extension gone from it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { addable, moveIn, orderRows, preferFirst } from '../lib/sourceOrder';

const all = [{ id: 'aqua', name: 'Aqua Manga' }, { id: 'mangadex', name: 'MangaDex' }, { id: 'coffeemanga', name: 'Coffee Manga' }];

test('every stored id is a row, in order, and one nothing loaded answers to has no name', () => {
  // Reintroduce #93's filter (`order.filter((id) => all.some((x) => x.id === id))`) and the sw: row is gone.
  assert.deepEqual(orderRows(['sw:8683375824843625513', 'aqua', 'mangadex'], all), [
    { id: 'sw:8683375824843625513', name: null },
    { id: 'aqua', name: 'Aqua Manga' },
    { id: 'mangadex', name: 'MangaDex' },
  ]);
  assert.deepEqual(orderRows([], all), []);
});

test('only loaded sources not in the order yet can be added', () => {
  assert.deepEqual(addable(['aqua', 'sw:1'], all).map((s) => s.id), ['mangadex', 'coffeemanga']);
});

test('moving swaps neighbours and never leaves the list', () => {
  assert.deepEqual(moveIn(['a', 'b', 'c'], 0, 1), ['b', 'a', 'c']);
  assert.deepEqual(moveIn(['a', 'b', 'c'], 2, -1), ['a', 'c', 'b']);
  assert.deepEqual(moveIn(['a', 'b', 'c'], 0, -1), ['a', 'b', 'c']);
  assert.deepEqual(moveIn(['a', 'b', 'c'], 2, 1), ['a', 'b', 'c']);
});

test("a series' preferred source goes first and the rest keep their follow order", () => {
  assert.deepEqual(preferFirst('mangadex', ['aqua', 'mangadex', 'coffeemanga']), ['mangadex', 'aqua', 'coffeemanga']);
  assert.deepEqual(preferFirst('aqua', ['aqua', 'mangadex']), ['aqua', 'mangadex']);
});

test('the admin section saves only orders built from the stored one', () => {
  const src = readFileSync(join(__dirname, '..', 'components/AdminSettings.tsx'), 'utf8');
  const body = src.slice(src.indexOf('function SourceOrderSection'), src.indexOf('function SwitchWithMore'));
  assert.ok(body.includes('orderRows(order, all)'), 'the rows are not built by orderRows');
  const calls = [...body.matchAll(/commit\(([^;]*?)\)\}/g)].map((m) => m[1]);
  assert.equal(calls.length, 4, `expected four places that save (up, down, remove, add): ${calls.join(' | ')}`);
  for (const c of calls) {
    assert.match(c, /^(moveIn\(order, |order\.filter\(|\[\.\.\.order, )/, `a save is not built from the stored order: ${c}`);
  }
  assert.doesNotMatch(body, /\.filter\(\(id\) => all\./, 'the stored order is filtered by the loaded sources');
});
