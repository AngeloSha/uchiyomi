// Language editions of one work (v0.52.0, #72), as the pages show them: lib/editions.ts, pure. The names come in as a
// function, so the rules are held here without Intl: a chip says the base language unless two editions share one,
// and the reader's switch opens the same chapter in the other edition, or that edition's page at the chapter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { editionChipLabels, editionLangPreset, editionNames, editionOffer, editionOfferKey, libraryCaption, openingLanguage, readerTarget, languageChoices } from '../lib/editions';
import type { EditionRow } from '../lib/types';

/** A web file with its comments removed, so a comment that quotes the code does not pass a pin. */
const code = (p: string): string => readFileSync(join(__dirname, '..', p), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

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
  // A chapter held inside a file holding a range there (v0.55.2): that file. Reintroduce the exact match alone: the
  // reader is sent to the series page for a chapter the edition holds.
  const ranged = [{ id: 'r', number: 1, numberEnd: 7 }, { id: 'b8', number: 8 }];
  assert.deepEqual(readerTarget(3, ranged, 'es'), { kind: 'book', id: 'r' }, 'a chapter inside a range file opens that file');
  assert.deepEqual(readerTarget(8, ranged, 'es'), { kind: 'book', id: 'b8' });
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

test('a refused follow whose work holds that language already opens that edition, not a second one', () => {
  // The v0.52.0 check pass: the guard offered "Add it as an edition in Spanish" beside a Spanish edition already there,
  // and the add ended on "already in your library". The server's offer carries that edition (`existing`) and the key
  // opens it. Reintroduce by dropping `existing` from editionOffer: "the offer drops the edition the work holds".
  const refusal = (body: unknown) => ({ body: JSON.stringify(body) });
  const offer = editionOffer(refusal({ error: 'language_differs', edition: { of: 's1', lang: 'es-419', existing: { id: 's2', lang: 'es-419' } } }));
  assert.deepEqual(offer, { of: 's1', lang: 'es-419', existing: { id: 's2', lang: 'es-419' } }, 'the offer drops the edition the work holds');
  assert.deepEqual(editionOffer(refusal({ error: 'language_differs', edition: { of: 's1', lang: 'es', existing: { id: 7 } } })), { of: 's1', lang: 'es' }, 'a malformed one is no edition');
  // Reintroduce by keying on "Add it as an edition" whatever the offer: "the key adds a second Spanish edition".
  assert.equal(editionOfferKey(offer!, name), 'Open the Latin American Spanish edition', 'the key adds a second Spanish edition');
  assert.equal(editionOfferKey({ of: 's1', lang: 'fr' }, name), 'Add it as an edition');
  // Both surfaces say it, and each handler goes to that edition instead of the add dialog.
  assert.match(code('components/FindMissingDialog.tsx'), /\{editionOfferKey\(edOffer, languageName\)\}/, 'Find missing keeps "Add it as an edition"');
  assert.match(code('components/FindSources.tsx'), /\{editionOfferKey\(offer, languageName\)\}/, 'the review keeps "Add it as an edition"');
  assert.match(code('components/FindSources.tsx'), /if \(ask\.existing\) \{ onClose\(\); router\.push\(seriesHref\(ask\.existing\.id\)\); return; \}/, 'the results sheet opens the add dialog');
  assert.match(code('app/series/page.tsx'), /\(o\.existing\s+\? router\.push\(`\/series\/\?id=\$\{encodeURIComponent\(o\.existing\.id\)\}`\)/, 'the series page opens the add dialog');
});

test('the source a follow was refused for starts on the language the refusal named', () => {
  // The v0.52.0 check pass: "That source is in Spanish and this series is in English. Add it as an edition in Spanish
  // instead" opened the dialog on the sources that do not say their language -- the refused one is such a source, its
  // Spanish only the server's unstated language -- and picking it asked "Choose a language" all over again. Reintroduce
  // by dropping the seed's term from editionLangPreset: "the refused source asks its language again".
  const seed = { lang: 'es', source: 'site-a' };
  assert.equal(editionLangPreset({ picked: { source: 'site-a', lang: null }, pick: 'unstated', seed }), 'es', 'the refused source asks its language again');
  assert.equal(editionLangPreset({ picked: { source: 'site-b', lang: null }, pick: 'unstated', seed }), '', 'another source that says nothing is guessed');
  assert.equal(editionLangPreset({ picked: { source: 'mangadex-fr', lang: 'fr' }, pick: 'unstated', seed }), 'fr', 'a declared language wins over the seed');
  assert.equal(editionLangPreset({ picked: { source: 'mangadex-es-419' }, pick: 'es-419', seed: null }), 'es-419', 'the row "Which language?" was answered with');
  assert.equal(editionLangPreset({ picked: { source: 'site-a' }, pick: 'unstated', seed: null, offer: 'pt-BR' }), 'pt-BR', "the server's offer");
  assert.equal(editionLangPreset({ picked: { source: 'site-a' }, pick: 'unstated', seed: null }), '', 'nobody knows: the add waits');
  // The dialog derives it there, not inline. Reintroduce the old inline chain: this pin fails.
  assert.match(code('components/AddSeriesDialog.tsx'), /: editionLangPreset\(\{ picked, pick: edPick, seed: edSeed, offer: offer\?\.lang \}\);/, 'the dialog does not use editionLangPreset');
});

test('a follow refused for its language offers the edition: Find missing, the review, and the dialog on that language', () => {
  // Where #123's guard meets #72's editions (v0.52.0): the manual follow and a Review-first match's Follow answer 409
  // language_differs with the add route's `edition: {of, lang}`, and each surface offers "Add it as an edition",
  // which opens the add dialog on that source's language.
  const refusal = (body: unknown) => ({ body: JSON.stringify(body) });
  assert.deepEqual(editionOffer(refusal({ error: 'language_differs', edition: { of: 's1', lang: 'es-419' } })), { of: 's1', lang: 'es-419' });
  assert.equal(editionOffer(refusal({ error: 'already_followed', edition: { of: 's1', lang: 'es-419' } })), null, 'another refusal is no offer');
  assert.equal(editionOffer(refusal({ error: 'language_differs' })), null, 'an older server sends no edition');
  assert.equal(editionOffer({ body: '<html>' }), null);
  // The dialog opens on the refused source's row: its language, or the sources that do not say theirs; else the
  // language named, when offered; else the list.
  const cands = { languages: [{ lang: 'es-419', sources: [{ id: 'mangadex-es-419' }] }, { lang: 'fr', sources: [{ id: 'fr-site' }] }], unstated: [{ id: 'site' }] };
  assert.equal(openingLanguage(cands, { lang: 'es', source: 'mangadex-es-419' }), 'es-419', 'the source\'s own row');
  assert.equal(openingLanguage(cands, { lang: 'en', source: 'site' }), 'unstated', 'a source that does not say its language');
  assert.equal(openingLanguage(cands, { lang: 'fr' }), 'fr');
  assert.equal(openingLanguage(cands, { lang: 'de' }), null, 'a language no source offers opens on the list');
  assert.equal(openingLanguage(undefined, { lang: 'fr' }), null);

  // Reintroduce by toasting the refusal like any other in Find missing chapters' follow: "Find missing offers no
  // edition" fails.
  const missing = code('components/FindMissingDialog.tsx');
  assert.match(missing, /else if \(ed\) setEdOffer\(\{ \.\.\.ed, source: c\.source, message: msgOf\(e, /, 'Find missing offers no edition');
  assert.match(missing, /onClick=\{\(\) => onAddEdition\(\{ of: edOffer\.of, lang: edOffer\.lang, source: edOffer\.source, existing: edOffer\.existing \}\)\}/);
  assert.equal(missing.match(/\{languageOffer\(c\)\}/g)?.length, 2, 'both cards that follow say it: the ones that fill and "Could also be followed"');
  // The review: the refusal's offer kept beside its words, and the key under them.
  const find = code('components/FindSources.tsx');
  assert.match(find, /offer: editionOffer\(e\),/, 'the review drops the offer');
  assert.match(find, /\{offer && !p\.state && act\.onAddEdition && \(/);
  assert.match(find, /seed=\{\{ kind: 'edition', of: adding\.of, title: adding\.title, lang: adding\.lang, source: adding\.source \}\}/, 'the results sheet does not open the dialog');
  // The series page: the Sources sheet's review and Find missing open the page's own dialog, on the language.
  const page = code('app/series/page.tsx');
  assert.match(page, /onAddEdition=\{addEdition \? \(o\) => \{ setFindingMissing\(false\); addEdition\(o\); \} : undefined\}/);
  assert.match(page, /onAddEdition=\{addEdition \? \(o\) => \{ setSourcesOpen\(false\); addEdition\(o\); \} : undefined\}/);
  assert.match(page, /seed=\{\{ kind: 'edition', of: id, title, \.\.\.addingLang \}\}/);
  // And the dialog starts there, until the person picks another.
  assert.match(code('components/AddSeriesDialog.tsx'), /const edPick = edChoice !== undefined \? edChoice : edSeed \? openingLanguage\(candQ\.data, edSeed\) : null;/,
    'the dialog does not open on the language');
});
