// MAX_FOLLOWED_SOURCES: how many other sources a series may follow. Three by default since v0.80.0 (two before), when the
// scout began following sources on its own; an operator may set 1 to 6.
import test from 'node:test';
import assert from 'node:assert/strict';
import { followLimit } from '../src/lib/followLimit';

test('three unless the operator says otherwise', () => {
  assert.equal(followLimit(undefined), 3);
  assert.equal(followLimit(''), 3);
  assert.equal(followLimit('not a number'), 3);
  assert.equal(followLimit('0'), 3, '0 is not a limit, it is nothing set');
  assert.equal(followLimit('2'), 2, 'the old default, set on purpose');
});

test('a number is taken whole, between 1 and 6', () => {
  // Every follower is one more chapter list per sweep for every series. Reintroduce a ceiling of 20: '500' reads 20.
  assert.equal(followLimit('5'), 5);
  assert.equal(followLimit('3.9'), 3);
  assert.equal(followLimit('1'), 1);
  assert.equal(followLimit('-4'), 1);
  assert.equal(followLimit('6'), 6);
  assert.equal(followLimit('7'), 6);
  assert.equal(followLimit('500'), 6);
});
