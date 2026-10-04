// Chapter ordering comes from filenames; getting this wrong shows up as chapters listed out of order.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { numFromName, naturalCmp, chapterName, chapterFromName, numberByRule, NAME_RULE, MAX_RANGE } from '../src/lib/naming';
import { heroFit, aspectDistance } from '../src/lib/heroFrame';

test('numFromName reads the first number, including decimals', () => {
  assert.equal(numFromName('Chapter 12.cbz'), 12);
  assert.equal(numFromName('Ch. 4.5.cbz'), 4.5);
  assert.equal(numFromName('Tome 01.cbr'), 1);
  assert.equal(numFromName('0001.cbz'), 1);
  assert.equal(numFromName('cover.jpg'), 0, 'no number -> 0');
  // Rule 1 stays exactly what it was: every chapter scanned before v0.55.2 is read by it for good.
  assert.equal(numFromName('Vol 3 Chapter 12.cbz'), 3);
  assert.equal(numFromName('Watchmen (1986).cbz'), 1986);
});

// Name rule 2 (v0.55.2, discussion #150), case by case: [file name, number, end of a range or null]. Each group is
// one of chapterFromName's rules, and the comment says what the first number (rule 1) made of it.
const RULE2: Array<[string, number, number | null]> = [
  // The downloader's own names, and plain ones: unchanged.
  ['Chapter 12.cbz', 12, null],
  ['Chapter 12.5.cbz', 12.5, null],
  ['Ch. 4.5.cbz', 4.5, null],
  ['0001.cbz', 1, null],
  ['Tome 01.cbr', 1, null],
  ['Berserk v41.cbz', 41, null],
  ['第12話.cbz', 12, null],
  // 1. A chapter word wins over a volume in front of it (rule 1 read the volume: 3, 3, 2).
  ['Vol 3 Chapter 12.cbz', 12, null],
  ['Vol XXX Chapt 12.cbz', 12, null],
  ['Volume 2 Chapter 5-6.cbz', 5, 6],
  ['Vol.3 Ch.12 - Title.cbz', 12, null],
  ['Ch.12 - Title [Group].cbz', 12, null],
  ['Official_Vol.1 Ch.1 - Romance Dawn.cbz', 1, null],
  ['Team 7_Chapter 12.cbz', 12, null],
  ['Chap.6.cbz', 6, null],
  ['Chapt 8.cbz', 8, null],
  ['ch12.cbz', 12, null],
  ['CHAPTER 9.cbz', 9, null],
  ['Cap. 3.cbz', 3, null],
  ['Capitolo 7 - La fine.cbz', 7, null],
  ['Capítulo 5.cbz', 5, null],
  ['CAPÍTULO 5.cbz', 5, null],
  ['Capitulo 5.cbz', 5, null],
  ['Chapitre 4.cbz', 4, null],
  ['Kapitel 9.cbz', 9, null],
  ['Chapter_12.cbz', 12, null],
  // ...never the inside of a word: these are the first number, as before.
  ['Batch 5.cbz', 5, null],
  ['Escape 5.cbz', 5, null],
  // ...and its short form, standing alone: Kavita's `v01 c001`.
  ['v03 c012.cbz', 12, null],
  ['One Piece v02 c012 [Digital].cbz', 12, null],
  ['Series Name v01c003.cbz', 3, null],
  ['Series Name c001-005.cbz', 1, 5],
  // ...but "(c2c)", the cover-to-cover tag, is no chapter, and two of them say nothing.
  ['Saga 001 (2012) (c2c) (Group).cbz', 1, null],
  ['Pack 2 c5.cbz', 5, null],
  ['Pack 2 c5 c7.cbz', 2, null],
  // ...and a title holding a number after the chapter's: the chapter's.
  ['Chapter 12 - Episode #5.cbz', 12, null],
  ['Ch.12 - 100 Days.cbz', 12, null],
  // 2. An issue number.
  ['Batman #12 (1987).cbz', 12, null],
  ['Amazing Spider-Man (1963) #300.cbz', 300, null],
  ['Batman v2016 #001.cbz', 1, null],
  ['Spider-Man 2099 #1.cbz', 1, null],
  ['Batman # 4.cbz', 4, null],
  // 3. Never a year in brackets (rule 1: 1986, 1986, 1962, 2019) ...
  ['Watchmen (1986) 01 (of 12).cbz', 1, null],
  ['Diabolik (1962) n.1.cbz', 1, null],
  ['[2019] Series 05.cbz', 5, null],
  ['Batman (Jan 1987) 05.cbz', 5, null],
  ['Dylan Dog 001 - L\'alba dei morti viventi (1986).cbr', 1, null],
  ['Tex 001 (1958).cbr', 1, null],
  // ...but a year outside them is a number like any other, and so is a bracketed number that is no year.
  ['Topolino 3000 (2013).cbz', 3000, null],
  ['Batman (2 of 12).cbz', 2, null],
  // ...nor a volume's number when another number follows it; alone, it is the number.
  ['Vol 3 12.cbz', 12, null],
  ['Vol 3 (2010).cbz', 3, null],
  ['Vol 3-5 12.cbz', 12, null],
  // 4. Ranges.
  ['Batman 01-07 (1987).cbz', 1, 7],
  ['X-Men 01-07.cbz', 1, 7],
  ['Ch. 1–7.cbz', 1, 7],
  ['Ch. 1—7.cbz', 1, 7],
  ['Batman #1-7.cbz', 1, 7],
  ['Vol 01-07.cbz', 1, 7],
  ['Chapter 12-13 (1987).cbz', 12, 13],
  ['Batman 001-050 (1940-1950).cbz', 1, 50],
  // ...never a year, a date, a smaller number, a spaced dash or an absurd width.
  ['Batman 12-1987.cbz', 12, null],
  ['Report 05-12-2023.cbz', 5, null],
  ['Chapter 12-2.cbz', 12, null],
  ['Chapter 12 - 13 Ghosts.cbz', 12, null],
  ['Title 1-99999.cbz', 1, null],
  ['Batman 1987-05.cbz', 1987, null],
  // 5. Nothing but a year, or a date, or nothing at all: 0, sorted by name with the other 0s.
  ['Watchmen (1986).cbz', 0, null],
  ['Batman (1940-1950).cbz', 0, null],
  ['Title (2023-05-12).cbz', 0, null],
  ['Watchmen [1986] (Digital) (Group).cbz', 0, null],
  ['Oneshot.cbz', 0, null],
  ['Extra.cbz', 0, null],
  // A folder of images has no extension to take off.
  ['Vol 2 Chapter 5', 5, null],
];

test('chapterFromName: every rule, as #150 was promised', () => {
  for (const [name, number, end] of RULE2) {
    assert.deepEqual(chapterFromName(name), { number, end }, name);
  }
});

test('chapterFromName reads every name the downloader and a renumber write exactly as rule 1 does', () => {
  // lib/downloader.ts chapterFileRel writes `Chapter ${n}.cbz` and lib/postingOrder.ts renumberedFile `Chapter ${n}
  // (${k}).cbz` (keeping a .cbr's extension): a new download must land on the number the old rule gave it, or the
  // sweep, the listing and every have-set would see a different chapter than the one it fetched.
  const ns = [0, 1, 2, 9, 10, 12, 12.5, 100.1, 999, 1000, 1001, 1986, 2001, 12345, 0.5, 0.1, 3.14159, -1, -0.5, 1e21, 1e-7, 1.5e-7];
  for (let i = 0; i < 200; i++) ns.push(Math.round(Math.random() * 3000 * 100) / 100);
  for (const n of ns) {
    for (const name of [`Chapter ${n}.cbz`, `Chapter ${n} (2).cbz`, `Chapter ${n}.cbr`, `Chapter ${n}`]) {
      assert.deepEqual(chapterFromName(name), { number: numFromName(name), end: null }, name);
    }
  }
});

test('numberByRule: a row is read by the rule it carries, and the new rule is 2', () => {
  assert.equal(NAME_RULE, 2);
  assert.deepEqual(numberByRule('Vol 3 Chapter 12.cbz', 1), { number: 3, end: null });
  assert.deepEqual(numberByRule('Batman 01-07 (1987).cbz', 1), { number: 1, end: null }, 'rule 1 knows no ranges');
  assert.deepEqual(numberByRule('Vol 3 Chapter 12.cbz', 2), { number: 12, end: null });
  assert.deepEqual(numberByRule('Batman 01-07 (1987).cbz', 2), { number: 1, end: 7 });
  // A rule from a later release, after a rollback: the newest this one knows.
  assert.deepEqual(numberByRule('Vol 3 Chapter 12.cbz', 3), { number: 12, end: null });
});

test('a range is never wider than MAX_RANGE', () => {
  assert.deepEqual(chapterFromName(`Title 1-${1 + MAX_RANGE}.cbz`), { number: 1, end: 1 + MAX_RANGE });
  assert.deepEqual(chapterFromName(`Title 1-${2 + MAX_RANGE}.cbz`), { number: 1, end: null });
});

test('naturalCmp orders chapters numerically, not lexically', () => {
  const sorted = ['Chapter 10', 'Chapter 9', 'Chapter 100', 'Chapter 1'].sort(naturalCmp);
  assert.deepEqual(sorted, ['Chapter 1', 'Chapter 9', 'Chapter 10', 'Chapter 100']);
});

test('naturalCmp falls back to text when numbers tie', () => {
  const sorted = ['Chapter 1 - b', 'Chapter 1 - a'].sort(naturalCmp);
  assert.deepEqual(sorted, ['Chapter 1 - a', 'Chapter 1 - b']);
});

test('chapterName is pure: the number said again is no name, what follows it is', () => {
  // The same cases chapterNames.int.test.ts runs through library.ts, here without a database: the numbering
  // logic (lib/postingOrder.ts) calls this in unit tests and must never import the scanner to do it.
  assert.equal(chapterName('Chapter 12', 12), null);
  assert.equal(chapterName('Vol.3 Chapter 12 - The Return', 12), 'The Return');
  assert.equal(chapterName('第12話', 12), null);
  assert.equal(chapterName('Chapter 120', 12), 'Chapter 120', '12 is not the front of 120');
  // #116's titles: the extension's suffix is part of the name here (postingOrder.displayTitle strips it),
  // and Istrevelia's bare 'E2' is not a chapter word, so the title stays whole.
  assert.equal(chapterName('Episode 1 - Page 2 (ch. 1)', 1), 'Page 2 (ch. 1)');
  assert.equal(chapterName('CH7-EP32: Words (ch. 7)', 7), 'EP32: Words (ch. 7)');
  assert.equal(chapterName('E2 - 54-56 (ch. 2)', 2), 'E2 - 54-56 (ch. 2)');
});

test('library.ts has no chapterName of its own, only naming.ts\'s', () => {
  // One implementation, so the scanner's chapter_name and the numbering logic's name matching cannot drift
  // apart. Reintroduce by pasting a copy back into library.ts: the first assertion fails.
  const lib = readFileSync(join(__dirname, '..', 'src', 'lib', 'library.ts'), 'utf8');
  assert.doesNotMatch(lib, /function chapterName|const CHAPTER_WORD/);
  assert.match(lib, /^export \{ chapterName \};$/m);
  assert.match(lib, /^import \{[^}]*\bchapterName\b[^}]*\} from '\.\/naming';$/m);
});

test('heroFit crops art shaped like the frame and fills art that is not', () => {
  // art already close to the desktop strip (2.67:1) -> a light saliency crop is safe
  assert.equal(heroFit(2000, 800, 'wide'), 'crop');
  // a 4.75:1 AniList banner is far wider than even the desktop strip: cropping it to fill 720px of height
  // would throw away half the image, so show it whole over a blurred copy instead
  assert.equal(heroFit(1900, 400, 'wide'), 'fill');
  // ...and it's nothing like a phone's near-portrait frame either
  assert.equal(heroFit(1900, 400, 'tall'), 'fill');
  // a portrait cover into the desktop strip: nothing like it -> fill
  assert.equal(heroFit(700, 1000, 'wide'), 'fill');
  // ...but that same cover is close to the phone frame (0.9:1) -> crop, so it fills the screen
  assert.equal(heroFit(700, 1000, 'tall'), 'crop');
});

test('heroFit degrades safely on unknown dimensions', () => {
  assert.equal(typeof heroFit(0, 0, 'wide'), 'string', 'must not throw on missing metadata');
});

test('aspectDistance is symmetric and >= 1', () => {
  assert.ok(aspectDistance(1920, 720, 'wide') - 1 < 1e-9, 'exact frame match is distance 1');
  assert.ok(aspectDistance(100, 900, 'wide') > 1);
});
