'use client';
// Customize Home (Look settings, UI refresh phase 3): a key beside the greeting that opens a sheet of Home's rails, each
// with its place and a switch -- so a reader who never opens "Top 10" or "Hidden gems" can put them away, and one who
// lives in "New episodes" can put it first.
//
// Every change shows on Home at once and is saved to the account (`settings.homeRails`, lib/homeRails.ts), one PUT at a
// time and always the newest arrangement: a reader moving a rail five places taps five times, and five requests racing
// each other could leave the server holding the third. A refused save puts back the last arrangement the server holds.
//
// "Your lists" moves like any rail but has no switch: which lists Home shows is the Lists page's choice, and its key goes
// there. One place picks the lists (lib/homeRails.ts says why).
import Link from 'next/link';
import { useId, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { t as tr } from '@/lib/i18n';
import {
  HOME_RAILS, HOME_RAIL_KEYS, LISTS_RAIL, moveRail, orderRails, railsSetting, setRailHidden,
  type HomeRailKey, type HomeRailsSetting, type RailSlot,
} from '@/lib/homeRails';
import { homeIdsOf } from '@/lib/lists';
import { IcChevronLeft, IcChevronRight, IcSliders } from './icons';
import { useListsAll } from './SaveListDialog';
import { Switch } from './Switch';
import { useToast } from './Toast';
import { Sheet } from './ui';
import { moveTo, useDragReorder } from '@/lib/dragReorder';

const LABEL = Object.fromEntries(HOME_RAILS.map((r) => [r.key, r.label])) as Record<HomeRailKey, string>;

/** The key on Home, and the sheet it opens. Squared, like every action; the word goes on a phone, the icon stays. */
export function HomeCustomize() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} aria-haspopup="dialog" className="btn-key" data-home-customize>
        <IcSliders width={14} height={14} aria-hidden />
        <span className="max-sm:sr-only">{tr('Customize')}</span>
      </button>
      {open && <CustomizeSheet onClose={() => setOpen(false)} />}
    </>
  );
}

function CustomizeSheet({ onClose }: { onClose: () => void }) {
  const { user, setSettings } = useAuth();
  const toast = useToast();
  const slots = orderRails(user?.settings?.homeRails, HOME_RAIL_KEYS);
  // The same answer Home's list rails read, so the names below are the lists Home shows.
  const { data } = useListsAll(true, 300_000);
  const lists = data?.content ?? [];
  const listNames = data
    ? homeIdsOf(user?.settings?.homeCollections, lists).map((id) => lists.find((l) => l.id === id)?.name).filter(Boolean)
    : undefined;

  // One request at a time, the newest arrangement each time; `good` is what the server last said yes to.
  const sending = useRef<{ busy: boolean; next?: { v: HomeRailsSetting | null }; good: unknown }>({
    busy: false, good: user?.settings?.homeRails ?? null,
  });
  const save = (v: HomeRailsSetting | null) => {
    const q = sending.current;
    q.next = { v };
    if (q.busy) return;
    q.busy = true;
    void (async () => {
      while (q.next) {
        const { v: want } = q.next;
        q.next = undefined;
        try {
          await api('/api/settings', { method: 'PUT', json: { homeRails: want } });
          q.good = want;
        } catch {
          q.next = undefined;
          setSettings({ homeRails: q.good });
          toast(tr('Could not save'), 'error');
        }
      }
      q.busy = false;
    })();
  };
  const change = (next: RailSlot[]) => {
    const v = railsSetting(next, HOME_RAIL_KEYS);
    setSettings({ homeRails: v });
    save(v);
  };
  const plain = railsSetting(slots, HOME_RAIL_KEYS) === null;
  // Drag a row to where it belongs; the arrows move it a place at a time.
  const drag = useDragReorder({ count: slots.length, layout: 'column', onMove: (from, to) => change(moveTo(slots, from, to)) });

  return (
    <Sheet title={tr('Customize Home')} onClose={onClose} overBottomNav
      footer={
        // `pb-2`: the sheet's nav clearance is 4 px short of the nav's measured height (the Library's More sheet says so).
        <div className="flex items-center justify-between gap-3 pb-2">
          <button type="button" onClick={() => change(orderRails(null, HOME_RAIL_KEYS))} disabled={plain} className="btn-key" data-home-rails-reset>
            {tr('Reset')}
          </button>
          <button type="button" onClick={onClose} className="btn-key btn-key-primary">{tr('Done')}</button>
        </div>
      }>
      <p className="pb-1 text-xs text-fog-500">{tr('Choose which rows Home shows, and in what order.')}</p>
      <ul data-home-rails>
        {slots.map((s, i) => (
          <RailRow key={s.key} slot={s} first={i === 0} last={i === slots.length - 1} dragProps={drag.item(i)}
            onMove={(by) => change(moveRail(slots, s.key, by))}
            onShow={(show) => change(setRailHidden(slots, s.key, !show))}
            listNames={s.key === LISTS_RAIL ? listNames : undefined} onClose={onClose} />
        ))}
      </ul>
    </Sheet>
  );
}

function RailRow({ slot, first, last, onMove, onShow, listNames, onClose, dragProps }: {
  slot: RailSlot;
  /** The row's handle for drag to reorder (lib/dragReorder.ts), spread onto the row. */
  dragProps?: object;
  first: boolean;
  last: boolean;
  onMove: (by: -1 | 1) => void;
  onShow: (show: boolean) => void;
  /** The lists rail only: the names of the lists Home shows, once they are known. */
  listNames?: ReadonlyArray<string | undefined>;
  onClose: () => void;
}) {
  // The move keys say which rail they move: "Move up" eleven times over says nothing to a screen reader on its own.
  const id = useId();
  const label = tr(LABEL[slot.key]);
  const lists = slot.key === LISTS_RAIL;
  return (
    <li {...dragProps} data-home-rail={slot.key} data-hidden={slot.hidden ? '' : undefined}
      className="flex items-center gap-2 border-b border-ink-800/70 py-2.5 last:border-b-0">
      <div className="min-w-0 flex-1">
        <p id={id} className={`text-sm transition-colors ${slot.hidden ? 'text-fog-500' : 'text-fog-100'}`}>{label}</p>
        {lists && (
          <p className="flex min-w-0 items-center gap-2 text-xs" data-home-rails-lists-line>
            {listNames && (
              <span className="min-w-0 truncate text-fog-500">
                {listNames.length ? listNames.map((n) => `\u2068${n}\u2069`).join(' · ') : tr('No lists chosen')}
              </span>
            )}
            {/* A link like Home's own "See all": it goes to the page that holds the choice. */}
            <Link href="/collections" onClick={onClose} className="shrink-0 text-accent" data-home-rails-lists>{tr('Choose lists')}</Link>
          </p>
        )}
      </div>
      {/* Up and down whatever the language: a column of rows does not mirror. */}
      <button type="button" onClick={() => onMove(-1)} disabled={first} aria-label={tr('Move up')} aria-describedby={id}
        className="btn-key w-8 px-0" data-home-rail-up>
        <IcChevronLeft width={14} height={14} className="rotate-90" aria-hidden />
      </button>
      <button type="button" onClick={() => onMove(1)} disabled={last} aria-label={tr('Move down')} aria-describedby={id}
        className="btn-key w-8 px-0" data-home-rail-down>
        <IcChevronRight width={14} height={14} className="rotate-90" aria-hidden />
      </button>
      {/* The lists rail keeps the switch's room empty, so every row's keys line up. */}
      {lists ? <span aria-hidden className="w-12 shrink-0" /> : <Switch on={!slot.hidden} onChange={onShow} label={label} />}
    </li>
  );
}
