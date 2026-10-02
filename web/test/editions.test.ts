// Language editions of one work (v0.52.0, #72), as the pages show them: lib/editions.ts, pure. The names come in as a
// function, so the rules are held here without Intl: a chip says the base language unless two editions share one,
// and the reader's switch opens the same chapter in the other edition, or that edition's page at the chapter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { editionChipLabels, editionNames, libraryCaption, readerTarget, languageChoices } from '../lib/editions';
import type { EditionRow } from '../lib/types';

const NAMES: Record<string, string> = {
  en: 'English', es: 'Spanish', 'es-419': 'Latin American Spanish', 'pt-BR': 'Brazilian Portuguese', pt: 'Portuguese',
  zh: 'Chinese', 'zh-Hans': 'Simplified Chinese', 'zh-Hant': 'Traditional Chinese', fr: 'French',
};
const name = (c: string) => NAMES[c] ?? c;
const ed = (seriesId: string, lang: string, current = false, lastRead: number | null = null): EditionRow =>
  ({ seriesId, lang, title: 'Blue Lock', booksCount: 10, current, lastRead });

test('an edition is named by its base language, unless two share one', () => {
  // Reintroduce by naming every edition in full: "Latin American Spanish" beside "English" says more than the chip
  // has room for, and the base name is enough. Reintroduce by always using the base: es and es-419 both read "Spanish".
  assert.deepEqual(editionNames(['en', 'es-419'], name), ['English', 'Spanish']);
  assert.deepEqual(editionNames(['es', 'es-419'], name), ['Spanish', 'Latin American Spanish'], 'two Spanish editions are told apart');
  assert.deepEqual(editionNames(['zh-Hans', 'zh-Hant', 'en'], name), ['Simplified Chinese', 'Traditional Chinese', 'English']);
});

test('a chip says how far the viewer read in the other editions, never in the one on screen', () => {
  const labels = editionChipLabels(
    [ed('a', 'en', true, 40), ed('b', 'es-419', false, 12), ed('c', 'pt-BR', false, null)],
    { name, chapter: (n) => `Ch. ${n}` },
  );
  assert.deepEqual(labels, ['English', 'Spanish · Ch. 12', 'Portuguese']);
});

test('the reader opens the same chapter in the other edition, else that edition\'s page at it', () => {
  // Reintroduce by rounding the number when matching: chapter 12.5 would open 12. Reintroduce by sending the
  // reader to the series page without `ch`: the ghost row with Fetch is a page of scrolling away.
  const books = [{ id: 'b12', number: 12 }, { id: 'b12.5', number: 12.5 }, { id: 'b13', number: 13, pruned: true }];
  assert.deepEqual(readerTarget(12.5, books, 'es'), { kind: 'book', id: 'b12.5' }, 'the exact chapter');
  assert.deepEqual(readerTarget(14.2, books, 'es'), { kind: 'series', href: '/series/?id=es&ch=14' }, 'a chapter it lacks: its page, at the number');
  assert.deepEqual(readerTarget(13, books, 'es'), { kind: 'series', href: '/series/?id=es&ch=13' }, 'a chapter deleted from the server has no pages to open');
});

test('the Library caption is every language\'s code, the shown edition marked', () => {
  assert.deepEqual(libraryCaption(['en', 'es-419'], 'es-419'), [
    { lang: 'en', label: 'EN', current: false }, { lang: 'es-419', label: 'ES-419', current: true },
  ]);
});

test('the language picker offers MangaDex\'s languages and whatever is already in play, each once, by name', () => {
  const list = languageChoices(['ja-ro', 'en', null], name);
  assert.ok(list.includes('ja-ro'), 'a code in play outside the table is offered');
  assert.equal(list.filter((l) => l === 'en').length, 1, 'a code is offered once');
  const named = list.map(name);
  assert.deepEqual(named, [...named].sort((a, b) => a.localeCompare(b)), 'sorted by name');
});
