'use client';
// "Filter chapters": the group filter and the ghost-row switch, behind the Filter chip in the chapters
// header. They used to be two chips of their own in that header -- a <select> under a chip that read
// "All groups ▾" and a toggle that read "Show chapters not on this server", 14 words on two rows at 390 px
// -- and the header is now one row of four short chips, with this sheet holding the two choices.
//
// A pure component over props: the page owns `group` and `showGhosts` (the latter is per-device, in
// localStorage), the same way the library's panel is pure over the URL.
import { Sheet } from '@/components/ui';
import { Switch } from '@/components/Switch';
import { GroupAvatar } from '@/components/GroupAvatar';
import { ALL_GROUPS } from '@/lib/groupFilter';
import { t as tr } from '@/lib/i18n';

export function ChapterFilterSheet({ groupNames, group, onGroup, hasGhosts, showGhosts, onToggleGhosts, onClose }: {
  /** The groups the filter offers, busiest first; the eyebrow is not drawn when there are none. */
  groupNames: string[];
  /** The chosen group, or `ALL_GROUPS`. */
  group: string;
  onGroup: (name: string) => void;
  /** Whether the sources list anything this server lacks; the switch is not drawn otherwise. */
  hasGhosts: boolean;
  showGhosts: boolean;
  onToggleGhosts: () => void;
  onClose: () => void;
}) {
  return (
    <Sheet title={tr('Filter chapters')} onClose={onClose} overBottomNav>
      {groupNames.length > 0 && (
        <section>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-fog-500">{tr('Translated by')}</p>
          <div className="flex flex-wrap gap-1.5">
            <button type="button" onClick={() => onGroup(ALL_GROUPS)} aria-pressed={group === ALL_GROUPS}
              className={`chip text-xs ${group === ALL_GROUPS ? 'chip-active' : ''}`}>{tr('All')}</button>
            {groupNames.map((n) => (
              <button key={n} type="button" onClick={() => onGroup(n)} aria-pressed={group === n}
                className={`chip text-xs ${group === n ? 'chip-active' : ''}`}>
                <GroupAvatar name={n} size={14} />
                <span className="max-w-[12rem] truncate">{n}</span>
              </button>
            ))}
          </div>
        </section>
      )}
      {hasGhosts && (
        <div className={`flex items-center justify-between gap-3 ${groupNames.length > 0 ? 'mt-5 border-t border-ink-800/70 pt-4' : ''}`}>
          <span className="text-sm text-fog-100">{tr('Show chapters not on the server yet')}</span>
          <Switch on={showGhosts} onChange={onToggleGhosts} label={tr('Show chapters not on the server yet')} />
        </div>
      )}
    </Sheet>
  );
}
