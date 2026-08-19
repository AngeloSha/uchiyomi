// Chapter vs volume labelling. Old manga is often stored as tomes (CBR per volume), and labelling those
// "Ch. 1" misreads the library.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isVolumeName, chapterLabel, bytes, progressOf } from '../lib/format';

test('recognises volume-style names', () => {
  for (const n of ['Tome 01', 'tome12', 'Volume 12', 'Vol. 3', 'vol.3', 'T05', 'v01', 'Berserk T41', 'Naruto Tome 07 (FR)']) {
    assert.equal(isVolumeName(n), true, `${n} should be a volume`);
  }
});

test('chapter markers win over volume markers', () => {
  // a release-version suffix must not turn a chapter into a volume
  assert.equal(isVolumeName('Ch. 5 v2'), false);
  assert.equal(isVolumeName('Chapter 12'), false);
  assert.equal(isVolumeName('Chapitre 4'), false);
  assert.equal(isVolumeName('Episode 3'), false);
});

test('does not mistake ordinary titles for volumes', () => {
  for (const n of ['One Piece 1045', 'Titan 05', 'Revolution 5', 'Solo Leveling 110']) {
    assert.equal(isVolumeName(n), false, `${n} should not be a volume`);
  }
  assert.equal(isVolumeName(''), false);
  assert.equal(isVolumeName(null), false);
});

test('chapterLabel picks the right noun', () => {
  assert.equal(chapterLabel({ number: 1, name: 'Tome 01' }), 'Vol. 1');
  assert.equal(chapterLabel({ number: 12, name: 'Chapter 12' }), 'Ch. 12');
  assert.equal(chapterLabel({ metadata: { number: '4.5' }, name: 'Chapter 4.5' }), 'Ch. 4.5');
  assert.equal(chapterLabel({ name: 'Extras' }), 'Extras', 'no number -> fall back to the name');
  assert.equal(chapterLabel({}), '');
});

test('bytes formats human sizes', () => {
  assert.match(bytes(0), /0/);
  assert.match(bytes(2_500_000), /MB/i);
  assert.equal(bytes(null), bytes(0));
});

test('progressOf reports a 0..1 fraction for the progress bar', () => {
  assert.equal(progressOf({ media: { pagesCount: 100 }, readProgress: { page: 50, completed: false } }), 0.5);
  assert.equal(progressOf({ media: { pagesCount: 100 }, readProgress: { page: 10, completed: true } }), 1, 'completed is always full');
  assert.equal(progressOf({ media: { pagesCount: 100 }, readProgress: { page: 250, completed: false } }), 1, 'never overflows the bar');
  assert.equal(progressOf({ media: { pagesCount: 0 } }), 0, 'unknown page count must not divide by zero');
  assert.equal(progressOf({ media: { pagesCount: 100 } }), 0, 'unread');
});
