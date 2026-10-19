// Translated pages (v0.85.0, lib/readerTranslate.ts): a page the server has translated is asked for with `tl` and its
// stamp, every other page exactly as before; the reader asks for a chapter from the page it is on and keeps asking only
// while the server has pages of it to do; the switch is per title, and shows only where the server offers it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { translatedSrc, translating, type TranslateStatus } from '../lib/readerTranslate';

const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
const st = (o: Partial<TranslateStatus> = {}): TranslateStatus => ({ available: true, problem: null, pages: {}, failed: [], pending: 0, ...o });

test('a translated page gets tl and its stamp; any other page keeps its address exactly', () => {
  assert.equal(translatedSrc('/img/books/b_1/page/3', 'pt-BR', '1760000000000'), '/img/books/b_1/page/3?tl=pt-BR&tv=1760000000000');
  assert.equal(translatedSrc('/img/books/b_1/page/3?fit=1080', 'en', '17'), '/img/books/b_1/page/3?fit=1080&tl=en&tv=17');
  // Reintroduce by adding tl whatever the stamp: every page not done yet is asked for at the translated address, and the
  // reader shows the original from an address that will never change to the translation.
  assert.equal(translatedSrc('/img/books/b_1/page/3', 'en', undefined), '/img/books/b_1/page/3');
});

test('"Translating… n/N" shows while the server still has pages of the chapter, and not after', () => {
  assert.deepEqual(translating(st({ pages: { 1: 'a', 2: 'b' }, pending: 3 }), 5), { done: 2, total: 5 });
  // Reintroduce by trusting `pending` alone: a chapter opened again says "Translating… 5/5" until the next answer.
  assert.equal(translating(st({ pages: { 1: 'a', 2: 'b', 3: 'c', 4: 'd', 5: 'e' }, pending: 1 }), 5), null, 'all there');
  assert.equal(translating(st({ pages: { 1: 'a' }, pending: 0 }), 5), null, 'finished, or stopped');
  assert.equal(translating(st({ available: false, pending: 2 }), 5), null, 'off');
  assert.equal(translating(undefined, 5), null, 'not asked');
});

test('the reader asks from the page it is on, polls only while pages wait, and shows a done page translated', () => {
  const page = read('app/reader/page.tsx');
  assert.match(page, /askTranslation\(activeChapter\.id, Math\.max\(1, pageInChapter\)\)/);
  // The next chapter once this one is done, from its first page.
  assert.match(page, /if \(!trOn \|\| !nextId \|\| !trHere \|\| trHere\.pending > 0\) return;\n\s+askTranslation\(nextId, 1\);/);
  // Reintroduce polling whatever the state: every open reader asks the server every 5 s for ever.
  assert.match(page, /const trPendingIds = trOn \? Object\.keys\(trStatus\)\.filter\(\(id\) => trStatus\[id\]\.pending > 0\)/);
  assert.match(page, /if \(document\.visibilityState !== 'visible'\) return;/);
  assert.match(page, /return translatedSrc\(src, trLang, trOn \? trStatus\[ch\.id\]\?\.pages\[flat\[i\]\.number\] : undefined\);/);
  // The title's memory, like the spread shift.
  assert.match(page, /setTranslate\(memory\.translate === true\);/);
  assert.match(page, /saveSeriesPrefs\(seriesId0, \{ translate: v \}\)/);
  assert.match(page, /onTranslate=\{trOffer\?\.available \? applyTranslate : undefined\}/);
});

test('the switch shows only where the server offers it, and Admin → Settings offers the engine except on desktop', () => {
  assert.match(read('components/ReaderSettings.tsx'), /\{onTranslate && \(\n\s+<div className="py-3" data-reader-translate>/);
  assert.match(read('components/AdminSettings.tsx'), /\{!desktop && <TranslateRow \/>\}/);
  const row = read('components/TranslateSettings.tsx');
  // The admin sees what Download costs before pressing it, and the row is gone where the server cannot run it.
  assert.match(row, /if \(!st \|\| st\.state === 'unsupported'\) return null;/);
  assert.match(row, /\{ size: bytes\(st\.need\), memory: bytes\(st\.ram\) \}/);
});
