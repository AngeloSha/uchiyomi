// Language editions of one work (v0.52.0, #72), as the pages show them: the series page's and the reader's
// chips, the Library card's codes, the add dialog's language choices and the reader's jump to another edition.
// Pure on purpose -- a language's name comes in as a function (lib/format.ts languageName in the app), so the
// rules are tested without Intl or a locale (test/editions.test.ts).
import type { EditionRow } from './types';
import { t as tr } from './i18n';

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
 * A follow refused for its language, as the add route takes an edition: the series it joins, and the language. And
 * `existing`, when the work holds an edition that may follow the source already: its series and language.
 */
export interface EditionOffer { of: string; lang: string; existing?: { id: string; lang: string } }

/**
 * The edition a refused follow offers instead (v0.52.0, where #123's guard meets #72's editions): 409
 * `language_differs` from the manual follow (Find missing chapters) and from a Review-first match's Follow, both
 * with the add route's own `edition: {of, lang}` -- and `existing: {id, lang}` when the work already holds an edition
 * the source may follow. Null for any other answer, or a body that is not JSON.
 */
export function editionOffer(e: unknown): EditionOffer | null {
  let j: { error?: unknown; edition?: { of?: unknown; lang?: unknown; existing?: { id?: unknown; lang?: unknown } } } | null = null;
  try { j = JSON.parse(String((e as { body?: unknown } | null)?.body ?? '')); } catch { return null; }
  const ed = j?.error === 'language_differs' ? j.edition : null;
  if (!(ed && typeof ed.of === 'string' && ed.of && typeof ed.lang === 'string' && ed.lang)) return null;
  const x = ed.existing;
  return x && typeof x.id === 'string' && x.id && typeof x.lang === 'string' && x.lang
    ? { of: ed.of, lang: ed.lang, existing: { id: x.id, lang: x.lang } }
    : { of: ed.of, lang: ed.lang };
}

/**
 * The key under a follow refused for its language: "Open the Spanish edition" when the work holds one that may follow
 * the source -- the follow belongs there, and adding another would only end on "already in your library" -- else
 * "Add it as an edition".
 */
export function editionOfferKey(offer: EditionOffer, name: (code: string) => string): string {
  return offer.existing ? tr('Open the {language} edition', { language: name(offer.existing.lang) }) : tr('Add it as an edition');
}

/**
 * The language "Add a language" opens on when it was asked for one (an edition offer): the row holding the refused
 * source -- its own language, or `unstated` for the sources that do not say theirs, which the server takes to be in
 * the unstated language -- else the language the server named, when the sources offer it. Null opens on the list, as
 * the series page's "Add a language" does, and so does a language the work holds already.
 */
export function openingLanguage(
  c: { languages: ReadonlyArray<{ lang: string; sources: ReadonlyArray<{ id: string }> }>; unstated: ReadonlyArray<{ id: string }> } | undefined,
  want: { lang?: string; source?: string },
): string | null {
  if (!c) return null;
  if (want.source) {
    const row = c.languages.find((l) => l.sources.some((s) => s.id === want.source));
    if (row) return row.lang;
    if (c.unstated.some((s) => s.id === want.source)) return 'unstated';
  }
  return want.lang && c.languages.some((l) => l.lang === want.lang) ? want.lang : null;
}

/**
 * The language the edition block starts on for the copy picked (the person's own choice overrides it): what its source
 * declares; else the language "Which language?" was answered with; else, for the very source a follow was refused for,
 * the language the refusal named -- "Add it as an edition in Spanish instead" opens on the sources that do not say
 * theirs when that source is one, and must not ask "Choose a language" again; else the server's own offer. Empty when
 * nobody knows (another source that says nothing is not guessed): the add then waits for a choice.
 */
export function editionLangPreset(p: {
  picked?: { source: string; lang?: string | null } | null;
  pick?: string | null;
  seed?: { lang?: string; source?: string } | null;
  offer?: string | null;
}): string {
  return p.picked?.lang || (p.pick && p.pick !== 'unstated' ? p.pick : '')
    || (p.seed?.source && p.picked?.source === p.seed.source ? p.seed.lang ?? '' : '')
    || p.offer || '';
}

/**
 * The languages a picker offers, sorted by name in the reader's language: EDITION_LANGS and whatever is already in
 * play (`extra`: the source's own code, the series' current one), each once.
 */
export function languageChoices(extra: ReadonlyArray<string | null | undefined>, name: (code: string) => string): string[] {
  const all = [...new Set([...EDITION_LANGS, ...extra.filter((x): x is string => !!x)])];
  return all.sort((a, b) => name(a).localeCompare(name(b)));
}
