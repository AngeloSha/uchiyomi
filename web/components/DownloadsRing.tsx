'use client';
import type { ReactNode } from 'react';
import { RingIcon } from './ProgressRing';
import { IcHourglass } from './icons';
import type { NavRing } from '@/lib/serverDownloads';

/**
 * The Library ring (v0.49.0): what the server is fetching, worn by an icon -- the phone's Library tab and the
 * desktop sidebar's Library item (components/Sidebar.tsx). It replaces the floating pill, which the owner removed.
 *
 * Only a mapper from `navRing` (lib/serverDownloads.ts) to RingIcon's props: the drawing, the squared count and
 * the one motion rule live in components/ProgressRing.tsx. While the slow archive is all that works, the ring
 * is the owner's calm mark -- still, amber, an hourglass in the count's corner -- and never turns.
 */
export function ringProps(ring: NavRing): { progress: NavRing['progress']; count: number; attention: boolean; static: boolean; tone: 'accent' | 'amber'; glyph?: ReactNode } {
  return {
    progress: ring.show ? ring.progress : 'idle',
    count: ring.count,
    attention: ring.attention,
    static: ring.slow,
    tone: ring.slow ? 'amber' : 'accent',
    glyph: ring.slow ? <IcHourglass width={11} height={11} strokeWidth={2.2} /> : undefined,
  };
}

/**
 * The phone's Library tab icon, wearing the ring. The ring, the count and the dot are absolutely placed, and the
 * wrapper is a GRID, so the tab's box is the plain tabs' box: the 22 px icon and nothing else.
 *
 * ⚠️ Never an inline wrapper. The other tabs' icon is a block `<svg>` (Tailwind's preflight), so their icon span
 * has no line box; an inline <span> here opened one, and its strut's descent under the baseline made this tab
 * 6 px taller -- the whole bar grew upward and "Library" sat 3 px below the other labels whenever the ring showed.
 */
export function LibraryTabIcon({ ring, children }: { ring: NavRing; children: ReactNode }) {
  return (
    <span className="grid" data-downloads-ring={ring.show ? (ring.slow ? 'slow' : ring.progress === 'idle' ? 'idle' : 'active') : undefined}>
      <RingIcon size="nav" {...ringProps(ring)}>{children}</RingIcon>
    </span>
  );
}
