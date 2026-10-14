'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useReducedMotion } from 'framer-motion';
import { Mark, Wordmark } from './Brand';
import { RingIcon } from './ProgressRing';
import { ringProps } from './DownloadsRing';
import { useHealthSummary, HEALTH_HREF } from './HealthAlert';
import { IcHome, IcGrid, IcBookmark, IcPlus, IcClock, IcMoments, IcDownload, IcShield, IcChevronRight } from './icons';
import { useAuth, canDownload } from '@/lib/auth';
import { keys, t as tr } from '@/lib/i18n';
import { isDesktop, DESKTOP_HIDDEN } from '@/lib/desktop';
import { useLayers } from '@/lib/layers';
import { useReduceEffects } from '@/lib/effects';
import { useDownloadsRing } from '@/lib/useServerDownloads';
import { downloadsHref } from '@/lib/libraryView';
import { alertTone, headlineText } from '@/lib/healthAlert';
import { INTENT_MS } from '@/lib/motion';
import type { NavRing } from '@/lib/serverDownloads';

// The desktop's main menu (UI refresh): a slim rail of icons down the start edge, with the art of a page running
// underneath it, that opens into a labelled panel over the page while the pointer rests on it. It took the place of
// the top bar's links and five of its six round buttons; the top bar keeps search, Updates and the avatar.
//
// Mounted by AppShell from lg up only, so on a phone none of it is in the document: the bottom bar is the phone's.
//
// ⚠️ Not an <aside>, and no `bottom-0`: e2e/i18n.mjs takes the Library's <aside> as its sign the page has drawn, and
// walk49 finds the phone's bar as `nav.fixed.bottom-0`. ⚠️ The labels stay in the document when the rail is closed --
// faded and clipped, never display:none -- because they are the links' accessible names, and i18n.mjs reads the nav
// words out of the page's text. ⚠️ It never registers a `nav` layer: that kind is the phone's bar, measured for the
// notices' band (lib/layers.ts).

// `keys()` is the identity function; it exists so these reach the translation extractor (lib/i18n.ts).
const LABELS = keys('Home', 'Library', 'Lists', 'Discover', 'Reading history', 'Moments', 'Offline', 'Admin');

interface Item {
  href: string;
  label: string;
  Icon: (p: { width?: number; height?: number; className?: string }) => ReactNode;
  match: (p: string) => boolean;
  /** Who sees it: everyone unless said. */
  only?: 'downloaders' | 'admins' | 'browser';
}

const MAIN: Item[] = [
  { href: '/', label: LABELS[0], Icon: IcHome, match: (p) => p === '/' },
  { href: '/library', label: LABELS[1], Icon: IcGrid, match: (p) => p.startsWith('/library') || p.startsWith('/series') },
  { href: '/collections', label: LABELS[2], Icon: IcBookmark, match: (p) => p.startsWith('/collection') },
  { href: '/discover', label: LABELS[3], Icon: IcPlus, match: (p) => p.startsWith('/discover'), only: 'downloaders' },
];
const MORE: Item[] = [
  { href: '/history', label: LABELS[4], Icon: IcClock, match: (p) => p.startsWith('/history') },
  { href: '/moments', label: LABELS[5], Icon: IcMoments, match: (p) => p.startsWith('/moments') },
  // Uchiyomi Desktop has no Offline: the chapters are already on that disk (lib/desktop.ts DESKTOP_HIDDEN).
  { href: '/downloads', label: LABELS[6], Icon: IcDownload, match: (p) => p.startsWith('/downloads'), only: 'browser' },
];
const ADMIN: Item = { href: '/admin', label: LABELS[7], Icon: IcShield, match: (p) => p.startsWith('/admin'), only: 'admins' };

/** What the rail shows, worked out from who is looking: a pure function, so a test can hold it. */
export function sidebarItems(o: { downloader: boolean; admin: boolean; desktop: boolean }): { main: Item[]; more: Item[]; admin: Item | null } {
  const keep = (i: Item) => (i.only === 'downloaders' ? o.downloader : i.only === 'browser'
    ? !(o.desktop && (DESKTOP_HIDDEN.navHrefs as readonly string[]).includes(i.href))
    : true);
  return { main: MAIN.filter(keep), more: MORE.filter(keep), admin: o.admin ? ADMIN : null };
}

/** The `data-downloads-ring` value walk49 reads off the rail's Library link (it was the old round button's). */
export const ringMark = (ring: NavRing): 'idle' | 'active' | 'slow' => (ring.show ? (ring.slow ? 'slow' : 'active') : 'idle');

export function Sidebar() {
  const path = usePathname();
  const { user, status, isAdmin } = useAuth();
  const offline = status === 'offline';
  const downloader = status === 'authed' && canDownload(user);
  const ring = useDownloadsRing();
  const { data: health } = useHealthSummary();
  const tone = alertTone(health);
  const layers = useLayers();
  // Both hooks on every render and in this order (effects.test.ts): `a() || b()` would skip the second.
  const plain = useReduceEffects();
  const still = useReducedMotion();
  const reduced = plain || !!still;

  // Open: the pointer rested on it, focus moved into it, or the key at its foot was pressed (a touch laptop has no
  // hover). Hover opens and closes after a beat, so passing over it on the way to a page's start edge does nothing.
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pinned, setPinned] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const open = hovered || focused || pinned;
  const later = (fn: () => void, ms: number) => { if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(fn, ms); };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  // A page change closes it: the click that navigated is the end of its job.
  useEffect(() => { setPinned(false); setHovered(false); setFocused(false); }, [path]);

  // While a dialog is open the rail steps aside like the rest of the page: dimmed and out of the tab order. Dialogs
  // render inside <main>, which is its own stacking context below this rail, so without this it would stay bright
  // and clickable over every scrim.
  const covered = layers.dialog > 0;

  const { main, more, admin } = sidebarItems({ downloader, admin: isAdmin, desktop: isDesktop() });
  const flagged = admin && tone && health ? `${tr(admin.label)} · ${headlineText(health) ?? tr('Health')}` : null;

  const link = (i: Item, extra?: { badge?: ReactNode; icon?: ReactNode; name?: string; mark?: string; sub?: { text: string; href: string } }) => {
    const active = i.match(path);
    // Offline only Offline leads anywhere; the rest stay in view, inert (as the phone's bar does).
    const dead = offline && i.href !== '/downloads';
    return (
      <div key={i.href}>
        <Link href={i.href} data-nav={i.href === '/' ? 'home' : i.href.slice(1)}
          aria-current={active ? 'page' : undefined} aria-disabled={dead || undefined}
          aria-label={extra?.name}
          {...(extra?.mark ? { 'data-downloads-ring': extra.mark } : {})}
          onClick={dead ? (e) => e.preventDefault() : undefined}
          className={`group relative flex h-12 items-center gap-3 rounded-xl text-sm font-medium transition-colors ${
            active ? 'text-accent' : 'text-fog-400 hover:text-fog-50'}${dead ? ' pointer-events-none opacity-35' : ''}`}>
          {active && <span aria-hidden className="absolute inset-y-2 -start-3 w-0.5 rounded-[1px] bg-accent" />}
          <span className={`relative grid h-12 w-12 shrink-0 place-items-center rounded-xl transition-colors ${
            active ? 'bg-accent-soft' : 'group-hover:bg-white/[0.06]'}`}>
            {extra?.icon ?? <i.Icon width={22} height={22} />}
            {extra?.badge}
          </span>
          <span className={`min-w-0 truncate pe-3 transition-opacity ${open ? 'opacity-100' : 'opacity-0'}${reduced ? ' duration-0' : ' duration-150'}`}>
            {tr(i.label)}
          </span>
        </Link>
        {extra?.sub && open && (
          <Link href={extra.sub.href} className="-mt-1 mb-1 ms-[3.75rem] block truncate pe-3 text-2xs text-fog-500 hover:text-fog-200">
            {extra.sub.text}
          </Link>
        )}
      </div>
    );
  };

  return (
    <div data-sidebar
      className={`fixed inset-y-0 start-0 z-40 w-[var(--rail-w)] transition-opacity${covered ? ' pointer-events-none opacity-40' : ''}`}
      inert={covered || undefined}>
      <nav aria-label={tr('Main menu')}
        onMouseEnter={() => later(() => setHovered(true), INTENT_MS.open)}
        onMouseLeave={() => later(() => setHovered(false), INTENT_MS.close)}
        // Keyboard focus only (:focus-visible): a mouse click focuses the link it clicked, which would hold the panel
        // open on the page it led to.
        onFocus={(e) => { if ((e.target as HTMLElement).matches?.(':focus-visible')) setFocused(true); }}
        onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false); }}
        onKeyDown={(e) => { if (e.key === 'Escape') { setPinned(false); setHovered(false); (document.activeElement as HTMLElement | null)?.blur(); } }}
        className={`absolute inset-y-0 start-0 flex flex-col overflow-hidden px-3 pb-4 pt-3 ${
          open ? 'w-64 border-e border-white/[0.06] glass-strong shadow-lift' : 'w-full rail-scrim'}${
          reduced ? '' : ' transition-[width] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]'}`}>
        {/* Named by the wordmark's own text, faded rather than removed while the rail is closed. */}
        <Link href="/" className="mb-4 flex h-10 shrink-0 items-center gap-3">
          <span aria-hidden className="grid w-12 shrink-0 place-items-center"><Mark size={32} /></span>
          <span className={`transition-opacity ${open ? 'opacity-100' : 'opacity-0'}`}><Wordmark className="text-xl" /></span>
        </Link>
        <div data-lenis-prevent className="-mx-3 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto overflow-x-hidden px-3 hide-scrollbar">
          {main.map((i) => i.href === '/library' && downloader
            ? link(i, {
              mark: ringMark(ring),
              name: ring.show && ring.label ? `${tr(i.label)} · ${ring.label}` : undefined,
              icon: ring.show ? <RingIcon size="nav" {...ringProps(ring)}><i.Icon width={22} height={22} /></RingIcon> : undefined,
              sub: ring.show && ring.label ? { text: `${tr('Server downloads')} · ${ring.label}`, href: downloadsHref() } : undefined,
            })
            : link(i))}
          <div className="my-2 h-px shrink-0 bg-white/[0.06]" aria-hidden />
          {more.map((i) => link(i))}
          <div className="flex-1" />
          {admin && link(admin, {
            name: flagged ?? undefined,
            badge: tone ? <span aria-hidden data-health-mark={tone} className={`absolute end-2 top-2 h-2 w-2 rounded-full ${tone === 'problem' ? 'bg-red-400' : 'bg-amber-300'}`} /> : undefined,
            sub: tone && health ? { text: headlineText(health) ?? tr('Health'), href: HEALTH_HREF } : undefined,
          })}
        </div>
        <button type="button" data-sidebar-expand onClick={() => setPinned((v) => !v)}
          aria-expanded={open} aria-label={open ? tr('Collapse menu') : tr('Expand menu')} title={open ? tr('Collapse menu') : tr('Expand menu')}
          className="mt-2 grid h-10 w-12 shrink-0 place-items-center rounded-xl text-fog-500 transition-colors hover:bg-white/[0.06] hover:text-fog-100">
          <IcChevronRight width={18} height={18} className={`transition-transform rtl:-scale-x-100 ${open ? 'rotate-180' : ''}`} />
        </button>
      </nav>
    </div>
  );
}
