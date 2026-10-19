'use client';
// Profile and Admin as ONE grouped list each (v0.88.0), with a search over every page and every setting.
//
// The owner, after v0.86.0 made the settings categories: "I still have to go to a tab under a tab … Connections is not
// under anything … the phone version is really confusing". Profile was five tabs under a hero, its Settings tab four
// categories under those; Admin was four groups of tabs under its own hero, its Settings tab five categories under those
// -- on a phone, a group menu, a tab row and a category list before the first switch. Now each is one list, the way a
// phone's own Settings is: its pages in a few named groups (the settings categories among them, Connections and Account
// beside the rest, Maintenance holding what was the Tasks tab), and the page itself beside it.
//
// Two shapes from ONE tree, chosen by the console's own width (a container query, never the window's):
//   * Wide (from 840 px): the list as a sticky rail -- the console's card at its top (the person, or the server's
//     state), the search, the groups, its own footer -- beside the page on screen.
//   * Narrow: the list IS the first screen. A tap opens the page, with a Back key to the list; the page is pushed onto
//     the history there, so the phone's own Back returns to the list as well. Wide switches replace the address instead:
//     clicking down a rail is not a trail anyone wants to walk back through.
//
// The page is in the address (`?tab=`), read on every render: Back, a refresh, a language change (which remounts
// everything) and a saved link all land on the same page. Tab names from before v0.88.0 are read too (lib/settingsIndex.ts
// readPage). `?section=<id>` and a search pick land on a ROW: its page opens, the More options or editor holding it
// unfolds (`SettingsGo`, components/settings.tsx), and the row is brought into view and flashed once.
// lib/useSectionArrival.ts leaves rows in here to this.
//
// ⚠️ The container is NAMED (`@container/console`, and every query here says `/console`): the pane is a container too,
// for its columns, and an unnamed query inside it measures the pane -- v0.86.0's phone Back key showed beside a 736 px
// pane at 1440 until the names went in.
import Link from 'next/link';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';
import { motion, useReducedMotion } from 'framer-motion';
import { useReduceEffects } from '@/lib/effects';
import { t as tr } from '@/lib/i18n';
import {
  readPage, resolveSection, searchPages, searchSettings, shown, withPage,
  type SettingsCategory, type SettingsCondition, type SettingsEntry, type SettingsIndex,
} from '@/lib/settingsIndex';
import { IcChevronLeft, IcChevronRight, IcSearch, IcX } from './icons';
import { SettingsGo, type SettingsTarget } from './settings';
import { setConsoleOnScreen } from '@/lib/consoleOnScreen';

/** How a page is drawn: the console supplies the pieces, the registry the order, the groups and the conditions. */
export interface PageView {
  icon: ReactNode;
  /** The icon tile's colours, a background and a text class: each page its own, as a phone's settings are. */
  tint: string;
  /** One line of what is set or happening, under its name in the list. */
  summary?: string;
  /** A sentence under the page's title. */
  description?: string;
  /** The page draws its own header (You's hero): no title above it. */
  ownHeader?: boolean;
  /** What is on the page. A settings page's groups are laid out in the pane's columns. */
  pane: ReactNode;
}

/** A row brought into view: the moment the page stops changing, at most this long after the row first appeared. */
const SETTLE_MS = 250;
const AT_MOST_MS = 1500;
const slashed = (p: string): string => (p.endsWith('/') ? p : `${p}/`);

export function ConsoleLayout({ index, conds, views, label, card, footer, home }: {
  index: SettingsIndex;
  conds: Readonly<Record<SettingsCondition, boolean>>;
  views: Readonly<Record<string, PageView>>;
  /** The console's name: the list's landmark and the narrow Back key. */
  label: string;
  /** The console's card, at the top of the list: the person, or the server's state. */
  card?: ReactNode;
  /** Rows at the foot of the list (Admin, Support, Sign out; the version). */
  footer?: ReactNode;
  /** The page a wide console opens on when the address names none. */
  home: string;
}) {
  const params = useSearchParams();
  const pages = useMemo(() => index.categories.filter((c) => shown(c.when, conds) && views[c.id]), [index, conds, views]);
  const ids = pages.map((c) => c.id);
  const groups = useMemo(() => {
    const out: Array<{ label?: string; pages: SettingsCategory[] }> = [];
    for (const c of pages) {
      const last = out[out.length - 1];
      if (last && last.label === c.group) last.pages.push(c);
      else out.push({ label: c.group, pages: [c] });
    }
    return out;
  }, [pages]);

  // An arrival is read once: its page wins over `?tab=`, and its row is the first target.
  const [arrived] = useState(() => {
    const section = params.get('section');
    if (!section) return null;
    const p = resolveSection(index, section);
    if (p && ids.includes(p.cat)) return p;
    // A card the registry does not list (Health's checks, Maintenance's tasks): landed on in whatever page the address
    // names, once it is drawn.
    return { cat: readPage(index, params.get('tab'), params.get('cat'), ids) ?? '', row: section } as { cat: string; row?: string; more?: string; editor?: string };
  });
  // The page is the address's, on every render -- except while an arrival's `section` is still in it: then the page that
  // holds its row, until the address is rewritten to say so (below).
  const fromUrl = readPage(index, params.get('tab'), params.get('cat'), ids);
  const page = params.get('section') && arrived?.cat ? arrived.cat : fromUrl;
  const [target, setTarget] = useState<SettingsTarget | null>(() =>
    arrived?.row ? { row: arrived.row, more: arrived.more, editor: arrived.editor, seq: 1 } : null);
  const seq = useRef(1);
  const shownPage = pages.find((c) => c.id === page) ?? pages.find((c) => c.id === home) ?? pages[0];
  const view = shownPage ? views[shownPage.id] : undefined;

  // Wide or narrow, measured, for what CSS cannot decide: pushing or replacing the address, and where focus goes.
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

  /**
   * Into a page. Narrow: pushed, so Back comes out again; wide: replaced. ⚠️ Never with Next's own history state as the
   * first argument: Next takes a state carrying its marker for one of its own calls and leaves its router -- and with it
   * `useSearchParams`, which the page is read from -- where it was.
   */
  const open = (id: string) => {
    if (wide) {
      window.history.replaceState(null, '', withPage(window.location.href, id));
      return;
    }
    window.history.pushState({ consolePage: id }, '', withPage(window.location.href, id));
    // Into the page: focus goes to its title, so a screen reader starts there and Tab goes on into it.
    requestAnimationFrame(() => heading.current?.focus({ preventScroll: true }));
    window.scrollTo({ top: 0 });
  };
  /** Back to the list (narrow): the history's own step when this console pushed the page, else the address without it. */
  const back = () => {
    const was = page;
    if ((window.history.state as { consolePage?: string } | null)?.consolePage) window.history.back();
    else window.history.replaceState(null, '', withPage(window.location.href, null));
    requestAnimationFrame(() => { if (was) rows.current[was]?.focus({ preventScroll: true }); });
  };
  const go = (e: SettingsEntry) => {
    open(e.cat);
    seq.current += 1;
    setTarget({ row: e.id, more: e.more, editor: e.editor, seq: seq.current });
  };

  // The way in for links to this console while it is open (lib/consoleOnScreen.ts): a row is gone to as a search pick is,
  // a page opened -- the first page for the console's bare address.
  useEffect(() => {
    const placeOf = (u: URL) => {
      const section = u.searchParams.get('section');
      const p = section ? resolveSection(index, section) : null;
      if (p && ids.includes(p.cat)) return p;
      const tab = readPage(index, u.searchParams.get('tab'), u.searchParams.get('cat'), ids)
        ?? (u.searchParams.has('tab') || section ? null : home);
      return tab ? { cat: tab, row: section ?? undefined } : null;
    };
    setConsoleOnScreen({
      path: slashed(window.location.pathname),
      know: (u) => !!placeOf(u),
      go: (u) => {
        const p = placeOf(u);
        if (!p) return;
        open(p.cat);
        if (p.row) {
          seq.current += 1;
          setTarget({ row: p.row, more: (p as { more?: string }).more, editor: (p as { editor?: string }).editor, seq: seq.current });
        }
      },
    });
    return () => setConsoleOnScreen(null);
  });

  // The arrival's `section` has done its work once read: off the address (and the page written in), so a refresh or a
  // language change does not land on the row again (lib/useSectionArrival.ts does the same with its own).
  useEffect(() => {
    if (!arrived) return;
    const u = new URL(window.location.href);
    u.searchParams.delete('section');
    window.history.replaceState(null, '', withPage(`${u.pathname}${u.search}${u.hash}`, arrived.cat || page));
  }, [arrived]); // eslint-disable-line react-hooks/exhaustive-deps -- once

  // An old address (`?tab=Settings&cat=downloads`, `?tab=Tasks`) is rewritten to the page's own, once.
  useEffect(() => {
    const raw = params.get('tab');
    if (page && raw && raw !== page) window.history.replaceState(null, '', withPage(window.location.href, page));
  }, [page]); // eslint-disable-line react-hooks/exhaustive-deps -- only when the page changes

  // Bring the target row into view and flash it, once it is drawn -- its page may still be loading, and an editor opens
  // on the next render -- and once the page has stopped moving under it.
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

  if (!shownPage || !view) return null;
  const narrowList = page ? '@max-[52.5rem]/console:hidden' : '';
  const narrowPane = page ? '' : '@max-[52.5rem]/console:hidden';
  const settingsPage = !!shownPage.settings;

  return (
    <div ref={wrap} className="@container/console" data-console data-settings-layout>
      <div className="@min-[52.5rem]/console:grid @min-[52.5rem]/console:grid-cols-[17rem_minmax(0,1fr)] @min-[52.5rem]/console:items-start @min-[52.5rem]/console:gap-8 @min-[72rem]/console:grid-cols-[19rem_minmax(0,1fr)]">
        {/* ---- the list: the card, the search, the groups, the foot ----
            Beside the page, it stays in view and scrolls on its own: taller than the window (Admin's is), a sticky list
            otherwise hides its last groups until the page under it has been read to the end. */}
        <nav aria-label={label} data-lenis-prevent
          className={`min-w-0 space-y-4 @min-[52.5rem]/console:sticky @min-[52.5rem]/console:top-[calc(var(--topbar-h)+1rem)] @min-[52.5rem]/console:-m-1 @min-[52.5rem]/console:max-h-[calc(100dvh-var(--topbar-h)-2rem)] @min-[52.5rem]/console:overflow-y-auto @min-[52.5rem]/console:overscroll-contain @min-[52.5rem]/console:p-1 ${narrowList}`} data-console-nav>
          {card}
          <ConsoleSearch index={index} conds={conds} drawn={(id) => ids.includes(id)} onPage={open} onPick={go} />
          {groups.map((g, gi) => (
            <div key={g.label ?? `g${gi}`}>
              {g.label && <h2 className="mb-1.5 px-1 text-[13px] font-semibold text-fog-400">{tr(g.label)}</h2>}
              <ul className="card grad-border overflow-hidden rounded-2xl p-1.5" data-console-group={g.label ?? ''}>
                {g.pages.map((c) => {
                  const v = views[c.id];
                  const on = c.id === shownPage.id;
                  return (
                    <li key={c.id}>
                      <button ref={(el) => { rows.current[c.id] = el; }} type="button" onClick={() => open(c.id)}
                        aria-current={on && wide ? 'page' : undefined} data-console-page={c.id}
                        className={`group relative flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-start transition hover:bg-ink-800/60 @min-[52.5rem]/console:py-2 ${on ? '@min-[52.5rem]/console:bg-accent-soft' : ''}`}>
                        <span aria-hidden className={`grid h-9 w-9 shrink-0 place-items-center rounded-[10px] @min-[52.5rem]/console:h-8 @min-[52.5rem]/console:w-8 ${v.tint}`}>{v.icon}</span>
                        <span className="min-w-0 flex-1">
                          <span className={`block truncate text-sm font-medium ${on ? 'text-fog-50 @min-[52.5rem]/console:text-accent' : 'text-fog-100'}`}>{tr(c.label)}</span>
                          {/* One line beside the page, where the list is a rail; two on a phone, where it is the screen. */}
                          {v.summary && <span className="line-clamp-2 block text-[11px] leading-snug text-fog-500 @min-[52.5rem]/console:line-clamp-1">{v.summary}</span>}
                        </span>
                        <IcChevronRight width={16} height={16} aria-hidden className="shrink-0 text-fog-500 transition group-hover:text-fog-200 rtl:-scale-x-100 @min-[52.5rem]/console:hidden" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
          {footer}
        </nav>

        {/* ---- the page on screen ---- */}
        <section aria-labelledby={`console-${shownPage.id}-title`} className={`min-w-0 @container/pane ${narrowPane}`} data-console-pane={shownPage.id}
          data-settings-pane={settingsPage ? shownPage.id : undefined}>
          <button type="button" onClick={back} className="btn-key mb-4 gap-1 @min-[52.5rem]/console:hidden" data-console-back>
            <IcChevronLeft width={16} height={16} aria-hidden className="rtl:-scale-x-100" />{label}
          </button>
          <header className={view.ownHeader ? 'sr-only' : 'mb-5'}>
            <h2 ref={heading} id={`console-${shownPage.id}-title`} tabIndex={-1} className="font-display text-2xl font-bold text-fog-50 outline-hidden">
              {tr(shownPage.label)}
            </h2>
            {view.description && <p className="mt-1 max-w-prose text-sm text-fog-400">{view.description}</p>}
          </header>
          <SettingsGo.Provider value={target}>
            <motion.div key={shownPage.id} initial={still ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
              transition={still ? { duration: 0 } : { duration: 0.2, ease: [0.22, 0.61, 0.36, 1] }}
              className={settingsPage ? 'grid items-start gap-6 @min-[48rem]/pane:grid-cols-2 @min-[90rem]/pane:grid-cols-3' : undefined}>
              {view.pane}
            </motion.div>
          </SettingsGo.Provider>
        </section>
      </div>
    </div>
  );
}

/**
 * The search over this console: its pages by name and the words they are known by, and every row of its settings pages
 * (lib/settingsIndex.ts). A combobox: the list follows the field, the arrows move through it with the focus staying in
 * the field (`aria-activedescendant`), Enter goes, Escape empties the field. From two characters, the palette's
 * threshold.
 */
function ConsoleSearch({ index, conds, drawn, onPage, onPick }: {
  index: SettingsIndex;
  conds: Readonly<Record<SettingsCondition, boolean>>;
  drawn: (id: string) => boolean;
  onPage: (id: string) => void;
  onPick: (e: SettingsEntry) => void;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const list = useId();
  type Hit = { kind: 'page'; c: SettingsCategory } | { kind: 'row'; e: SettingsEntry };
  const results = useMemo<Hit[]>(() => [
    ...searchPages(index, query, conds, (k) => tr(k), drawn).map((c): Hit => ({ kind: 'page', c })),
    ...searchSettings(index, query, conds, (k) => tr(k)).filter((e) => drawn(e.cat)).map((e): Hit => ({ kind: 'row', e })),
  ].slice(0, 9), [index, query, conds, drawn]);
  const open = query.trim().length >= 2;
  const cats = new Map(index.categories.map((c) => [c.id, c]));
  const names = new Map(index.entries.map((e) => [e.id, e]));
  const where = (h: Hit): string => {
    if (h.kind === 'page') return h.c.group ? tr(h.c.group) : '';
    const e = h.e;
    const parts = [tr(cats.get(e.cat)?.label ?? '')];
    if (e.editor && e.editor !== e.id) parts.push(tr(names.get(e.editor)?.label ?? ''));
    else if (e.more) parts.push(tr('More options'));
    return parts.join(' › ');
  };
  const pick = (h: Hit) => {
    setQuery('');
    setActive(0);
    if (h.kind === 'page') onPage(h.c.id);
    else onPick(h.e);
  };
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
          {results.map((h, i) => (
            <li key={h.kind === 'page' ? `p-${h.c.id}` : h.e.id} id={`${list}-${i}`} role="option" aria-selected={i === active}
              onMouseDown={(ev) => ev.preventDefault()} onClick={() => pick(h)} onMouseMove={() => setActive(i)}
              className={`cursor-pointer rounded-xl px-3 py-2 ${i === active ? 'bg-ink-800/80' : ''}`}>
              <span className="block truncate text-sm text-fog-100">{tr(h.kind === 'page' ? h.c.label : h.e.label)}</span>
              {where(h) && <span className="block truncate text-[11px] text-fog-500">{where(h)}</span>}
            </li>
          ))}
          {!results.length && <li className="px-3 py-2 text-sm text-fog-500">{tr('Nothing found')}</li>}
        </ul>
      )}
    </div>
  );
}

/**
 * A row at the foot of the list: Admin, Support Uchiyomi, Sign out -- the same rows as the pages above them, set apart in
 * a card of their own. A link when it has an address, a button otherwise; `tone` "danger" for Sign out.
 */
export function ConsoleFootRow({ href, onClick, icon, label, tone, external }: {
  href?: string;
  onClick?: () => void;
  icon: ReactNode;
  label: string;
  tone?: 'danger';
  external?: boolean;
}) {
  const cls = `group flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-start text-sm transition hover:bg-ink-800/60 ${tone === 'danger' ? 'text-red-300/90 hover:text-red-300' : 'text-fog-200 hover:text-fog-50'}`;
  const inner = (
    <>
      <span aria-hidden className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-ink-800/80">{icon}</span>
      <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
    </>
  );
  if (href) {
    return external
      ? <a href={href} target="_blank" rel="noopener noreferrer" className={cls}>{inner}</a>
      : <Link href={href} className={cls}>{inner}</Link>;
  }
  return <button type="button" onClick={onClick} className={cls}>{inner}</button>;
}
