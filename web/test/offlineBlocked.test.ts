// The v0.11.1 regression: an upgrade nobody could complete, and a reader that waited for it forever.
//
// An IndexedDB version change waits for every OTHER open connection to close first. The service worker held
// one open (it opened `yomi-offline` for the outbox flush and never closed it on any path), so the page's
// v1 to v2 upgrade fired `blocked` and, with no handler, the promise never settled. `loadChapter` awaits the
// offline lookup before anything else, so every chapter showed "Loading chapter..." indefinitely, for
// everyone who already had the old database. A fresh browser creates v2 directly and never blocks, which is
// exactly why the browser end-to-end pass did not catch it.
//
// Its own file because it deliberately squats on the database at the old version, which is not something the
// other offline tests can have happening underneath them.
import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.fetch = (async (url: any) => {
  const u = String(url);
  if (u.includes('/download-manifest')) {
    return new Response(JSON.stringify({
      seriesId: 's1', seriesTitle: 'S', title: 'Chapter 1', number: '1', pageCount: 1, totalBytes: 10,
      pages: [{ number: 1, url: '/p/1', width: 8, height: 12 }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (u.startsWith('/p/')) return new Response(new Blob(['x']), { status: 200 });
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
}) as any;

// The v0.11.1 regression: an upgrade nobody could complete, and a reader that waited for it forever.
//
// An IndexedDB version change waits for every OTHER open connection to close first. The service worker held
// one open (it opened `yomi-offline` for the outbox flush and never closed it on any path), so the page's
// v1 to v2 upgrade fired `blocked` and, with no handler, the promise never settled. `loadChapter` awaits the
// offline lookup before anything else, so every chapter showed "Loading chapter..." indefinitely.
//
// Two things are pinned here. The store must answer "nothing here" rather than hanging or throwing, and it
// must recover once the other connection lets go, instead of caching the failure forever.
test('a blocked upgrade degrades to online reading instead of hanging', async (t) => {
  const { openDB, deleteDB } = await import('idb');
  const fresh = await import('../lib/downloads');

  await deleteDB('yomi-offline').catch(() => {});
  // Somebody else is holding the store at the old version, exactly as the leaked worker connection did.
  const squatter = await openDB('yomi-offline', 1, {
    upgrade(d) {
      d.createObjectStore('chapters', { keyPath: 'bookId' });
      d.createObjectStore('pages');
      d.createObjectStore('outbox', { keyPath: 'id', autoIncrement: true });
    },
  });

  try {
    await t.test('the reader gets an answer, and gets it quickly', async () => {
      const started = Date.now();
      const got = await Promise.race([
        fresh.getOfflineChapter('bk-blocked'),
        new Promise((r) => setTimeout(() => r('HUNG'), 6000)),
      ]);
      assert.notEqual(got, 'HUNG', 'this is the bug: the promise never settled and the spinner never cleared');
      assert.equal(got, undefined, 'an unopenable store means "not downloaded", not an exception');
      assert.ok(Date.now() - started < 6000, 'and it must not sit on the deadline every single call');
    });

    await t.test('the other reads degrade the same way', async () => {
      assert.equal(await fresh.isDownloaded('bk-blocked'), false);
      assert.deepEqual(await fresh.listDownloads(), []);
      assert.equal(await fresh.getPageBlob('bk-blocked', 1), undefined);
      assert.equal(await fresh.flushOutbox(), 0);
    });
  } finally {
    squatter.close();
  }

  await t.test('and it recovers once the other connection lets go', async () => {
    const { setCurrentUser } = await import('../lib/api');
    setCurrentUser('user-aaaa-1111');
    await fresh.downloadChapter('bk-after');
    assert.equal(await fresh.isDownloaded('bk-after'), true,
      'the failure must not have been cached: a blocked upgrade clears the moment the blocker closes');
  });
});
