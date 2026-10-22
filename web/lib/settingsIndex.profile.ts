// Profile in the console registry (lib/settingsIndex.ts): its pages in the order its list shows them (v0.88.0), and every
// row of its settings pages by its DOM id (components/ProfileSettings.tsx), in the order the page draws them.
import { keys } from './i18n';
import { INCOGNITO_TEXT } from './incognito';
import type { SettingsIndex } from './settingsIndex';

/** The categories' names and the groups' titles, declared for the translation extractor (lib/i18n.ts `keys`). */
export const PROFILE_SETTINGS_WORDS = keys(
  'You', 'Insights', 'Settings', 'Connections', 'Account',
  'General', 'Appearance', 'Reading', 'This device',
  'Series pages', 'Shortcuts', 'Privacy', 'Reader', 'Pages', 'Paged mode', 'Offline downloads', 'Alerts and app',
);

export const PROFILE_SETTINGS: SettingsIndex = {
  page: 'profile',
  // v0.88.0: one list. You and Insights first (the person), then everything that is a setting -- Connections and Account
  // among them, where they were tabs beside Settings that "were not under anything".
  categories: [
    { id: 'you', label: 'You', keywords: ['profile', 'me', 'my stats', 'badges', 'reading studio', 'lists', 'weekly goal'] },
    { id: 'insights', label: 'Insights', keywords: ['my stats', 'backlog', 'unread', 'best day', 'genres', 'finish date', 'dropped'] },
    { id: 'general', label: 'General', group: 'Settings', settings: true },
    { id: 'appearance', label: 'Appearance', group: 'Settings', settings: true },
    { id: 'reading', label: 'Reading', group: 'Settings', settings: true },
    // Uchiyomi Desktop: no offline copies (the chapters are on this disk already), no push service, nothing to install.
    { id: 'device', label: 'This device', group: 'Settings', settings: true, when: ['web'] },
    { id: 'connections', label: 'Connections', group: 'Settings',
      keywords: ['integrations', 'anilist', 'myanimelist', 'kitsu', 'mangaupdates', 'trackers', 'opds', 'api tokens', 'mihon'] },
    // Uchiyomi Desktop has no password, two-factor or other sessions: the app signs itself in.
    { id: 'account', label: 'Account', group: 'Settings', when: ['web'],
      keywords: ['security', 'password', '2fa', 'two-factor', 'sessions', 'sign out', 'log out'] },
  ],
  // The profile's tabs before v0.88.0: Settings was the tab the four settings pages sat in.
  tabAliases: { Settings: 'settings' },
  entries: [
    // ---- General ----
    { id: 'language', cat: 'general', label: 'Language', keywords: ['translation', 'locale', 'english', 'arabic', 'interface'],
      help: 'Translations other than English are machine-assisted and have not been checked by a native speaker. If something reads wrong, the language files are one JSON each — corrections are welcome.' },
    { id: 'show-all-chapters', cat: 'general', label: 'Show all chapters at once', keywords: ['chapter list', 'hundred at a time', 'series page'],
      help: 'A series page lists every chapter, including those not here yet, on one page instead of a hundred at a time. Saved to your account.' },
    { id: 'notify-only-next', cat: 'general', label: 'Only tell me about my next chapter', keywords: ['notifications', 'push', 'alerts', 'new chapter', 'caught up'],
      help: 'A new chapter notifies you only when it is the one the series page would open for you: you are caught up, with nothing older unread or half read. Applies to push alerts and to messages sent to you. Saved to your account.' },
    // Only a computer's rows change, so a phone or tablet held alone has nothing to switch (lib/compactChapters.ts).
    { id: 'compact-chapters', cat: 'general', label: 'Compact chapter list', when: ['pointer'], keywords: ['thumbnails', 'dense', 'chapter rows'] },
    { id: 'type-to-search', cat: 'general', label: 'Type anywhere to search', when: ['pointer'], keywords: ['shortcut', 'keyboard', 'slash'] },
    { id: 'context-menus', cat: 'general', label: 'Right-click menus', keywords: ['context menu', 'long press', 'press and hold'] },
    { id: 'incognito', cat: 'general', label: INCOGNITO_TEXT[0], help: INCOGNITO_TEXT[1], keywords: ['private', 'history', 'hide reading'] },

    // ---- Appearance ----
    { id: 'background', cat: 'appearance', label: 'Background', keywords: ['tone', 'oled', 'black', 'graphite', 'midnight', 'dark', 'theme'] },
    { id: 'accent', cat: 'appearance', label: 'Accent', keywords: ['colour', 'color', 'theme colour'] },
    { id: 'avatar', cat: 'appearance', label: 'Avatar', keywords: ['emoji', 'profile picture', 'face'] },
    { id: 'avatar-frame', cat: 'appearance', label: 'Frame', editor: 'avatar', keywords: ['avatar frame', 'badge frame', 'ring', 'border', 'decoration', 'reward', 'badges'] },
    { id: 'reduce-effects', cat: 'appearance', label: 'Reduce effects', keywords: ['motion', 'animations', 'blur', 'performance', 'slow', 'battery'],
      help: 'Turns off the animated background, blur, smooth scrolling and transitions. Try it if scrolling feels slow.' },

    // ---- Reading ----
    { id: 'reader-mode', cat: 'reading', label: 'Mode', keywords: ['webtoon', 'paged', 'scroll', 'swipe', 'reading mode', 'reader'] },
    { id: 'auto-mode', cat: 'reading', label: 'Pick the mode for each series', keywords: ['automatic', 'long strip', 'manga'] },
    { id: 'reader-theme', cat: 'reading', label: 'Theme', keywords: ['amoled', 'sepia', 'gray', 'grey', 'page colour'] },
    { id: 'comments', cat: 'reading', label: 'Comments and reactions', when: ['web', 'talk'], keywords: ['comments', 'reactions', 'emoji', 'talk', 'discussion', 'household', 'hide comments', 'turn off comments'] },
    { id: 'fit', cat: 'reading', label: 'Fit', keywords: ['fit width', 'original size', 'zoom'] },
    { id: 'wide-pages', cat: 'reading', label: 'Wide pages', keywords: ['double page', 'spread', 'landscape', 'rotate', 'split'] },
    { id: 'repeated-pages', cat: 'reading', label: 'Repeated pages', keywords: ['credits', 'ads', 'adverts', 'junk pages', 'recruitment'] },
    { id: 'reading-direction', cat: 'reading', more: 'reading-more', label: 'Reading direction', keywords: ['right to left', 'left to right', 'rtl', 'manga direction'] },
    { id: 'pages-per-view', cat: 'reading', more: 'reading-more', label: 'Pages per view', keywords: ['double spread', 'two pages', 'single page'] },
    { id: 'join-split', cat: 'reading', more: 'reading-more', label: 'Join split double pages', keywords: ['spread', 'split pages'] },
    { id: 'crop-borders', cat: 'reading', more: 'reading-more', label: 'Crop page borders', keywords: ['margins', 'trim', 'white borders'] },

    // ---- This device ----
    { id: 'downloads', cat: 'device', label: 'Offline downloads', when: ['web'], keywords: ['offline', 'downloaded chapters'] },
    { id: 'keep-offline', cat: 'device', label: 'Keep favorites offline', when: ['web'], keywords: ['auto download', 'offline', 'favourites'] },
    { id: 'storage', cat: 'device', label: 'Storage used', when: ['web'], keywords: ['space', 'quota', 'eviction', 'protect downloads', 'persist'] },
    { id: 'chapter-alerts', cat: 'device', label: 'New-chapter alerts', when: ['web'], keywords: ['push', 'notifications', 'alerts', 'comments', 'replies'] },
    { id: 'install', cat: 'device', label: 'Install Uchiyomi', when: ['web'], keywords: ['install app', 'pwa', 'home screen', 'add to home screen'] },
  ],
  legacy: {},
};
