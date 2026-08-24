// A value shown once has to survive a remount.
//
// The bug this guards: changing the language remounts the whole app subtree, and three screens hold a secret
// in component state that the server only ever sends once. Tapping a language chip while one is displayed
// destroyed it permanently. This is a unit test of the store, so it runs without a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { clearShownOnce, readShownOnce, writeShownOnce } from '../lib/shownOnce';

test('shown-once values', async (t) => {
  t.beforeEach(() => clearShownOnce());

  await t.test('a written value reads back, which is the whole point', () => {
    assert.equal(readShownOnce<string>('opds'), null, 'nothing before anything is written');
    writeShownOnce('opds', 'sekrit-token');
    // A remount constructs a fresh component and asks again. Same module, same map.
    assert.equal(readShownOnce<string>('opds'), 'sekrit-token');
  });

  await t.test('null forgets it rather than storing a null', () => {
    writeShownOnce('api', 'abc');
    writeShownOnce('api', null);
    assert.equal(readShownOnce<string>('api'), null);
  });

  await t.test('keys do not collide', () => {
    writeShownOnce('opds', 'one');
    writeShownOnce('api', 'two');
    writeShownOnce('recovery', ['a', 'b']);
    assert.equal(readShownOnce<string>('opds'), 'one');
    assert.equal(readShownOnce<string>('api'), 'two');
    assert.deepEqual(readShownOnce<string[]>('recovery'), ['a', 'b']);
  });

  await t.test('sign-out clears everything, so a shared machine does not leak the last token', () => {
    writeShownOnce('opds', 'one');
    writeShownOnce('api', 'two');
    clearShownOnce();
    assert.equal(readShownOnce<string>('opds'), null);
    assert.equal(readShownOnce<string>('api'), null);
  });
});
