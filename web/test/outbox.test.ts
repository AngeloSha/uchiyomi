// The offline progress outbox: what may and may not throw away something somebody read.
//
// This queue holds reading that has not reached the server yet -- the chapters finished on a plane, on the
// tube, or anywhere the signal went. It used to count every failure the same way and delete an entry on the
// fifth: `api()` throws identically for a dead network, a 401 while the session is refreshing, a 429 and a
// 500 as it does for a bad payload. Since the app flushes 4s after every launch and on every `online` event,
// a weekend of bad signal, or a captive portal on landing, silently erased the lot.
//
// The service worker's copy of this exact queue always drew the line at a permanent 4xx instead. The two
// implementations disagreeing is what showed this one up, so these tests pin the SW's rule as the shared one.
//
// The second bug here is quieter: `getAllKeys` and `getAll` were two separate IDB transactions, so a
// concurrent SW flush landing between them shifted the arrays out of step and a failure on one entry deleted
// a different one. Keys now come off the records themselves.
import 'fake-indexeddb/auto';
import test, { before } from 'node:test';
import assert from 'node:assert/strict';

process.env.NEXT_PUBLIC_API_BASE = '';

type Reply = { status: number } | { throws: true };
let replies: Reply[] = [];
let calls = 0;

globalThis.fetch = (async () => {
  const r = replies[Math.min(calls, replies.length - 1)];
  calls++;
  if ('throws' in r) throw new TypeError('Failed to fetch'); // what a dead network actually looks like
  return new Response(r.status === 204 ? null : '{}', {
    status: r.status,
    headers: { 'content-type': 'application/json' },
  });
}) as any;

// Loaded in `before` rather than at the top level: tsx emits CJS, which rejects top-level await.
let queueProgress: typeof import('../lib/downloads').queueProgress;
let flushOutbox: typeof import('../lib/downloads').flushOutbox;
let openDB: typeof import('idb').openDB;

before(async () => {
  ({ queueProgress, flushOutbox } = await import('../lib/downloads'));
  ({ openDB } = await import('idb'));
  // Let the app create its own schema first. Opening 'yomi-offline' here without an upgrade callback would
  // otherwise create an empty v1 database, and the real one would then never get its object stores.
  await flushOutbox();
});

const outbox = async () => {
  const d = await openDB('yomi-offline', 1);
  const all = await d.getAll('outbox');
  d.close();
  return all;
};

async function reset(rs: Reply[]) {
  const d = await openDB('yomi-offline', 1);
  const tx = d.transaction('outbox', 'readwrite');
  await tx.objectStore('outbox').clear();
  await tx.done;
  d.close();
  replies = rs;
  calls = 0;
}

test('a 2xx clears the entry', async () => {
  await reset([{ status: 200 }]);
  await queueProgress({ bookId: 'b1', seriesId: 's1', page: 4, completed: false });
  assert.equal(await flushOutbox(), 1);
  assert.equal((await outbox()).length, 0);
});

test('a dead network keeps the entry queued, however many times it happens', async () => {
  await reset([{ throws: true }]);
  await queueProgress({ bookId: 'b1', seriesId: 's1', page: 12, completed: true });
  for (let i = 0; i < 8; i++) await flushOutbox(); // more than the old five-strike limit
  const left = await outbox();
  assert.equal(left.length, 1, 'a network that is down is not a reason to delete what someone read');
  assert.equal(left[0].page, 12, 'and the event must survive intact, not just its slot');
});

test('a 500 keeps the entry queued', async () => {
  await reset([{ status: 500 }]);
  await queueProgress({ bookId: 'b1', page: 3, completed: false });
  for (let i = 0; i < 8; i++) await flushOutbox();
  assert.equal((await outbox()).length, 1, 'the server being broken is the server’s problem, not the reader’s');
});

test('a 401 and a 429 keep the entry queued', async () => {
  for (const status of [401, 429]) {
    await reset([{ status }]);
    await queueProgress({ bookId: 'b1', page: 3, completed: false });
    for (let i = 0; i < 8; i++) await flushOutbox();
    assert.equal((await outbox()).length, 1, `${status} is transient and must not discard progress`);
  }
});

test('a permanent 4xx does drop the entry, so one bad record cannot wedge the queue', async () => {
  await reset([{ status: 404 }]);
  await queueProgress({ bookId: 'gone', page: 1, completed: false });
  await flushOutbox();
  assert.equal((await outbox()).length, 0, 'a deleted book is a permanent rejection');
});

test('a failure deletes only its own entry, never a neighbour', async () => {
  // The desync bug: with keys read in a separate transaction, a failure on one row deleted whatever happened
  // to sit at the same index in the other array.
  await reset([{ status: 500 }, { status: 200 }, { status: 500 }]);
  await queueProgress({ bookId: 'keep-a', page: 1, completed: false });
  await queueProgress({ bookId: 'sent', page: 2, completed: false });
  await queueProgress({ bookId: 'keep-b', page: 3, completed: false });
  await flushOutbox();
  const left = (await outbox()).map((e: any) => e.bookId).sort();
  assert.deepEqual(left, ['keep-a', 'keep-b'], 'only the delivered entry should be gone');
});
