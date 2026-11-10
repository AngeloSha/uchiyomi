import { keys, t as tr } from '../i18n';
import type { NavRing } from '../serverDownloads';

const LABELS = keys('Home', 'Library', 'Search', 'Discover', 'Offline', 'You');
export const PRIMARY_DESTINATIONS = [
  { id: 'home', href: '/', label: LABELS[0] },
  { id: 'library', href: '/library/', label: LABELS[1] },
  { id: 'search', href: '/search/', label: LABELS[2] },
  { id: 'discover', href: '/discover/', label: LABELS[3] },
  { id: 'offline', href: '/downloads/', label: LABELS[4] },
  { id: 'profile', href: '/profile/', label: LABELS[5] },
] as const;
const MORE_LABELS = keys('Lists', 'Reading history', 'Moments', 'Updates', 'Admin', 'Quick settings');
export const SECONDARY_DESTINATIONS = [
  { id: 'lists', href: '/collections/', label: MORE_LABELS[0] },
  { id: 'history', href: '/history/', label: MORE_LABELS[1] },
  { id: 'moments', href: '/moments/', label: MORE_LABELS[2] },
  { id: 'updates', href: '/updates/', label: MORE_LABELS[3] },
  { id: 'admin', href: '/admin/', label: MORE_LABELS[4] },
  { id: 'quick-settings', href: null, label: MORE_LABELS[5] },
] as const;
export type Destination = typeof PRIMARY_DESTINATIONS[number]['id'];
export type NavigationAction = Destination | typeof SECONDARY_DESTINATIONS[number]['id'];
export type NavigationAuth = 'loading' | 'anon' | 'authed' | 'offline';
export interface NavigationItem { id: NavigationAction; label: string; enabled: boolean; badge?: string; status?: string }
export interface NavigationPresentation {
  auth: NavigationAuth;
  immersive: boolean;
  selected: Destination;
  items: NavigationItem[];
  secondary: NavigationItem[];
}
const route = (path: string, root: string) => path === root || path.startsWith(`${root}/`);
export function selectedDestination(path: string): Destination {
  if (path === '/') return 'home';
  if (route(path, '/library') || route(path, '/series')) return 'library';
  if (route(path, '/search')) return 'search';
  if (route(path, '/discover')) return 'discover';
  if (route(path, '/downloads')) return 'offline';
  return 'profile';
}
export function navigationPresentation(options: {
  path: string; auth: NavigationAuth; downloader: boolean; admin: boolean; ring?: NavRing;
}): NavigationPresentation {
  const { path, auth, downloader, admin, ring } = options;
  const state: NavigationPresentation = { auth, immersive: route(path, '/reader'), selected: selectedDestination(path), items: [], secondary: [] };
  if (auth === 'loading' || auth === 'anon') return state;
  state.items = PRIMARY_DESTINATIONS.filter(i => i.id !== 'discover' || downloader).map(i => ({
    id: i.id, label: tr(i.label).slice(0, 120), enabled: auth === 'authed' || i.id === 'offline',
    ...(i.id === 'library' && auth === 'authed' && downloader && ring?.show ? {
      badge: ring.attention ? '!' : String(Math.min(999, Math.max(0, Math.floor(ring.count)))),
      status: ring.label.slice(0, 240),
    } : {}),
  }));
  state.secondary = SECONDARY_DESTINATIONS.filter(i => i.id !== 'admin' || admin).map(i => ({
    id: i.id, label: tr(i.label).slice(0, 120), enabled: auth === 'authed' || i.id === 'quick-settings',
  }));
  if (!state.items.some(i => i.id === state.selected)) state.selected = 'profile';
  return state;
}
export function navigationTarget(action: NavigationAction): string | null {
  return [...PRIMARY_DESTINATIONS, ...SECONDARY_DESTINATIONS].find(i => i.id === action)?.href ?? null;
}
export function actionAllowed(state: NavigationPresentation, action: unknown): action is NavigationAction {
  return typeof action === 'string' && [...state.items, ...state.secondary].some(i => i.id === action && i.enabled);
}
