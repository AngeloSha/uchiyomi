import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as bulk from '../lib/bulkChapterDelete';

const saved = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (key: string) => saved.get(key) ?? null,
  setItem: (key: string, value: string) => void saved.set(key, value),
  removeItem: (key: string) => void saved.delete(key),
};

test('the durable chapter cleanup id survives reloads and an old dialog cannot clear a newer run', () => {
  bulk.rememberBulkChapterDeleteRun('run-one');
  assert.equal(bulk.rememberedBulkChapterDeleteRun(), 'run-one');
  bulk.rememberBulkChapterDeleteRun('run-two');
  bulk.forgetBulkChapterDeleteRun('run-one');
  assert.equal(bulk.rememberedBulkChapterDeleteRun(), 'run-two');
  bulk.forgetBulkChapterDeleteRun('run-two');
  assert.equal(bulk.rememberedBulkChapterDeleteRun(), null);
});

test('blocked localStorage only loses the reload hint, never throws from job handling', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem() { throw new Error('SecurityError'); },
      setItem() { throw new Error('SecurityError'); },
      removeItem() { throw new Error('SecurityError'); },
    },
  });
  assert.equal(bulk.rememberedBulkChapterDeleteRun(), null);
  assert.doesNotThrow(() => bulk.rememberBulkChapterDeleteRun('run-three'));
  assert.doesNotThrow(() => bulk.forgetBulkChapterDeleteRun('run-three'));
  if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
});

test('the provisional 202 status has the same shape as a polled running status', () => {
  const run = bulk.startedBulkChapterDeleteRun('run-four', 12, true);
  assert.equal(run.id, 'run-four');
  assert.equal(run.total, 12);
  assert.equal(run.done, 0);
  assert.equal(run.status, 'running');
  assert.equal(run.pause, true);
  assert.deepEqual(run.results, []);
  assert.equal(bulk.bulkChapterDeleteFinished(run), false);
  assert.equal(bulk.bulkChapterDeleteFinished({ ...run, status: 'interrupted' }), true);
});

test('the progress dialog exposes cancellation and durable per-series terminal results', () => {
  const src = readFileSync(join(__dirname, '../components/BulkChapterDeleteRun.tsx'), 'utf8');
  assert.match(src, /data-bulk-delete-run=\{run\.status\}/, 'the run status is not exposed to the browser walk');
  assert.match(src, /data-cancel-bulk-delete/, 'an active cleanup has no cancel control');
  assert.match(src, /disabled=\{cancelling \|\| run\.cancelRequested\}/, 'cancel can be submitted repeatedly');
  assert.match(src, /run\.results\.map\(/, 'terminal per-series results are missing');
  assert.match(src, /data-bulk-delete-result=\{result\.outcome\}/, 'result outcomes are not exposed to the browser walk');
  assert.match(src, /result\.kept \? keptCount\(result\.kept\)/, 'per-series kept-file counts are hidden');
  assert.match(src, /result\.paused \? tr\('Updates stopped'\)/, 'per-series pause state is hidden');
  assert.match(src, /result\.message/, 'a refusal or unlink failure loses its explanation');
});
