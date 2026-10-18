// routeCopy's order (v0.81.0, lib/copyRouter.ts), with the pace and the gate handed in.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
process.env.CONFIG_DIR ||= '/tmp/uchiyomi-test-config';

let routeCopy: typeof import('../src/lib/copyRouter').routeCopy;
before(async () => { ({ routeCopy } = await import('../src/lib/copyRouter')); });

const c = (source: string) => ({ source, sourceId: `${source}-1`, number: 1 });
const none = () => false;

test('the quietest image server, with the chosen copy winning a tie', () => {
  const own = c('main'), a = c('a'), b = c('b');
  const load = (k: string) => ({ main: 2, a: 1, b: 0 } as Record<string, number>)[k] ?? 0;
  // Reintroduce by dropping the load from the order: the chosen copy is taken.
  assert.equal(routeCopy(own, [a, b], { may: () => true, load, slowed: none }).source, 'b');
  assert.equal(routeCopy(own, [a], { may: () => true, load: () => 0, slowed: none }).source, 'main', 'a tie keeps the chosen copy');
});

test('full speed first, then not the source that failed it, then the load', () => {
  const own = c('main'), a = c('a'), b = c('b');
  const load = (k: string) => ({ main: 0, a: 5, b: 9 } as Record<string, number>)[k] ?? 0;
  assert.equal(routeCopy(own, [a, b], { may: () => true, load, slowed: (s) => s === 'main' }).source, 'a', 'a slowed site goes after one at full speed, however quiet');
  assert.equal(routeCopy(own, [a, b], { may: () => true, load, slowed: none, blamed: 'main' }).source, 'a', 'the source that failed it goes after its twins');
});

test('only a source that may be asked; a chosen copy that may not is left to the fallback helper', () => {
  const own = c('main'), a = c('a'), b = c('b');
  const load = (k: string) => ({ main: 9, a: 0, b: 0 } as Record<string, number>)[k] ?? 0;
  assert.equal(routeCopy(own, [a, b], { may: (s) => s !== 'a', load, slowed: none }).source, 'b');
  // The chosen copy's own source is refusing: untouched, the fallback helper switches it and says so.
  assert.equal(routeCopy(own, [a], { may: (s) => s === 'a', load: () => 0, slowed: none }).source, 'main');
});

test('the main at full speed wins over a backup on a quieter server; a slowed or blamed main gives way to it', () => {
  // v0.82.0: a backup extension's copy (lib/backupExtensions.ts) is taken only when the main's is slowed or failed this
  // chapter last -- never because the backup's image server is quieter, which would keep it in use, and installed, for
  // good. Reintroduce by dropping the backup's turn from the order: the backup is taken on the first line.
  const own = c('main'), spare = c('spare');
  const load = (k: string) => ({ main: 4, spare: 0 } as Record<string, number>)[k] ?? 0;
  const backup = (s: string) => s === 'spare';
  assert.equal(routeCopy(own, [spare], { may: () => true, load, slowed: none, backup }).source, 'main', 'the main at full speed');
  assert.equal(routeCopy(own, [spare], { may: () => true, load, slowed: (s) => s === 'main', backup }).source, 'spare', 'a slowed main gives way');
  assert.equal(routeCopy(own, [spare], { may: () => true, load, slowed: none, blamed: 'main', backup }).source, 'spare', 'so does the one that failed it');
  // And a backup's copy chosen by the release rules gives way to the main's, the same release, at full speed.
  assert.equal(routeCopy(spare, [own], { may: () => true, load, slowed: none, backup }).source, 'main');
});
