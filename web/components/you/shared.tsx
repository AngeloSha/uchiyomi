'use client';
import { t as tr } from '@/lib/i18n';

/** The same chrome as ProfileYou's CARD (kept here so these files do not import the file that composes them). */
export const CARD = 'card grad-border p-4';

export function Card({ id, title, span = '', children }: { id?: string; title: string; span?: string; children: React.ReactNode }) {
  return (
    <div id={id} data-you-insight={id} className={`${CARD} ${span}`}>
      <h2 className="mb-3 font-display text-base font-semibold">{title}</h2>
      {children}
    </div>
  );
}

/** A figure with a caption under it, the Studio's squared tile. */
export function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-ink-700/70 bg-ink-850/50 px-2.5 py-2">
      <p className="truncate text-[10px] text-fog-500">{label}</p>
      <p className="truncate font-display text-base font-semibold tabular-nums text-fog-100">{value}</p>
      {hint && <p className="truncate text-[10px] text-fog-500">{hint}</p>}
    </div>
  );
}

export const Sub = ({ children }: { children: React.ReactNode }) => (
  <p className="mb-1.5 text-[11px] uppercase tracking-widest text-fog-500">{children}</p>
);

export const Empty = ({ children }: { children: React.ReactNode }) => (
  <p className="py-4 text-center text-xs text-fog-500">{children}</p>
);

/** "up 12%" / "down 8%" / "same as usual" as words, so the direction is not carried by a colour alone. */
export function deltaText(pct: number | null): string {
  if (pct == null) return '';
  if (pct === 0) return tr('Same as usual');
  return pct > 0 ? tr('{n}% above', { n: pct }) : tr('{n}% below', { n: -pct });
}

export const shortDate = (ms: number): string => new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: 'UTC' });
export const longDate = (ms: number): string => new Date(ms).toLocaleDateString([], { month: 'long', year: 'numeric', timeZone: 'UTC' });
