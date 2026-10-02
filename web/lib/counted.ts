/**
 * Counted words several screens share, each said as a pair (v0.52.0).
 *
 * English does not inflect "3 selected" or "3 deleted", so these shipped as one plural key apiece, and every language
 * that agrees the word with its count read wrong at 1: "1 seleccionados", "1 supprimés" (localeCoverage.test.ts kept
 * them frozen in AGREEING_UNPAIRED until they had their singulars).
 */
import { t as tr } from './i18n';

/** "1 selected", "{n} selected": a selection's count, wherever things are picked. */
export const selectedText = (n: number): string => (n === 1 ? tr('1 selected') : tr('{n} selected', { n }));

/** "1 deleted", "{n} deleted": chapters a Delete removed. */
export const deletedText = (n: number): string => (n === 1 ? tr('1 deleted') : tr('{n} deleted', { n }));

/** Chapters a Delete left alone because Uchiyomi did not download them. */
export const skippedNotOursText = (n: number): string =>
  (n === 1 ? tr('1 skipped: not downloaded by Uchiyomi') : tr('{n} skipped: not downloaded by Uchiyomi', { n }));

/** Chapters a Delete left alone because a reader's bookmark is in them. */
export const skippedBookmarkedText = (n: number): string =>
  (n === 1 ? tr('1 skipped: bookmarked by a reader') : tr('{n} skipped: bookmarked by a reader', { n }));
