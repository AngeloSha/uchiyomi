'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { t as tr } from '@/lib/i18n';
import { brokenTrackers, reconnectSignature, useTrackers } from '@/lib/trackerHealth';
import { IcAlert } from './icons';

/** Where a person repairs a connection: Profile → Connections → Progress tracking. */
export const TRACKER_FIX_HREF = '/profile/?tab=Connections&card=tracking';
const SEEN_KEY = 'yomi.trackerAlertSeen';

/**
 * A line above the page (#246, @Squeaks72), for the signed-in person only, while one of THEIR tracker connections needs
 * a new token (lib/trackerHealth.ts: rejected, lapsed or unreadable -- never a rate limit or an outage). Health's line,
 * in its slot and its look: `safe-top` (AppShell's banner stack keeps it for the first line only), the rail's offset on
 * a desktop, Reconnect to the row and Not now, which holds until the connections break in another way. Not on Profile,
 * where the row says it.
 */
export function TrackerAlert() {
  // Five minutes: one small request when a session starts, not on every page.
  const { data } = useTrackers({ staleTime: 5 * 60_000 });
  const path = usePathname() || '';
  // Read after mount: storage is not there during the static export's render.
  const [seen, setSeen] = useState<string | null | undefined>(undefined);
  useEffect(() => { try { setSeen(localStorage.getItem(SEEN_KEY)); } catch { setSeen(null); } }, []);
  const broken = brokenTrackers(data);
  const sig = reconnectSignature(broken);
  if (seen === undefined || !broken.length || seen === sig || path.startsWith('/profile')) return null;
  const names = broken.map((t) => `\u2068${t.label || t.provider}\u2069`).join(', ');
  const dismiss = () => { try { localStorage.setItem(SEEN_KEY, sig); } catch { /* private mode: this visit only */ } setSeen(sig); };
  return (
    <div role="status" data-tracker-alert
      className="safe-top relative z-[1] flex flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-amber-400/10 px-4 pb-2 text-xs text-amber-100 lg:ps-[calc(var(--rail-w)+1rem)] lg:pt-2">
      <IcAlert width={14} height={14} className="shrink-0" />
      <span className="min-w-0">{tr('Your token for {names} no longer works. Reconnect to keep your progress in sync.', { names })}</span>
      <Link href={TRACKER_FIX_HREF} onClick={dismiss} className="font-semibold underline-offset-2 hover:underline" data-tracker-reconnect>{tr('Reconnect')}</Link>
      <button type="button" onClick={dismiss} className="text-fog-400 hover:text-fog-100" data-tracker-not-now>{tr('Not now')}</button>
    </div>
  );
}
