// The MangaDex card's decisions, with no React in them (components/MangadexCard.tsx, v0.52.0, #123): what one tap
// on a language sends, whether turning one off asks first, and the order the saves go out in.
import { mangadexSourceId, type ProviderGroup } from './providerGroups';

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
 * What turning `code` off would cost, when it would cost something: its source's name and how many series came from
 * it, which stop updating until it is back. Null when nothing came from it -- that one goes at once, unasked.
 */
export function offCost(group: ProviderGroup, code: string): { name: string; used: number } | null {
  const src = group.sources.find((s) => s.id === mangadexSourceId(code));
  return src && (src.used ?? 0) > 0 ? { name: src.name, used: src.used! } : null;
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
