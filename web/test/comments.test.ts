// Chapter comments and reactions (v0.87.0), the web's half: the words the strip, the key and the sheet say
// (lib/comments.ts), and the reader's promise that the strip where two chapters meet is exactly as tall as the room it
// keeps for it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REACTIONS, commentsLine, myReaction, reactedLine, reactionCounts, type TalkReaction } from '../lib/comments';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const person = (name: string) => ({ id: name.toLowerCase(), name, avatar: {} });
const r = (name: string, emoji: (typeof REACTIONS)[number], mine = false): TalkReaction => ({ user: person(name), emoji, mine });
/** The words without the isolation marks around each name. */
const plain = (s: string) => s.replace(/[⁨⁩]/g, '');

test('who reacted, in words: you first, two names at most, the rest counted', () => {
  assert.equal(reactedLine([]), '');
  assert.equal(reactedLine([r('Me', '❤️', true)]), 'You reacted');
  assert.equal(plain(reactedLine([r('Mostafa', '😂')])), 'Mostafa reacted');
  assert.equal(plain(reactedLine([r('Mostafa', '😂'), r('Noura', '🔥')])), 'Mostafa and Noura reacted');
  assert.equal(plain(reactedLine([r('Mostafa', '😂'), r('Me', '❤️', true)])), 'You and Mostafa reacted', 'you are named first');
  assert.equal(plain(reactedLine([r('A', '😂'), r('B', '😂'), r('C', '😭')])), 'A, B and 1 other reacted');
  assert.equal(plain(reactedLine([r('A', '😂'), r('Me', '❤️', true), r('B', '😭')])), 'You, A and 1 other reacted');
  assert.equal(plain(reactedLine([r('A', '😂'), r('Me', '❤️', true), r('B', '😭'), r('C', '😭')])), 'You, A and 2 others reacted');
  assert.equal(plain(reactedLine([r('A', '😂'), r('B', '😂'), r('C', '😭'), r('D', '😱')])), 'A, B and 2 others reacted');
  assert.equal(plain(reactedLine([r('A', '😂'), r('B', '😂'), r('C', '😭'), r('D', '😱'), r('E', '🤯')])), 'A, B and 3 others reacted');
  // Reintroduce by dropping the isolation: an Arabic name inside an English sentence reorders the words around it.
  assert.ok(reactedLine([r('مصطفى', '😂')]).includes('⁨مصطفى⁩'), 'each name keeps its own direction');
});

test('the six, counted in their own order, and yours', () => {
  const counts = reactionCounts([r('A', '🔥'), r('B', '😂'), r('Me', '🔥', true)]);
  assert.deepEqual(counts.map((c) => c.emoji), [...REACTIONS], 'always the six, always in this order');
  assert.deepEqual(counts.find((c) => c.emoji === '🔥'), { emoji: '🔥', n: 2, mine: true });
  assert.deepEqual(counts.find((c) => c.emoji === '😂'), { emoji: '😂', n: 1, mine: false });
  assert.equal(counts.find((c) => c.emoji === '❤️')!.n, 0);
  assert.equal(myReaction([r('A', '😂'), r('Me', '😭', true)]), '😭');
  assert.equal(myReaction([r('A', '😂')]), null);
  assert.equal(commentsLine(0), '');
  assert.equal(commentsLine(1), '1 comment');
  assert.equal(commentsLine(3), '3 comments');
});

test("the six reactions are the server's six, byte for byte", () => {
  // Reintroduce by changing one emoji on either side -- "❤" without its emoji presentation, say: the server refuses
  // every tap on that key with a 400.
  const bff = readFileSync(join(ROOT, '..', 'bff', 'src', 'lib', 'comments.ts'), 'utf8');
  const m = bff.match(/export const REACTIONS = \[([^\]]*)\] as const/);
  assert.ok(m, 'the server lists its six');
  const theirs = [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  assert.deepEqual(theirs, [...REACTIONS]);
});

test('the reader reserves the strip it draws', () => {
  // The reader's height model (`tops`) is never measured back from the page: the strip where two chapters meet must be
  // reserved at exactly the height it is drawn, and only while it is drawn. Reintroduce by reserving DIVIDER_H whatever
  // talkOn says: every page below a strip reads as another page.
  const page = read('app/reader/page.tsx');
  assert.match(page, /const dividerH = talkOn \? SEAM_H : DIVIDER_H;/, 'the model takes the strip\'s height while talk is on');
  assert.match(page, /if \(p\.firstOfChapter && p\.ci > 0\) acc \+= dividerH;/, 'and reserves it before a chapter\'s first page');
  assert.doesNotMatch(page, /acc \+= DIVIDER_H/, 'never the old height regardless');
  assert.match(page, /\[flat, colW, prefs\.gap, collapsing, expanded, wideMode, prefs\.cropBorders, sideVersion, dividerH\]/,
    'and the model is worked out again when talk comes or goes');
  assert.match(page, /seam=\{talkOn && p\.firstOfChapter && p\.ci > 0 \?/, 'the row draws the strip only while talk is on');
  const row = read('components/ReaderPage.tsx');
  assert.match(row, /divider != null && seam && onSeam \? \(\s*<ChapterSeam/, 'the row draws the strip in the divider\'s place');
  const talk = read('components/ChapterTalk.tsx');
  const seam = talk.slice(talk.indexOf('export function ChapterSeam'));
  assert.match(seam, /style=\{\{ height: SEAM_H \}\}/, 'and the strip is exactly SEAM_H tall');
});
