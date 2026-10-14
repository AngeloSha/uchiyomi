// Chapters in the series' language (v0.62.0): the two language options of the release rules (lib/releases.ts
// ChooseOpts.inLanguage and .continuity), built in one place so the sweep (lib/updater.ts) and the stored listing
// (lib/seriesListing.ts decisions, and every automatic action that reads them) cannot disagree.
//
// The report behind it: a server set to English only downloaded a few series in Spanish, and after the admin
// corrected the series' language and fetched again, every chapter had two versions and the Spanish one still won.
// The release rules ranked copies by group, hosting, source and date and had no notion of language at all.
import { q } from './db';
import { getSource } from './sources';
import { canonLang, sameLanguage } from './lang';
import { groupsOf, normGroup } from './releases';
import { seriesLanguage, type SeriesLang } from './seriesLang';

/** The module's q, or a transaction's own (db.ts tx), so a caller inside one reads what it has written. */
type Qq = <R = any>(text: string, params?: any[]) => Promise<R[]>;

/** A copy as the rules see one: its own language when the source names one per chapter, and its source. */
type Copy = { lang?: string | null; source?: string | null; groups?: string[]; scanlator?: string | null };

/**
 * The single language a source DECLARES, or null. Null for a site added by address that says nothing (it is read as
 * the unstated language by the follow guard, but nothing here is KNOWN about it), for an extension in every language
 * ("all", "other": canonLang reads no single language), and for a source not loaded right now.
 */
export function languageDeclared(sourceId?: string | null): string | null {
  if (!sourceId) return null;
  const said = getSource(sourceId)?.lang;
  return said?.trim() ? canonLang(said) : null;
}

/**
 * A copy's language, when it is known: its own (MangaDex rows carry one), else its source's declared one. A chapter's
 * file reads the same way, as `{ lang: lib_books.lang, source: lib_books.source_id }`: its own language is kept only
 * where it is not its source's (migrate.ts, v0.62.0).
 */
export function copyLang(c: Copy): string | null {
  return canonLang(c.lang ?? null) ?? languageDeclared(c.source);
}

/** The release rules' language options; a key is absent when it would change nothing. */
export interface LanguageRules {
  inLanguage?: (c: Copy) => boolean;
  continuity?: (c: Copy) => number;
}

/**
 * The rules for one series, from its language, the sources it follows (main first) and the groups of its latest
 * chapters on disk. Pure, for tests; languageRulesFor reads the three facts.
 *
 * `inLanguage` drops a copy KNOWN to be in another language: never chosen, never an alternate, exactly like a copy
 * from a blocked group. A copy whose language is unknown -- a site that declares none, an extension in every
 * language -- is always on offer: the rule only drops what it knows. And it applies only while one of the series'
 * sources serves the series' language, meaning no source of it declares a different single language. A series whose
 * every source declares another language is one whose language was set by hand to something its sources never had
 * (the original language, say: Korean for a manhwa read in English), and dropping every copy would stop it updating
 * with nothing on screen to say why. Such a series behaves as it did before v0.62.0. Compared like a follow
 * (seriesLang.ts languageFits): base language and script, exact codes for a series with a same-base sibling edition.
 *
 * `continuity`, for a copy of unknown language only: 0 when one of its groups translated one of the series' latest
 * chapters on disk, else 1. lib/releases.ts consults it after the source rank and before the release date, so it
 * decides between copies of one source that the rules otherwise call equal -- which is what an extension in every
 * language lists: one copy per translation of each number. A group translates into one language, so keeping the
 * group keeps the language, where the earliest release is whichever translation came out first. Copies whose
 * language is known are never reordered by it.
 */
export function languageRules(
  series: Pick<SeriesLang, 'lang' | 'sameBaseSibling'>,
  sources: readonly string[],
  recentGroups: readonly string[],
): LanguageRules {
  const fits = (lang: string) => sameLanguage(series.lang, lang, { exact: series.sameBaseSibling });
  const served = sources.some((s) => {
    const said = languageDeclared(s);
    return said === null || fits(said);
  });
  const recent = new Set(recentGroups.map(normGroup).filter(Boolean));
  const rules: LanguageRules = {};
  if (served) {
    rules.inLanguage = (c) => {
      const lang = copyLang(c);
      return lang === null || fits(lang);
    };
  }
  if (recent.size) {
    rules.continuity = (c) => {
      if (copyLang(c) !== null) return 0;
      const keys = groupsOf({ groups: c.groups, scanlator: c.scanlator ?? undefined }).map(normGroup);
      return keys.some((k) => recent.has(k)) ? 0 : 1;
    };
  }
  return rules;
}

/** How many of the latest chapters on disk name the groups `continuity` keeps to. */
const RECENT_CHAPTERS = 3;

/** The groups that translated the series' latest chapters on disk, newest first (lib_books.scanlator). */
export async function recentGroups(seriesId: string, qq: Qq = q): Promise<string[]> {
  const rows = await qq<{ scanlator: string }>(
    `SELECT scanlator FROM lib_books
      WHERE series_id = $1 AND pruned_at IS NULL AND scanlator IS NOT NULL AND btrim(scanlator) <> ''
      ORDER BY number DESC LIMIT ${RECENT_CHAPTERS}`, [seriesId]);
  return rows.flatMap((r) => groupsOf({ scanlator: r.scanlator }));
}

/**
 * languageRules for one series, read from the database: its language (seriesLang.ts seriesLanguage) and the groups of
 * its latest chapters on disk. `sources` is the caller's: the sources it is choosing between, main first.
 */
export async function languageRulesFor(seriesId: string, sources: readonly string[], qq: Qq = q): Promise<LanguageRules> {
  const [series, groups] = await Promise.all([seriesLanguage(seriesId, qq), recentGroups(seriesId, qq)]);
  return languageRules(series, sources, groups);
}
