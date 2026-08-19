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
