// Chapter ordering comes from filenames; getting this wrong shows up as chapters listed out of order.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { numFromName, naturalCmp, chapterName } from '../src/lib/naming';
import { heroFit, aspectDistance } from '../src/lib/heroFrame';

test('numFromName reads the first number, including decimals', () => {
  assert.equal(numFromName('Chapter 12.cbz'), 12);
  assert.equal(numFromName('Ch. 4.5.cbz'), 4.5);
  assert.equal(numFromName('Tome 01.cbr'), 1);
  assert.equal(numFromName('0001.cbz'), 1);
  assert.equal(numFromName('cover.jpg'), 0, 'no number -> 0');
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
