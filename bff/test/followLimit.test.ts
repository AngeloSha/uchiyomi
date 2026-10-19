// How many other sources a series may follow, the env's number (MAX_FOLLOWED_SOURCES): the starting value since v0.89.0,
// when the admin's choice became the limit (Admin -> Settings -> Other sources per series, lib/followLimit.ts, pinned in
// followLimit.int.test.ts). Three by default since v0.80.0 (two before), when the scout began following sources on its
// own; 1 to 10 since v0.89.0 (#305), 1 to 6 before.
import test from 'node:test';
import assert from 'node:assert/strict';

// lib/followLimit.ts reads the admin's choice from the database (never here), so it loads the env check: set it first.
process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
process.env.CONFIG_DIR ||= '/tmp/uchiyomi-test-config';
const load = () => import('../src/lib/followLimit');

test('three unless the operator says otherwise', async () => {
  const { followLimit } = await load();
  assert.equal(followLimit(undefined), 3);
  assert.equal(followLimit(''), 3);
  assert.equal(followLimit('not a number'), 3);
  assert.equal(followLimit('0'), 3, '0 is not a limit, it is nothing set');
  assert.equal(followLimit('2'), 2, 'the old default, set on purpose');
});

test('a number is taken whole, between 1 and 10', async () => {
  const { FOLLOW_LIMIT_MAX, followLimit } = await load();
  // Every follower is one more chapter list per sweep for every series. Reintroduce a ceiling of 20: '500' reads 20.
  assert.equal(FOLLOW_LIMIT_MAX, 10);
  assert.equal(followLimit('5'), 5);
  assert.equal(followLimit('3.9'), 3);
  assert.equal(followLimit('1'), 1);
  assert.equal(followLimit('-4'), 1);
  assert.equal(followLimit('6'), 6);
  assert.equal(followLimit('7'), 7, 'past the old ceiling of six');
  assert.equal(followLimit('10'), 10);
  assert.equal(followLimit('11'), 10);
  assert.equal(followLimit('500'), 10);
});
