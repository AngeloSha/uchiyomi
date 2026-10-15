'use client';
import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { t as tr } from '@/lib/i18n';
import { useLayer } from '@/lib/layers';
import { READER_ACTIONS, type KeyMap } from '@/lib/readerKeys';
import { actionLabel, capLabel } from '@/components/ReaderKeys';
import { IcX } from '@/components/icons';

/**
 * Whether this device has a keyboard worth advertising: a pointer that hovers and is fine, which is a computer and not a phone.
 * False until mounted, so the static export and the first paint show no button a phone would then have to take away.
 */
export function useHasKeyboard(): boolean {
  const [has, setHas] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia?.('(hover: hover) and (pointer: fine)');
    if (!mq) return;
    const read = () => setHas(mq.matches);
    read();
    mq.addEventListener?.('change', read);
    return () => mq.removeEventListener?.('change', read);
  }, []);
  return has;
}

/** One line: the key caps on the left, what they do on the right. */
function Line({ caps, label }: { caps: string[]; label: string }) {
  return (
    <li className="flex items-center justify-between gap-4 py-2">
      <span className="text-sm text-fog-200">{label}</span>
      <span className="flex shrink-0 flex-wrap justify-end gap-1.5" dir="ltr">
        {caps.map((c) => <kbd key={c} className="min-w-7 rounded-md border border-ink-600 bg-ink-800 px-2 py-1 text-center text-xs text-fog-200">{c}</kbd>)}
      </span>
    </li>
  );
}

/**
 * The reader's keyboard shortcuts, as they are bound on this device right now (keyMap already holds the device's own
 * rebindings, lib/readerKeys.ts keyMapFor), with the ones that are not rebindable (Esc and ?) beside them. Opened from the toolbar's keyboard
 * button or by pressing ?. Escape, ? and the backdrop close it; the reader's key handler owns the first two (app/reader/page.tsx).
 */
export function ReaderShortcuts({ keyMap, onClose }: { keyMap: KeyMap; onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null);
  useLayer('dialog', true, { ref: panelRef });
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => opener?.focus?.();
  }, []);
  const bound = READER_ACTIONS.filter((a) => a !== 'exit' && keyMap[a].length > 0);
  return (
    <motion.div className="fixed inset-0 z-50 grid place-items-center px-4" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div ref={panelRef} role="dialog" aria-modal="true" aria-label={tr('Keyboard shortcuts')} tabIndex={-1} data-lenis-prevent
        className="relative max-h-[85dvh] w-full max-w-md overflow-y-auto overscroll-contain rounded-3xl border border-ink-700 bg-ink-900/95 px-5 py-4 backdrop-blur-xl focus-visible:outline-none">
        <div className="mb-1 flex items-center justify-between">
          <h2 className="font-display text-lg font-semibold">{tr('Keyboard shortcuts')}</h2>
          <button onClick={onClose} aria-label={tr('Close')} className="grid h-8 w-8 place-items-center text-fog-500 hover:text-fog-200"><IcX width={20} height={20} aria-hidden /></button>
        </div>
        <ul className="divide-y divide-ink-800">
          {bound.map((a) => <Line key={a} caps={keyMap[a].map(capLabel)} label={actionLabel(a)} />)}
          <Line caps={[capLabel('Escape')]} label={actionLabel('exit')} />
          <Line caps={['?']} label={tr('Show this list')} />
        </ul>
        <p className="mt-3 text-[11px] leading-snug text-fog-500">
          {tr('With the mouse: double-click zooms in and out. Change the keys in Reader settings.')}
        </p>
      </div>
    </motion.div>
  );
}
