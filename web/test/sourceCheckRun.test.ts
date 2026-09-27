// "Check all now" runs in the background since v0.49.0 (#115): the POST answers at once and the page follows the
// sweep with GETs. The toast after it still reads the sweep's result, so the walk must end on that result, not on
// the POST's own "started" answer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { checkAllSources, SOURCE_CHECK_PATH, type SourceCheckProgress } from '../lib/sourceCheckRun';

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

test('Providers starts Check all through the helper', () => {
  // Reintroduce by putting back `api('/api/admin/sources/check', { method: 'POST' })` in page.tsx: the toast reads
  // the 202 answer, which has no needsAttention, and throws.
  const src = readFileSync(join(__dirname, '..', 'app', 'admin', 'page.tsx'), 'utf8');
  assert.match(src, /await checkAllSources\(api\)/);
  assert.doesNotMatch(src, /api<any>\('\/api\/admin\/sources\/check', \{ method: 'POST' \}\)/);
});
