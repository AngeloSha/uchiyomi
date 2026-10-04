// The download gate. Without it, importing a few hundred titles starts a few hundred simultaneous download
// loops against the same sites — which reads as an attack and gets the server blocked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { withGate, gateDepth } from '../src/lib/gate';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('never exceeds the configured concurrency for a key', async () => {
  let inFlight = 0;
  let peak = 0;
  await Promise.all(
    Array.from({ length: 12 }, () =>
      withGate('site-a', async () => {
        peak = Math.max(peak, ++inFlight);
        await sleep(10);
        inFlight--;
      }, { concurrency: 3 }),
    ),
  );
  assert.equal(peak, 3, `expected at most 3 concurrent, saw ${peak}`);
  assert.equal(inFlight, 0);
});

test('keys are independent, so a slow site cannot starve a fast one', async () => {
  let aDone = false;
  const slow = withGate('slow-site', async () => { await sleep(80); aDone = true; }, { concurrency: 1 });
  await withGate('fast-site', async () => {}, { concurrency: 1 });
  assert.equal(aDone, false, 'the fast site finished without waiting on the slow one');
  await slow;
});

test('enforces a minimum gap between operations on the same key', async () => {
  const started: number[] = [];
  await Promise.all(
    Array.from({ length: 3 }, () => withGate('paced', async () => { started.push(Date.now()); }, { concurrency: 1, minGapMs: 40 })),
  );
  started.sort((a, b) => a - b);
  assert.ok(started[1] - started[0] >= 35, `gap 1 was ${started[1] - started[0]}ms`);
  assert.ok(started[2] - started[1] >= 35, `gap 2 was ${started[2] - started[1]}ms`);
});

test('releases the slot when the operation throws', async () => {
  await assert.rejects(withGate('boom', async () => { throw new Error('nope'); }, { concurrency: 1 }));
  // if the slot leaked, this would hang forever rather than resolve
  await withGate('boom', async () => {}, { concurrency: 1 });
  assert.deepEqual(gateDepth('boom'), { active: 0, queued: 0 }, 'lane is cleaned up');
});

test('queued work still runs after a failure ahead of it', async () => {
  const ran: string[] = [];
  const failing = withGate('mixed', async () => { await sleep(5); throw new Error('x'); }, { concurrency: 1 }).catch(() => ran.push('failed'));
  const following = withGate('mixed', async () => { ran.push('ran'); }, { concurrency: 1 });
  await Promise.all([failing, following]);
  assert.ok(ran.includes('ran'), 'work queued behind a failure must still execute');
});

test('a width asked again narrows a busy lane as its operations finish', async () => {
  // v0.55.3: the downloader's width falls to one while a source's pace is raised, and two chapters may already be
  // running at two. Reintroduce the old release in admit() (`lane.queue.shift()` and go, whatever the width): the first
  // of the two to finish lets a waiter in beside the one still running, and `nothing new beside` reads 2.
  let width = 2;
  let inFlight = 0;
  let peakLate = 0;
  const release: Array<() => void> = [];
  const first = [0, 1].map(() => withGate('narrow', async () => {
    inFlight++;
    await new Promise<void>((r) => release.push(r));
    inFlight--;
  }, { concurrency: () => width }));
  await sleep(5);
  assert.equal(inFlight, 2, 'both ran at two');
  width = 1;
  const late = [0, 1, 2].map(() => withGate('narrow', async () => {
    peakLate = Math.max(peakLate, ++inFlight);
    await sleep(10);
    inFlight--;
  }, { concurrency: () => width }));
  release[0]();
  await sleep(30);
  assert.equal(peakLate, 0, 'nothing new beside the one still running, at a width of one');
  release[1]();
  await Promise.all([...first, ...late]);
  assert.equal(peakLate, 1, 'then one at a time');
  assert.deepEqual(gateDepth('narrow'), { active: 0, queued: 0 });
});

test('first come, first served: a widened lane lets its waiters in, in order, before a newcomer', async () => {
  // Reintroduce the arrival's old test (`if (lane.active >= width())` alone): the newcomer walks past the waiter into
  // the slot the widening opened, and the order reads A, C, B.
  let width = 1;
  const order: string[] = [];
  let releaseA!: () => void;
  const a = withGate('fifo', async () => { order.push('A'); await new Promise<void>((r) => { releaseA = r; }); }, { concurrency: () => width });
  await sleep(5);
  const b = withGate('fifo', async () => { order.push('B'); await sleep(5); }, { concurrency: () => width });
  await sleep(5);
  width = 2;
  const c = withGate('fifo', async () => { order.push('C'); }, { concurrency: () => width });
  await sleep(5);
  assert.deepEqual(order, ['A', 'B'], 'the waiter got the widened slot, the newcomer waits behind it');
  releaseA();
  await Promise.all([a, b, c]);
  assert.deepEqual(order, ['A', 'B', 'C']);
});
