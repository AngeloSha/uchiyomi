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
//   * Wide (from 840 px): the console's cinematic hero across the top -- in full above its first page, a band above the
//     rest -- then the list as a sticky rail (the pages with a picture as tiles, the search, the groups, its own footer)
//     beside the page on screen.
//   * Narrow: the hero and the list ARE the first screen. A tap opens the page under a band of the same art with its
//     title and a Back key; the page is pushed onto the history there, so the phone's own Back returns to the list as
//     well. Wide switches replace the address instead: clicking down a rail is not a trail anyone wants to walk back
//     through.
// The owner, on a first cut that put the heroes in a card: "it was cinematic and nicer before with a hero section". The
// heroes are the consoles' own (app/profile/page.tsx ProfileHero, app/admin/page.tsx AdminHero); this places them.
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
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';
import { motion, PresenceContext, useReducedMotion } from 'framer-motion';
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
  /** The hero above it says what it is on a computer (You): its title shows on a phone only, over the art. */
  ownHeader?: boolean;
  /** A picture for the page's tile (covers, a chart): pages with one lead the list as tiles, two to a row. */
  tile?: ReactNode;
  /** What is on the page. A settings page's groups are laid out in the pane's columns. */
  pane: ReactNode;
}

/** A row brought into view: the moment the page stops changing, at most this long after the row first appeared. */
const SETTLE_MS = 250;
const AT_MOST_MS = 1500;
const slashed = (p: string): string => (p.endsWith('/') ? p : `${p}/`);

export function ConsoleLayout({ index, conds, views, label, hero, art, footer, home }: {
  index: SettingsIndex;
  conds: Readonly<Record<SettingsCondition, boolean>>;
  views: Readonly<Record<string, PageView>>;
  /** The console's name: the list's landmark and the narrow Back key. */
  label: string;
  /**
   * The console's hero, above the list and the page: `band` above every page but the first on a computer, `full`
   * otherwise. A phone shows it above the list, and opens a page under that page's own band instead.
   */
  hero?: (mode: 'full' | 'band') => ReactNode;
  /** The art the hero is washed in, for the band a phone opens a page under. */
  art?: ReactNode;
  /** Rows at the foot of the list (Admin, Support, Sign out; the version). */
  footer?: ReactNode;
  /** The page a wide console opens on when the address names none. */
  home: string;
}) {
  const params = useSearchParams();
  const pages = useMemo(() => index.categories.filter((c) => shown(c.when, conds) && views[c.id]), [index, conds, views]);
  const ids = pages.map((c) => c.id);
  // The pages with a picture lead the list as tiles; the rest are rows in their groups.
  const tiles = pages.filter((c) => views[c.id]?.tile);
  const groups = useMemo(() => {
    const out: Array<{ label?: string; pages: SettingsCategory[] }> = [];
    for (const c of pages.filter((p) => !views[p.id]?.tile)) {
      const last = out[out.length - 1];
      if (last && last.label === c.group) last.pages.push(c);
      else out.push({ label: c.group, pages: [c] });
    }
    return out;
  }, [pages, views]);

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

  // Beside the page, the list scrolls on its own only once it has stuck under the top bar. Before that -- the hero still
  // on screen above it -- a wheel over it scrolls the page, as it would anywhere else; a list that scrolled itself there
  // took the wheel from the page while the page had not yet moved. Stuck is when a mark at the list's top has passed the
  // line it sticks at, told by an observer: nothing here reads the layout on a scroll (idleWork.test.ts).
  const nav = useRef<HTMLElement>(null);
  const mark = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const el = nav.current;
    const at = mark.current;
    if (!wide || !el || !at || typeof IntersectionObserver === 'undefined') { setStuck(false); return; }
    // Where the list sticks: its `top`, and the 4 px its negative margin lifts it by. Read once, not on a scroll.
    const line = Math.round((parseFloat(getComputedStyle(el).top) || 0) + 4);
    const io = new IntersectionObserver(([e]) => {
      const now = !e.isIntersecting && e.boundingClientRect.top < (e.rootBounds?.top ?? line);
      // Unstuck, its own scroll goes back to the top: the hero is in view again, and so must the list's start be.
      if (!now && el.scrollTop) el.scrollTop = 0;
      setStuck(now);
    }, { rootMargin: `-${line}px 0px 0px 0px`, threshold: 0 });
    io.observe(at);
    return () => io.disconnect();
  }, [wide]);
  // Both settings, both hooks on every render (components/Toast.tsx says why).
  const plain = useReduceEffects();
  const still = useReducedMotion();
  const reduced = plain || !!still;

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
    window.scrollTo({ top: 0 });
  };
  /** Back to the list (narrow): the history's own step when this console pushed the page, else the address without it. */
  const back = () => {
    if ((window.history.state as { consolePage?: string } | null)?.consolePage) window.history.back();
    else window.history.replaceState(null, '', withPage(window.location.href, null));
  };
  // On a phone, the focus follows the screen, once the screen has changed (the address does first, and the page after it):
  //   * into a page, its title takes it, so a screen reader starts there and Tab goes on into it;
  //   * Back -- this key or the phone's own -- puts the list where it was: the row the page was opened from in view and
  //     focused, not the top of a list whose last group is a screen down. Next keeps scrolling to itself
  //     (`scrollRestoration` manual), so nothing else would.
  const was = useRef(page);
  useEffect(() => {
    const from = was.current;
    was.current = page;
    if (wide || from === page) return;
    requestAnimationFrame(() => {
      if (page) {
        heading.current?.focus({ preventScroll: true });
        return;
      }
      const row = from ? rows.current[from] : null;
      row?.scrollIntoView({ block: 'center' });
      row?.focus({ preventScroll: true });
    });
  }, [page]); // eslint-disable-line react-hooks/exhaustive-deps -- on a change of page only
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
      el.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });
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
  }, [target]); // eslint-disable-line react-hooks/exhaustive-deps -- once per arrival; `reduced` is read when it lands

  if (!shownPage || !view) return null;
  const narrowList = page ? '@max-[52.5rem]/console:hidden' : '';
  const narrowPane = page ? '' : '@max-[52.5rem]/console:hidden';
  const settingsPage = !!shownPage.settings;
  const heroMode = wide && shownPage.id !== home ? 'band' : 'full';

  return (
    // ⚠️ The page transition mounts every page with Framer's `initial` turned off (components/PageTransition.tsx), which
    // reaches every motion element under it for its life: opened directly -- a refresh, a link, a language change -- the
    // hero, the tiles and the groups would start already in place. The console's entrance is part of its look, so its
    // own elements answer to their own `initial`, and to the two motion settings, and nothing else.
    <PresenceContext.Provider value={null}>
    <div ref={wrap} className="@container/console" data-console data-settings-layout>
      {/* The hero: the first screen's on a phone, so not above a page opened from it -- that page has its own band. */}
      {hero && <div className={narrowList} data-console-hero={heroMode}><HeroFrame reduced={reduced}>{hero(heroMode)}</HeroFrame></div>}
      {/* Where the list starts, for telling when it has stuck (above). Takes no room. */}
      <div ref={mark} aria-hidden className="h-0" data-console-mark />
      <div className="@min-[52.5rem]/console:grid @min-[52.5rem]/console:grid-cols-[17rem_minmax(0,1fr)] @min-[52.5rem]/console:items-start @min-[52.5rem]/console:gap-8 @min-[72rem]/console:grid-cols-[19rem_minmax(0,1fr)]">
        {/* ---- the list: the tiles, the search, the groups, the foot ----
            Beside the page, it stays in view and scrolls on its own: taller than the window (Admin's is), a sticky list
            otherwise hides its last groups until the page under it has been read to the end. */}
        <nav ref={nav} aria-label={label} data-lenis-prevent={stuck ? '' : undefined}
          className={`min-w-0 space-y-4 @min-[52.5rem]/console:sticky @min-[52.5rem]/console:top-[calc(var(--topbar-h)+1.5rem)] @min-[52.5rem]/console:-m-1 @min-[52.5rem]/console:max-h-[calc(100dvh-var(--topbar-h)-2.5rem)] @min-[52.5rem]/console:p-1 @min-[52.5rem]/console:[scrollbar-gutter:stable] ${stuck ? '@min-[52.5rem]/console:overflow-y-auto' : '@min-[52.5rem]/console:overflow-y-hidden'} ${narrowList}`} data-console-nav>
          {tiles.length > 0 && (
            <div className="grid grid-cols-2 gap-3" data-console-tiles>
              {tiles.map((c, i) => {
                const v = views[c.id];
                const on = c.id === shownPage.id;
                return (
                  // Named states rather than targets: the picture inside answers to the same ones (a fan of covers spreads
                  // as the tile lifts), and Framer hands a state down to it where a target stays the tile's own.
                  <motion.button key={c.id} ref={(el) => { rows.current[c.id] = el; }} type="button" onClick={() => open(c.id)}
                    aria-current={on && wide ? 'page' : undefined} data-console-page={c.id} data-console-tile={c.id}
                    initial={reduced ? false : 'enter'} animate="rest" whileHover={reduced ? undefined : 'hover'} whileTap={reduced ? undefined : 'tap'}
                    variants={{
                      enter: { opacity: 0, y: 10 },
                      rest: { opacity: 1, y: 0, scale: 1, transition: reduced ? { duration: 0 } : { duration: 0.4, delay: i * 0.07, ease: [0.22, 0.61, 0.36, 1] } },
                      hover: { y: -3, transition: { duration: 0.2 } },
                      tap: { scale: 0.98, transition: { duration: 0.1 } },
                    }}
                    className={`card grad-border group relative isolate flex h-44 flex-col justify-end overflow-hidden rounded-2xl p-3 text-start transition-shadow hover:shadow-glow @min-[52.5rem]/console:h-36 ${on ? '@min-[52.5rem]/console:ring-2 @min-[52.5rem]/console:ring-accent/70' : ''}`}>
                    <span aria-hidden className="absolute inset-0 -z-10">{v.tile}</span>
                    {/* The picture fades into the words, so they read over any cover. */}
                    <span aria-hidden className="absolute inset-0 -z-10 bg-linear-to-t from-ink-950 via-ink-950/70 to-transparent" />
                    <span className="flex min-w-0 items-center gap-2">
                      <span aria-hidden className={`grid h-7 w-7 shrink-0 place-items-center rounded-lg ${v.tint}`}>{v.icon}</span>
                      {/* Marked only beside the page: on a phone the list is a screen of its own, and nothing on it is open. */}
                      <span className={`truncate font-display text-base font-bold text-fog-50 @min-[52.5rem]/console:text-sm ${on ? '@min-[52.5rem]/console:text-accent' : ''}`}>{tr(c.label)}</span>
                    </span>
                    {v.summary && <span className="mt-1 line-clamp-2 text-[11px] leading-snug text-fog-400">{v.summary}</span>}
                  </motion.button>
                );
              })}
            </div>
          )}
          <ConsoleSearch index={index} conds={conds} drawn={(id) => ids.includes(id)} onPage={open} onPick={go} />
          {groups.map((g, gi) => (
            <motion.div key={g.label ?? `g${gi}`} initial={reduced ? false : { opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
              transition={reduced ? { duration: 0 } : { duration: 0.4, delay: 0.1 + gi * 0.05, ease: [0.22, 0.61, 0.36, 1] }}>
              {g.label && <h2 className="mb-1.5 px-1 text-[13px] font-semibold text-fog-400">{tr(g.label)}</h2>}
              <ul className="card grad-border overflow-hidden rounded-2xl p-1.5" data-console-group={g.label ?? ''}>
                {g.pages.map((c) => {
                  const v = views[c.id];
                  const on = c.id === shownPage.id;
                  return (
                    <li key={c.id}>
                      <button ref={(el) => { rows.current[c.id] = el; }} type="button" onClick={() => open(c.id)}
                        aria-current={on && wide ? 'page' : undefined} data-console-page={c.id}
                        className={`group relative flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-start transition hover:bg-ink-800/60 @min-[52.5rem]/console:py-2 ${on ? '@min-[52.5rem]/console:bg-accent-soft @min-[52.5rem]/console:before:absolute @min-[52.5rem]/console:before:inset-y-2 @min-[52.5rem]/console:before:start-0 @min-[52.5rem]/console:before:w-[3px] @min-[52.5rem]/console:before:rounded-[2px] @min-[52.5rem]/console:before:bg-accent' : ''}`}>
                        <span aria-hidden className={`grid h-9 w-9 shrink-0 place-items-center rounded-[10px] ring-1 ring-inset ring-white/5 transition-transform group-hover:scale-105 @min-[52.5rem]/console:h-8 @min-[52.5rem]/console:w-8 ${v.tint}`}>{v.icon}</span>
                        <span className="min-w-0 flex-1">
                          <span className={`block truncate text-sm font-medium ${on ? 'text-fog-50 @min-[52.5rem]/console:text-accent' : 'text-fog-100'}`}>{tr(c.label)}</span>
                          {/* One line beside the page, where the list is a rail; two on a phone, where it is the screen. */}
                          {v.summary && <span className="line-clamp-2 block text-[11px] leading-snug text-fog-500 @min-[52.5rem]/console:line-clamp-1">{v.summary}</span>}
                        </span>
                        <IcChevronRight width={16} height={16} aria-hidden className="shrink-0 text-fog-500 transition group-hover:translate-x-0.5 group-hover:text-fog-200 rtl:-scale-x-100 rtl:group-hover:-translate-x-0.5 @min-[52.5rem]/console:hidden" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </motion.div>
          ))}
          {footer}
        </nav>

        {/* ---- the page on screen ---- */}
        <section aria-labelledby={`console-${shownPage.id}-title`} className={`min-w-0 @container/pane ${narrowPane}`} data-console-pane={shownPage.id}
          data-settings-pane={settingsPage ? shownPage.id : undefined}>
          {/* The page's header. On a phone a band of the hero's art, edge to edge, with the Back key under the status bar --
              the hero is the list's, so the page opens under its own. Beside the list on a computer, under the hero, the
              same title in the flow. */}
          <header data-console-header
            className={`relative isolate -mx-4 mb-5 overflow-hidden px-4 pb-5 pt-[max(0.9rem,calc(env(safe-area-inset-top)+0.5rem))] @min-[52.5rem]/console:mx-0 @min-[52.5rem]/console:overflow-visible @min-[52.5rem]/console:p-0 ${view.ownHeader ? '@min-[52.5rem]/console:sr-only' : ''}`}>
            <div aria-hidden className="absolute inset-0 -z-10 @min-[52.5rem]/console:hidden" data-console-header-art>
              {art}
              <div className="absolute inset-0 bg-linear-to-t from-ink-950 via-ink-950/85 to-ink-950/55" />
              <div className="absolute inset-0" style={{ background: 'radial-gradient(80% 120% at var(--start) 0%, rgb(var(--accent) / 0.24), transparent 65%)' }} />
            </div>
            <button type="button" onClick={back} className="btn-key mb-4 gap-1 bg-black/30 backdrop-blur @min-[52.5rem]/console:hidden" data-console-back>
              <IcChevronLeft width={16} height={16} aria-hidden className="rtl:-scale-x-100" />{label}
            </button>
            <div className="flex items-center gap-3.5">
              {/* The page's own colour and mark, as its row in the list wears them. */}
              <span aria-hidden className={`grid h-12 w-12 shrink-0 place-items-center rounded-2xl shadow-lg shadow-black/40 [&_svg]:h-6 [&_svg]:w-6 ${view.tint}`}>{view.icon}</span>
              <div className="min-w-0">
                <h2 ref={heading} id={`console-${shownPage.id}-title`} tabIndex={-1} className="font-display text-2xl font-bold leading-tight text-fog-50 outline-hidden [text-shadow:0_2px_12px_rgba(0,0,0,0.5)] @min-[72rem]/console:text-3xl">
                  {tr(shownPage.label)}
                </h2>
                {(view.description ?? (view.ownHeader ? view.summary : undefined)) && (
                  <p className="mt-1 max-w-prose text-sm text-fog-400">{view.description ?? view.summary}</p>
                )}
              </div>
            </div>
          </header>
          <SettingsGo.Provider value={target}>
            <motion.div key={shownPage.id} initial={reduced ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
              transition={reduced ? { duration: 0 } : { duration: 0.22, ease: [0.22, 0.61, 0.36, 1] }}
              className={settingsPage ? 'grid items-start gap-6 @min-[48rem]/pane:grid-cols-2 @min-[90rem]/pane:grid-cols-3' : undefined}>
              {view.pane}
            </motion.div>
          </SettingsGo.Provider>
        </section>
      </div>
    </div>
    </PresenceContext.Provider>
  );
}

/**
 * The hero's height, eased between full and band (a computer moving between the first page and another) instead of
 * jumping: the list under it slides with it rather than leaping out from under the pointer, and the full hero opens
 * like a curtain. Its inner box is measured and the outer one follows; only the height is clipped, never the sides the
 * hero's bleed reaches into.
 */
function HeroFrame({ reduced, children }: { reduced: boolean; children: ReactNode }) {
  const inner = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = inner.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setHeight(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div className="overflow-y-clip" data-hero-frame
      style={{ height: height ?? undefined, transition: reduced || height === null ? undefined : 'height 0.45s cubic-bezier(0.22, 0.61, 0.36, 1)' }}>
      {/* flow-root: the hero's own margins count in what is measured, rather than collapsing out of it. */}
      <div ref={inner} className="flow-root">{children}</div>
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
