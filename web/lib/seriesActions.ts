// The series page's keys and its More, decided in one place (v0.60.0).
//
// Under the cover there were eight to twelve stacked buttons -- Start reading, Favourite, Save all offline, Add to
// collection, the notes link, the stars, the AniList line, Find missing chapters, Archive slowly, and an admin's Edit
// details, New banner, Rename folder and Remove from library -- and on a 768-px-tall screen an admin's column ran past
// the bottom with no way to reach its last keys. The owner chose four keys under the one reading button (Favourite,
// Offline, List, More) and everything else behind More, grouped. Who sees what is each item's old rule, unchanged, and
// it lives here so a test can hold it per role (test/seriesActions.test.ts) rather than finding it in JSX.
//
// More is a menu from lg up (components/ContextMenu.tsx) and a sheet below (components/SeriesKeys.tsx): both draw these
// groups, in this order.
import { t as tr } from './i18n';

export type SeriesActionId =
  | 'notes' | 'markAllRead' | 'markAllUnread'
  | 'findMissing' | 'archive' | 'checkNew'
  | 'copyLink' | 'openTab'
  | 'edit' | 'newBanner' | 'rename' | 'remove'
  // Admin: the chapters taken out of this series (Remove from series) and the way back.
  | 'removed';

export type SeriesActionGroupId = 'reading' | 'chapters' | 'share' | 'admin';

export interface SeriesAction {
  id: SeriesActionId;
  label: string;
  /** The destructive one: drawn in red, and it asks first (Remove from library's typed title). */
  danger?: boolean;
  /**
   * What a browser walk finds the item by, whatever the language: `data-menu-item` on the menu's item and on the sheet's
   * row, and on the row also as an attribute of its own (`data-archive-slowly`, `data-new-banner`), the names these two
   * keys had under the cover.
   */
  hook?: string;
  /** Shown, not hidden, while the server cannot be reached: greyed, as a series card's menu does it. */
  disabled?: boolean;
}

export interface SeriesActionGroup {
  id: SeriesActionGroupId;
  heading: string;
  items: SeriesAction[];
}

export interface SeriesActionsInput {
  isAdmin: boolean;
  /** `canDownload(user)`: Find missing chapters and the slow archive. */
  mayDownload: boolean;
  booksCount: number;
  /** The page's own `mayArchive` (something to archive, no archive on it yet). */
  mayArchive: boolean;
  /** The hero is the automatic banner (`series.autoHero`): New banner makes another. */
  autoHero: boolean;
  /** `series.folder`, sent to admins only: Rename folder. */
  hasFolder: boolean;
  offline?: boolean;
  /** Chapter numbers an admin removed from this series: Removed chapters, to restore them. */
  removedCount?: number;
  /**
   * Items whose work this page already has running -- a Check for new chapters, an archive being queued, a banner being
   * made: greyed until it ends, as their keys were under the cover.
   */
  busy?: Partial<Record<SeriesActionId, boolean>>;
  /** This series' saved pages and notes, once asked for (More asks when it opens); null before. */
  notes?: { moments: number; notes: number } | null;
}

/**
 * The notes door's words: how many saved pages, else how many notes, else "Add a note" -- it is never a door to an empty
 * page, since that page is where the series' first note is written. Neutral until the counts arrive: they are asked for
 * only when More opens (two requests every visit, for a line most visits never look at).
 */
export function notesLabel(counts: { moments: number; notes: number } | null | undefined): string {
  if (!counts) return tr('Notes and saved pages');
  if (counts.moments > 0) return counts.moments === 1 ? tr('1 saved page') : tr('{n} saved pages', { n: counts.moments });
  if (counts.notes > 0) return counts.notes === 1 ? tr('1 note') : tr('{n} notes', { n: counts.notes });
  return tr('Add a note');
}

/** More's groups for this viewer, each with its items in order; a group with nothing in it is left out. */
export function seriesActionGroups(x: SeriesActionsInput): SeriesActionGroup[] {
  const offline = !!x.offline;
  const some = x.booksCount > 0;
  const reading: SeriesAction[] = [
    { id: 'notes', label: notesLabel(x.notes), hook: 'notes' },
    // Nothing to mark on a "Nothing yet" series: Mark all read would say "Everything is already read".
    ...(some ? [
      { id: 'markAllRead' as const, label: tr('Mark all read'), disabled: offline },
      { id: 'markAllUnread' as const, label: tr('Mark all unread'), disabled: offline },
    ] : []),
  ];
  const chapters: SeriesAction[] = [
    // Refused below three chapters by the route itself, so not offered there.
    ...(x.mayDownload && x.booksCount >= 3 ? [{ id: 'findMissing' as const, label: tr('Find missing chapters'), disabled: offline }] : []),
    ...(x.mayArchive ? [{ id: 'archive' as const, label: tr('Archive slowly'), hook: 'archive-slowly', disabled: offline }] : []),
    ...(x.isAdmin ? [{ id: 'checkNew' as const, label: tr('Check for new chapters'), disabled: offline }] : []),
    ...(x.isAdmin && (x.removedCount ?? 0) > 0 ? [{ id: 'removed' as const, label: tr('Removed chapters ({n})…', { n: x.removedCount ?? 0 }), hook: 'removed-open', disabled: offline }] : []),
  ];
  const share: SeriesAction[] = [
    { id: 'copyLink', label: tr('Copy link') },
    { id: 'openTab', label: tr('Open in a new tab') },
  ];
  const admin: SeriesAction[] = x.isAdmin ? [
    { id: 'edit', label: tr('Edit details'), hook: 'edit-details', disabled: offline },
    // Only while the hero is an automatic one: a real banner is changed in Edit details, and Shuffle answers 409 for it.
    ...(x.autoHero ? [{ id: 'newBanner' as const, label: tr('New banner'), hook: 'new-banner', disabled: offline }] : []),
    ...(x.hasFolder ? [{ id: 'rename' as const, label: tr('Rename folder'), disabled: offline }] : []),
    { id: 'remove', label: tr('Remove from library'), danger: true, hook: 'remove-series', disabled: offline },
  ] : [];
  const groups: SeriesActionGroup[] = [
    { id: 'reading', heading: tr('Reading'), items: reading },
    { id: 'chapters', heading: tr('Chapters'), items: chapters },
    { id: 'share', heading: tr('Share'), items: share },
    { id: 'admin', heading: tr('Admin'), items: admin },
  ];
  const busy = (it: SeriesAction): SeriesAction => (x.busy?.[it.id] ? { ...it, disabled: true } : it);
  return groups.filter((g) => g.items.length > 0).map((g) => ({ ...g, items: g.items.map(busy) }));
}

/**
 * Whether the Offline key (Save all offline) is drawn: not on a series with nothing to save, and never in Uchiyomi
 * Desktop, where the chapters are already files on this computer (lib/desktop.ts) and a copy in the window's storage
 * would store every one twice.
 */
export const offlineKeyShown = (x: { nothingYet: boolean; desktop: boolean }): boolean => !x.nothingYet && !x.desktop;
