'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLayer } from '@/lib/layers';
import { t as tr } from '@/lib/i18n';
import { IcX } from './icons';

/** A stable surface for a diagnostic: no swipe handler, no notice clock, and above the sheet that failed. */
export function ErrorDetailsDialog({ summary, details, onClose }: { summary: string; details: string; onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  const text = useRef<HTMLTextAreaElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const [status, setStatus] = useState<'copied' | 'manual' | null>(null);
  const label = useId();
  const description = useId();
  const diagnostic = `${summary}\n\n${details}`;
  useLayer('dialog', true, { navBandFree: true });
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    close.current?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
      else document.querySelector<HTMLElement>('[role="dialog"]:not([data-error-details]) button')?.focus();
    };
  }, []);

  const select = () => {
    text.current?.focus();
    text.current?.select();
    text.current?.setSelectionRange(0, diagnostic.length);
  };
  const copy = async () => {
    try {
      if (typeof navigator.clipboard?.writeText !== 'function') throw new Error('clipboard_unavailable');
      await navigator.clipboard.writeText(diagnostic);
      setStatus('copied');
    } catch {
      select();
      setStatus('manual');
    }
  };
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div className="fixed inset-0 z-[80] grid place-items-center bg-ink-950/80 p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] backdrop-blur-xs"
      data-error-details-backdrop
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
      onKeyDown={(event) => {
        // Keep Escape inside this dialog; the underlying source sheet has its own document listener.
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
        if (event.key !== 'Tab') return;
        const fields = [...(panel.current?.querySelectorAll<HTMLElement>('button, textarea') ?? [])];
        const first = fields[0]; const last = fields[fields.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}>
      <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={label} aria-describedby={description}
        data-error-details data-lenis-prevent
        className="glass flex max-h-[calc(100dvh-2rem-env(safe-area-inset-bottom))] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-ink-700 p-4 sm:p-5">
        <div className="flex items-start justify-between gap-3">
          <h2 id={label} className="font-display text-lg font-semibold">{tr('Technical details')}</h2>
          <button ref={close} type="button" onClick={onClose} aria-label={tr('Close')}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-fog-400 hover:bg-ink-800 hover:text-fog-100">
            <IcX width={16} height={16} />
          </button>
        </div>
        <p id={description} className="mt-2 break-words text-sm leading-relaxed text-fog-200" dir="auto">{summary}</p>
        <textarea ref={text} readOnly value={diagnostic} aria-label={tr('Technical details')} dir="auto" spellCheck={false}
          data-error-details-text data-lenis-prevent
          className="mt-3 min-h-24 h-[min(52dvh,24rem)] w-full shrink resize-none select-text overflow-auto overscroll-contain rounded-lg border border-ink-700 bg-ink-950/70 p-3 font-mono text-xs leading-relaxed text-fog-200 outline-hidden focus:border-accent [touch-action:pan-y]" />
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" onClick={() => void copy()} className="btn-key btn-key-primary" data-error-copy>{tr('Copy error')}</button>
          <button type="button" onClick={select} className="btn-key" data-error-select>{tr('Select text')}</button>
        </div>
        <p role="status" aria-live="polite" className="mt-2 text-xs leading-relaxed text-fog-400" data-error-copy-status>
          {status === 'copied' ? tr('Copied') : status === 'manual' ? tr('Could not copy automatically. The text is selected; copy it using your device’s controls.') : ''}
        </p>
      </div>
    </div>, document.body,
  );
}
