'use client';
import { useState, type ReactNode } from 'react';
import { t as tr } from '@/lib/i18n';

/**
 * One card on the settings board.
 *
 * `summary` is the whole point: three of these (two-factor, API tokens, external readers) are forms nobody
 * opens twice a year sitting above one fact somebody checks often -- "2FA on", "3 tokens". With a summary
 * the card collapses to that fact behind `Manage` and expands in place.
 *
 * Deliberately not an accordion for the whole page: a seventeen-row accordion is still a seventeen-item
 * list, with an extra click on every row.
 */
export function SettingsCard({ title, summary, span = '', defaultOpen, children }: {
  title: string;
  /** the one honest fact the card is worth checking for; its presence is what makes the card collapsible */
  summary?: string;
  /** board span class, e.g. `wide` or `full` */
  span?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const collapsible = summary != null;
  const [open, setOpen] = useState(!collapsible || !!defaultOpen);

  return (
    <div className={`card grad-border p-4 ${span}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-display text-base font-semibold">{title}</h2>
          {collapsible && <p className="mt-0.5 text-xs text-fog-400">{summary}</p>}
        </div>
        {collapsible && (
          <button onClick={() => setOpen((v) => !v)} aria-expanded={open} className="chip shrink-0 gap-1 text-xs">
            {tr('Manage')}
            {/* A down chevron rather than a right one: it rotates instead of pointing, so it needs no mirroring. */}
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
              strokeLinecap="round" strokeLinejoin="round" className={`transition-transform ${open ? 'rotate-180' : ''}`}>
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
        )}
      </div>
      {open && <div className="mt-3">{children}</div>}
    </div>
  );
}
