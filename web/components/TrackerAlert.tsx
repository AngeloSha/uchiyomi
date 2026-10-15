'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { t as tr } from '@/lib/i18n';
import { brokenTrackers, useTrackers } from '@/lib/trackerHealth';
import { IcAlert } from './icons';

/** Where a person repairs a connection: Profile → Connections → Progress tracking. */
export const TRACKER_FIX_HREF = '/profile/?tab=Connections&card=tracking';

/**
 * A line above the page, for the signed-in person only, while one of THEIR tracker connections needs reconnecting
 * (rejected, failing or expired). Health (admin) lists these for the whole house; this is the same finding for the
 * account it belongs to, with the way to fix it. No dismissal: it goes when the connection does.
 */
export function TrackerAlert() {
  const { data } = useTrackers();
  const path = usePathname() || '';
  const broken = brokenTrackers(data);
  if (!broken.length || path.startsWith('/profile')) return null;
  const names = broken.map((t) => t.label || t.provider).join(', ');
  return (
    <div role="status" data-tracker-alert className="relative z-[1] flex flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-amber-400/10 px-4 py-1.5 text-xs text-amber-100">
      <IcAlert width={14} height={14} className="shrink-0" />
      <span dir="auto" className="min-w-0">{tr('Your tracker connection needs attention: {names}', { names })}</span>
      <Link href={TRACKER_FIX_HREF} className="inline-flex min-h-6 items-center font-semibold underline-offset-2 hover:underline">{tr('Reconnect')}</Link>
    </div>
  );
}
