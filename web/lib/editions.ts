// Language editions of one work (v0.52.0, #72), as the pages show them: the series page's and the reader's
// chips, the Library card's codes, the add dialog's language choices and the reader's jump to another edition.
// Pure on purpose -- a language's name comes in as a function (lib/format.ts languageName in the app), so the
// rules are tested without Intl or a locale (test/editions.test.ts).
import type { EditionRow } from './types';

/**
 * The languages an edition can be said to be in, when a person chooses: MangaDex's (bff lib/lang.ts
 * MANGADEX_LANGS), which are the codes Mihon's extensions use. A code outside it -- a Suwayomi source's `ja-ro`
 * -- is offered too wherever it is already in play (`languageChoices`).
 */
export const EDITION_LANGS = [
  'en', 'es-419', 'es', 'pt-BR', 'pt', 'fr', 'de', 'it', 'ru', 'uk', 'pl', 'tr', 'ar', 'id', 'vi', 'th', 'ms', 'fil',
  'zh-Hans', 'zh-Hant', 'ja', 'ko', 'hu', 'ro', 'cs', 'nl',
] as const;

/** A code's base language: "es" for "es-419", "zh" for "zh-Hant". */
export const baseOf = (code: string): string => code.split('-')[0].toLowerCase();

/** A code as the server's folder names and Komga titles write it: "ES-419", "PT-BR". Never translated. */
export const codeLabel = (code: string): string => code.toUpperCase();

/**
 * What each edition is called beside the others: its base language's name ("Spanish") -- unless two of them share
 * a base, when both take their full names ("Latin American Spanish", "European Spanish") so they can be told apart.
 */
export function editionNames(langs: readonly string[], name: (code: string) => string): string[] {
  return langs.map((l) => (langs.filter((o) => baseOf(o) === baseOf(l)).length > 1 ? name(l) : name(baseOf(l))));
}

/**
 * The words on each edition's chip, in the order given: its name, and for an edition other than the one on screen
 * where the viewer has read, how far ("Español · Ch. 12") -- the reason to switch is usually "where was I there".
 */
export function editionChipLabels(eds: readonly EditionRow[], ui: { name: (code: string) => string; chapter: (n: number) => string }): string[] {
  const names = editionNames(eds.map((e) => e.lang), ui.name);
  return eds.map((e, i) => (!e.current && e.lastRead != null ? `${names[i]} · ${ui.chapter(e.lastRead)}` : names[i]));
}

/**
 * The Library card's second caption line, `EN · ES-419`: every language of the work the viewer may browse, the one
 * the card shows marked. Codes rather than names: two short codes fit a 110-px tile where "English · Spanish" does
 * not, and the tile's `title` carries the names.
 */
export function libraryCaption(langs: readonly string[], current: string | undefined): Array<{ lang: string; label: string; current: boolean }> {
  return langs.map((l) => ({ lang: l, label: codeLabel(l), current: l === current }));
}

/**
 * Where the reader goes when the person switches to another edition at chapter `number`: that chapter there, when
 * the server holds it with pages; else that edition's series page at the chapter (`?ch=`, rounded down -- the
 * page lands on the row before a number it lacks), whose ghost row has its Fetch.
 */
export function readerTarget(
  number: number,
  books: ReadonlyArray<{ id: string; number: number; pruned?: boolean }>,
  seriesId: string,
): { kind: 'book'; id: string } | { kind: 'series'; href: string } {
  const hit = books.find((b) => b.number === number && !b.pruned);
  return hit
    ? { kind: 'book', id: hit.id }
    : { kind: 'series', href: `/series/?id=${encodeURIComponent(seriesId)}&ch=${Math.floor(number)}` };
}

/**
 * The languages a picker offers, sorted by name in the reader's language: EDITION_LANGS and whatever is already in
 * play (`extra`: the source's own code, the series' current one), each once.
 */
export function languageChoices(extra: ReadonlyArray<string | null | undefined>, name: (code: string) => string): string[] {
  const all = [...new Set([...EDITION_LANGS, ...extra.filter((x): x is string => !!x)])];
  return all.sort((a, b) => name(a).localeCompare(name(b)));
}
