'use client';
// The series page's keys and its More (v0.60.0): four squared keys under the reading button -- Favourite, Offline,
// List and More -- and what More opens, a menu from lg up and a sheet below. Which items there are, for whom, is
// lib/seriesActions.ts's; this file only draws them. Keys, never capsules (the owner's "no more pills": only filter and
// sort chips keep that shape), so web/test/noPills.test.ts scans this whole file.
import Link from 'next/link';
import type { MouseEvent, ReactNode } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { useReduceEffects } from '@/lib/effects';
import { t as tr } from '@/lib/i18n';
import type { SeriesActionGroup, SeriesActionId } from '@/lib/seriesActions';
import type { MenuItem } from './ContextMenu';
import { Sheet } from './ui';
import { IcCheck, IcHeart, IcHourglass, IcMoments, IcMore, IcPencil, IcRefresh, IcTrash } from './icons';

type Glyph = { size?: number; className?: string };
/** The icons' own stroke style (components/icons.tsx `base`), for the few glyphs only this page draws. */
const glyph = (size: number, className: string | undefined, d: ReactNode) => (
  <svg aria-hidden width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}
    strokeLinecap="round" strokeLinejoin="round" className={className}>{d}</svg>
);
/** A list with a plus: put this series in one of your lists (the glyph Add to list always had). */
export const IcListAdd = ({ size = 20, className }: Glyph) => glyph(size, className, <><path d="M4 6h16M4 12h16M4 18h10" /><path d="M19 15v6M16 18h6" /></>);
/** Out of the app: the AniList tile's corner, and Open in a new tab. */
export const IcExternal = ({ size = 16, className }: Glyph) => glyph(size, className, <><path d="M14 4h6v6" /><path d="M20 4 11 13" /><path d="M19 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4" /></>);
const IcLink = ({ size = 16, className }: Glyph) => glyph(size, className, <><path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1" /><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1" /></>);
const IcUnread = ({ size = 16, className }: Glyph) => glyph(size, className, <><circle cx="12" cy="12" r="8" /><path d="M8.5 12h7" /></>);
const IcFindMissing = ({ size = 16, className }: Glyph) => glyph(size, className, <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /><path d="M11 8v6M8 11h6" /></>);
const IcBanner = ({ size = 16, className }: Glyph) => glyph(size, className, <><rect x="3" y="5" width="18" height="14" rx="2.5" /><circle cx="9" cy="10" r="1.6" /><path d="m21 16-5-5-8 8" /></>);
const IcFolder = ({ size = 16, className }: Glyph) => glyph(size, className, <><path d="M3 7V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9L11.7 5H19a2 2 0 0 1 2 2v2" /><path d="M3 9h18l-1.5 9a2 2 0 0 1-2 1.8H6.5a2 2 0 0 1-2-1.8Z" /></>);

/** Each More item's icon, in the menu and in the sheet alike. */
export function ActionIcon({ id, size = 16 }: { id: SeriesActionId; size?: number }) {
  const p = { width: size, height: size, 'aria-hidden': true } as const;
  switch (id) {
    case 'notes': return <IcMoments {...p} />;
    case 'markAllRead': return <IcCheck {...p} />;
    case 'markAllUnread': return <IcUnread size={size} />;
    case 'findMissing': return <IcFindMissing size={size} />;
    case 'archive': return <IcHourglass {...p} />;
    case 'checkNew': return <IcRefresh {...p} />;
    case 'copyLink': return <IcLink size={size} />;
    case 'openTab': return <IcExternal size={size} />;
    case 'edit': return <IcPencil {...p} />;
    case 'newBanner': return <IcBanner size={size} />;
    case 'rename': return <IcFolder size={size} />;
    case 'remove': return <IcTrash {...p} />;
  }
}

/**
 * A key of the row: its icon over a short word. 8-px corners, the height of two lines so a long word may wrap. Its
 * width is the grid cell's, never `w-full`: the browser walks find the supply line as the visible
 * `button[aria-haspopup="dialog"].w-full`, and from lg up this row comes before it on the page.
 */
const KEY = 'btn-key h-auto min-h-[3.75rem] min-w-0 flex-col gap-1 px-1 py-2 text-[11px] leading-tight';
/** The same key in the phone's bar: the icon alone, its word for screen readers. */
const SMALL = 'btn-key h-11 w-11 px-0';

export interface SeriesKeyProps {
  icon: ReactNode;
  /** The word under the icon. */
  label: string;
  /**
   * What a screen reader says, when it is more than the word: the Offline key is "Save all offline". It contains the
   * word, so a voice command naming what is on screen still finds the key.
   */
  name?: string;
  /** A tooltip: what the key does, when its word is a noun (List: Add to list). */
  title?: string;
  onClick: (e: MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  /** Icon only (the phone's bar). The word is then the key's name. */
  compact?: boolean;
  className?: string;
  /** `aria-haspopup`, `aria-expanded`, `aria-pressed` and `data-*` hooks, passed through. */
  attrs?: Record<string, string | boolean | undefined>;
}

export function SeriesKey({ icon, label, name, title, onClick, disabled, compact, className = '', attrs }: SeriesKeyProps) {
  if (compact) {
    return (
      <button type="button" onClick={onClick} disabled={disabled} aria-label={name ?? label} title={title ?? label} className={`${SMALL} ${className}`} {...attrs}>
        {icon}
      </button>
    );
  }
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={title} className={`${KEY} ${className}`} {...attrs}>
      {icon}
      {name ? (
        <>
          <span aria-hidden className="line-clamp-2 max-w-full text-center [overflow-wrap:anywhere]">{label}</span>
          <span className="sr-only">{name}</span>
        </>
      ) : (
        <span className="line-clamp-2 max-w-full text-center [overflow-wrap:anywhere]">{label}</span>
      )}
    </button>
  );
}

/**
 * Favourite: a toggle (`aria-pressed`), its word the same either way, the heart filled and pink when on. Turning it on
 * pops the heart -- a spring from small, once -- unless Reduce effects or the system's reduced motion asks for
 * stillness. `pops` counts the times it was turned on in this visit: a new count is a new heart that springs in, and a
 * series that opens as a favourite (0) draws its heart still.
 */
export function FavouriteKey({ on, pops, onToggle, compact }: { on: boolean; pops: number; onToggle: () => void; compact?: boolean }) {
  // Both hooks on every render and in this order: `a() || b()` would skip the second whenever the first is true.
  const plain = useReduceEffects();
  const still = useReducedMotion();
  const reduced = plain || !!still;
  const heart = (
    <motion.span key={pops} aria-hidden className={`grid place-items-center ${on ? 'text-pink-400' : ''}`}
      initial={reduced || pops === 0 ? false : { scale: 0.45 }}
      animate={{ scale: 1 }}
      transition={reduced ? { duration: 0 } : { type: 'spring', stiffness: 600, damping: 13, mass: 0.6 }}>
      <IcHeart width={20} height={20} fill={on ? 'currentColor' : 'none'} />
    </motion.span>
  );
  const tone = on ? 'border-pink-400/45 bg-pink-500/10 text-pink-200 hover:border-pink-300/70 hover:text-pink-100' : '';
  return (
    <SeriesKey icon={heart} label={tr('Favourite')} onClick={onToggle} compact={compact} className={tone}
      attrs={{ 'aria-pressed': on, 'data-favourite': on ? 'on' : 'off' }} />
  );
}

/**
 * More: a menu from lg up, a sheet below (the page decides, it knows the width). `data-series-more` is what a browser
 * walk presses it by (web/test/e2e/seriesMore.mjs), in any language.
 */
export function MoreKey({ onOpen, open, menu, compact }: { onOpen: (el: HTMLElement) => void; open: boolean; menu: boolean; compact?: boolean }) {
  return (
    <SeriesKey icon={<IcMore width={20} height={20} aria-hidden />} label={tr('More')} compact={compact}
      onClick={(e) => onOpen(e.currentTarget)}
      attrs={{ 'aria-haspopup': menu ? 'menu' : 'dialog', 'aria-expanded': open, 'data-series-more': '' }} />
  );
}

/** More's groups as the menu's items: each group's name above its first item, the icons before the words. */
export function moreMenuItems(groups: SeriesActionGroup[], onPick: (id: SeriesActionId) => void): MenuItem[] {
  return groups.flatMap((g) => g.items.map((it, i): MenuItem => ({
    label: it.label,
    heading: i === 0 ? g.heading : undefined,
    icon: <ActionIcon id={it.id} />,
    danger: it.danger,
    // The destructive one stands apart from the keys before it in its group.
    divider: it.danger && i > 0 ? true : undefined,
    disabled: it.disabled,
    hook: it.hook,
    onSelect: () => onPick(it.id),
  })));
}

/** The attributes a row is found by: `data-menu-item`, as the menu's items carry it, and its own name (`data-new-banner`). */
const hooks = (hook?: string): Record<string, string> => (hook ? { 'data-menu-item': hook, [`data-${hook}`]: '' } : {});

/**
 * More on a phone: a sheet over the bottom nav, its groups as headed blocks of rows. A row closes the sheet BEFORE its
 * action runs (the page's `onPick` does both in one go): a dialog opened under a Sheet paints beneath its backdrop and
 * cannot be tapped (Modal is z-50, Sheet z-60, both inside <main>).
 */
export function SeriesMoreSheet({ title, groups, notesHref, onPick, onClose }: {
  title: string;
  groups: SeriesActionGroup[];
  notesHref: string;
  onPick: (id: SeriesActionId) => void;
  onClose: () => void;
}) {
  return (
    <Sheet title={title} onClose={onClose} overBottomNav>
      <div data-series-more-sheet className="space-y-4 pb-2">
        {groups.map((g) => (
          <section key={g.id} aria-label={g.heading}>
            <h3 className="mb-1.5 px-1 text-[11px] font-medium text-fog-500">{g.heading}</h3>
            <div className="overflow-hidden rounded-2xl border border-ink-700/70 bg-ink-900/60">
              {g.items.map((it, i) => {
                const row = `flex w-full items-center gap-3 px-3.5 py-3 text-start text-sm transition-colors hover:bg-ink-800/70 disabled:opacity-40 ${
                  i > 0 ? 'border-t border-ink-800/80' : ''} ${it.danger ? 'text-rose-300' : 'text-fog-100'}`;
                const icon = (
                  <span aria-hidden className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${it.danger ? 'bg-rose-500/10 text-rose-300' : 'bg-ink-800 text-fog-300'}`}>
                    <ActionIcon id={it.id} size={17} />
                  </span>
                );
                // The notes door is a link: it goes to a page, and a new tab or a long-press works on it as on any link.
                return it.id === 'notes' ? (
                  <Link key={it.id} href={notesHref} onClick={onClose} className={row} {...hooks(it.hook)}>
                    {icon}<span className="min-w-0 flex-1">{it.label}</span>
                  </Link>
                ) : (
                  <button key={it.id} type="button" disabled={it.disabled} onClick={() => onPick(it.id)} className={row} {...hooks(it.hook)}>
                    {icon}<span className="min-w-0 flex-1">{it.label}</span>
                  </button>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </Sheet>
  );
}
