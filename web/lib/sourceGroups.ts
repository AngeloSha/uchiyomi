// Which sources belong to which language group, and which of them are worth fetching.
//
// Split out of SourcePicker so it can be tested: the component is a client component that pulls in
// react-query and JSX, and this is arithmetic on a list of rows. `components/SourcePicker.tsx` re-exports
// everything here, so nothing else had to change.
import { langName } from './langNames';
import { storedLocale, detectLocale } from './i18n';

export interface Src {
  id: string;
  name: string;
  /** null means "declares no single language", not "serves none". See `inGroup`. */
  lang: string | null;
  latest?: boolean;
  status?: 'ok' | 'disabled' | 'rate_limited' | 'blocked' | 'down';
  blockedUntil?: string | null;
  /** How many series in the library came from this source. See `budgetFor`. */
  used?: number;
}

/**
 * The languages a source serves.
 *
 * Suwayomi gives one language per source today — the multi-language extensions register once per language
 * instead — so this matches a single code in every real row. It exists so a future source that reports
 * `en,ja` lands in both groups rather than in a group called "en,ja" that nothing selects.
 */
const langsOf = (s: Src): string[] =>
  (s.lang ?? '').split(',').map((x) => x.trim()).filter(Boolean);

/**
 * The site a source belongs to, for counting.
 *
 * 29 of this install's 45 rows are one site (3Hentai) installed once per language, which is the Mihon
 * `SourceFactory` model. Counting rows made the language rail a rendering of that one site's supported
 * languages: thirty chips, most of them leading to the same place.
 */
const siteOf = (s: Src): string => s.name.toLowerCase().replace(/[^a-z0-9]+/g, '');

export type SrcState = 'loading' | 'ok' | 'empty' | 'idle' | 'blocked' | 'off';

/**
 * A source belongs to a language group when it declares that language, or declares none.
 *
 * A source with no declared language is not an orphan: MangaDex serves everything, and the pack sources are
 * code rather than an operator's choice. Bucketing those separately would put a "no language" chip on a page
 * whose entire organising idea is language.
 */
export const inGroup = (s: Src, lang: string) => {
  if (!lang) return true;
  const own = langsOf(s);
  return !own.length || own.includes('all') || own.includes(lang);
};

/** Languages worth a chip: those a `latest`-capable source actually declares, counted by SITE. */
export function languagesOf(sources: Src[]): { code: string; label: string; count: number }[] {
  const locale = (typeof window === 'undefined' ? 'en' : (storedLocale() ?? detectLocale())) as string;
  const n = new Map<string, Set<string>>();
  for (const s of sources) {
    if (!s.latest || s.status === 'disabled') continue;
    for (const code of langsOf(s)) {
      // 'all' would otherwise add itself to all thirty counts and tell you nothing.
      if (code === 'all') continue;
      let set = n.get(code);
      if (!set) { set = new Set(); n.set(code, set); }
      set.add(siteOf(s));
    }
  }
  return [...n.entries()]
    .map(([code, sites]) => ({ code, label: langName(code, locale), count: sites.size }))
    .sort((a, b) => (a.code === locale ? -1 : b.code === locale ? 1 : 0) || b.count - a.count || a.label.localeCompare(b.label));
}

/**
 * Which sources to actually fetch, and in what order.
 *
 * English on one real install is six declared sources plus four universals plus three packs. Fetching
 * thirteen at eight seconds each is not a plan, and the page that fetched every registered source opened
 * forty-five concurrent scrapes. Six, best-first:
 *   1. healthy before rate-limited or blocked, because a blocked source is a guaranteed timeout for a
 *      guaranteed nothing;
 *   2. sources that actually declare the chosen language before the universals, since the chip is the point;
 *   3. what the library actually came from. This is the one that mattered: with only (1) and (2), ties fell
 *      back to the server's order, which resolves alphabetically -- "18 Porn Comic", "1Manga.co", "3Hentai" --
 *      while the source 176 of that library's 214 series came from, answering in 2.5s, was never in the six.
 *   4. registry order after that, which puts the preferred adapters first (Array.sort is stable).
 */
export function budgetFor(sources: Src[], lang: string, max = 6): Src[] {
  const declares = (s: Src) => langsOf(s).includes(lang);
  return sources
    .filter((s) => s.latest && s.status !== 'disabled' && inGroup(s, lang))
    .sort((a, b) =>
      Number(a.status !== 'ok') - Number(b.status !== 'ok') ||
      Number(declares(b)) - Number(declares(a)) ||
      (b.used ?? 0) - (a.used ?? 0))
    .slice(0, max);
}

