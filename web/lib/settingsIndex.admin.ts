// Admin in the console registry (lib/settingsIndex.ts): its pages in the order its list shows them (v0.88.0), every row
// of its settings pages by its DOM id (components/AdminSettings.tsx and the files it mounts), and the card ids and tab
// names it had before.
import { keys } from './i18n';
import type { SettingsIndex } from './settingsIndex';

/** The categories' names and the groups' titles, declared for the translation extractor (lib/i18n.ts `keys`). */
export const ADMIN_SETTINGS_WORDS = keys(
  'Overview', 'Health', 'Libraries', 'Sources', 'Art', 'Members', 'Sessions', 'Activity', 'Library', 'People', 'Settings',
  'Server', 'Series & chapters', 'Downloads', 'Maintenance', 'Notifications',
  'Updates and privacy', 'Shown to members', 'From the internet', 'Getting chapters', 'Disk space', 'Backups', 'Repair', 'Extensions',
);

/**
 * The names sections had before v0.86.0, for the docs test (test/consoleNamesInDocs) and search: "Updates & schedules"
 * is Downloads now, "Library housekeeping" Maintenance, "Scanlators" the Scanlation groups row.
 */
export const SETTINGS_NAME_ALIASES: Readonly<Record<string, string>> = {
  'Updates & schedules': 'Downloads',
  'Library housekeeping': 'Maintenance',
  Scanlators: 'Scanlation groups',
};

export const ADMIN_SETTINGS: SettingsIndex = {
  page: 'admin',
  // v0.88.0: one list. Overview and Health first (what is wrong, what is happening), then the library, the people, and
  // the settings pages -- Maintenance with every Run now that was the Tasks tab.
  categories: [
    { id: 'overview', label: 'Overview', keywords: ['admin', 'dashboard', 'stats', 'needs attention', 'top 10'] },
    { id: 'health', label: 'Health', keywords: ['problems', 'errors', 'fix everything', 'checks', 'missing chapters', 'gaps'] },
    { id: 'library', label: 'Libraries', group: 'Library',
      keywords: ['library', 'folders', 'hidden series', 'removed series', 'restore', 'age rating'] },
    { id: 'sources', label: 'Sources', group: 'Library', keywords: ['providers', 'extensions', 'mangadex', 'sites', 'add a site', 'repositories'] },
    { id: 'art', label: 'Art', group: 'Library', keywords: ['covers', 'artwork', 'banners', 'images'] },
    // Uchiyomi Desktop is one person: no other accounts, no other sessions (lib/desktop.ts).
    { id: 'members', label: 'Members', group: 'People', when: ['web'], keywords: ['users', 'accounts', 'people', 'roles', 'age limit', 'reset password'] },
    { id: 'sessions', label: 'Sessions', group: 'People', when: ['web'], keywords: ['devices', 'signed in', 'logins'] },
    { id: 'activity', label: 'Activity', group: 'People', keywords: ['audit', 'log', 'events'] },
    { id: 'server', label: 'Server', group: 'Settings', settings: true, keywords: ['server settings', 'configuration', 'config'] },
    { id: 'series', label: 'Series & chapters', group: 'Settings', settings: true },
    { id: 'downloads', label: 'Downloads', group: 'Settings', settings: true },
    { id: 'maintenance', label: 'Maintenance', group: 'Settings', settings: true,
      keywords: ['tasks', 'jobs', 'run now', 'scheduled', 'backup', 'repair', 'scan'] },
    { id: 'notifications', label: 'Notifications', group: 'Settings', settings: true },
  ],
  // The console's tabs before v0.88.0: Tasks is Maintenance's Run now; Settings was the tab the settings pages sat in;
  // Providers and Extensions were Sources before v0.54.0.
  tabAliases: { Tasks: 'maintenance', Settings: 'settings', Providers: 'sources', Extensions: 'sources' },
  entries: [
    // ---- Server ----
    { id: 'server-name', cat: 'server', label: 'Server name', keywords: ['name', 'title'] },
    { id: 'registration', cat: 'server', label: 'Open registration', when: ['web', 'local-accounts'], keywords: ['sign up', 'signup', 'register', 'new accounts'] },
    { id: 'local-pick', cat: 'server', label: 'Choose a profile at home', when: ['web'],
      keywords: ['profiles', 'who is reading', 'no password', 'children', 'family', 'home network'] },
    { id: 'local-networks', cat: 'server', label: 'Home network', when: ['web'],
      keywords: ['local network', 'lan', 'private networks', 'local addresses', 'LOCAL_NETWORKS', 'at home'] },
    { id: 'trusted-proxies', cat: 'server', more: 'network-more', label: 'Trusted proxies', when: ['web'],
      keywords: ['reverse proxy', 'nginx', 'traefik', 'caddy', 'X-Forwarded-For', 'TRUST_PROXY', 'ip address'] },
    { id: 'member-defaults-link', cat: 'server', label: 'When someone signs up', when: ['web'],
      keywords: ['new member defaults', 'permissions', 'age limit', 'libraries', 'can download'] },
    { id: 'update-check', cat: 'server', label: 'Check for updates', keywords: ['updates', 'new version', 'release', 'github'] },
    { id: 'install-count', cat: 'server', label: 'Count this server in the anonymous install count', when: ['web'],
      keywords: ['telemetry', 'analytics', 'install ping', 'privacy', 'statistics'] },
    { id: 'translate', cat: 'server', label: 'Translate pages', when: ['web'],
      keywords: ['translation', 'ocr', 'machine translation', 'raw', 'speech bubbles', 'qwen', 'llm'] },

    // ---- Series & chapters ----
    { id: 'notice-chapters', cat: 'series', label: 'Notice chapters',
      keywords: ['notices', 'announcements', 'hiatus', 'short chapters'] },
    { id: 'notice-short-only', cat: 'series', label: 'Only hide short ones (3 pages or fewer)', editor: 'notice-chapters' },
    { id: 'adult-filter', cat: 'series', label: '18+ filter', keywords: ['adult', 'nsfw', 'mature', 'show 18+', 'genres'] },
    { id: 'deleted-ghosts', cat: 'series', label: 'Show deleted chapters as ghosts', keywords: ['deleted chapters', 'ghost', 'fetch again'] },
    { id: 'fill-details', cat: 'series', label: 'Fill in missing details', keywords: ['anilist', 'metadata', 'description', 'author', 'cover'] },
    { id: 'borrow-names', cat: 'series', label: 'Borrow chapter names from other sources', keywords: ['chapter titles', 'chapter names'] },
    { id: 'discover-lookups', cat: 'series', label: 'Match Discover titles online', keywords: ['discover', 'anilist', 'mangadex', 'mangaupdates', 'duplicates'] },
    { id: 'mihon-missing', cat: 'series', more: 'series-more', label: 'Show missing chapters in Mihon', when: ['web'],
      keywords: ['komga', 'ghost chapters', 'tachiyomi', 'trackers'] },

    // ---- Downloads ----
    { id: 'update-interval', cat: 'downloads', label: 'Library update interval', keywords: ['update interval', 'schedule', 'how often', 'check for new chapters'],
      help: 'How often every followed series is asked for new chapters.' },
    { id: 'finish-downloads', cat: 'downloads', label: 'Finish downloads on their own',
      keywords: ['rate limit', 'rate limited', 'blocked', 'stuck downloads', 'resume downloads', 'retry', 'other sources'] },
    { id: 'source-order', cat: 'downloads', label: 'Source order', keywords: ['priority', 'preferred source'] },
    { id: 'scanlators', cat: 'downloads', label: 'Scanlation groups',
      keywords: ['groups', 'scanlators', 'translation groups', 'blocked groups', 'scanlation'] },
    { id: 'blocked-groups', cat: 'downloads', label: 'Blocked groups', editor: 'scanlators' },
    { id: 'group-priority', cat: 'downloads', label: 'Default priority', editor: 'scanlators', keywords: ['group order', 'ranking'] },
    { id: 'patience', cat: 'downloads', label: 'Patience (days)', editor: 'scanlators', keywords: ['wait for group'] },
    { id: 'group-upgrade', cat: 'downloads', label: 'Upgrade chapters to a preferred group', editor: 'scanlators', keywords: ['replace chapters', 'better group'] },
    { id: 'slow-archive', cat: 'downloads', label: 'Slow archive', keywords: ['archive', 'older chapters', 'whole series', 'pace'] },
    { id: 'archive-per-hour', cat: 'downloads', label: 'Chapters an hour, per source', editor: 'slow-archive', keywords: ['pace', 'speed'] },
    { id: 'archive-window', cat: 'downloads', label: 'Only during set hours', editor: 'slow-archive', keywords: ['night', 'schedule', 'hours'] },
    { id: 'archive-free-space', cat: 'downloads', label: 'Stop when free space is below (GB)', editor: 'slow-archive', keywords: ['disk full', 'free space'] },
    { id: 'delete-read', cat: 'downloads', label: 'Delete read chapters', keywords: ['cleanup', 'free space', 'disk space'] },
    { id: 'delete-read-days', cat: 'downloads', label: 'Wait (days)', keywords: ['cleanup delay'] },
    { id: 'mangadex-languages', cat: 'downloads', label: 'MangaDex languages', keywords: ['mangadex', 'languages', 'translations'] },
    { id: 'sources-per-series', cat: 'downloads', more: 'downloads-more', label: 'Other sources per series',
      keywords: ['more sources', 'followed sources', 'sources per series', 'multiple sources', 'follow limit', 'MAX_FOLLOWED_SOURCES'],
      help: 'How many sources besides its main one a series may follow, whether you add them or Uchiyomi finds them. 3 by default. Each one is one more chapter list to ask for at every library update.' },
    { id: 'smart-checks', cat: 'downloads', more: 'downloads-more', label: 'Smart update checks', keywords: ['quiet series', 'check less often', 'release radar', 'sweep'] },

    // ---- Maintenance ----
    { id: 'nightly-backup', cat: 'maintenance', label: 'Nightly backup', keywords: ['backup', 'database backup', 'dump', 'backup time'] },
    { id: 'nightly-repair', cat: 'maintenance', label: 'Repair the library nightly', keywords: ['repair', 'fix everything', 'autofix', 'nightly'] },
    { id: 'extension-auto-update', cat: 'maintenance', label: 'Update extensions automatically', when: ['extensions'], keywords: ['extension updates'] },
    { id: 'backups-keep', cat: 'maintenance', label: 'Backups to keep', keywords: ['backup limit', 'retention', 'old backups'] },
    { id: 'extension-hours', cat: 'maintenance', label: 'Extension check interval (hours)', when: ['extensions'],
      keywords: ['extension updates'] },

    // ---- Notifications ----
    { id: 'notify-targets', cat: 'notifications', label: 'Notifications', keywords: ['webhook', 'discord', 'ntfy', 'home assistant', 'alerts'] },
  ],
  // The cards' ids before v0.86.0. `downloads` was the slow archive's card, and is the Downloads category now, where it is.
  aliases: SETTINGS_NAME_ALIASES,
  legacy: {
    schedules: { cat: 'downloads' },
    housekeeping: { cat: 'maintenance' },
    'backup-time': { cat: 'maintenance', row: 'nightly-backup' },
  },
};
