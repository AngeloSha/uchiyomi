import test from 'node:test';
import assert from 'node:assert/strict';
import { retryReaderImage, versionedImageBook } from '../lib/readerImageRetry';

test('a failed versioned page refreshes its chapter metadata before retrying the image', async () => {
  const steps: string[] = [];
  let done!: () => void;
  const pending = new Promise<void>((r) => { done = r; });
  const retry = retryReaderImage('/img/books/book%2Fone/page/7?fit=900&cv=old&r=1', async (id) => {
    steps.push(`refresh:${id}`); await pending; steps.push('new page metadata');
  }, () => { steps.push('retry image'); });
  assert.deepEqual(steps, ['refresh:book/one']);
  done(); await retry;
  assert.deepEqual(steps, ['refresh:book/one', 'new page metadata', 'retry image']);
});
test('offline and ordinary unversioned retries never contact the server', async () => {
  for (const src of ['blob:http://127.0.0.1/id', 'data:image/png;base64,AA==', '/img/books/book/page/1', '/img/books/book/thumb?cv=version']) {
    let refreshed = false, retried = false;
    await retryReaderImage(src, async () => { refreshed = true; }, () => { retried = true; });
    assert.equal(refreshed, false, src);
    assert.equal(retried, true, src);
  }
});
test('a metadata outage still leaves the normal retry available; malformed URLs cannot select a chapter', async () => {
  let retried = false;
  await retryReaderImage('/img/books/book/page/1?cv=version', async () => { throw new Error('offline'); }, () => { retried = true; });
  assert.equal(retried, true);
  assert.equal(versionedImageBook('/img/books/%ZZ/page/1?cv=old'), null);
  assert.equal(versionedImageBook('/img/books/book/page/1?unrelated=cv'), null);
});
