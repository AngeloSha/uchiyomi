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

test('only a source that may be asked, else the chosen copy', () => {
  const own = c('main'), a = c('a');
  assert.equal(routeCopy(own, [a], { may: (s) => s === 'a', load: () => 0, slowed: none }).source, 'a');
  assert.equal(routeCopy(own, [a], { may: () => false, load: () => 0, slowed: none }).source, 'main');
});
