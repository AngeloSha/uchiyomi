// The three answers the reader can get when it opens a chapter, and why they must stay three.
//
// This decision lived as inline conditions that collapsed them into two, in both places it was made:
//
//   first load:  `if (!alive || !first) { setReady(true); return; }`
//                -- a failure became "nothing more to do", which cleared the loading overlay and left a
//                   full-screen black rectangle with no message and no way back.
//
//   mid-series:  `if (ch && ch.pages.length) ... else { setEnded(true); }`
//                -- a failure became the end of the series, so a damaged file or a dropped connection
//                   rendered the "You finished" card over a series the reader was halfway through.
//
// The two failures also come from different places and need different words: a corrupt CBZ or an unmounted
// library answers 200 with an empty page list, while a deleted or not-permitted book throws 404.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chapterOutcome } from '../lib/readerState';

test('a chapter with pages opens', () => {
  assert.equal(chapterOutcome({ pages: [{ number: 1 }] }), 'ok');
});

test('a chapter that resolved with no pages is unreadable, not finished', () => {
  // 200 [] — the corrupt-CBZ and unmounted-library case, from ownedCatalog's `.catch(() => [])`
  assert.equal(chapterOutcome({ pages: [] }), 'unreadable');
});

test('a chapter that would not load at all is unavailable, not finished', () => {
  // the 404 case: deleted, hidden, or never this account's to see
  assert.equal(chapterOutcome(null), 'unavailable');
  assert.equal(chapterOutcome(undefined), 'unavailable');
});

test('the two failures stay distinguishable from each other', () => {
  assert.notEqual(chapterOutcome({ pages: [] }), chapterOutcome(null),
    'they have different causes and the reader is told different things; collapsing them is the bug');
});
