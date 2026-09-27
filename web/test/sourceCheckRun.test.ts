// "Check all now" runs in the background since v0.49.0 (#115): the POST answers at once and the page follows the
// sweep with GETs. The toast after it still reads the sweep's result, so the walk must end on that result, not on
// the POST's own "started" answer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { checkAllSources, followRunningCheck, SOURCE_CHECK_PATH, type SourceCheckProgress } from '../lib/sourceCheckRun';

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

test('opening Providers during a sweep follows it; with none running it asks once and stops', async () => {
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
  // A page that went away stops asking.
  let asked = 0;
  assert.equal(await followRunningCheck(async <T,>(): Promise<T> => { asked++; return at({}) as T; }, undefined, 1, () => asked < 2), null);
  assert.equal(asked, 2, 'it kept polling after the page left');
});

test('Providers starts Check all through the helper', () => {
  // Reintroduce by putting back `api('/api/admin/sources/check', { method: 'POST' })` in page.tsx: the toast reads
  // the 202 answer, which has no needsAttention, and throws.
  const src = readFileSync(join(__dirname, '..', 'app', 'admin', 'page.tsx'), 'utf8');
  assert.match(src, /await checkAllSources\(api[,)]/);
  assert.doesNotMatch(src, /api<any>\('\/api\/admin\/sources\/check', \{ method: 'POST' \}\)/);
});
