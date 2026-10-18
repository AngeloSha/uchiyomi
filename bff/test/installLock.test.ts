// One extension install or removal at a time (v0.82.0, lib/sources/suwayomi/installLock.ts): first come, first served,
// each caller waiting as long as it says, and BUSY past that.
import test from 'node:test';
import assert from 'node:assert/strict';
import { withInstallLock, BUSY, installLockHolder, _installLockWaiting } from '../src/lib/sources/suwayomi/installLock';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('one at a time, in the order asked; a caller that will not wait gets BUSY', async () => {
  // Reintroduce by running every caller at once (fn() alone): two run together, and the one that would not wait runs.
  const order: string[] = [];
  let running = 0, most = 0;
  const job = (name: string, ms: number) => async () => {
    running++; most = Math.max(most, running); order.push(`${name}+`);
    await wait(ms);
    order.push(`${name}-`); running--;
    return name;
  };
  const a = withInstallLock('a', job('a', 60));
  await wait(5);
  assert.equal(installLockHolder(), 'a');
  const b = withInstallLock('b', job('b', 10), 2_000);
  const c = withInstallLock('c', job('c', 10), 2_000);
  assert.equal(await withInstallLock('d', job('d', 1)), BUSY, 'a caller that will not wait is told it is busy');
  assert.deepEqual(await Promise.all([a, b, c]), ['a', 'b', 'c']);
  assert.equal(most, 1, 'never two at once');
  assert.deepEqual(order, ['a+', 'a-', 'b+', 'b-', 'c+', 'c-'], 'first come, first served');
  assert.equal(installLockHolder(), null);
});

test('past its wait a caller gets BUSY, and the queue goes on without it; a throw still lets go', async () => {
  const a = withInstallLock('a', async () => { await wait(80); return 'a'; });
  const late = withInstallLock('late', async () => 'late', 20);
  const next = withInstallLock('next', async () => 'next', 2_000);
  assert.equal(await late, BUSY, 'gave up after its wait');
  assert.equal(await a, 'a');
  assert.equal(await next, 'next', 'the one behind it still runs');
  assert.equal(_installLockWaiting(), 0);
  await assert.rejects(withInstallLock('boom', async () => { throw new Error('boom'); }));
  assert.equal(installLockHolder(), null, 'a throw lets go');
});
