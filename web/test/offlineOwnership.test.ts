// Who an offline chapter belongs to, on a device more than one person signs into.
//
// The reader consults this store BEFORE any server call: `loadChapter` in app/reader/page.tsx returns the
// offline copy and never asks. So the store is not a cache in front of an authorisation check, it IS the
// authorisation check for anything downloaded. In v1 it had no concept of an owner at all: `chapters` was
// keyed by bookId and `pages` by `bookId:n`, with no account anywhere and nothing cleared on sign-out.
//
// The consequence on a shared tablet: A downloads chapters, signs out, B signs in, and B can open A's
// chapters by navigating to those book ids, with `visible()` never consulted, so the age cap and the
// per-library grants are both bypassed. That is the same hole the v0.11.0 sign-out purge closed for cached
// API responses, left open on the larger and more permanent store beside it.
//
// The outbox has the quieter half of the same problem: it flushes as whoever is signed in at that moment,
// which is not necessarily who turned the pages.
import 'fake-indexeddb/auto';
import test, { before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const A = 'user-aaaa-1111';
const B = 'user-bbbb-2222';

let dl: typeof import('../lib/downloads');
let setCurrentUser: typeof import('../lib/api').setCurrentUser;

/** Page bytes and the manifest, so downloadChapter can run without a server. */
let sent: any[] = [];
globalThis.fetch = (async (url: any, init?: any) => {
  const u = String(url);
  sent.push({ url: u, body: init?.body ? JSON.parse(init.body) : undefined });
  if (u.includes('/download-manifest')) {
    return new Response(JSON.stringify({
      seriesId: 's1', seriesTitle: 'A Series', title: 'Chapter 1', number: '1',
      pageCount: 2, totalBytes: 20, readingDirection: 'WEBTOON',
      pages: [{ number: 1, url: '/p/1', width: 800, height: 1200 }, { number: 2, url: '/p/2', width: 800, height: 1200 }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (u.startsWith('/p/')) return new Response(new Blob(['x'.repeat(10)]), { status: 200 });
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
}) as any;

before(async () => {
  dl = await import('../lib/downloads');
  ({ setCurrentUser } = await import('../lib/api'));
  await dl.flushOutbox(); // forces the schema to be created by the app, not by a bare openDB
});

beforeEach(() => { sent = []; });

test('a chapter downloaded by one account is invisible to another', async (t) => {
  setCurrentUser(A);
  await dl.downloadChapter('bk1');

  await t.test('its owner can see it', async () => {
    setCurrentUser(A);
    assert.equal(await dl.isDownloaded('bk1'), true);
    assert.ok(await dl.getOfflineChapter('bk1'), 'the meta record');
    assert.ok(await dl.getPageBlob('bk1', 1), 'and the page bytes');
    assert.equal((await dl.listDownloads()).length, 1);
  });

  await t.test('the next person on the device cannot', async () => {
    setCurrentUser(B);
    assert.equal(await dl.isDownloaded('bk1'), false, 'B must not be told the chapter is available');
    assert.equal(await dl.getOfflineChapter('bk1'), undefined,
      'this is the one that matters: the reader returns this BEFORE asking the server, so a hit here is a read');
    assert.equal(await dl.getPageBlob('bk1', 1), undefined, 'nor the page bytes behind it');
    assert.deepEqual(await dl.listDownloads(), [], 'and it must not appear in their downloads list');
  });

  await t.test('signing back in restores it, so this is scoping and not deletion', async () => {
    setCurrentUser(A);
    assert.equal(await dl.isDownloaded('bk1'), true);
  });

  await t.test('B deleting the same book id does not touch A copy', async () => {
    setCurrentUser(B);
    await dl.deleteDownload('bk1');
    setCurrentUser(A);
    assert.equal(await dl.isDownloaded('bk1'), true, 'B has no reach into A records at all, including delete');
    assert.ok(await dl.getPageBlob('bk1', 1), 'the pages survived too');
  });

  await t.test('and signed out, nothing is reachable', async () => {
    setCurrentUser(null);
    assert.equal(await dl.isDownloaded('bk1'), false);
    assert.deepEqual(await dl.listDownloads(), []);
  });
});

test('queued reading is flushed by the account that did the reading', async (t) => {
  setCurrentUser(A);
  await dl.queueProgress({ bookId: 'bk9', seriesId: 's1', page: 7, completed: false });

  await t.test('a different account does not send it', async () => {
    setCurrentUser(B);
    const n = await dl.flushOutbox();
    assert.equal(n, 0, "B must not file A's reading against B's history, streaks and leaderboard");
  });

  await t.test('but it is kept, not discarded', async () => {
    setCurrentUser(A);
    const n = await dl.flushOutbox();
    assert.equal(n, 1, 'it waits for its owner to come back rather than being thrown away');
  });
});
