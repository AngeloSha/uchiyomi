'use client';
// Global command palette (Ctrl/Cmd+K, "/", or just start typing): instant series search + quick actions.
// No dependency — a fixed overlay + debounced POST /api/series/search, keyboard-navigable.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AnimatePresence, motion } from 'framer-motion';
import { api, img } from '@/lib/api';
import { Page, Series } from '@/lib/types';
import { triggerRefresh } from '@/lib/refresh';
import { useToast } from './Toast';
import { Img } from './ui';
import { IcSearch, IcSparkle, IcRefresh, IcBell, IcDownload, IcGrid, IcMoments } from './icons';
import { t as tr } from '@/lib/i18n';
import { hiddenOnDesktop, DESKTOP_HIDDEN } from '@/lib/desktop';
import { isTypingTarget, typeToSearchKey } from '@/lib/typeToSearch';

interface Action { key: string; label: string; hint?: string; icon: React.ReactNode; run: () => void | Promise<void> }

export function CommandPalette({ open, seed = '', onClose }: { open: boolean; seed?: string; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Series[]>([]);
  const [searching, setSearching] = useState(false);
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const seq = useRef(0);

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

  const actions: Action[] = useMemo(() => ([
    {
      key: 'surprise', label: 'Surprise me', hint: 'random series', icon: <IcSparkle width={16} height={16} />,
      run: async () => {
        try { const r = await api<{ seriesId: string | null }>('/api/random'); if (r.seriesId) go(`/series/?id=${r.seriesId}`); }
        catch { toast('No luck — try again', 'error'); }
      },
    },
    { key: 'updates', label: 'Updates', hint: 'new chapters', icon: <IcBell width={16} height={16} />, run: () => go('/updates') },
    { key: 'moments', label: 'Moments', hint: 'pages you saved', icon: <IcMoments width={16} height={16} />, run: () => go('/moments') },
    { key: 'downloads', label: 'Offline downloads', icon: <IcDownload width={16} height={16} />, run: () => go('/downloads') },
    // Genres are a filter now, not a page. The palette still gets you there in one keystroke.
    { key: 'genres', label: 'Filter by genre', icon: <IcGrid width={16} height={16} />, run: () => go('/library') },
    {
      key: 'refresh', label: 'Refresh library', hint: 'scan for new chapters', icon: <IcRefresh width={16} height={16} />,
      run: async () => { onClose(); toast('Refreshing…'); await triggerRefresh(); toast('Refresh started', 'success'); },
    },
  ] as Action[]).filter((a) => !hiddenOnDesktop(DESKTOP_HIDDEN.paletteKeys, a.key)), [go, onClose, toast]); // no Offline downloads on desktop (lib/desktop.ts)

  const query = q.trim().toLowerCase();
  const shownActions = query.length < 2 ? actions : actions.filter((a) => a.label.toLowerCase().includes(query) || a.key.includes(query));
  // one flat keyboard list: series first, then actions
  const rows = useMemo(
    () => [
      ...results.map((s) => ({ kind: 'series' as const, series: s })),
      ...shownActions.map((a) => ({ kind: 'action' as const, action: a })),
    ],
    [results, shownActions],
  );
  useEffect(() => { setSel((s) => Math.min(s, Math.max(0, rows.length - 1))); }, [rows.length]);

  const activate = (i: number) => {
    const r = rows[i];
    if (!r) return;
    if (r.kind === 'series') go(`/series/?id=${r.series.id}`);
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
                <p className="px-4 py-3 text-xs text-fog-500">No series match “{q.trim()}”.</p>
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
                      <p className="text-[11px] text-fog-500">{r.series.booksCount} chapters</p>
                    </div>
                  </button>
                ) : (
                  <div key={`a:${r.action.key}`}>
                    {i === results.length && <p className="px-4 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-widest text-fog-600">{tr('Actions')}</p>}
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
 * Global open-palette keybindings: Ctrl/Cmd+K anywhere, "/" when not typing, and type-to-search -- a letter
 * or digit when not typing opens the palette with that character already in it (lib/typeToSearch.ts).
 */
export function usePaletteHotkeys(setOpen: (fn: (o: boolean) => boolean) => void, enabled: boolean, onSeed?: (seed: string) => void) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const typing = isTypingTarget(document.activeElement);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); onSeed?.(''); setOpen((o) => !o); return; }
      if (e.key === '/' && !typing) { e.preventDefault(); onSeed?.(''); setOpen(() => true); return; }
      if (!onSeed) return;
      const ch = typeToSearchKey(e, { typing, modalOpen: !!document.querySelector('[aria-modal="true"]') });
      if (ch) { e.preventDefault(); onSeed(ch); setOpen(() => true); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setOpen, enabled, onSeed]);
}
