import { normTitle } from './normTitle';
import type { Trending } from '../components/DiscoverHero';
import type { Pick as PersonalPick } from './forYou';

export type DiscoveryTab = 'for-you' | 'sources';
export type DiscoveryCountry = 'JP' | 'KR' | 'CN';
/** Per-account feedback uses a work identity; saving never creates a downloaded series. */
export interface DiscoveryItem {
  key: string; title: string; id?: number | null; cover: string | null;
  coverXL?: string | null; banner?: string | null; description: string; genres: string[];
  score: number | null; chapters: number | null; status: string | null;
  country?: DiscoveryCountry | null; reason?: string;
}
export interface DiscoveryState { tab: DiscoveryTab; saved: DiscoveryItem[]; hidden: string[] }
export interface DiscoveryFilters { country: DiscoveryCountry | 'all'; genre: string | null; completed: boolean }
export const EMPTY_DISCOVERY_STATE: DiscoveryState = { tab: 'for-you', saved: [], hidden: [] };
export const NO_DISCOVERY_FILTERS: DiscoveryFilters = { country: 'all', genre: null, completed: false };

export const discoveryKey = (item: { key?: string; id?: number | null; title: string }): string =>
  item.key || (item.id != null ? `al:${item.id}` : `t:${normTitle(item.title)}`);
export const titleKey = (title: string): string => `t:${normTitle(title)}`;
export const isHiddenPick = (item: { key?: string; id?: number | null; title: string }, hidden: ReadonlySet<string>): boolean =>
  hidden.has(discoveryKey(item)) || hidden.has(titleKey(item.title));

export function catalogItem(t: Trending, country: DiscoveryCountry): DiscoveryItem {
  return { ...t, key: discoveryKey(t), country, genres: t.genres ?? [], description: t.description ?? '' };
}

/** Round-robin the countries. A large manhwa list must not crowd manga/manhua out of the hero. */
export function mixCatalog(lists: readonly (readonly DiscoveryItem[])[]): DiscoveryItem[] {
  const out: DiscoveryItem[] = [], keys = new Set<string>(), names = new Set<string>();
  const longest = Math.max(0, ...lists.map((list) => list.length));
  for (let i = 0; i < longest; i++) for (const list of lists) {
    const item = list[i];
    if (!item) continue;
    const key = discoveryKey(item), name = normTitle(item.title);
    if (keys.has(key) || (name && names.has(name))) continue;
    keys.add(key); if (name) names.add(name); out.push(item);
  }
  return out;
}

/** Personal recommendations inherit known metadata, without pretending an unknown genre/status is known. */
export function recommendationItems(picks: readonly PersonalPick[], catalog: readonly DiscoveryItem[], reasonOf: (p: PersonalPick) => string): DiscoveryItem[] {
  const ids = new Map(catalog.filter((c) => c.id != null).map((c) => [c.id, c]));
  const names = new Map(catalog.map((c) => [normTitle(c.title), c]));
  return picks.map((p) => {
    const meta = (p.id != null && ids.get(p.id)) || names.get(normTitle(p.title));
    return { ...meta, key: discoveryKey(meta ?? p), id: p.id ?? meta?.id ?? null, title: p.title, cover: p.cover || meta?.cover || null,
      description: meta?.description ?? '', genres: meta?.genres ?? [], score: p.score ?? meta?.score ?? null,
      chapters: meta?.chapters ?? null, status: meta?.status ?? null, reason: reasonOf(p) };
  });
}

/** Unknown metadata stays unknown: a filter only admits titles that actually satisfy it. */
export function filterDiscovery(items: readonly DiscoveryItem[], filters: DiscoveryFilters, hidden: ReadonlySet<string> = new Set()): DiscoveryItem[] {
  return items.filter((it) => !isHiddenPick(it, hidden)
    && (filters.country === 'all' || it.country === filters.country)
    && (!filters.genre || it.genres.some((g) => g.toLocaleLowerCase('en') === filters.genre!.toLocaleLowerCase('en')))
    && (!filters.completed || it.status === 'FINISHED'));
}

export function surprisePick(items: readonly DiscoveryItem[], previous: string | null, random: number): DiscoveryItem | null {
  const eligible = items.length > 1 ? items.filter((it) => discoveryKey(it) !== previous) : [...items];
  if (!eligible.length) return null;
  const index = Math.min(eligible.length - 1, Math.max(0, Math.floor(random * eligible.length)));
  return eligible[index];
}

export const openingDiscoveryTab = (tab: string | null, query: string): DiscoveryTab | null =>
  query ? 'sources' : tab === 'sources' || tab === 'for-you' ? tab : null;

export function discoveryFiltersFrom(params: Pick<URLSearchParams, 'get'>): DiscoveryFilters {
  const country = params.get('country'), genre = params.get('genre');
  return { country: country === 'JP' || country === 'KR' || country === 'CN' ? country : 'all',
    genre: genre && ['Fantasy', 'Action', 'Romance', 'Mystery', 'Comedy', 'Sports'].includes(genre) ? genre : null,
    completed: params.get('completed') === '1' };
}
export function writeDiscoveryFilters(params: URLSearchParams, filters: DiscoveryFilters): URLSearchParams {
  const next = new URLSearchParams(params);
  if (filters.country === 'all') next.delete('country'); else next.set('country', filters.country);
  if (filters.genre) next.set('genre', filters.genre); else next.delete('genre');
  if (filters.completed) next.set('completed', '1'); else next.delete('completed');
  return next;
}

/** Wait for a remembered tab only when no URL or user choice has already settled it. Errors use the hub default. */
export function discoveryView(choice: DiscoveryTab | null, remembered: DiscoveryTab | undefined, pending: boolean): { tab: DiscoveryTab; ready: boolean } {
  return { tab: choice ?? remembered ?? 'for-you', ready: choice !== null || !pending };
}
