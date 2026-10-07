'use client';
// Global command palette (Ctrl/Cmd+K, "/", or just start typing): instant series search + quick actions, and since v0.55.4
// the pages and settings a query names (lib/destinations.ts).
// No dependency — a fixed overlay + debounced POST /api/series/search, keyboard-navigable.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { AnimatePresence, motion } from 'framer-motion';
import { api, img } from '@/lib/api';
import { Page, Series } from '@/lib/types';
import { triggerRefresh } from '@/lib/refresh';
import { useToast } from './Toast';
import { Img } from './ui';
import { IcSearch, IcSparkle, IcRefresh, IcBell, IcDownload, IcCloudDownload, IcGrid, IcMoments, IcSettings, IcUser, IcImport } from './icons';
import { t as tr } from '@/lib/i18n';
import { hiddenOnDesktop, isDesktop, DESKTOP_HIDDEN } from '@/lib/desktop';
import { effectsReduced } from '@/lib/effects';
import { arrival, findDestinations, whereText, type Destination } from '@/lib/destinations';
import { isTypingTarget, seedFor, typeToSearchKey, typeToSearchOn } from '@/lib/typeToSearch';
import { useLayer } from '@/lib/layers';
import { canDownload, useAuth } from '@/lib/auth';
import { downloadsHref } from '@/lib/libraryView';

interface Action { key: string; label: string; hint?: string; icon: React.ReactNode; run: () => void | Promise<void> }

export function CommandPalette({ open, seed = '', onClose }: { open: boolean; seed?: string; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const { user, status, isAdmin } = useAuth();
  // What the server is fetching is Library -> Downloads, a view the route behind it opens only to a viewer
  // who may download: nobody else is offered the way in.
  const mayDownload = status === 'authed' && canDownload(user);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Series[]>([]);
  const [searching, setSearching] = useState(false);
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const seq = useRef(0);
  // On the notices' layer stack while open (lib/layers.ts). It stays mounted while closed, hence `open`.
  useLayer('dialog', open);

  // Reset on open (to the typed-to-open character, if any) and focus the input. A layout effect, focusing
  // in the same commit that mounts the input: with type-to-search the NEXT keystroke is usually already on
  // its way, and a deferred focus let it land on <body> and vanish. The timeout stays as a backstop for
  // the enter animation.
  useLayoutEffect(() => {
    if (open) {
      setQ(seed);
      setResults([]);
      setSel(0);
      inputRef.current?.focus();
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]); // seed is read at open time only

  // Focus can leave the box while the palette is open -- a click on a result, Tab. A letter typed then was
  // swallowed: the seed only applies on open, and the global handler below now stands down for an open dialog.
  // It goes into the box instead.
  useEffect(() => {
    if (!open) return;
    const onKeyAnywhere = (e: KeyboardEvent) => {
      if (document.activeElement === inputRef.current || isTypingTarget(document.activeElement)) return;
      const ch = typeToSearchKey(e, { typing: false, modalOpen: false });
      if (!ch) return;
      e.preventDefault();
      setQ((cur) => cur + ch);
      inputRef.current?.focus();
    };
    document.addEventListener('keydown', onKeyAnywhere);
    return () => document.removeEventListener('keydown', onKeyAnywhere);
  }, [open]);

  // debounced instant search
  useEffect(() => {
    if (!open) return;
    const query = q.trim();
    if (query.length < 2) { setResults([]); setSearching(false); return; }
    setSearching(true);
    const my = ++seq.current;
    const t = setTimeout(async () => {
      try {
        const r = await api<Page<Series>>('/api/series/search', { json: { query, size: 12 } });
        if (seq.current === my) setResults(r.content ?? []);
      } catch { if (seq.current === my) setResults([]); }
      if (seq.current === my) setSearching(false);
    }, 250);
    return () => clearTimeout(t);
  }, [q, open]);

  const go = useCallback((href: string) => { onClose(); router.push(href); }, [onClose, router]);
  // A page or a setting (v0.55.4). Another page is a client-side push, and it reads its tab and its `?section=` as it
  // mounts; a card already on this page is scrolled to; this console on another tab is a whole page load, because the
  // console reads `?tab=` once (lib/destinations.ts `arrival`, lib/useTabParam.ts).
  const goTo = useCallback((href: string) => {
    onClose();
    const how = arrival(href, window.location, (id) => !!document.getElementById(id));
    if (how === 'push') router.push(href);
    else if (how === 'load') window.location.assign(href);
    else if (how === 'scroll') {
      const id = new URL(href, window.location.href).searchParams.get('section');
      const still = effectsReduced() || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (id) document.getElementById(id)?.scrollIntoView({ block: 'start', behavior: still ? 'auto' : 'smooth' });
    }
  }, [onClose, router]);

  // Labels and hints through tr(): they are what the list shows and what a typed query is matched against, so
  // an English-only list could neither be read nor found in the reader's language.
  const actions: Action[] = useMemo(() => ([
    {
      key: 'surprise', label: tr('Surprise me'), hint: tr('random series'), icon: <IcSparkle width={16} height={16} />,
      run: async () => {
        try { const r = await api<{ seriesId: string | null }>('/api/random'); if (r.seriesId) go(`/series/?id=${r.seriesId}`); }
        catch { toast(tr('No luck — try again'), 'error'); }
      },
    },
    { key: 'updates', label: tr('Updates'), hint: tr('new chapters'), icon: <IcBell width={16} height={16} />, run: () => go('/updates') },
    { key: 'moments', label: tr('Moments'), hint: tr('pages you saved'), icon: <IcMoments width={16} height={16} />, run: () => go('/moments') },
    // What the SERVER is fetching (v0.49.0), beside this device's copies: two different promises, two entries.
    // Kept on desktop, where it is the only "downloads" there is.
    ...(mayDownload ? [{ key: 'server-downloads', label: tr('Server downloads'), hint: tr('what the server is fetching'), icon: <IcCloudDownload width={16} height={16} />, run: () => go(downloadsHref()) }] : []),
    { key: 'downloads', label: tr('Offline downloads'), icon: <IcDownload width={16} height={16} />, run: () => go('/downloads') },
    // Genres are a filter now, not a page. The palette still gets you there in one keystroke.
    { key: 'genres', label: tr('Filter by genre'), icon: <IcGrid width={16} height={16} />, run: () => go('/library') },
    {
      key: 'refresh', label: tr('Refresh library'), hint: tr('scan for new chapters'), icon: <IcRefresh width={16} height={16} />,
      run: async () => { onClose(); toast(tr('Refreshing…'), 'info', { busy: true, key: 'refresh' }); await triggerRefresh(); toast(tr('Refresh started'), 'success', { key: 'refresh' }); },
    },
  ] as Action[]).filter((a) => !hiddenOnDesktop(DESKTOP_HIDDEN.paletteKeys, a.key)), [go, onClose, toast, mayDownload]); // no Offline downloads on desktop (lib/desktop.ts)

  const query = q.trim().toLowerCase();
  const shownActions = query.length < 2 ? actions : actions.filter((a) => a.label.toLowerCase().includes(query) || a.key.includes(query));
  // v0.55.4: the pages and settings the query names, for two characters or more, admins' only for admins and none of
  // Desktop's missing ones there (lib/destinations.ts).
  const places = useMemo(() => findDestinations(q, { admin: isAdmin, desktop: isDesktop() }), [q, isAdmin]);
  // one flat keyboard list: series first, then pages and settings, then actions
  const rows = useMemo(
    () => [
      ...results.map((s) => ({ kind: 'series' as const, series: s })),
      ...places.map((p) => ({ kind: 'place' as const, place: p })),
      ...shownActions.map((a) => ({ kind: 'action' as const, action: a })),
    ],
    [results, places, shownActions],
  );
  useEffect(() => { setSel((s) => Math.min(s, Math.max(0, rows.length - 1))); }, [rows.length]);

  const activate = (i: number) => {
    const r = rows[i];
    if (!r) return;
    if (r.kind === 'series') go(`/series/?id=${r.series.id}`);
    else if (r.kind === 'place') goTo(r.place.href);
    else r.action.run();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(rows.length - 1, s + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); activate(sel); }
    else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}
          className="fixed inset-0 z-[70] bg-ink-950/70 p-4 pt-[12vh] backdrop-blur-xs" onClick={onClose}>
          <motion.div initial={{ opacity: 0, y: -10, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -8, scale: 0.98 }}
            transition={{ duration: 0.18, ease: [0.22, 0.61, 0.36, 1] }}
            className="glass-strong grad-border mx-auto w-full max-w-xl overflow-hidden rounded-2xl border border-ink-700 shadow-lift"
            // A dialog, said so: screen readers announce it as one, and every global key handler that stands down
            // for an open `aria-modal` (type-to-search among them) now stands down for this one too.
            role="dialog" aria-modal="true" aria-label={tr('Search')}
            onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2.5 border-b border-ink-800 px-4">
              <IcSearch width={17} height={17} className="shrink-0 text-fog-500" />
              <input
                ref={inputRef}
                value={q}
                onChange={(e) => { setQ(e.target.value); setSel(0); }}
                onKeyDown={onKey}
                placeholder={tr('Search series or type a command…')}
                autoCapitalize="none" autoCorrect="off" spellCheck={false}
                className="w-full bg-transparent py-3.5 text-sm text-fog-50 outline-hidden placeholder:text-fog-500"
              />
              <kbd className="hidden shrink-0 rounded-md border border-ink-700 px-1.5 py-0.5 text-[10px] text-fog-500 lg:block">esc</kbd>
            </div>
            <div className="max-h-[52vh] overflow-y-auto py-1.5" data-lenis-prevent>
              {searching && <p className="px-4 py-3 text-xs text-fog-500">{tr('Searching…')}</p>}
              {!searching && query.length >= 2 && results.length === 0 && (
                <p className="px-4 py-3 text-xs text-fog-500">{tr('No series match “{query}”.', { query: `\u2068${q.trim()}\u2069` })}</p>
              )}
              {results.length > 0 && <p className="px-4 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-widest text-fog-600">{tr('Series')}</p>}
              {rows.map((r, i) =>
                r.kind === 'series' ? (
                  <button key={`s:${r.series.id}`} onClick={() => activate(i)} onMouseEnter={() => setSel(i)}
                    className={`flex w-full items-center gap-3 px-4 py-2 text-left ${sel === i ? 'bg-accent-soft' : ''}`}>
                    <div className="h-12 w-8 shrink-0 overflow-hidden rounded-md border border-ink-700">
                      <Img src={img.seriesThumb(r.series.id)} alt="" className="h-full w-full" />
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-sm text-fog-100">{r.series.metadata?.title || r.series.name}</p>
                      <p className="text-[11px] text-fog-500">{r.series.booksCount === 1 ? tr('1 chapter') : tr('{n} chapters', { n: r.series.booksCount })}</p>
                    </div>
                  </button>
                ) : r.kind === 'place' ? (
                  <div key={`p:${r.place.key}`}>
                    {rows[i - 1]?.kind !== 'place' && <p className="px-4 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-widest text-fog-600">{tr('Pages and settings')}</p>}
                    <PlaceRow place={r.place} selected={sel === i} onClick={() => activate(i)} onHover={() => setSel(i)} />
                  </div>
                ) : (
                  <div key={`a:${r.action.key}`}>
                    {rows[i - 1]?.kind !== 'action' && <p className="px-4 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-widest text-fog-600">{tr('Actions')}</p>}
                    <button onClick={() => activate(i)} onMouseEnter={() => setSel(i)}
                      className={`flex w-full items-center gap-3 px-4 py-2.5 text-left ${sel === i ? 'bg-accent-soft' : ''}`}>
                      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-ink-700 text-fog-400">{r.action.icon}</span>
                      <span className="text-sm text-fog-100">{r.action.label}</span>
                      {r.action.hint && <span className="ms-auto text-[11px] text-fog-500">{r.action.hint}</span>}
                    </button>
                  </div>
                ),
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/**
 * A page or a setting (v0.55.4): its name, and where it is ("Admin → Settings") in the reader's language. Exported for
 * the phone search page, which lists the same ones under its series.
 */
export function PlaceRow({ place, selected, onClick, onHover, href }: {
  place: Destination; selected?: boolean; onClick?: () => void; onHover?: () => void; href?: string;
}) {
  const Icon = place.href.startsWith('/admin/import/') ? IcImport : place.href.startsWith('/admin/') ? IcSettings : IcUser;
  const rtl = typeof document !== 'undefined' && document.documentElement.dir === 'rtl';
  const inner = (
    <>
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-ink-700 text-fog-400"><Icon width={16} height={16} /></span>
      <span className="min-w-0 truncate text-sm text-fog-100">{tr(place.label)}</span>
      <span className="ms-auto shrink-0 text-[11px] text-fog-500">{whereText(place, rtl)}</span>
    </>
  );
  const cls = `flex w-full items-center gap-3 px-4 py-2.5 text-start ${selected ? 'bg-accent-soft' : ''}`;
  return href
    ? <Link href={href} data-palette-place={place.key} className={cls}>{inner}</Link>
    : <button type="button" data-palette-place={place.key} onClick={onClick} onMouseEnter={onHover} className={cls}>{inner}</button>;
}

/**
 * Global open-palette keybindings: Ctrl/Cmd+K anywhere, "/" when not typing, and type-to-search -- a letter
 * or digit when not typing opens the palette with that character already in it (lib/typeToSearch.ts).
 */
export function usePaletteHotkeys(setOpen: (fn: (o: boolean) => boolean) => void, enabled: boolean, onSeed?: (seed: string) => void) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const typing = isTypingTarget(document.activeElement);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); onSeed?.(''); setOpen((o) => !o); return; }
      // Single-key shortcuts from here on, which this device can switch off (Profile -> Settings).
      if (!typeToSearchOn()) return;
      if (e.key === '/' && !typing) { e.preventDefault(); onSeed?.(''); setOpen(() => true); return; }
      if (!onSeed) return;
      // An open right-click menu counts as modal (#100): letters typed at it must not open the palette behind it.
      const ch = typeToSearchKey(e, { typing, modalOpen: !!document.querySelector('[aria-modal="true"], [role="menu"]') });
      if (ch) { e.preventDefault(); onSeed(seedFor(ch, document.documentElement.lang)); setOpen(() => true); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setOpen, enabled, onSeed]);
}
