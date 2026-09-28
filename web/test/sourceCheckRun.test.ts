// "Check all now" runs in the background since v0.49.0 (#115): the POST answers at once and the page follows the
// sweep with GETs. The toast after it still reads the sweep's result, so the walk must end on that result, not on
// the POST's own "started" answer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { checkAllSession, checkAllSources, followRunningCheck, SOURCE_CHECK_PATH, type SourceCheckProgress } from '../lib/sourceCheckRun';

const at = (over: Partial<SourceCheckProgress>): SourceCheckProgress => ({
  running: true, by: 'admin', startedAt: '2026-09-27T10:00:00.000Z', finishedAt: null,
  total: 3, done: 0, current: null, result: null, error: null, ...over,
});

test('it starts the sweep, follows it, and ends on the sweep result', async () => {
  // Reintroduce by returning the POST's answer (the pre-v0.49.0 shape): the result assertion finds the progress
  // object, and the page's toast would read `needsAttention` off it and throw.
  const result = { checkedAt: 'x', sources: [], needsAttention: [{ id: 'a' }], inconclusive: [], notified: ['a'] };
  const answers = [
    at({ done: 0 }),
    at({ done: 1, current: { id: 'b', name: 'B' } }),
    at({ running: false, done: 3, finishedAt: '2026-09-27T10:01:00.000Z', result }),
  ];
  const calls: string[] = [];
  const seen: number[] = [];
  const call = async <T,>(path: string, opts?: { method?: string }): Promise<T> => {
    calls.push(`${opts?.method ?? 'GET'} ${path}`);
    return answers.shift() as T;
  };
  const r = await checkAllSources(call, (p) => seen.push(p.done), 1);
  assert.deepEqual(r, result);
  assert.deepEqual(calls, [`POST ${SOURCE_CHECK_PATH}`, `GET ${SOURCE_CHECK_PATH}`, `GET ${SOURCE_CHECK_PATH}`]);
  assert.deepEqual(seen, [0, 1, 3], 'every reading reaches the page');
});

test('a sweep that ended without a result is an error, not "All sources healthy"', async () => {
  const call = async <T,>(): Promise<T> => at({ running: false, error: 'boom' }) as T;
  await assert.rejects(checkAllSources(call, undefined, 1), /boom/);
});

test('a sweep somebody else started is followed, not refused', async () => {
  // Reintroduce by rethrowing every POST error in checkAllSources: the 409 reaches the page as "Could not run the
  // check" while the daily check it collided with is running fine.
  const result = { checkedAt: 'x', sources: [], needsAttention: [], inconclusive: [], notified: [] };
  const calls: string[] = [];
  const gets = [at({ done: 2 }), at({ running: false, done: 3, result })];
  const call = async <T,>(path: string, opts?: { method?: string }): Promise<T> => {
    calls.push(`${opts?.method ?? 'GET'} ${path}`);
    if (opts?.method === 'POST') throw Object.assign(new Error('API 409'), { status: 409 });
    return gets.shift() as T;
  };
  assert.deepEqual(await checkAllSources(call, undefined, 1), result);
  assert.deepEqual(calls, [`POST ${SOURCE_CHECK_PATH}`, `GET ${SOURCE_CHECK_PATH}`, `GET ${SOURCE_CHECK_PATH}`]);
  // Any other error is still an error.
  const boom = async <T,>(): Promise<T> => { throw Object.assign(new Error('API 500'), { status: 500 }); };
  await assert.rejects(checkAllSources(boom, undefined, 1), /500/);
});

test('opening Providers during a sweep follows it; with none running it asks once and stops', { timeout: 2000 }, async () => {
  // Reintroduce by returning the first reading's result without following: the page shows "Check all now" while
  // the daily check runs, and never its answer.
  const idle: string[] = [];
  assert.equal(await followRunningCheck(async <T,>(p: string): Promise<T> => { idle.push(p); return at({ running: false }) as T; }, undefined, 1), null);
  assert.deepEqual(idle, [SOURCE_CHECK_PATH], 'one GET, no POST, nothing started');
  const result = { checkedAt: 'y', sources: [], needsAttention: [], inconclusive: [], notified: [] };
  const answers = [at({ done: 1 }), at({ done: 2 }), at({ running: false, done: 3, result })];
  const seen: number[] = [];
  assert.deepEqual(await followRunningCheck(async <T,>(): Promise<T> => answers.shift() as T, (p) => seen.push(p.done), 1), result);
  assert.deepEqual(seen, [1, 2, 3]);
  // A page that went away stops asking. The fake ends the sweep on its sixth answer, so a follower that ignores the
  // page leaving fails the count below instead of polling forever (the test's timeout is the second guard).
  let asked = 0;
  const left = new AbortController();
  const gone = { checkedAt: 'z', sources: [], needsAttention: [], inconclusive: [], notified: [] };
  const r = await followRunningCheck(async <T,>(): Promise<T> => {
    asked++;
    if (asked === 2) left.abort();
    return (asked > 5 ? at({ running: false, done: 3, result: gone }) : at({})) as T;
  }, undefined, 1, left.signal);
  assert.equal(asked, 2, 'it kept polling after the page left');
  assert.equal(r, null);
});

/**
 * A server with one sweep: POST starts it (409 while it runs), every GET moves it one source on, and it ends with
 * its result after `total`. `hold` keeps the next GET waiting until released, as a slow first answer does.
 */
function fakeServer(total = 4) {
  const result = { checkedAt: 'w', sources: [], needsAttention: [{ id: 'a' }], inconclusive: [], notified: [] };
  let running = false, done = 0;
  const log: string[] = [];
  let hold: Promise<void> | null = null;
  const snap = () => at(running ? { done, total } : { running: false, done, total, result: done ? result : null });
  const call = async <T,>(path: string, opts?: { method?: string }): Promise<T> => {
    const method = opts?.method ?? 'GET';
    log.push(method);
    if (method === 'POST') {
      if (running) throw Object.assign(new Error('API 409'), { status: 409 });
      running = true; done = 0;
      return snap() as T;
    }
    if (hold) { const h = hold; hold = null; await h; }
    if (running && ++done >= total) running = false;
    return snap() as T;
  };
  return {
    call, log, result,
    start() { running = true; done = 0; },
    holdNextGet() { let release!: () => void; hold = new Promise((r) => { release = r; }); return () => release(); },
  };
}
const hooks = () => {
  const seen = { progress: 0, done: [] as any[], failed: [] as unknown[], idle: 0 };
  return {
    seen,
    hooks: {
      progress: () => { seen.progress++; },
      done: (r: any) => { seen.done.push(r); },
      failed: (e: unknown) => { seen.failed.push(e); },
      idle: () => { seen.idle++; },
    },
  };
};
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

test('Check all pressed before the tab\'s first GET answers: one follower, one notice', { timeout: 2000 }, async () => {
  // Reintroduce by not stopping the visit's follower on a press (drop `watching.abort()` in press): the mount's GET
  // sees the press's own sweep running, follows it too, and the admin gets the notice twice.
  // Long enough that the press is still following it when the held first GET answers.
  const srv = fakeServer(40);
  const release = srv.holdNextGet();
  const { seen, hooks: h } = hooks();
  const visit = checkAllSession(srv.call, h, 1);
  const following = visit.follow();
  const pressing = visit.press();
  await settle(2);
  release();
  await Promise.all([following, pressing]);
  assert.deepEqual(seen.done, [srv.result], `the notice came ${seen.done.length} times`);
  assert.equal(seen.idle, 1, 'the button was handed back twice');
  assert.deepEqual(seen.failed, []);
});

test('leaving the tab stops a Check all run; the next visit follows the same sweep and owns its notice', { timeout: 2000 }, async () => {
  // Reintroduce by ignoring the signal in checkAllSources (or not aborting it in leave()): the first visit keeps
  // polling after the tab unmounted and gives its notice beside the second visit's -- two notices, one of them
  // from a component that is gone.
  const srv = fakeServer(12);
  const first = hooks();
  const a = checkAllSession(srv.call, first.hooks, 1);
  const pressing = a.press();
  await settle(3);
  a.leave();
  const asked = srv.log.length;
  await settle(20);
  assert.ok(srv.log.length <= asked + 1, `the left tab kept polling (${srv.log.length - asked} more GETs)`);
  await pressing;
  assert.deepEqual(first.seen.done, [], 'the left tab gave a notice');
  assert.equal(first.seen.idle, 0, 'the left tab set state after it was gone');

  const second = hooks();
  const b = checkAllSession(srv.call, second.hooks, 1);
  await b.follow();
  assert.deepEqual(second.seen.done, [srv.result], 'the visit on screen did not say how it ended');
  assert.ok(second.seen.progress > 0);
  assert.equal(second.seen.idle, 1);
});

test('a sweep the daily check started is followed when Check all is pressed into it', { timeout: 2000 }, async () => {
  // The 409 case through the session: one notice, no error.
  const srv = fakeServer();
  srv.start();
  const { seen, hooks: h } = hooks();
  await checkAllSession(srv.call, h, 1).press();
  assert.deepEqual(srv.log.slice(0, 2), ['POST', 'GET']);
  assert.deepEqual(seen.done, [srv.result]);
  assert.deepEqual(seen.failed, []);
});

test('Providers starts Check all through the helper, and leaves it when the tab goes', () => {
  // Reintroduce by putting back `api('/api/admin/sources/check', { method: 'POST' })` in page.tsx: the toast reads
  // the 202 answer, which has no needsAttention, and throws. Or by dropping the effect's `run.leave()`: a run the
  // tab no longer shows keeps polling and gives its notice again beside the next visit's.
  const src = readFileSync(join(__dirname, '..', 'app', 'admin', 'page.tsx'), 'utf8');
  assert.match(src, /const run = checkAllSession\(api, \{/);
  assert.match(src, /void run\.follow\(\);\n    return \(\) => run\.leave\(\);/, 'the session is not left on unmount');
  assert.match(src, /void checkRun\.current\?\.press\(\);/);
  assert.doesNotMatch(src, /api<any>\('\/api\/admin\/sources\/check', \{ method: 'POST' \}\)/);
});
