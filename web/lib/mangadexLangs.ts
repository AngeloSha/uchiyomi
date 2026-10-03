// The MangaDex languages' decisions, with no React in them (components/MangadexCard.tsx, v0.52.0, #123): what one tap
// on a language sends, whether turning one off asks first, and the order the saves go out in.
import { mangadexSourceId } from './providerGroups';

/**
 * Admin → Sources → Add sources at the MangaDex languages, unfolded (v0.52.0; Providers' MangaDex card until v0.54.0):
 * where the add dialog's "Turn on more MangaDex languages" goes, from an edition with no source in another language
 * yet. `card=` as Profile's `?tab=Connections&card=tracking` is. The old `?tab=Providers&card=mangadex` lands there
 * too (lib/sourcesPanel.ts SOURCES_TAB_ALIASES).
 */
export const MANGADEX_LANGUAGES_HREF = '/admin/?tab=Sources&card=mangadex';

/** Whether the address asks for the MangaDex languages unfolded (MANGADEX_LANGUAGES_HREF). */
export const opensMangadexLanguages = (params: { get(name: string): string | null }): boolean => params.get('card') === 'mangadex';

/** One of MangaDex's sources as the question reads it: its name, and how many series use it. */
export interface LanguageSource { id: string; name: string; main?: number; followed?: number; used?: number }

/**
 * The languages besides English after one tap on `code`: on if it was off, off if it was on, in the picker's order
 * (the server's, MANGADEX_LANGS) however the taps came. English is always on and never in the list.
 */
export function toggleLang(available: readonly string[], on: readonly string[], code: string): string[] {
  if (code === 'en') return [...on];
  const next = on.includes(code) ? on.filter((c) => c !== code) : [...on, code];
  return available.filter((c) => c !== 'en' && next.includes(c));
}

/**
 * What turning `code` off would cost, when it would cost something: its source's name and how many series use it --
 * as their main source or a followed one -- which stop updating from it until it is back. Null when nothing uses it:
 * that one goes at once, unasked.
 */
export function offCost(sources: readonly LanguageSource[], code: string): { name: string; used: number } | null {
  const src = sources.find((s) => s.id === mangadexSourceId(code));
  const used = src ? (src.used ?? (src.main ?? 0) + (src.followed ?? 0)) : 0;
  return src && used > 0 ? { name: src.name, used } : null;
}

/**
 * Jobs that run one at a time, in the order they were handed in, each after the one before has settled -- failed
 * or not. The language list is saved whole, so two saves in flight at once could land the older one last and leave
 * the server a language short of what the chips show: three quick taps must be three saves in tap order.
 */
export function serial(): <T>(job: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(job: () => Promise<T>): Promise<T> => {
    const run = tail.then(job);
    tail = run.catch(() => {});
    return run;
  };
}
