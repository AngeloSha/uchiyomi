'use client';
// The settings pages' layout (v0.86.0): a few categories and a search over every row, one category on screen at a time.
//
// The owner, 2026-10-19: "a million toggle in setting and a million section … organized, look cooler, more user
// friendly … easier to find". Profile → Settings showed 31 rows at once and Admin → Settings nine cards of 44; now each
// is four or five categories of at most eight rows (lib/settingsIndex*.ts says which), with the search above them.
//
// Two shapes from ONE tree, chosen by the layout's own width (a container query), never the window's: Admin's console
// rail and the app's sidebar take part of the window, so a 1280 px window can leave this less room than a tablet.
//   * Wide (from 840 px): the categories as a rail -- each with its icon, name and a line of what is set now -- beside the
//     category on screen, its groups in one, two or three columns as the pane grows.
//   * Narrow: the categories as a list; a tap goes into one, with a Back key to the list, as iPhone Settings does.
// ⚠️ The layout's container is NAMED (`@container/settings`, and every query here says `/settings`): the pane is a
// container too, for its columns, and an unnamed query inside it measured the pane -- the phone's Back key showed beside
// a 736 px pane on a 1440 px window.
//
// The category is in the address (`?cat=`), read ONCE and written with replaceState, never pushed -- the console's own
// rule for `?tab=` (lib/useTabParam.ts): a refresh, a language change (which remounts everything) and a saved link land
// on the same category, and the browser's Back leaves the page as it does from a tab.
//
// `?section=<id>` and a search pick land on a ROW (lib/settingsIndex.ts resolveSection): its category opens, the More
// options or editor holding it unfolds (`SettingsGo`, components/settings.tsx), and the row is brought into view and
// flashed once. lib/useSectionArrival.ts leaves rows in here to this.
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';
import { motion, useReducedMotion } from 'framer-motion';
import { useReduceEffects } from '@/lib/effects';
import { t as tr } from '@/lib/i18n';
import {
  readCat, resolveSection, searchSettings, shown, withCat,
  type SettingsCondition, type SettingsEntry, type SettingsIndex,
} from '@/lib/settingsIndex';
import { IcChevronLeft, IcChevronRight, IcSearch, IcX } from './icons';
import { SettingsGo, type SettingsTarget } from './settings';

/** How a category is drawn: the page supplies the pieces, the registry the order and the conditions. */
export interface CategoryView {
  icon: ReactNode;
  /** The icon tile's colours, a background and a text class: each category its own, as a phone's settings are. */
  tint: string;
  /** One line of what is set now, under its name in the list. */
  summary?: string;
  /** A sentence under the category's title. */
  description?: string;
  /** Its groups. */
  pane: ReactNode;
}

/**
 * The settings layout on screen, for the search palette (components/CommandPalette.tsx): a setting picked while its
 * page is already open is opened here -- its category, its fold, the row flashed -- instead of a whole page load.
 */
let onScreen: ((section: string) => boolean) | null = null;
/** Whether the settings layout on screen knows this `?section=`. */
export const settingsKnow = (section: string): boolean => !!onScreen && onScreen(section);
let goNow: ((section: string) => void) | null = null;
/** Go to a `?section=` the settings layout on screen knows (`settingsKnow`). */
export const settingsGoTo = (section: string): void => { goNow?.(section); };

/** A row brought into view: the moment the page stops changing, at most this long after the row first appeared. */
const SETTLE_MS = 250;
const AT_MOST_MS = 1500;

export function SettingsLayout({ index, conds, views, label }: {
  index: SettingsIndex;
  conds: Readonly<Record<SettingsCondition, boolean>>;
  views: Readonly<Record<string, CategoryView>>;
  /** The page's name for the list: the narrow Back key's label and the landmark's. */
  label: string;
}) {
  const params = useSearchParams();
  const cats = useMemo(() => index.categories.filter((c) => shown(c.when, conds) && views[c.id]), [index, conds, views]);
  // An arrival is read once, like the tab: its category wins over `?cat=`, and its row is the first target.
  const [arrived] = useState(() => {
    const p = resolveSection(index, params.get('section'));
    return p && cats.some((c) => c.id === p.cat) ? p : null;
  });
  const [cat, setCatState] = useState<string | null>(() => arrived?.cat ?? readCat(params.get('cat'), cats));
  const [target, setTarget] = useState<SettingsTarget | null>(() =>
    arrived?.row ? { row: arrived.row, more: arrived.more, editor: arrived.editor, seq: 1 } : null);
  const seq = useRef(1);
  const shownCat = cats.find((c) => c.id === cat) ?? cats[0];
  const view = shownCat ? views[shownCat.id] : undefined;

  // Wide or narrow, measured, for what CSS cannot decide: where focus goes, and which category is "current".
  const wrap = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(true);
  useEffect(() => {
    const el = wrap.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => setWide(e.contentRect.width >= 840));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const heading = useRef<HTMLHeadingElement>(null);
  const rows = useRef<Record<string, HTMLButtonElement | null>>({});
  // Both hooks on every render and in this order (ProgressRing.tsx says why).
  const reduced = useReducedMotion();
  const fewer = useReduceEffects();
  const still = !!reduced || fewer;

  const writeCat = (c: string | null) => {
    setCatState(c);
    window.history.replaceState(null, '', withCat(window.location.href, c));
  };
  const open = (id: string) => {
    writeCat(id);
    // Into the category on a phone: focus goes to its title, so a screen reader starts there and Tab goes on into it.
    if (wide) return;
    requestAnimationFrame(() => heading.current?.focus({ preventScroll: true }));
    // A list scrolled down a long page opens the category at its top, not halfway through it.
    const top = wrap.current?.getBoundingClientRect().top ?? 0;
    if (top < 0) window.scrollBy({ top: top - 12 });
  };
  const back = () => {
    const was = cat;
    writeCat(null);
    requestAnimationFrame(() => { if (was) rows.current[was]?.focus(); });
  };
  const go = (e: SettingsEntry) => {
    writeCat(e.cat);
    seq.current += 1;
    setTarget({ row: e.id, more: e.more, editor: e.editor, seq: seq.current });
  };

  // The palette's way in while this page is open (`settingsGoTo` above): a row is gone to as a search pick is, a category
  // opened.
  useEffect(() => {
    const place = (section: string) => {
      const p = resolveSection(index, section);
      return p && cats.some((c) => c.id === p.cat) ? p : null;
    };
    onScreen = (section) => !!place(section);
    goNow = (section) => {
      const p = place(section);
      if (!p) return;
      const e = p.row ? index.entries.find((x) => x.id === p.row) : undefined;
      if (e) go(e);
      else open(p.cat);
    };
    return () => { onScreen = null; goNow = null; };
  });

  // The arrival's `section` has done its work once read: off the address, so a refresh or a language change does not
  // land on the row again (lib/useSectionArrival.ts does the same with its own).
  useEffect(() => {
    if (!arrived) return;
    const u = new URL(window.location.href);
    u.searchParams.delete('section');
    window.history.replaceState(null, '', withCat(`${u.pathname}${u.search}${u.hash}`, arrived.cat));
  }, [arrived]);

  // Bring the target row into view and flash it, once it is drawn -- its category may still be loading, and an editor
  // opens on the next render -- and once the page has stopped moving under it.
  useEffect(() => {
    if (!target) return;
    let first = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let done = false;
    const land = () => {
      const el = document.getElementById(target.row);
      if (!el || done) return;
      done = true;
      mo.disconnect();
      el.scrollIntoView({ block: 'center', behavior: still ? 'auto' : 'smooth' });
      el.classList.remove('settings-flash');
      void el.offsetWidth;
      el.classList.add('settings-flash');
      setTimeout(() => el.classList.remove('settings-flash'), 2000);
      const control = el.matches('button, a[href], input, select') ? el : el.querySelector<HTMLElement>('input, select, button, a[href]');
      control?.focus({ preventScroll: true });
    };
    const settle = () => {
      if (done || !document.getElementById(target.row)) return;
      first ||= Date.now();
      clearTimeout(timer);
      timer = setTimeout(land, Date.now() - first >= AT_MOST_MS ? 0 : SETTLE_MS);
    };
    const mo = new MutationObserver(settle);
    mo.observe(document.body, { childList: true, subtree: true });
    settle();
    const giveUp = setTimeout(() => mo.disconnect(), 10_000);
    return () => { done = true; mo.disconnect(); clearTimeout(timer); clearTimeout(giveUp); };
  }, [target]); // eslint-disable-line react-hooks/exhaustive-deps -- once per arrival; `still` is read when it lands

  if (!shownCat || !view) return null;
  const narrowList = cat ? '@max-[52.5rem]/settings:hidden' : '';
  const narrowPane = cat ? '' : '@max-[52.5rem]/settings:hidden';

  return (
    <div ref={wrap} className="@container/settings" data-settings-layout>
      <div className="@min-[52.5rem]/settings:grid @min-[52.5rem]/settings:grid-cols-[17rem_minmax(0,1fr)] @min-[52.5rem]/settings:items-start @min-[52.5rem]/settings:gap-8 @min-[90rem]/settings:grid-cols-[19rem_minmax(0,1fr)]">
        {/* ---- the categories, and the search over every row ---- */}
        <nav aria-label={label} className={`min-w-0 @min-[52.5rem]/settings:sticky @min-[52.5rem]/settings:top-[calc(var(--topbar-h)+1rem)] ${narrowList}`} data-settings-nav>
          <SettingsSearch index={index} conds={conds} onPick={go} />
          <ul className="card grad-border mt-3 overflow-hidden rounded-2xl p-1.5" data-settings-categories>
            {cats.map((c) => {
              const v = views[c.id];
              const on = c.id === shownCat.id;
              return (
                <li key={c.id}>
                  <button ref={(el) => { rows.current[c.id] = el; }} type="button" onClick={() => open(c.id)}
                    aria-current={on && wide ? 'page' : undefined} data-settings-cat={c.id}
                    className={`group relative flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-start transition hover:bg-ink-800/60 ${on ? '@min-[52.5rem]/settings:bg-accent-soft' : ''}`}>
                    <span aria-hidden className={`grid h-9 w-9 shrink-0 place-items-center rounded-[10px] ${v.tint}`}>{v.icon}</span>
                    <span className="min-w-0 flex-1">
                      <span className={`block truncate text-sm font-medium ${on ? 'text-fog-50 @min-[52.5rem]/settings:text-accent' : 'text-fog-100'}`}>{tr(c.label)}</span>
                      {v.summary && <span className="line-clamp-2 block text-[11px] leading-snug text-fog-500">{v.summary}</span>}
                    </span>
                    <IcChevronRight width={16} height={16} aria-hidden className="shrink-0 text-fog-500 transition group-hover:text-fog-200 rtl:-scale-x-100 @min-[52.5rem]/settings:hidden" />
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>

        {/* ---- the category on screen ---- */}
        <section aria-labelledby={`settings-${shownCat.id}-title`} className={`min-w-0 @container/pane ${narrowPane}`} data-settings-pane={shownCat.id}>
          <button type="button" onClick={back} className="btn-key mb-4 gap-1 @min-[52.5rem]/settings:hidden" data-settings-back>
            <IcChevronLeft width={16} height={16} aria-hidden className="rtl:-scale-x-100" />{label}
          </button>
          <header className="mb-5">
            <h2 ref={heading} id={`settings-${shownCat.id}-title`} tabIndex={-1} className="font-display text-2xl font-bold text-fog-50 outline-hidden">
              {tr(shownCat.label)}
            </h2>
            {view.description && <p className="mt-1 max-w-prose text-sm text-fog-400">{view.description}</p>}
          </header>
          <SettingsGo.Provider value={target}>
            <motion.div key={shownCat.id} initial={still ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
              transition={still ? { duration: 0 } : { duration: 0.2, ease: [0.22, 0.61, 0.36, 1] }}
              className="grid items-start gap-6 @min-[48rem]/pane:grid-cols-2 @min-[90rem]/pane:grid-cols-3">
              {view.pane}
            </motion.div>
          </SettingsGo.Provider>
        </section>
      </div>
    </div>
  );
}

/**
 * The search over every row of this page (lib/settingsIndex.ts searchSettings): by what a row says, in the reader's
 * language and in English, by the words someone might type instead, and by its help. A combobox: the list follows the
 * field, the arrows move through it with the focus staying in the field (`aria-activedescendant`), Enter goes, Escape
 * empties the field. From two characters, the search palette's threshold.
 */
function SettingsSearch({ index, conds, onPick }: {
  index: SettingsIndex;
  conds: Readonly<Record<SettingsCondition, boolean>>;
  onPick: (e: SettingsEntry) => void;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const list = useId();
  const results = useMemo(() => searchSettings(index, query, conds, (k) => tr(k)), [index, query, conds]);
  const open = query.trim().length >= 2;
  const cats = new Map(index.categories.map((c) => [c.id, c]));
  const names = new Map(index.entries.map((e) => [e.id, e]));
  const where = (e: SettingsEntry): string => {
    const parts = [tr(cats.get(e.cat)?.label ?? '')];
    if (e.editor && e.editor !== e.id) parts.push(tr(names.get(e.editor)?.label ?? ''));
    else if (e.more) parts.push(tr('More options'));
    return parts.join(' › ');
  };
  const pick = (e: SettingsEntry) => { setQuery(''); setActive(0); onPick(e); };
  return (
    <div className="relative" data-settings-search>
      <IcSearch width={16} height={16} aria-hidden className="pointer-events-none absolute start-3 top-[1.15rem] -translate-y-1/2 text-fog-500" />
      <input
        type="search"
        role="combobox"
        aria-expanded={open}
        aria-controls={list}
        aria-autocomplete="list"
        aria-activedescendant={open && results[active] ? `${list}-${active}` : undefined}
        aria-label={tr('Search settings')}
        placeholder={tr('Search settings')}
        enterKeyHint="search"
        autoComplete="off"
        value={query}
        onChange={(e) => { setQuery(e.target.value); setActive(0); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && results.length) { e.preventDefault(); setActive((a) => (a + 1) % results.length); }
          else if (e.key === 'ArrowUp' && results.length) { e.preventDefault(); setActive((a) => (a - 1 + results.length) % results.length); }
          else if (e.key === 'Enter' && open && results[active]) { e.preventDefault(); pick(results[active]); }
          else if (e.key === 'Escape' && query) { e.preventDefault(); setQuery(''); }
        }}
        className="field max-w-none ps-9 pe-9 [&::-webkit-search-cancel-button]:appearance-none"
      />
      {query && (
        <button type="button" onClick={() => setQuery('')} aria-label={tr('Clear')}
          className="absolute end-2 top-[1.15rem] grid h-7 w-7 -translate-y-1/2 place-items-center rounded-lg text-fog-500 hover:text-fog-100">
          <IcX width={14} height={14} />
        </button>
      )}
      {open && (
        <ul id={list} role="listbox" aria-label={tr('Search settings')} data-settings-results
          className="card grad-border mt-2 overflow-hidden rounded-2xl p-1.5">
          {results.map((e, i) => (
            <li key={e.id} id={`${list}-${i}`} role="option" aria-selected={i === active}
              onMouseDown={(ev) => ev.preventDefault()} onClick={() => pick(e)} onMouseMove={() => setActive(i)}
              className={`cursor-pointer rounded-xl px-3 py-2 ${i === active ? 'bg-ink-800/80' : ''}`}>
              <span className="block truncate text-sm text-fog-100">{tr(e.label)}</span>
              <span className="block truncate text-[11px] text-fog-500">{where(e)}</span>
            </li>
          ))}
          {!results.length && <li className="px-3 py-2 text-sm text-fog-500">{tr('Nothing found')}</li>}
        </ul>
      )}
    </div>
  );
}
