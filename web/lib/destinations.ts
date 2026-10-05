// Where search takes you besides a series (v0.55.4): the pages and settings the search palette and the phone search
// page find by name.
//
// The owner: "settings are buried too much". Kedryn looked for the version in "a menu on the left somewhere" (#150) and
// DannyDynamite39 for the import (#158), and both were there -- a tab, a section and a scroll away. Typing what you are
// looking for is the one way in that needs no map, so every admin tab, Admin → Settings' sections, the profile's tabs
// and cards, the import page and the settings people ask for by name are destinations here: shown for a query of two
// characters or more, under their own heading after the series, to admins only where the page is theirs, and never on
// Uchiyomi Desktop where the page or the setting does not exist there (lib/desktop.ts DESKTOP_HIDDEN).
//
// A destination is found by its label in the reader's language (it is what the row says) and in English, and by a few
// English words someone might type instead ("flaresolverr", "mihon", "2fa"). `?section=` names the card to scroll to
// once the page has it (lib/useSectionArrival.ts); each such id is on its card (web/test/destinations.test.ts holds
// every one to its source).
import { keys, t as tr } from './i18n';

/** Every label and place below, declared so the translation extractor sees them (lib/i18n.ts `keys`). */
const LABELS = keys(
  // The admin tabs.
  'Overview', 'Tasks', 'Settings', 'Members', 'Sessions', 'Activity', 'Library', 'Health', 'Art', 'Sources',
  // The sections of Admin → Settings, in their order.
  'Server', 'Updates & schedules', 'Library housekeeping', 'Scanlators', 'Notifications', 'Downloads', '18+ filter',
  'Source order', 'Notice chapters',
  // Settings people ask for by name.
  'Check for updates', 'Open registration', 'Backup time', 'Delete read chapters', 'Show missing chapters in Mihon',
  'Slow archive', 'Cloudflare solver', 'Version', 'Import a list',
  // The profile: its tabs, its cards and its settings by name.
  'You', 'Connections', 'Account', 'Badges', 'Reading studio', 'Appearance', 'Language', 'Reduce effects', 'Reading',
  'Weekly goal', 'Reading direction', 'Offline downloads', 'This device', 'New-chapter alerts', 'Progress tracking',
  'External readers (OPDS)', 'API tokens', 'Change password', 'Two-factor authentication', 'Active sessions',
  // Where each one is.
  'Admin', 'Profile',
);
export type DestinationLabel = (typeof LABELS)[number];

export interface Destination {
  /** Stable: React's key and the tests'. */
  key: string;
  /** What the row says, an English key shown through tr(). */
  label: DestinationLabel;
  /** Where it is, said after the label: Admin → Settings. */
  where: readonly DestinationLabel[];
  /** The page, its `?tab=` and the card it scrolls to (`?section=`). */
  href: string;
  /** English words someone might type for it besides its label. */
  keywords?: readonly string[];
  /** The admin console and the import page: admins only. */
  admin?: boolean;
  /** Not on Uchiyomi Desktop, which has no such page or setting. */
  desktopHidden?: boolean;
}

const ADMIN = ['Admin'] as const;
const ADMIN_SETTINGS = ['Admin', 'Settings'] as const;
const ADMIN_HEALTH = ['Admin', 'Health'] as const;
const PROFILE = ['Profile'] as const;
const PROFILE_SETTINGS = ['Profile', 'Settings'] as const;
const PROFILE_CONNECTIONS = ['Profile', 'Connections'] as const;
const PROFILE_ACCOUNT = ['Profile', 'Account'] as const;
const settings = (section: string) => `/admin/?tab=Settings&section=${section}`;

export const DESTINATIONS: readonly Destination[] = [
  // ---- Admin's tabs (app/admin/page.tsx GROUPS) ----
  { key: 'admin-overview', label: 'Overview', where: ADMIN, href: '/admin/', admin: true, keywords: ['admin', 'dashboard', 'stats'] },
  { key: 'admin-tasks', label: 'Tasks', where: ADMIN, href: '/admin/?tab=Tasks', admin: true, keywords: ['jobs', 'scheduled', 'run now'] },
  { key: 'admin-settings', label: 'Settings', where: ADMIN, href: '/admin/?tab=Settings', admin: true,
    keywords: ['server settings', 'admin settings', 'configuration', 'config', 'options'] },
  { key: 'admin-members', label: 'Members', where: ADMIN, href: '/admin/?tab=Members', admin: true, desktopHidden: true,
    keywords: ['users', 'accounts', 'people', 'roles', 'age limit', 'reset password'] },
  { key: 'admin-sessions', label: 'Sessions', where: ADMIN, href: '/admin/?tab=Sessions', admin: true, desktopHidden: true,
    keywords: ['devices', 'signed in', 'logins'] },
  { key: 'admin-activity', label: 'Activity', where: ADMIN, href: '/admin/?tab=Activity', admin: true, keywords: ['audit', 'log', 'events'] },
  { key: 'admin-library', label: 'Library', where: ADMIN, href: '/admin/?tab=Library', admin: true,
    keywords: ['libraries', 'folders', 'hidden series', 'removed series', 'restore', 'age rating'] },
  { key: 'admin-health', label: 'Health', where: ADMIN, href: '/admin/?tab=Health', admin: true,
    keywords: ['problems', 'errors', 'fix everything', 'repair', 'checks', 'missing chapters', 'gaps'] },
  { key: 'admin-art', label: 'Art', where: ADMIN, href: '/admin/?tab=Art', admin: true, keywords: ['covers', 'artwork', 'banners', 'images'] },
  { key: 'admin-sources', label: 'Sources', where: ADMIN, href: '/admin/?tab=Sources', admin: true,
    keywords: ['providers', 'extensions', 'mangadex', 'sites', 'add a site', 'repositories'] },

  // ---- Admin → Settings' sections (components/AdminSettings.tsx), each by its `id` ----
  { key: 'settings-server', label: 'Server', where: ADMIN_SETTINGS, href: settings('server'), admin: true, keywords: ['server name'] },
  { key: 'settings-schedules', label: 'Updates & schedules', where: ADMIN_SETTINGS, href: settings('schedules'), admin: true,
    keywords: ['update interval', 'schedule', 'extension updates'] },
  { key: 'settings-housekeeping', label: 'Library housekeeping', where: ADMIN_SETTINGS, href: settings('housekeeping'), admin: true,
    keywords: ['cleanup', 'repair nightly'] },
  { key: 'settings-scanlators', label: 'Scanlators', where: ADMIN_SETTINGS, href: settings('scanlators'), admin: true,
    keywords: ['groups', 'scanlation', 'translation groups', 'blocked groups'] },
  { key: 'settings-notifications', label: 'Notifications', where: ADMIN_SETTINGS, href: settings('notifications'), admin: true,
    keywords: ['webhook', 'discord', 'ntfy', 'home assistant', 'alerts'] },
  { key: 'settings-downloads', label: 'Downloads', where: ADMIN_SETTINGS, href: settings('downloads'), admin: true,
    keywords: ['chapters an hour', 'pace', 'free space'] },
  { key: 'settings-adult', label: '18+ filter', where: ADMIN_SETTINGS, href: settings('adult-filter'), admin: true,
    keywords: ['adult', 'nsfw', 'mature', 'show 18+'] },
  { key: 'settings-source-order', label: 'Source order', where: ADMIN_SETTINGS, href: settings('source-order'), admin: true,
    keywords: ['priority', 'preferred source'] },
  { key: 'settings-notice', label: 'Notice chapters', where: ADMIN_SETTINGS, href: settings('notice-chapters'), admin: true,
    keywords: ['notices', 'announcements', 'hiatus', 'short chapters'] },

  // ---- Settings people ask for by name ----
  { key: 'update-check', label: 'Check for updates', where: ADMIN_SETTINGS, href: settings('server'), admin: true,
    keywords: ['updates', 'new version', 'release', 'github'] },
  { key: 'registration', label: 'Open registration', where: ADMIN_SETTINGS, href: settings('server'), admin: true, desktopHidden: true,
    keywords: ['sign up', 'signup', 'register'] },
  { key: 'backup-time', label: 'Backup time', where: ADMIN_SETTINGS, href: settings('schedules'), admin: true,
    keywords: ['backup', 'database backup', 'dump'] },
  { key: 'delete-read', label: 'Delete read chapters', where: ADMIN_SETTINGS, href: settings('housekeeping'), admin: true,
    keywords: ['cleanup', 'free space', 'disk space'] },
  { key: 'mihon-missing', label: 'Show missing chapters in Mihon', where: ADMIN_SETTINGS, href: settings('housekeeping'), admin: true,
    desktopHidden: true, keywords: ['komga', 'ghost chapters', 'tachiyomi'] },
  { key: 'slow-archive', label: 'Slow archive', where: ADMIN_SETTINGS, href: settings('downloads'), admin: true,
    keywords: ['archive', 'older chapters', 'whole series'] },
  // Health's cards, by the check they show (`check-<id>`, app/admin/page.tsx Health).
  { key: 'solver', label: 'Cloudflare solver', where: ADMIN_HEALTH, href: '/admin/?tab=Health&section=check-solver', admin: true,
    keywords: ['flaresolverr', 'byparr', 'trawl', 'captcha', 'cloudflare'] },
  { key: 'version', label: 'Version', where: ADMIN_HEALTH, href: '/admin/?tab=Health&section=check-update', admin: true,
    keywords: ['update', 'upgrade', 'release', 'changelog', 'about'] },

  // ---- The import (app/admin/import/page.tsx) ----
  { key: 'import', label: 'Import a list', where: ADMIN, href: '/admin/import/', admin: true,
    keywords: ['import', 'mihon', 'tachiyomi', 'tachibk', 'backup', 'mangadex', 'anilist', 'myanimelist', 'mal', 'kitsu',
      'migrate', 'move my library', 'paste titles'] },

  // ---- The profile's tabs (app/profile/page.tsx), cards and settings ----
  { key: 'profile-you', label: 'You', where: PROFILE, href: '/profile/', keywords: ['profile', 'me', 'my stats'] },
  { key: 'profile-badges', label: 'Badges', where: PROFILE, href: '/profile/?section=badges', keywords: ['achievements'] },
  { key: 'profile-studio', label: 'Reading studio', where: PROFILE, href: '/profile/?section=reading-studio',
    keywords: ['stats', 'statistics', 'heatmap', 'calendar'] },
  { key: 'profile-settings', label: 'Settings', where: PROFILE, href: '/profile/?tab=Settings', keywords: ['my settings', 'preferences', 'options'] },
  { key: 'appearance', label: 'Appearance', where: PROFILE_SETTINGS, href: '/profile/?tab=Settings&section=appearance',
    keywords: ['theme', 'accent', 'colour', 'color', 'avatar'] },
  { key: 'language', label: 'Language', where: PROFILE_SETTINGS, href: '/profile/?tab=Settings&section=appearance',
    keywords: ['translation', 'locale'] },
  { key: 'reduce-effects', label: 'Reduce effects', where: PROFILE_SETTINGS, href: '/profile/?tab=Settings&section=appearance',
    keywords: ['motion', 'animations', 'blur'] },
  { key: 'reading', label: 'Reading', where: PROFILE_SETTINGS, href: '/profile/?tab=Settings&section=reading',
    keywords: ['reader', 'webtoon', 'paged', 'brightness', 'page gap'] },
  { key: 'weekly-goal', label: 'Weekly goal', where: PROFILE_SETTINGS, href: '/profile/?tab=Settings&section=reading', keywords: ['goal'] },
  { key: 'reading-direction', label: 'Reading direction', where: PROFILE_SETTINGS, href: '/profile/?tab=Settings&section=reading',
    keywords: ['right to left', 'left to right', 'rtl'] },
  { key: 'offline-downloads', label: 'Offline downloads', where: PROFILE_SETTINGS, href: '/profile/?tab=Settings&section=downloads',
    desktopHidden: true, keywords: ['offline', 'keep favorites offline', 'storage'] },
  { key: 'this-device', label: 'This device', where: PROFILE_SETTINGS, href: '/profile/?tab=Settings&section=device',
    desktopHidden: true, keywords: ['install app', 'pwa'] },
  { key: 'chapter-alerts', label: 'New-chapter alerts', where: PROFILE_SETTINGS, href: '/profile/?tab=Settings&section=device',
    desktopHidden: true, keywords: ['push', 'notifications'] },
  { key: 'profile-connections', label: 'Connections', where: PROFILE, href: '/profile/?tab=Connections', keywords: ['integrations'] },
  { key: 'progress-tracking', label: 'Progress tracking', where: PROFILE_CONNECTIONS, href: '/profile/?tab=Connections&section=progress-tracking',
    keywords: ['anilist', 'myanimelist', 'mal', 'kitsu', 'tracker', 'sync'] },
  { key: 'opds', label: 'External readers (OPDS)', where: PROFILE_CONNECTIONS, href: '/profile/?tab=Connections&section=opds',
    desktopHidden: true, keywords: ['opds', 'koreader', 'panels', 'chunky', 'e-reader'] },
  { key: 'api-tokens', label: 'API tokens', where: PROFILE_CONNECTIONS, href: '/profile/?tab=Connections&section=api-tokens',
    desktopHidden: true, keywords: ['api', 'token', 'mihon', 'komga', 'scripts'] },
  { key: 'profile-account', label: 'Account', where: PROFILE, href: '/profile/?tab=Account', desktopHidden: true,
    keywords: ['security', 'sign out', 'log out'] },
  { key: 'change-password', label: 'Change password', where: PROFILE_ACCOUNT, href: '/profile/?tab=Account&section=signed-in',
    desktopHidden: true, keywords: ['password'] },
  { key: 'two-factor', label: 'Two-factor authentication', where: PROFILE_ACCOUNT, href: '/profile/?tab=Account&section=two-factor',
    desktopHidden: true, keywords: ['2fa', 'totp', 'authenticator', 'mfa', 'recovery codes'] },
  { key: 'active-sessions', label: 'Active sessions', where: PROFILE_ACCOUNT, href: '/profile/?tab=Account&section=sessions',
    desktopHidden: true, keywords: ['devices', 'signed in'] },
];

/** Lower case with the accents off, so "parametres" finds "Paramètres" and "u" finds "ü". */
export const fold = (s: string): string => s.normalize('NFKD').replace(/\p{M}+/gu, '').toLocaleLowerCase();

const atWordStart = (text: string, word: string): boolean =>
  new RegExp(`(^|[^\\p{L}\\p{N}])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'u').test(text);

/**
 * The destinations a query finds, best first, for this viewer: admins only for the admin's pages, none of Desktop's
 * missing ones there, nothing below two characters (the palette's own threshold). Its label first -- in the reader's
 * language and in English, whole, then at its start, then at a word's start, then anywhere in it -- then its words.
 * A match inside a word ("ate" in "Updates") counts from three characters, where two are noise ("pd" found Updates
 * and OPDS) -- except in Chinese and Japanese, written without spaces, where there is no word start to look for.
 */
export function findDestinations(query: string, viewer: { admin: boolean; desktop: boolean; limit?: number; label?: (k: string) => string }): Destination[] {
  const q = fold(query.trim()).replace(/\s+/g, ' ');
  if (q.length < 2) return [];
  const words = q.split(' ');
  const inside = q.length >= 3 || /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(q);
  const label = viewer.label ?? ((k: string) => tr(k));
  const rank = (d: Destination): number => {
    const names = [fold(label(d.label)), fold(d.label)];
    if (names.includes(q)) return 0;
    if (names.some((n) => n.startsWith(q))) return 1;
    if (names.some((n) => words.every((w) => atWordStart(n, w)))) return 2;
    if (inside && names.some((n) => n.includes(q))) return 3;
    const kws = (d.keywords ?? []).map(fold);
    if (kws.some((k) => k === q || k.startsWith(q))) return 4;
    const all = [...names, ...kws].join('\n');
    if (words.every((w) => atWordStart(all, w))) return 5;
    if (inside && words.every((w) => all.includes(w))) return 6;
    return -1;
  };
  return DESTINATIONS
    .filter((d) => (!d.admin || viewer.admin) && !(d.desktopHidden && viewer.desktop))
    .map((d, i) => ({ d, i, r: rank(d) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .slice(0, viewer.limit ?? 6)
    .map((x) => x.d);
}

/**
 * "Admin → Settings", in the reader's language. The arrow points the way the sentence reads: Arabic writes these paths
 * with "←" (its translations of "Admin → Sources" do), and a "→" there would point back at where you came from.
 */
export function whereText(d: Destination, rtl: boolean): string {
  return d.where.map((w) => tr(w)).join(rtl ? ' ← ' : ' → ');
}

/** The console a page's first tab is, when its address names none. */
const FIRST_TAB: Readonly<Record<string, string>> = { '/admin/': 'Overview', '/profile/': 'You' };
const slashed = (p: string): string => (p.endsWith('/') ? p : `${p}/`);

/**
 * How to get to `href` from the page at `here`:
 *   * `push` -- another page: a client-side navigation, and that page reads its tab and section as it mounts;
 *   * `scroll` -- this page, with the section already on it: scroll there;
 *   * `none` -- this page and tab, and no section: already there;
 *   * `load` -- this page on another tab (or a section not drawn yet): a whole page load. ⚠️ The console reads `?tab=`
 *     ONCE (lib/useTabParam.ts, which must not re-read it -- settingsConsole.test.ts), so a client-side push to
 *     `/admin/?tab=Settings` while Admin is open changes the address and nothing on the screen: the precedent is Fix
 *     everything's Settings key, an `<a href>` for the same reason (lib/autofix.ts needsYouKey).
 */
export function arrival(href: string, here: { pathname: string; search: string }, onPage: (id: string) => boolean): 'push' | 'scroll' | 'none' | 'load' {
  const to = new URL(href, 'http://x');
  const path = slashed(to.pathname);
  if (path !== slashed(here.pathname)) return 'push';
  const section = to.searchParams.get('section');
  if (section && onPage(section)) return 'scroll';
  const first = FIRST_TAB[path] ?? '';
  const tabOf = (search: string) => new URLSearchParams(search).get('tab') || first;
  if (!section && tabOf(to.search) === tabOf(here.search)) return 'none';
  return 'load';
}
