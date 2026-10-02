'use client';
// The small pieces Admin → Extensions' rows and sheets share (v0.53.0): an extension's icon, its marks, a busy key.
import { useState, type ReactNode } from 'react';
import { t as tr } from '@/lib/i18n';
import type { CatalogExt } from '@/lib/extensions';
import { ProgressRing } from '@/components/ProgressRing';

/** An extension's icon, served by Uchiyomi (the engine is not reachable from a browser), or its initial on a tile. */
export function ExtIcon({ url, name, size = 40 }: { url: string | null; name: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  const box = { width: size, height: size };
  if (!url || failed) {
    return (
      <span aria-hidden style={box} className="grid shrink-0 place-items-center rounded-xl border border-ink-600 bg-ink-800 font-display text-sm font-semibold text-fog-300">
        {[...name.trim()][0]?.toUpperCase() ?? '?'}
      </span>
    );
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt="" width={size} height={size} loading="lazy" onError={() => setFailed(true)} style={box} className="shrink-0 rounded-xl bg-ink-800 object-cover" />;
}

/** The small marks after an extension's name: 18+, and no longer in any repository. Squared tags, never capsules. */
export function ExtTags({ e }: { e: Pick<CatalogExt, 'nsfw' | 'obsolete'> }) {
  return (
    <>
      {/* dir="ltr": in an Arabic line the "+" of a bare "18+" printed on the wrong side ("+18"). */}
      {e.nsfw && <span dir="ltr" className="shrink-0 rounded-[4px] border border-red-400/30 px-1 text-[10px] font-semibold leading-[15px] text-red-300">18+</span>}
      {e.obsolete && (
        <span className="shrink-0 rounded-[4px] border border-amber-400/30 px-1 text-[10px] font-medium leading-[15px] text-amber-300">{tr('Not in any repository')}</span>
      )}
    </>
  );
}

/**
 * A busy key stays at full strength: it is disabled so it cannot be pressed twice, and `.btn-key`'s disabled fade
 * made the turning ring and its words read as a key that does nothing.
 */
export const busyKey = (busy: boolean): string => (busy ? 'disabled:opacity-100' : '');

/** A key's busy face: a small turning ring (still under Reduce effects or reduced motion) and what it is doing. */
export function Busy({ children, tone = 'accent' }: { children: ReactNode; tone?: 'accent' | 'amber' | 'muted' | 'red' }) {
  return <><ProgressRing progress="spin" size={14} tone={tone} />{children}</>;
}
