// The series page's one reading button (v0.60.0, lib/continueLabel.ts): which chapter it opens and what it says.
//
// It opened the lowest unfinished chapter and said "Start reading" over it -- after chapters 1 to 10 were read -- and
// "Start reading · Ch. 1" once every chapter was. Each of the five answers is run here on a chapter list, and the page
// is read from source for the one thing a pure function cannot show: that the button is drawn from it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { continueChoice, continueText, readCountText, type ContinueBook } from '../lib/continueLabel';
import { setActiveLocale } from '../lib/format';
import { setActiveDict } from '../lib/i18n';

setActiveLocale('en');
setActiveDict({});

const ROOT = join(__dirname, '..');
const code = (src: string): string => src.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

type B = ContinueBook & { downloaded?: boolean };
const DAY = 86_400_000;
/** Chapter `n`: `done` finished, a page number for part-read, `at` days ago for its progress' date. */
const ch = (n: number, o: { done?: boolean; page?: number; at?: number; pruned?: boolean; downloaded?: boolean; name?: string } = {}): B => ({
  id: `b${n}`, number: n, metadata: { numberSort: n }, media: { pagesCount: 20 }, chapterName: o.name ?? null,
  pruned: o.pruned, downloaded: o.downloaded,
  readProgress: o.done ? { page: 20, completed: true } : o.page !== undefined
    ? { page: o.page, completed: false, ...(o.at !== undefined ? { readDate: new Date(Date.now() - o.at * DAY).toISOString() } : {}) }
    : null,
});
/** The page's own rule: a deleted chapter opens only from this device's copy. */
const openable = (b: B) => !b.pruned || !!b.downloaded;
const choose = (list: B[]) => continueChoice(list, openable);
const said = (list: B[]) => { const c = choose(list); return { kind: c.kind, n: c.book?.number ?? null, ...continueText(c) }; };
const range = (from: number, to: number, o: Parameters<typeof ch>[1] = {}) => Array.from({ length: to - from + 1 }, (_, i) => ch(from + i, o));

test('1–10 read of 20: "Next · Ch. 11", not "Start reading" over chapter 11', () => {
  // The owner's report. Reintroduce the old rule (the lowest unfinished chapter, said as "Start reading"): this fails.
  const list = [...range(1, 10, { done: true }), ...range(11, 20)];
  assert.deepEqual(said(list), { kind: 'next', n: 11, label: 'Next · Ch. 11', caption: '' });
  // The chapter's own name, when its source gave one, is the line under the button: the label already has its number.
  list[10] = ch(11, { name: 'The Return' });
  assert.equal(said(list).caption, 'The Return');
});

test('everything read: "Read again", which opens the first chapter', () => {
  // It said "Start reading · Ch. 1". Reintroduce that: this fails.
  const r = said(range(1, 5, { done: true }));
  assert.deepEqual(r, { kind: 'again', n: 1, label: 'Read again', caption: 'Ch. 1' });
});

test('nothing read: "Start reading", and the line under it names the chapter it opens', () => {
  assert.deepEqual(said(range(1, 3)), { kind: 'start', n: 1, label: 'Start reading', caption: 'Ch. 1' });
  // "Mark unread" writes page 0: that chapter is unread, not one to continue.
  assert.equal(said([ch(1, { page: 0 }), ch(2)]).kind, 'start');
});

test('a chapter part-read: "Continue · Ch. n", with how far into it', () => {
  const list = [...range(1, 4, { done: true }), ch(5, { page: 7 }), ...range(6, 9)];
  assert.deepEqual(said(list), { kind: 'continue', n: 5, label: 'Continue · Ch. 5', caption: 'page 7 of 20' });
  list[4] = { ...ch(5, { page: 7, name: 'Into the Rift' }) };
  assert.equal(said(list).caption, 'Into the Rift · page 7 of 20');
  // Part-read beats finished: the reader is in the middle of something.
  assert.equal(said([ch(1, { done: true }), ch(2, { done: true }), ch(3, { page: 2 })]).kind, 'continue');
});

test('several chapters part-read: the most recently read one wins, the lowest when the progress carries no dates', () => {
  // On a long series an abandoned half-read chapter sits far below where the reader is. Reintroduce "the lowest
  // part-read chapter" alone: the dated case fails.
  const dated = [ch(3, { page: 4, at: 30 }), ch(4, { done: true }), ch(9, { page: 2, at: 1 }), ch(12, { page: 6, at: 5 })];
  assert.equal(said(dated).n, 9, 'the most recently read part-read chapter does not win');
  assert.equal(said(dated).label, 'Continue · Ch. 9');
  assert.equal(said([ch(3, { page: 4 }), ch(9, { page: 2 })]).n, 3, 'without dates, the lowest');
  // A date in lastModified counts as well, and one chapter with a date beats those without.
  const mixed = [ch(2, { page: 1 }), { ...ch(6, { page: 3 }), readProgress: { page: 3, completed: false, lastModified: new Date(Date.now() - DAY).toISOString() } }];
  assert.equal(said(mixed).n, 6);
});

test('next: after the highest finished chapter, past one that cannot be opened; else the lowest unread', () => {
  // Chapter 11 was deleted from the server and is not on this device: the button opens 12.
  const gap = [...range(1, 10, { done: true }), ch(11, { pruned: true }), ...range(12, 14)];
  assert.equal(said(gap).label, 'Next · Ch. 12');
  // ...but saved on this device, it opens: that copy is the last one left.
  gap[10] = ch(11, { pruned: true, downloaded: true });
  assert.equal(said(gap).label, 'Next · Ch. 11');
  // The newest chapter read first, the rest not: nothing after it, so the lowest unread.
  assert.equal(said([...range(1, 9), ch(10, { done: true })]).label, 'Next · Ch. 1');
  // A finished tombstone still says how far the reader is.
  assert.equal(said([ch(1, { done: true }), ch(2, { done: true, pruned: true }), ch(3)]).label, 'Next · Ch. 3');
  // A part-read chapter that cannot be opened is not one to continue.
  assert.equal(said([ch(1, { done: true }), ch(2, { page: 5, pruned: true }), ch(3)]).label, 'Next · Ch. 3');
});

test('none: nothing that can be opened, or no chapters at all', () => {
  assert.deepEqual(said([]), { kind: 'none', n: null, label: 'Nothing to read yet', caption: '' });
  assert.equal(said([ch(1, { pruned: true }), ch(2, { pruned: true, done: true })]).kind, 'none');
  // Every chapter finished but one that cannot be opened: read again from the first that can.
  assert.equal(said([ch(1, { done: true }), ch(2, { pruned: true })]).label, 'Read again');
});

test('the list is read in its own order, whatever order it arrives in', () => {
  const shuffled = [ch(12), ch(3, { done: true }), ch(1, { done: true }), ch(2, { done: true }), ch(4)];
  assert.equal(said(shuffled).label, 'Next · Ch. 4');
  // numberSort is the order where it differs from the number (a volume numbered after its chapters, say).
  const sorted = [{ ...ch(5, { done: true }), metadata: { numberSort: 1 } }, { ...ch(1), metadata: { numberSort: 2 } }];
  assert.equal(said(sorted).label, 'Next · Ch. 1');
});

test('a volume, a range file and a decimal say themselves the way the chapter rows do', () => {
  assert.equal(said([ch(1, { done: true }), { ...ch(2), name: 'Vol 2.cbz' }]).label, 'Next · Vol. 2');
  assert.equal(said([{ ...ch(1), numberEnd: 7 }]).caption, 'Ch. 1–7');
  assert.equal(said([ch(1, { done: true }), { ...ch(1.5), metadata: { numberSort: 1.5, number: '1.5' } }]).label, 'Next · Ch. 1.5');
});

test('how far through the series: "10 of 50 read", nothing without chapters', () => {
  assert.equal(readCountText(10, 50), '10 of 50 read');
  assert.equal(readCountText(0, 1), '0 of 1 read');
  assert.equal(readCountText(3, 0), null, 'a series with no chapters says a count');
  assert.equal(readCountText(9, 4), '4 of 4 read', 'more read than there are');
});

test('the page draws its button, its line and its count from these', () => {
  // Reintroduce the old label (`inProgress ? tr('Continue') : tr('Start reading')`) or the old pick
  // (`c.find((b) => !b.readProgress?.completed …)`): this fails.
  const page = code(readFileSync(join(ROOT, 'app/series/page.tsx'), 'utf8'));
  assert.match(page, /const openable = \(b: Book\) => !b\.pruned \|\| downloaded\.has\(b\.id\);\s*return continueChoice\(books\?\.content \?\? \[\], openable\);/,
    'the button does not choose with the page\'s openable rule');
  assert.match(page, /const ctaText = books \|\| nothingYet \? continueText\(reading\)/, 'the button\'s words are not continueText\'s');
  assert.match(page, /<ContinueButton label=\{ctaText\.label\} disabled=\{!resumeBook\} onOpen=\{openReader\} \/>/);
  assert.match(page, /<ContinueButton compact label=\{ctaText\.label\} disabled=\{!resumeBook\} onOpen=\{openReader\} \/>/, 'the phone bar says something else');
  assert.match(page, /const readLine = readCountText\(readCount\.read, readCount\.total\);/);
  assert.doesNotMatch(page, /\binProgress\b|tr\('Continue'\)/, 'the old label is back');
});
