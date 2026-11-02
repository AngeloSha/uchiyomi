import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDB } from 'idb';
import { nativeHost, usesNativeCache, publicServerURL } from '../lib/native';

test('only the explicit supported iOS host opts out of the PWA cache', () => {
  const saved = (globalThis as any).window;
  try {
    delete (globalThis as any).window;
    assert.equal(nativeHost(), null);
    for (const marker of [undefined, { platform: 'desktop', protocolVersion: 1 }, { platform: 'ios', protocolVersion: 2 }]) {
      (globalThis as any).window = { uchiyomiNative: marker };
      assert.equal(usesNativeCache(), false);
    }
    (globalThis as any).window = { uchiyomiNative: { platform: 'ios', protocolVersion: 1, serverOrigin: 'https://books.example' } };
    assert.equal(usesNativeCache(), true);
  } finally { (globalThis as any).window = saved; }
});

test('native progress is saved with its account without touching serviceWorker.ready', async () => {
  const savedWindow = (globalThis as any).window;
  const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let workerReads = 0;
  try {
    (globalThis as any).window = { uchiyomiNative: { platform: 'ios', protocolVersion: 1, serverOrigin: 'https://books.example' } };
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
      get serviceWorker() { workerReads++; return { ready: new Promise(() => {}) }; },
    } });
    const { setCurrentUser } = await import('../lib/api');
    const { queueProgress } = await import('../lib/downloads');
    setCurrentUser('native-reader');
    await queueProgress({ bookId: 'offline-chapter', page: 7, completed: false });
    assert.equal(workerReads, 0);
    const db = await openDB('yomi-offline', 2);
    const rows = await db.getAll('outbox');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].userId, 'native-reader');
    assert.equal(rows[0].page, 7);
    db.close();
    setCurrentUser(null);
  } finally {
    (globalThis as any).window = savedWindow;
    if (savedNavigator) Object.defineProperty(globalThis, 'navigator', savedNavigator);
    else delete (globalThis as any).navigator;
  }
});

test('shared native links use the selected public server while browser and external links keep their origins', () => {
  const saved = (globalThis as any).window;
  try {
    (globalThis as any).window = { uchiyomiNative: { platform: 'ios', protocolVersion: 1, serverOrigin: 'https://books.example:8443' } };
    assert.equal(publicServerURL('/series/?id=book%2F1#chapters', 'http://localhost:54321/reader/'), 'https://books.example:8443/series/?id=book%2F1#chapters');
    assert.equal(publicServerURL('https://external.example/article', 'http://localhost:54321/'), 'https://external.example/article');
    delete (globalThis as any).window;
    assert.equal(publicServerURL('/series/?id=one', 'https://browser.example/library/'), 'https://browser.example/series/?id=one');
  } finally { (globalThis as any).window = saved; }
});
