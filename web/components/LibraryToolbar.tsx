'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useContextMenu, type MenuItem } from './ContextMenu';
import { Segmented } from './settings';
import { Sheet, useWideViewport } from './ui';
import { IcCheck, IcChevronRight, IcFilter, IcGrid, IcGridDense, IcRows, IcSearch, IcSort, IcSparkle, IcX } from './icons';
import { t as tr } from '@/lib/i18n';
import { SORT_GROUPS, dirChoices, dirLabel, naturalDir, type LibrarySort, type SortDir } from '@/lib/librarySort';
import type { LibraryLayout } from '@/lib/libraryLayout';

/**
 * The Library's toolbar (v0.60.0): find a series, choose the order, the layout, and select -- above the grid, where the
 * nine sort chips, the Select chip and the sparkle used to be split between the filter panel and the header.
 *
 * Pure over props, like LibraryFilters: the page owns the URL (`q`, `sort`, `dir`, through its one `setParam`) and the
 * device's layout, and this only says what was asked. On a phone it sits inside the page's sticky header; from lg up the
 * page makes it sticky under the top bar on its own. Its keys are `.btn-key`s: the owner's "no more pills" keeps the
 * capsule for the filter chips alone.
 *
 * The search is the page's own `/api/series/search` `query`, debounced, and in the URL as `q` -- a real <input>, so the
 * app's type-to-search leaves it alone (lib/typeToSearch.ts isTypingTarget). Escape empties it, then leaves it.
 */
export function LibraryToolbar({ q, onSearch, active, dir, onSort, onDir, onSortSheet, layout, onLayout, filterCount, onFilters,
  selecting, onSelecting, onSelectAll, onSurprise, adult, className = '' }: {
  q: string;
  onSearch: (q: string) => void;
  active: LibrarySort;
  dir: SortDir;
  /** A different order was picked: the page writes `sort`, drops `dir`, and saves both as the account's default. */
  onSort: (key: string) => void;
  /** The other direction was picked: the page writes `dir`, and saves it with the order as the account's default. */
  onDir: (dir: SortDir) => void;
  /**
   * Below lg the Sort key opens the page's LibrarySortSheet (below), as the Filters key opens its Filters sheet: a sheet
   * opened from inside the phone's sticky, blurred header would be laid out in the header's box -- a backdrop filter makes
   * an element the containing block of its `fixed` descendants (components/ui.tsx OnBody) -- and on <body> it would sit
   * over the bottom nav, where every other sheet on a page with the nav clears it (notices.test.ts).
   */
  onSortSheet: () => void;
  layout: LibraryLayout;
  onLayout: (layout: LibraryLayout) => void;
  /** How many filters are on, for the phone's Filters key: the panel is a sheet there, a sidebar from lg up. */
  filterCount: number;
  onFilters: () => void;
  selecting: boolean;
  onSelecting: () => void;
  onSelectAll: () => void;
  onSurprise: () => void;
  /** The 18+ reveal, as the page renders it (a session switch, not a filter: Clear all cannot clear it). */
  adult?: ReactNode;
  className?: string;
}) {
  return (
    <div data-library-toolbar className={`flex flex-wrap items-center gap-2 ${className}`}>
      <SearchField q={q} onSearch={onSearch} />
      <SortKey active={active} dir={dir} onSort={onSort} onDir={onDir} onSheet={onSortSheet} />
      {/* A phone's second row: the search and the order are what a thumb wants first. From lg up, one row. */}
      <span aria-hidden className="h-0 basis-full lg:hidden" />
      {/* On a wide screen the panel is open beside the grid, so this key would open a sheet duplicating what is visible
          two inches to the left. */}
      <button type="button" onClick={onFilters} aria-haspopup="dialog"
        className={`btn-key h-9 lg:hidden ${filterCount ? 'btn-key-accent' : ''}`}>
        <IcFilter aria-hidden width={15} height={15} />{tr('Filters')}{filterCount > 0 ? ` · ${filterCount}` : ''}
      </button>
      {adult}
      <div data-library-layout={layout} className="ms-auto">
        <Segmented square label={tr('Layout')} value={layout} onChange={onLayout}
          options={[
            { value: 'comfortable', label: tr('Comfortable'), icon: <IcGrid aria-hidden width={15} height={15} /> },
            { value: 'compact', label: tr('Compact'), icon: <IcGridDense aria-hidden width={15} height={15} /> },
            { value: 'list', label: tr('List'), icon: <IcRows aria-hidden width={15} height={15} /> },
          ]} />
      </div>
      {/* Selects what is LOADED, not the whole filtered library: the grid is an infinite scroll over a paged search, and
          silently sweeping two thousand series into a pick would surprise more than the loaded-pages boundary the count
          beside it makes visible. Scroll further, tap again. */}
      {selecting && <button type="button" onClick={onSelectAll} className="btn-key h-9">{tr('Select all')}</button>}
      {/* A mode, not a filter. */}
      <button type="button" onClick={onSelecting} className={`btn-key h-9 ${selecting ? 'btn-key-accent' : ''}`}>
        {selecting ? tr('Done') : tr('Select')}
      </button>
      {/* One series, at random: the honest version of a shuffled shelf (lib/librarySort.ts says why there is none). Not
          while choosing: it leaves the page. */}
      {!selecting && (
        <button type="button" onClick={onSurprise} title={tr('Surprise me')} aria-label={tr('Surprise me')} className="btn-key h-9 w-9 px-0">
          <IcSparkle width={17} height={17} />
        </button>
      )}
    </div>
  );
}

/** How long the typing has to pause before the shelf follows it. */
export const SEARCH_DEBOUNCE_MS = 300;

/**
 * "Search your library": the title filter. The field keeps what is typed; the URL -- and with it the grid -- follows a
 * pause in the typing, and the field follows the URL when something else moves it (Clear all, a chip's ×, Back).
 */
function SearchField({ q, onSearch }: { q: string; onSearch: (q: string) => void }) {
  const [typed, setTyped] = useState(q);
  // What this field last put in the URL, or found there.
  const sent = useRef(q);
  // ⚠️ The page's writer as of NOW, not of the keystroke that started the wait: it builds the URL from the params it was
  // rendered with, and a filter picked during the pause would be written over by the older ones.
  const write = useRef(onSearch);
  write.current = onSearch;
  useEffect(() => {
    if (q !== sent.current) { sent.current = q; setTyped(q); }
  }, [q]);
  useEffect(() => {
    const next = typed.trim();
    if (next === sent.current) return;
    const h = setTimeout(() => { sent.current = next; write.current(next); }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(h);
  }, [typed]);
  const commit = (v: string) => {
    setTyped(v);
    const next = v.trim();
    if (next !== sent.current) { sent.current = next; onSearch(next); }
  };
  return (
    <label className="relative min-w-[9.5rem] flex-1 lg:max-w-sm">
      <span className="sr-only">{tr('Search your library…')}</span>
      <IcSearch aria-hidden width={16} height={16} className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-fog-500" />
      <input value={typed} onChange={(e) => setTyped(e.target.value)} data-library-search
        placeholder={tr('Search your library…')} inputMode="search" enterKeyHint="search" maxLength={200}
        autoCapitalize="none" autoCorrect="off" spellCheck={false}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit(typed);
          else if (e.key === 'Escape') {
            e.preventDefault();
            if (typed) commit('');
            else e.currentTarget.blur();
          }
        }}
        className="field h-9 max-w-none py-0 ps-9 pe-9" />
      {typed && (
        <button type="button" onClick={() => commit('')} aria-label={tr('Clear search')} title={tr('Clear search')}
          className="absolute end-1.5 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-md text-fog-500 hover:text-fog-200">
          <IcX width={14} height={14} />
        </button>
      )}
    </label>
  );
}

/**
 * The order: one key saying the one in force ("Most popular"), its icon upside down while the order runs the other
 * way. From lg up it opens a menu -- the four groups, each order a ticked choice, then the Order switch; on a phone the
 * page's sheet, the same with the switch pinned under the orders. Picking the order already in force changes nothing
 * (its direction stays); picking another starts it in its own natural direction.
 */
function SortKey({ active, dir, onSort, onDir, onSheet }: {
  active: LibrarySort; dir: SortDir; onSort: (key: string) => void; onDir: (dir: SortDir) => void; onSheet: () => void;
}) {
  const wide = useWideViewport();
  const reversed = dir !== naturalDir(active);
  const pickSort = (key: string) => { if (key !== active.key) onSort(key); };
  const pickDir = (d: SortDir) => { if (d !== dir) onDir(d); };
  const items = (): MenuItem[] => [
    ...SORT_GROUPS.flatMap((g) => g.sorts.map((s, i): MenuItem => ({
      label: tr(s.label), heading: i === 0 ? tr(g.label) : undefined, checked: s.key === active.key, hook: `sort-${s.key}`,
      onSelect: () => pickSort(s.key),
    }))),
    ...dirChoices(active).map(([d, label], i): MenuItem => ({
      label: tr(label), heading: i === 0 ? tr('Order') : undefined, checked: d === dir, hook: `dir-${d}`,
      onSelect: () => pickDir(d),
    })),
  ];
  const menu = useContextMenu(items, { label: tr('Sort by') });
  // Its name says the order and, when it runs the other way, which way: the icon alone says that to nobody.
  const said = tr('Sorted by {name}', {
    name: reversed ? `${tr(active.label).toLowerCase()} · ${tr(dirLabel(active, dir)).toLowerCase()}` : tr(active.label).toLowerCase(),
  });
  return (
    <>
      <button type="button" data-library-sort={active.key} data-sort-dir={dir}
        onClick={(e) => (wide ? menu.openFrom(e.currentTarget) : onSheet())}
        aria-haspopup={wide ? 'menu' : 'dialog'} aria-expanded={wide ? menu.open : undefined} aria-label={said} title={said}
        className="btn-key h-9 min-w-0 max-w-full">
        <IcSort aria-hidden width={15} height={15} className={`shrink-0 ${reversed ? '-scale-y-100' : ''}`} />
        <span className="min-w-0 truncate">{tr(active.label)}</span>
        <IcChevronRight aria-hidden width={13} height={13} className="shrink-0 rotate-90 text-fog-500" />
      </button>
      {menu.element}
    </>
  );
}

/**
 * The orders on a phone (v0.60.0): the Sort menu's four groups as rows, and the Order switch as the sheet's pinned footer
 * -- nine orders are taller than a phone, and the direction must not be a scroll away under them. The page renders it,
 * beside its Filters sheet (LibraryToolbar's `onSortSheet` says why). A pick of an order closes it; the switch flips in
 * place, as a switch does.
 */
export function LibrarySortSheet({ active, dir, onSort, onDir, onClose }: {
  active: LibrarySort; dir: SortDir; onSort: (key: string) => void; onDir: (dir: SortDir) => void; onClose: () => void;
}) {
  const pickSort = (key: string) => { onClose(); if (key !== active.key) onSort(key); };
  const pickDir = (d: SortDir) => { if (d !== dir) onDir(d); };
  return (
    <Sheet title={tr('Sort by')} onClose={onClose} overBottomNav
      footer={
        // `pb-2`: the sheet's nav clearance is 4 px short of the nav's measured height (the Library's More sheet says so).
        <div data-library-sort-order className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 pb-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-fog-500">{tr('Order')}</p>
          <Segmented square label={tr('Order')} value={dir} onChange={pickDir}
            options={dirChoices(active).map(([d, label]) => ({ value: d, label: tr(label) }))} />
        </div>
      }>
      <div data-library-sort-sheet className="space-y-4 pb-2">
        {SORT_GROUPS.map((g) => (
          <SheetGroup key={g.label} title={tr(g.label)}>
            {g.sorts.map((s) => (
              <SheetChoice key={s.key} on={s.key === active.key} hook={`sort-${s.key}`} onPick={() => pickSort(s.key)}>{tr(s.label)}</SheetChoice>
            ))}
          </SheetGroup>
        ))}
      </div>
    </Sheet>
  );
}

function SheetGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-fog-500">{title}</p>
      <div className="space-y-0.5">{children}</div>
    </section>
  );
}

function SheetChoice({ on, hook, onPick, children }: { on: boolean; hook: string; onPick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-pressed={on} data-sort-option={hook} onClick={onPick}
      className={`flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-2.5 text-start text-sm ${
        on ? 'bg-accent-soft font-medium text-accent' : 'text-fog-200 hover:bg-ink-800/60'}`}>
      <span className="min-w-0">{children}</span>
      {on && <IcCheck aria-hidden width={16} height={16} className="shrink-0" />}
    </button>
  );
}
