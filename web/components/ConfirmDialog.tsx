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
  //
  // And focus goes BACK when the dialog goes: the element that opened it is read before the first field
  // takes focus, and re-focused in the cleanup. Without that, Escape or Cancel on the "Delete read
  // chapters" confirm left focus on <body>, and the next Tab started from the top of the admin console. An
  // opener the confirm action has since removed (a revoked row) ignores the call, which is the right answer.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current(); };
    document.addEventListener('keydown', onKey);
    // A field if there is one; the close button only when there is nothing to type into.
    const first = ref.current?.querySelector<HTMLElement>('input, textarea, select')
      ?? ref.current?.querySelector<HTMLElement>('button');
    first?.focus();
    return () => { document.removeEventListener('keydown', onKey); opener?.focus(); };
  }, []);

  // ⚠️ Clear of the phone's bottom nav. The nav is a root-level sibling above `main` (z-40 over this
  // z-50-inside-main), so it paints over the bottom 5.5 rem of anything here: with a panel capped at 88vh
  // the last row of a tall dialog -- the add dialog's "Add to library", scrolled to the end -- sat under
  // the bar, with 9 to 20 px of the button reachable at 390×740 and the bar's own link under its centre at
  // 667. Below `lg` (where BottomNav.tsx hides itself) the backdrop keeps the bar's band free and the panel
  // is capped at the viewport minus that band and the top padding (7.5 rem = 5.5 + 1 + 1); from `lg` up it
  // is the centred 88vh dialog it always was. The same 5.5 rem the Sheet's `overBottomNav` uses.
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink-950/70 p-4 pb-[calc(5.5rem+env(safe-area-inset-bottom))] backdrop-blur-xs lg:pb-4" onClick={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`glass max-h-[calc(100dvh-7.5rem-env(safe-area-inset-bottom))] w-full lg:max-h-[88vh] ${wide ? 'max-w-lg' : 'max-w-md'} overflow-y-auto rounded-2xl border border-ink-700 p-5`}
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
  // Compared the way a person types: trimmed and in NFC. A title read off a macOS-written share is NFD
  // ("Cafe" + a combining accent) while every keyboard produces the precomposed "Café", and byte for byte
  // those never match -- the button never enabled and the route (which normalises the same way) was never
  // reached. Reintroduce by comparing `.trim()` alone: "the typed confirmation compares in NFC" in
  // forgetSeries.test.ts.
  const ready = !confirmText || typed.trim().normalize('NFC') === confirmText.trim().normalize('NFC');
  // ONE sentence with the title inside it, split around the placeholder so the title can carry its own
  // colour. `tr('Type')` + title + a literal " to confirm" read "TYPGONE FOR GOOD TO CONFIRM" in German
  // and "النوعGONE…" in Arabic: 'Type' translated as the noun (Typ, النوع = "the kind"), no space before
  // the title, and the tail in English regardless of language. A sentence key translates as a sentence.
  const [before, after] = tr('Type {title} to confirm').split('{title}');

  return (
    <Modal title={title} onClose={onClose}>
      <div className="text-sm leading-relaxed text-fog-300">{body}</div>
      {confirmText && (
        <>
          <label className="mb-1 mt-4 block text-xs font-semibold uppercase tracking-wider text-fog-500">
            {before}<span className="text-fog-200">{confirmText}</span>{after}
          </label>
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            className="w-full rounded-lg border border-ink-700 bg-ink-900/60 px-3 py-2 text-sm text-fog-50 outline-hidden focus:border-accent"
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
          {busy ? tr('Working…') : confirmLabel}
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
