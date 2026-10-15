// MAX_FOLLOWED_SOURCES: how many other sources a series may follow. Two stays the default; an operator may raise it to 20.
import test from 'node:test';
import assert from 'node:assert/strict';
import { followLimit } from '../src/lib/followLimit';

test('two unless the operator says otherwise', () => {
  assert.equal(followLimit(undefined), 2);
  assert.equal(followLimit(''), 2);
  assert.equal(followLimit('not a number'), 2);
  assert.equal(followLimit('0'), 2, '0 is not a limit, it is nothing set');
});

test('a number is taken whole, between 1 and 20', () => {
  assert.equal(followLimit('5'), 5);
  assert.equal(followLimit('3.9'), 3);
  assert.equal(followLimit('1'), 1);
  assert.equal(followLimit('-4'), 1);
  assert.equal(followLimit('500'), 20);
});
