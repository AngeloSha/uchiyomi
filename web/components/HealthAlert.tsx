'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { t as tr } from '@/lib/i18n';
import { alertTone, bannerWanted, readSeen, writeSeen, type HealthSummary } from '@/lib/healthAlert';
import { IcAlert } from './icons';

// lib/healthAlert.ts says what this is for and why it never runs the checks itself (#101).

const HEALTH_HREF = '/admin/?tab=Health';

/** The stored summary, for admins only. `enabled`, not a conditional hook: the order of hooks must not change. */
export function useHealthSummary() {
  const { isAdmin, status } = useAuth();
  return useQuery({
    queryKey: ['health-summary'],
    queryFn: () => api<{ summary: HealthSummary | null }>('/api/admin/health/summary').then((r) => r.summary),
    enabled: isAdmin && status === 'authed',
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });
}

const countLine = (n: number) => (n === 1 ? tr('1 check found something') : tr('{n} checks found something', { n }));

/** The header's marker: present only while the last report was not clean, beside the Updates bell. */
export function HealthMarker() {
  const { data } = useHealthSummary();
  const tone = alertTone(data);
  if (!tone || !data) return null;
  // The worst check's own sentence, so the header says "3 chapters across 2 sources keep failing" rather
  // than "problems found".
  const label = `${countLine(data.count)}${data.headline ? ` — ${data.headline}` : ''}`;
  return (
    <Link href={HEALTH_HREF} title={label} aria-label={label}
      className={`relative grid h-10 w-10 place-items-center rounded-full border border-ink-700 transition hover:border-accent/50 ${tone === 'problem' ? 'text-red-400' : 'text-amber-300'}`}>
      <IcAlert width={19} height={19} />
      <span className={`absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full ${tone === 'problem' ? 'bg-red-400' : 'bg-amber-300'}`} />
    </Link>
  );
}

/** Once per finding set, on any page but the admin console, at every screen size (the header is desktop-only). */
export function HealthBanner() {
  const { data } = useHealthSummary();
  const path = usePathname();
  // Read after mount: storage is not there during the static export's render.
  const [seen, setSeen] = useState<string | null | undefined>(undefined);
  useEffect(() => { setSeen(readSeen()); }, []);
  if (seen === undefined || !data || !bannerWanted(data, seen, path)) return null;
  const tone = alertTone(data)!;
  const dismiss = () => { writeSeen(data.key); setSeen(data.key); };
  return (
    <div role="status" data-health-banner
      className={`relative z-[2] flex flex-wrap items-center justify-center gap-x-3 gap-y-1 px-4 py-2 text-xs ${tone === 'problem' ? 'bg-red-500/10 text-red-200' : 'bg-amber-400/10 text-amber-100'}`}>
      <IcAlert width={14} height={14} className="shrink-0" />
      <span className="min-w-0">{data.headline ?? countLine(data.count)}</span>
      {data.count > 1 && <span className="text-fog-400">{countLine(data.count)}</span>}
      <Link href={HEALTH_HREF} onClick={dismiss} className="font-semibold underline-offset-2 hover:underline">{tr('Take a look')}</Link>
      <button type="button" onClick={dismiss} className="text-fog-400 hover:text-fog-100">{tr('Not now')}</button>
    </div>
  );
}
