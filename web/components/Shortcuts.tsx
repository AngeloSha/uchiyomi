'use client';
import { useEffect, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Modal } from './ConfirmDialog';
import { t as tr } from '@/lib/i18n';
import { CHORD_MS, chords, shortcutKeyOk, type ShortcutCtx } from '@/lib/shortcuts';
import { isTypingTarget, seedFor, typeToSearchOn } from '@/lib/typeToSearch';

/**
 * "g" then a letter navigates (g h Home, g l Library, g s Search ...) and "?" opens the cheat sheet.
 *
 * Standing down is the point of the guards: not in the reader (`enabled` is false there, as it is for the palette's
 * hotkeys), not while typing in an input / textarea / select / contentEditable, not under an open dialog or menu,
 * not with Ctrl/Cmd/Alt held, and not at all when the device has switched single-key shortcuts off (Profile ->
 * Settings, WCAG 2.1.4 -- the same switch as type-to-search).
 *
 * ⚠️ "g" is also a letter a title can start with, and a bare letter opens the palette with it already typed
 * (components/CommandPalette.tsx usePaletteHotkeys). This handler runs in the capture phase and takes the "g"; if
 * the next key is not a chord, or none comes within CHORD_MS, the palette opens with what was typed ("g", "gu...") --
 * so searching for "gundam" still works, one beat later.
 */
export function useGoShortcuts({ enabled, ctx, onHelp, onSearch }: {
  enabled: boolean; ctx: ShortcutCtx; onHelp: () => void; onSearch: (seed: string) => void;
}) {
  const router = useRouter();
  const list = useMemo(() => chords(ctx), [ctx.admin, ctx.mayDownload, ctx.desktop]); // eslint-disable-line react-hooks/exhaustive-deps
  // Latest callbacks without re-binding the listener on every render.
  const live = useRef({ onHelp, onSearch, list, router });
  live.current = { onHelp, onSearch, list, router };

  useEffect(() => {
    if (!enabled) return;
    let pending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const lang = () => document.documentElement.lang;
    const clear = () => { pending = false; if (timer) clearTimeout(timer); timer = undefined; };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') return;
      const ok = shortcutKeyOk(e, { typing: isTypingTarget(document.activeElement), modalOpen: !!document.querySelector('[aria-modal="true"], [role="menu"]') });
      if (!ok || !typeToSearchOn()) { clear(); return; }
      if (pending) {
        clear();
        const hit = live.current.list.find((c) => c.key === e.key.toLowerCase());
        const letter = e.key.length === 1 && /^[\p{L}\p{N}]$/u.test(e.key);
        // Anything else (Escape, Tab, an arrow) was not meant for us: it goes on to the page.
        if (!hit && !letter) return;
        e.preventDefault();
        e.stopPropagation();
        if (hit) live.current.router.push(hit.href);
        // Not a chord: it was the start of a title. Hand both letters to the palette.
        else live.current.onSearch(seedFor('g', lang()) + seedFor(e.key, lang()));
        return;
      }
      if (e.key === 'g') {
        e.preventDefault();
        e.stopPropagation();
        pending = true;
        timer = setTimeout(() => { clear(); live.current.onSearch(seedFor('g', lang())); }, CHORD_MS);
      } else if (e.key === '?') {
        e.preventDefault();
        live.current.onHelp();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => { window.removeEventListener('keydown', onKey, true); clear(); };
  }, [enabled]);
}

/** The cheat sheet: every chord this account has, and the other keys. */
export function ShortcutsDialog({ ctx, onClose }: { ctx: ShortcutCtx; onClose: () => void }) {
  const list = chords(ctx);
  const kbd = 'rounded-md border border-ink-700 bg-ink-850 px-1.5 py-0.5 font-mono text-xs text-fog-100';
  const other: [string[], string][] = [
    [['Ctrl', 'K'], tr('Search and commands')],
    [['/'], tr('Search and commands')],
    [['?'], tr('This list')],
    [['Esc'], tr('Close a dialog')],
  ];
  return (
    <Modal title={tr('Keyboard shortcuts')} onClose={onClose}>
      <div data-shortcuts className="max-h-[60vh] space-y-4 overflow-y-auto" data-lenis-prevent>
        <div>
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-fog-400">{tr('Go to')}</p>
          <ul className="grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
            {list.map((c) => (
              <li key={c.key} className="flex items-center justify-between gap-3 text-sm text-fog-100">
                <span className="min-w-0 truncate">{c.label}</span>
                <span className="flex shrink-0 items-center gap-1"><kbd className={kbd}>g</kbd><kbd className={kbd}>{c.key}</kbd></span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-fog-400">{tr('Anywhere')}</p>
          <ul className="space-y-1.5">
            {other.map(([ks, what], i) => (
              <li key={i} className="flex items-center justify-between gap-3 text-sm text-fog-100">
                <span>{what}</span>
                <span className="flex shrink-0 items-center gap-1">{ks.map((k) => <kbd key={k} className={kbd}>{k}</kbd>)}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-fog-400">{tr('Typing a letter with nothing selected also starts a search. Single-key shortcuts can be switched off in Profile → Settings.')}</p>
        </div>
      </div>
    </Modal>
  );
}
