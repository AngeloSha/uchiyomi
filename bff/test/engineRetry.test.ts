// Registration keeps trying until the extension engine answers (#72).
//
// It used to give up about four minutes after boot (5 s, 15 s, 30 s, 1 min, 2 min, then nothing), so an engine
// that came up later -- a slow NAS, an Unraid template installed after Uchiyomi, a container restarted by hand --
// stayed unregistered until someone found the reload button. Now the fast phase is followed by one quiet try
// every five minutes, in ONE loop however many callers ask for it.
//
// Driven with node:test's mock clock and an injected load, so nothing here needs an engine or a database; the
// real engine coming back is engineRecovery.int.test.ts.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.SUWAYOMI_URL = 'http://engine.test:4567';
delete process.env.EXTENSION_ENGINE;
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
process.env.DATABASE_URL ||= 'postgres://unused/unused';
process.env.CONFIG_DIR ||= '/tmp/uchiyomi-test-config';

const FAST = [5_000, 15_000, 30_000, 60_000, 120_000];
const EVERY = 300_000;
const DOWN = { configured: true, reachable: false, available: 0, registered: 0, skipped: 0, error: 'fetch failed' };
const UP = { configured: true, reachable: true, available: 4, registered: 2, skipped: 0 };

/** Let the loop's awaits run: the timer fires synchronously, the load and the re-arm happen in microtasks. */
const flush = () => new Promise<void>((r) => setImmediate(r));

async function rig() {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const reg = await import('../src/lib/sources/suwayomi/register');
  reg.stopSuwayomiRetry();
  const quiet: boolean[] = [];
  let up = false;
  const load = async ({ quiet: q }: { quiet: boolean }) => { quiet.push(q); return up ? UP : DOWN; };
  let now = 0;
  /** Walk the clock second by second to `ms` after start, letting every try finish before the next second. */
  const until = async (ms: number) => {
    while (now < ms) { mock.timers.tick(1000); now += 1000; await flush(); }
  };
  return { reg, quiet, load, until, bringUp: () => { up = true; }, now: () => now };
}

function done() {
  mock.timers.reset();
  mock.restoreAll();
}

/**
 * Reintroduce the old give-up (in arm(): `if (l.fast[l.tries] === undefined) { loop = null; return; }`, the old
 * `if (i >= delaysMs.length) return;`): "still trying ten minutes after boot" fails at 5 attempts.
 */
test('still trying ten minutes after boot, quietly, every five minutes', async () => {
  const warns: string[] = [];
  mock.method(console, 'warn', (m: string) => { warns.push(String(m)); });
  const { reg, quiet, load, until } = await rig();
  try {
    reg.scheduleSuwayomiRetry(FAST, EVERY, load);
    await until(230_000); // 5 + 15 + 30 + 60 + 120 s: the fast phase
    assert.equal(quiet.length, 5, 'the fast phase is five tries');
    assert.deepEqual(quiet, [false, false, false, false, false], 'the fast phase says what it found, as before');
    assert.equal(warns.filter((w) => /still not answering/.test(w)).length, 1, 'the slow phase is announced once');

    await until(600_000);
    assert.equal(quiet.length, 6, 'still trying ten minutes after boot');
    assert.equal(quiet[5], true, 'the tries after the fast phase are quiet');
    await until(830_000);
    assert.equal(quiet.length, 7, 'and every five minutes after that');
    assert.equal(warns.filter((w) => /still not answering/.test(w)).length, 1, 'the slow tries log nothing each');

    const st = reg.suwayomiRetryState();
    assert.ok(st, 'the loop is visible while it runs');
    assert.equal(st!.attempts, 8, 'the load that started it plus seven retries');
    assert.equal(st!.since, new Date(0).toISOString());
    assert.equal(st!.nextAt, new Date(830_000 + EVERY).toISOString(), 'the next try is five minutes after the last');
  } finally {
    reg.stopSuwayomiRetry();
    done();
  }
});

test('the first answer ends it', async () => {
  const { reg, quiet, load, until, bringUp } = await rig();
  mock.method(console, 'log', () => {});
  mock.method(console, 'warn', () => {});
  try {
    reg.scheduleSuwayomiRetry(FAST, EVERY, load);
    await until(20_000); // two fast tries
    bringUp();
    await until(50_000); // the third, at 50 s, answers
    assert.equal(quiet.length, 3);
    assert.equal(reg.suwayomiRetryState(), null, 'the loop is over once the engine answered');
    await until(2 * 3_600_000);
    assert.equal(quiet.length, 3, 'nothing asks again after the engine answered');
  } finally {
    reg.stopSuwayomiRetry();
    done();
  }
});

/**
 * Reintroduce by dropping the `|| loop` from scheduleSuwayomiRetry's guard: the boot, a reload and another reload
 * each start a loop, and the engine is asked three times at the five-second mark.
 */
test('asking for it again while it runs changes nothing', async () => {
  const { reg, quiet, load, until } = await rig();
  mock.method(console, 'warn', () => {});
  try {
    reg.scheduleSuwayomiRetry(FAST, EVERY, load);
    reg.scheduleSuwayomiRetry(FAST, EVERY, load);
    reg.scheduleSuwayomiRetry([1_000], 1_000, load);
    await until(5_000);
    assert.equal(quiet.length, 1, 'one loop, one try at five seconds');
    await until(20_000);
    assert.equal(quiet.length, 2);
  } finally {
    reg.stopSuwayomiRetry();
    done();
  }
});

test('Check again tries at once, and an answer ends the loop', async () => {
  const { reg, quiet, load, until, bringUp } = await rig();
  mock.method(console, 'log', () => {});
  mock.method(console, 'warn', () => {});
  try {
    reg.scheduleSuwayomiRetry(FAST, EVERY, load);
    await until(1_000);
    // A failed Check again counts as a try of this outage, and the loop carries on.
    const miss = await reg.retrySuwayomiNow(load);
    assert.equal(miss.reachable, false);
    assert.equal(reg.suwayomiRetryState()?.attempts, 2);
    bringUp();
    const hit = await reg.retrySuwayomiNow(load);
    assert.equal(hit.reachable, true);
    assert.equal(reg.suwayomiRetryState(), null, 'an answer to Check again ends the loop');
    await until(600_000);
    assert.equal(quiet.length, 2, 'and the loop asks nothing after it');
  } finally {
    reg.stopSuwayomiRetry();
    done();
  }
});

test('a registration that reaches the engine by any road ends the loop, and tells whoever listens', async () => {
  // reloadAll or the status route's self-heal registering the sources must not leave a loop behind that asks
  // again; and Health's cached probe is forgotten when the engine comes back (extensionEngine.ts).
  const { reg, load, until } = await rig();
  mock.method(console, 'log', () => {});
  mock.method(console, 'warn', () => {});
  let told = 0;
  const off = reg.onSuwayomiReconnect(() => { told++; });
  try {
    reg.scheduleSuwayomiRetry(FAST, EVERY, load);
    await until(1_000);
    const r = await reg.loadSuwayomiSources(async () => []);
    assert.equal(r.reachable, true);
    assert.equal(reg.suwayomiRetryState(), null, 'a successful load ended the loop');
    assert.equal(told, 1, 'the reconnect listener heard about it');
  } finally {
    off();
    reg.stopSuwayomiRetry();
    done();
  }
});
