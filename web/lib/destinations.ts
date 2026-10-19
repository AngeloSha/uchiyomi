// Where search takes you besides a series (v0.55.4): the pages and settings the search palette and the phone search
// page find by name.
//
// The owner: "settings are buried too much". Kedryn looked for the version in "a menu on the left somewhere" (#150) and
// DannyDynamite39 for the import (#158), and both were there -- a tab, a section and a scroll away. Typing what you are
// looking for is the one way in that needs no map, so every page of the two consoles, every row of their settings, the
// profile's cards, the import page and the settings people ask for by name are destinations here: shown for a query of two
// characters or more, under their own heading after the series, to admins only where the page is theirs, and never on
// Uchiyomi Desktop where the page or the setting does not exist there (lib/desktop.ts DESKTOP_HIDDEN).
//
// A destination is found by its label in the reader's language (it is what the row says) and in English, and by a few
// English words someone might type instead ("flaresolverr", "mihon", "2fa"). `?section=` names the card to scroll to
// once the page has it (lib/useSectionArrival.ts); each such id is on its card (web/test/destinations.test.ts holds
// every one to its source).
import { keys, t as tr } from './i18n';
import { fold, rankMatch, type SettingsIndex } from './settingsIndex';
import { PROFILE_SETTINGS } from './settingsIndex.profile';
import { ADMIN_SETTINGS, SETTINGS_NAME_ALIASES } from './settingsIndex.admin';

export { fold };

/** Every label and place below, declared so the translation extractor sees them (lib/i18n.ts `keys`). The consoles' pages
 * and groups are declared with their registries (lib/settingsIndex*.ts). */
const LABELS = keys(
  // The settings pages by their old tab's name, and what was the Tasks tab.
  'Settings', 'Tasks',
  // Pages and cards people ask for by name, besides the consoles' pages and settings (generated below).
  'Cloudflare solver', 'Version', 'Import a list', 'Rescan everything',
  // The profile's cards.
  'Badges', 'Reading studio', 'Weekly goal', 'Progress tracking',
  'External readers (OPDS)', 'API tokens', 'Change password', 'Two-factor authentication', 'Active sessions',
  // Where each one is.
  'Admin', 'Profile', 'Health', 'Maintenance', 'Connections', 'Account',
);
export type DestinationLabel = (typeof LABELS)[number];

export interface Destination {
  /** Stable: React's key and the tests'. */
  key: string;
  /** What the row says, an English key shown through tr(). A setting's is its row's own label (lib/settingsIndex*.ts). */
  label: string;
  /** Where it is, said after the label: Admin → Settings → Downloads. */
  where: readonly string[];
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
const ADMIN_HEALTH = ['Admin', 'Health'] as const;
const ADMIN_MAINTENANCE = ['Admin', 'Settings', 'Maintenance'] as const;
const PROFILE = ['Profile'] as const;
const PROFILE_CONNECTIONS = ['Profile', 'Connections'] as const;
const PROFILE_ACCOUNT = ['Profile', 'Account'] as const;

/** Besides the consoles' own pages and settings rows (generated from their registries, `consoleDestinations` below). */
const PAGES: readonly Destination[] = [
  // ---- Admin ----
  // The settings pages by the tab they sat in before v0.88.0: Server is the first of them.
  { key: 'admin-settings', label: 'Settings', where: ADMIN, href: '/admin/?tab=server', admin: true,
    keywords: ['server settings', 'admin settings', 'configuration', 'config', 'options'] },
  // What was the Tasks tab (v0.88.0): Maintenance's Run now, under its settings.
  { key: 'admin-tasks', label: 'Tasks', where: ADMIN_MAINTENANCE, href: '/admin/?tab=maintenance&section=tasks', admin: true,
    keywords: ['jobs', 'scheduled', 'run now'] },
  // Health's cards, by the check they show (`check-<id>`, app/admin/page.tsx Health).
  { key: 'solver', label: 'Cloudflare solver', where: ADMIN_HEALTH, href: '/admin/?tab=health&section=check-solver', admin: true,
    keywords: ['flaresolverr', 'byparr', 'trawl', 'captcha', 'cloudflare'] },
  { key: 'version', label: 'Version', where: ADMIN_HEALTH, href: '/admin/?tab=health&section=check-update', admin: true,
    keywords: ['update', 'upgrade', 'release', 'changelog', 'about'] },
  // Maintenance's tasks, by the task they run (`task-<id>`, app/admin/page.tsx Tasks). Rescan everything (v0.55.4, #150) is
  // what Kedryn asked for by name, "rescan everything from scratch, removing from library what is no more on disk".
  { key: 'rescan', label: 'Rescan everything', where: ADMIN_MAINTENANCE, href: '/admin/?tab=maintenance&section=task-rescan', admin: true,
    keywords: ['rescan', 'scan from scratch', 'files gone', 'deleted files', 'missing files', 'remove from library', 'no longer on disk'] },

  // ---- The import (app/admin/import/page.tsx) ----
  { key: 'import', label: 'Import a list', where: ADMIN, href: '/admin/import/', admin: true,
    keywords: ['import', 'mihon', 'tachiyomi', 'tachibk', 'backup', 'mangadex', 'anilist', 'myanimelist', 'mal', 'kitsu', 'mangaupdates',
      'migrate', 'move my library', 'paste titles'] },

  // ---- The profile's cards (app/profile/page.tsx) ----
  { key: 'profile-badges', label: 'Badges', where: PROFILE, href: '/profile/?section=badges', keywords: ['achievements'] },
  { key: 'profile-studio', label: 'Reading studio', where: PROFILE, href: '/profile/?section=reading-studio',
    keywords: ['stats', 'statistics', 'heatmap', 'calendar'] },
  // The settings pages by the tab they sat in before v0.88.0: General is the first of them.
  { key: 'profile-settings', label: 'Settings', where: PROFILE, href: '/profile/?tab=general', keywords: ['my settings', 'preferences', 'options'] },
  // The weekly goal's one home since v0.86.0: the ring on the profile's card, which opens its dialog.
  { key: 'weekly-goal', label: 'Weekly goal', where: PROFILE, href: '/profile/?section=weekly-goal', keywords: ['goal', 'chapters a week'] },
  { key: 'progress-tracking', label: 'Progress tracking', where: PROFILE_CONNECTIONS, href: '/profile/?tab=connections&section=progress-tracking',
    keywords: ['anilist', 'myanimelist', 'mal', 'kitsu', 'mangaupdates', 'tracker', 'sync'] },
  { key: 'opds', label: 'External readers (OPDS)', where: PROFILE_CONNECTIONS, href: '/profile/?tab=connections&section=opds',
    desktopHidden: true, keywords: ['opds', 'koreader', 'panels', 'chunky', 'e-reader'] },
  { key: 'api-tokens', label: 'API tokens', where: PROFILE_CONNECTIONS, href: '/profile/?tab=connections&section=api-tokens',
    desktopHidden: true, keywords: ['api', 'token', 'mihon', 'komga', 'scripts'] },
  { key: 'change-password', label: 'Change password', where: PROFILE_ACCOUNT, href: '/profile/?tab=account&section=signed-in',
    desktopHidden: true, keywords: ['password'] },
  { key: 'two-factor', label: 'Two-factor authentication', where: PROFILE_ACCOUNT, href: '/profile/?tab=account&section=two-factor',
    desktopHidden: true, keywords: ['2fa', 'totp', 'authenticator', 'mfa', 'recovery codes'] },
  { key: 'active-sessions', label: 'Active sessions', where: PROFILE_ACCOUNT, href: '/profile/?tab=account&section=sessions',
    desktopHidden: true, keywords: ['devices', 'signed in'] },
];

/**
 * Every page of a console and every row of its settings pages as a destination (v0.86.0; the pages since v0.88.0), from
 * its registry (lib/settingsIndex*.ts). A page's place is the console and the group it is listed under; a row's, that
 * and its page; `?tab=` opens the page and `?section=` the row, which the console opens and flashes
 * (components/ConsoleLayout.tsx). The first page is the console's bare address. The pages and rows needing a server's
 * web install are not offered on Uchiyomi Desktop; one that needs a mode or an engine this server may not have lands on
 * its page, which is still the right place to look.
 */
export function consoleDestinations(index: SettingsIndex): Destination[] {
  const admin = index.page === 'admin';
  const path = admin ? '/admin/' : '/profile/';
  const top = admin ? 'Admin' : 'Profile';
  const first = index.categories[0]?.id;
  const cats = new Map(index.categories.map((c) => [c.id, c]));
  const web = (when?: readonly string[]) => !!when?.includes('web');
  const aliasesOf = (label: string) => Object.entries(SETTINGS_NAME_ALIASES).filter(([, to]) => to === label).map(([from]) => from);
  const out: Destination[] = index.categories.map((c) => ({
    key: `${index.page}-cat-${c.id}`, label: c.label, where: c.group ? [top, c.group] : [top],
    href: c.id === first ? path : `${path}?tab=${c.id}`,
    admin: admin || undefined, desktopHidden: web(c.when) || undefined,
    // A section's name before v0.86.0 finds the page it became.
    keywords: [...(c.keywords ?? []), ...aliasesOf(c.label)],
  }));
  for (const e of index.entries) {
    const cat = cats.get(e.cat);
    if (!cat) continue;
    out.push({
      key: `${index.page}-${e.id}`, label: e.label, where: [top, ...(cat.group ? [cat.group] : []), cat.label],
      href: `${path}?tab=${cat.id}&section=${e.id}`,
      admin: admin || undefined, desktopHidden: web(e.when) || web(cat.when) || undefined,
      keywords: [...(e.keywords ?? []), ...aliasesOf(e.label)],
    });
  }
  return out;
}

const CONSOLES = [...consoleDestinations(ADMIN_SETTINGS), ...consoleDestinations(PROFILE_SETTINGS)];
const isPage = (d: Destination) => d.key.includes('-cat-');
/** The consoles' pages, then the cards above, then every settings row: the order a tie is broken in. */
export const DESTINATIONS: readonly Destination[] = [...CONSOLES.filter(isPage), ...PAGES, ...CONSOLES.filter((d) => !isPage(d))];


/**
 * The destinations a query finds, best first, for this viewer: admins only for the admin's pages, none of Desktop's
 * missing ones there, nothing below two characters (the palette's own threshold). Its label first -- in the reader's
 * language and in English, whole, then at its start, then at a word's start, then anywhere in it -- then its words.
 * A match inside a word ("ate" in "Updates") counts from three characters, where two are noise ("pd" found Updates
 * and OPDS) -- except in Chinese and Japanese, written without spaces, where there is no word start to look for.
 */
export function findDestinations(query: string, viewer: { admin: boolean; desktop: boolean; limit?: number; label?: (k: string) => string }): Destination[] {
  if (fold(query.trim()).length < 2) return [];
  const label = viewer.label ?? ((k: string) => tr(k));
  const rank = (d: Destination): number => rankMatch(query, [label(d.label), d.label], d.keywords ?? []);
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

/** The page a console opens on when its address names none (lib/settingsIndex*.ts, the first of its pages). */
const FIRST_TAB: Readonly<Record<string, string>> = { '/admin/': 'overview', '/profile/': 'you' };
const slashed = (p: string): string => (p.endsWith('/') ? p : `${p}/`);

/**
 * How to get to `href` from the page at `here`, when the console on screen does not open it itself
 * (lib/consoleOnScreen.ts, asked first):
 *   * `push` -- another page: a client-side navigation, and that page reads its page and section as it mounts;
 *   * `scroll` -- this page, with the section already on it: scroll there;
 *   * `none` -- this page and tab, and no section: already there;
 *   * `load` -- this page on another tab (or a section not drawn yet): a whole page load, which reads `?section=` as it
 *     arrives. A console's pages are compared by name in any case (`?tab=Health` is `health`).
 */
export function arrival(href: string, here: { pathname: string; search: string }, onPage: (id: string) => boolean): 'push' | 'scroll' | 'none' | 'load' {
  const to = new URL(href, 'http://x');
  const path = slashed(to.pathname);
  if (path !== slashed(here.pathname)) return 'push';
  const section = to.searchParams.get('section');
  if (section && onPage(section)) return 'scroll';
  const first = FIRST_TAB[path] ?? '';
  const tabOf = (search: string) => (new URLSearchParams(search).get('tab') || first).toLowerCase();
  if (!section && tabOf(to.search) === tabOf(here.search)) return 'none';
  return 'load';
}
