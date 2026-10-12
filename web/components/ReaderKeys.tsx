'use client';
import { useEffect, useRef, useState } from 'react';
import { t as tr } from '@/lib/i18n';
import { READER_ACTIONS, bindKey, bindable, keyMapFor, normalize, unbindKey, type KeyOverrides, type ReaderAction } from '@/lib/readerKeys';
import { PAD_BUTTONS, bindButton, padMapFor, pressedButton, unbindButton, type PadOverrides } from '@/lib/readerPad';
import { buttonsOf, firstPad, gamepadsAvailable } from '@/lib/useGamepad';

/**
 * Reader → Keys and controller (v0.61.0, this device only): which key and which controller button does what.
 *
 * Every binding is a squared key cap; tapping one takes it off. "Add a key" waits for the next key pressed -- a still
 * line, no animation -- and a key that belonged to another action moves here and says so. Escape cancels a wait (and
 * is never bound: it always leaves the reader, or closes what is open over it); Tab is never bound either. Key caps are
 * left to right whatever the language: they are the keyboard's own marks.
 */

const ACTION_LABEL: Record<ReaderAction, () => string> = {
  next: () => tr('Next page'),
  prev: () => tr('Previous page'),
  pageLeft: () => tr('Page to the left'),
  pageRight: () => tr('Page to the right'),
  nextChapter: () => tr('Next chapter'),
  prevChapter: () => tr('Previous chapter'),
  fullscreen: () => tr('Full screen'),
  menu: () => tr('Show or hide the controls'),
  exit: () => tr('Leave the reader'),
};
export const actionLabel = (a: ReaderAction) => ACTION_LABEL[a]();

/** How keyboards print a key: arrows as arrows, Shift as ⇧, the space bar in the reader's words. */
const CAPS: Record<string, string> = {
  ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', PageUp: 'PgUp', PageDown: 'PgDn', Home: 'Home', End: 'End',
  Enter: '↵', Backspace: '⌫', Delete: 'Del', Insert: 'Ins', Escape: 'Esc',
};
export function capLabel(k: string): string {
  if (k.startsWith('Shift+')) return `⇧${capLabel(k.slice(6))}`;
  if (k === 'Space') return tr('Space');
  return CAPS[k] ?? k;
}
const padLabel = (i: number) => PAD_BUTTONS[i] ?? `#${i}`;

export function ReaderKeys({ mode, keys, pad, padConnected, onKeys, onPad }: {
  mode: 'paged' | 'vertical';
  keys: KeyOverrides;
  pad: PadOverrides;
  padConnected: boolean;
  onKeys: (k: KeyOverrides) => void;
  onPad: (p: PadOverrides) => void;
}) {
  const keyMap = keyMapFor(mode, keys);
  const padMap = padMapFor(pad);
  /** Which action is waiting for a key, or for a button; and what the last binding moved, if anything. */
  const [waitKey, setWaitKey] = useState<ReaderAction | null>(null);
  const [waitPad, setWaitPad] = useState<ReaderAction | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // The latest bindings and writers, read by the waits below without restarting them on every render of the sheet.
  const latest = useRef({ keys, pad, mode, onKeys, onPad });
  latest.current = { keys, pad, mode, onKeys, onPad };
  const secure = gamepadsAvailable();

  // Waiting for a key: the next real key pressed is the binding. Ahead of the reader's own handler (capture phase), so
  // the key does nothing else -- Escape cancels the wait without closing the sheet.
  useEffect(() => {
    if (!waitKey) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Tab') { setWaitKey(null); return; } // focus moves on, as it should
      if (e.ctrlKey || e.altKey || e.metaKey) return; // the browser's and the palette's, never a binding
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); setWaitKey(null); return; }
      const k = normalize(e.key, e.shiftKey);
      if (!bindable(k)) return; // a lone Shift: keep waiting for the key it goes with
      e.preventDefault();
      e.stopImmediatePropagation();
      const r = bindKey(latest.current.keys, latest.current.mode, waitKey, k);
      latest.current.onKeys(r.overrides);
      setNote(r.from ? tr('{key} moved here from {action}', { key: capLabel(k), action: actionLabel(r.from) }) : null);
      setWaitKey(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [waitKey]);

  // Waiting for a button: polled once a frame while waiting, the first button that goes down is the binding.
  useEffect(() => {
    if (!waitPad) return;
    let raf = 0;
    let prev: boolean[] | null = null;
    const tick = () => {
      const p = firstPad();
      if (p) {
        const now = buttonsOf(p);
        const i = prev ? pressedButton(prev, now) : null;
        prev = now;
        if (i != null) {
          const r = bindButton(latest.current.pad, waitPad, i);
          latest.current.onPad(r.overrides);
          setNote(r.from ? tr('{key} moved here from {action}', { key: padLabel(i), action: actionLabel(r.from) }) : null);
          setWaitPad(null);
          return;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [waitPad]);

  const row = (a: ReaderAction, caps: { id: string; label: string; remove: () => void }[], waiting: boolean, add: (() => void) | null, addLabel: string, waitLabel: string) => (
    <li key={a} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 py-1.5">
      <span className="text-sm text-fog-200">{actionLabel(a)}</span>
      <span className="flex flex-wrap items-center justify-end gap-1.5">
        {!caps.length && !waiting && <span className="text-xs text-fog-500">{tr('Not set')}</span>}
        {caps.map((c) => (
          <button key={c.id} type="button" dir="ltr" onClick={c.remove} className="btn-key min-w-8 font-mono"
            aria-label={tr('Remove {key}', { key: c.label })}>{c.label}</button>
        ))}
        {waiting
          ? <span role="status" className="btn-key btn-key-accent">{waitLabel}</span>
          : add && <button type="button" onClick={add} className="btn-key">{addLabel}</button>}
      </span>
    </li>
  );

  return (
    <div data-reader-keys className="space-y-5">
      <section>
        <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-fog-500">{tr('Keyboard')}</h4>
        <ul>
          {READER_ACTIONS.map((a) => row(
            a,
            keyMap[a].map((k) => ({ id: k, label: capLabel(k), remove: () => { setNote(null); onKeys(unbindKey(keys, mode, a, k)); } })),
            waitKey === a,
            () => { setNote(null); setWaitPad(null); setWaitKey(a); },
            tr('Add a key'),
            tr('Press a key…'),
          ))}
        </ul>
        <p className="mt-1 text-[11px] leading-snug text-fog-500">{tr('Esc always leaves the reader, or closes what is open over it. Tab is never bound.')}</p>
      </section>

      <section>
        <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-fog-500">{tr('Controller')}</h4>
        {/* Said plainly: on a plain-http address the browser offers no controller at all, whatever is plugged in. */}
        {!secure ? (
          <p className="text-[11px] leading-snug text-fog-400">{tr('A controller works only on a secure (https) address.')}</p>
        ) : (
          <>
            <ul>
              {READER_ACTIONS.map((a) => row(
                a,
                padMap[a].map((i) => ({ id: String(i), label: padLabel(i), remove: () => { setNote(null); onPad(unbindButton(pad, a, i)); } })),
                waitPad === a,
                padConnected ? () => { setNote(null); setWaitKey(null); setWaitPad(a); } : null,
                tr('Add a button'),
                tr('Press a button…'),
              ))}
            </ul>
            {!padConnected && <p className="mt-1 text-[11px] leading-snug text-fog-500">{tr('Connect a controller and press any of its buttons.')}</p>}
          </>
        )}
      </section>

      {note && <p role="status" className="text-[11px] text-fog-300">{note}</p>}
      <button type="button" onClick={() => { setNote(null); setWaitKey(null); setWaitPad(null); onKeys({}); onPad({}); }} className="btn-key">
        {tr('Reset to defaults')}
      </button>
    </div>
  );
}
