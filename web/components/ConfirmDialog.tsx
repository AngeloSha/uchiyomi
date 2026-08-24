'use client';
// A real confirmation dialog, for the destructive actions the app now has.
//
// Until this, every confirmation in the product was `window.confirm()` and every modal was the same five
// lines of markup copy-pasted, with no Escape handling and no focus management. That was survivable while
// nothing could be destroyed.
//
// `confirmText` asks the user to type the name of what they are about to change. Worth the friction only
// where the action moves other people's data — deleting a series a household is reading, merging two.
import { useEffect, useRef, useState } from 'react';
import { t as tr } from '@/lib/i18n';

export function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Read through a ref so the effect below can depend on nothing. Callers pass `onClose={() => ...}`, a new
  // function identity on every render, so an effect depending on it re-ran after every keystroke.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // Escape closes, and focus starts inside rather than wherever it happened to be.
  //
  // Runs ONCE. It used to re-run whenever `onClose` changed identity, i.e. on every render, i.e. after every
  // character typed into any field in the dialog -- and it focused `input, button, textarea`, whose first
  // match in document order is the ✕ in the header, not the first field. So the first keystroke landed, the
  // rest went to the close button, and the first SPACE activated it and threw the dialog away mid-sentence.
  // Every modal in the app with a text field had this.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current(); };
    document.addEventListener('keydown', onKey);
    // A field if there is one; the close button only when there is nothing to type into.
    const first = ref.current?.querySelector<HTMLElement>('input, textarea, select')
      ?? ref.current?.querySelector<HTMLElement>('button');
    first?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink-950/70 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`glass max-h-[88vh] w-full ${wide ? 'max-w-lg' : 'max-w-md'} overflow-y-auto rounded-2xl border border-ink-700 p-5`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <h3 className="font-display text-lg font-semibold leading-tight">{title}</h3>
          <button onClick={onClose} aria-label={tr('Close')} className="shrink-0 text-fog-500 hover:text-fog-200">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  title,
  body,
  confirmLabel = 'Confirm',
  confirmText,
  danger,
  busy,
  onConfirm,
  onClose,
}: {
  title: string;
  body: React.ReactNode;
  confirmLabel?: string;
  /** When set, the button stays disabled until the user types this exactly. */
  confirmText?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState('');
  const ready = !confirmText || typed.trim() === confirmText.trim();

  return (
    <Modal title={title} onClose={onClose}>
      <div className="text-sm leading-relaxed text-fog-300">{body}</div>
      {confirmText && (
        <>
          <label className="mb-1 mt-4 block text-xs font-semibold uppercase tracking-wider text-fog-500">{tr('Type')}<span className="text-fog-200">{confirmText}</span> to confirm
          </label>
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            className="w-full rounded-lg border border-ink-700 bg-ink-900/60 px-3 py-2 text-sm text-fog-50 outline-none focus:border-accent"
            autoComplete="off"
          />
        </>
      )}
      <div className="mt-4 flex gap-2">
        <button onClick={onClose} className="btn-ghost flex-1 py-2 text-sm">{tr('Cancel')}</button>
        <button
          onClick={onConfirm}
          disabled={!ready || busy}
          className={`flex-1 rounded-full py-2 text-sm font-semibold disabled:opacity-40 ${
            danger ? 'bg-rose-500/90 text-white hover:bg-rose-500' : 'btn-accent'
          }`}
        >
          {busy ? 'Working…' : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

/** Pull the server's human-readable message out of an ApiError, falling back to something useful. */
export const msgOf = (e: any, fallback: string): string => {
  try {
    return JSON.parse(e?.body || '{}').message || fallback;
  } catch {
    return fallback;
  }
};
