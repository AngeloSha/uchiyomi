// The solver's cookie jars map onto a FIXED set of Electron partitions (pool.ts): Electron never frees a
// partition, so an unbounded name per origin or per made-up session name was a memory leak by construction.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PartitionPool } from '../src/solver/pool';

test('a thousand origins never use more than `capacity` partition names', () => {
  // Reintroduce by returning `${prefix}:${key}` from claim(): the set grows to 1000.
  const p = new PartitionPool('fs-o', 16);
  const names = new Set<string>();
  for (let i = 0; i < 1000; i++) names.add(p.claim(`o:https://site${i}.example`, i).name);
  assert.equal(names.size, 16);
  assert.deepEqual([...names].sort(), p.allNames().sort());
  assert.equal(p.keys().length, 16);
});

test('the least recently USED key is evicted, and the claim says so (the jar must be emptied before reuse)', () => {
  // Reintroduce by sorting most-recent-first in claim(): the fresh key B stays and A (just used) goes.
  const p = new PartitionPool('fs-o', 2);
  const a = p.claim('A', 1);
  const b = p.claim('B', 2);
  assert.equal(a.fresh, true);
  assert.equal(p.claim('A', 3).name, a.name, 'touching A makes B the oldest');
  const c = p.claim('C', 4);
  assert.equal(c.evicted, 'B');
  assert.equal(c.name, b.name);
  assert.equal(c.fresh, true);
  assert.equal(p.has('B'), false);
  assert.equal(p.claim('A', 5).evicted, undefined);
});

test('a key in the middle of a solve is not evicted while an idle one exists', () => {
  // Reintroduce by ignoring `busy` (always order[0]): the busy jar is emptied mid-solve.
  const p = new PartitionPool('fs-s', 2);
  p.claim('busy', 1);
  p.claim('idle', 2);
  const c = p.claim('new', 3, (k) => k === 'busy');
  assert.equal(c.evicted, 'idle');
  assert.equal(p.has('busy'), true);
});

test('release frees the name (sessions.destroy); the next key reuses it', () => {
  // Reintroduce by making release() a no-op: the second key evicts instead of reusing a free name.
  const p = new PartitionPool('fs-s', 1);
  const a = p.claim('suwayomi', 1);
  assert.equal(p.release('suwayomi'), true);
  assert.equal(p.release('suwayomi'), false);
  const b = p.claim('other', 2);
  assert.equal(b.name, a.name);
  assert.equal(b.evicted, undefined);
  assert.throws(() => new PartitionPool('x', 0));
});
