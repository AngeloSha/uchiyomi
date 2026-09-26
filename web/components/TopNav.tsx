'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Lockup } from './Brand';
import { IcHome, IcGrid, IcSearch, IcRefresh, IcBell, IcSparkle, IcPlus, IcBookmark, IcMoments } from './icons';
import { triggerRefresh } from '@/lib/refresh';
import { api } from '@/lib/api';
import { useAuth, canDownload } from '@/lib/auth';
import { Avatar } from './Avatar';
import { HealthMarker } from './HealthAlert';
import { useToast } from './Toast';
import { keys, t as tr } from '@/lib/i18n';

// `keys()` is the identity function; it exists so these reach the translation extractor, which
// cannot see a label rendered as `tr(label)`. This nav shipped untranslated once already.
// See lib/i18n.ts.
// ⚠️ The labels are POSITIONAL indices into that array, so removing one renumbers every entry after it --
// silently, with no type error, relabelling the tabs that follow. Browse came out here; Lists and Discover
// moved from 3,4 to 2,3.
const NAV_LABELS = keys('Home', 'Library', 'Lists', 'Discover');
const links = [
  { href: '/', label: NAV_LABELS[0], Icon: IcHome, match: (p: string) => p === '/' },
  { href: '/library', label: NAV_LABELS[1], Icon: IcGrid, match: (p: string) => p.startsWith('/library') || p.startsWith('/series') },
  { href: '/collections', label: NAV_LABELS[2], Icon: IcBookmark, match: (p: string) => p.startsWith('/collection') },
  { href: '/discover', label: NAV_LABELS[3], Icon: IcPlus, match: (p: string) => p.startsWith('/discover') },
];

export function TopNav({ onSearchFocus }: { onSearchFocus?: () => void }) {
  const path = usePathname();
  const qc = useQueryClient();
  const toast = useToast();
  const { user, status } = useAuth();
  const offline = status === 'offline';
  const [refreshing, setRefreshing] = useState(false);
  // `enabled`, not a conditional call: hooks must run in the same order every render. Offline this would be
  // a request at a dead network, and the browser harness counts every console error.
  const { data: upd } = useQuery({ queryKey: ['updates'], queryFn: () => api<{ content: any[] }>('/api/updates'), staleTime: 120000, enabled: !offline });
  const updCount = upd?.content?.length ?? 0;

  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    toast('Checking for new chapters…');
    await triggerRefresh();
    setTimeout(() => {
      qc.invalidateQueries({ queryKey: ['home'] });
      qc.invalidateQueries({ queryKey: ['library'] });
      toast('Library refreshed', 'success');
      setRefreshing(false);
    }, 1800);
  };

  return (
    <header className="sticky top-0 z-40 hidden border-b border-ink-800/70 bg-ink-950/80 backdrop-blur-xl lg:block">
      <div className="shell flex items-center gap-6 py-3">
        <Link href="/"><Lockup className="text-2xl" markSize={38} /></Link>
        <nav className="flex items-center gap-1">
          {(canDownload(user) ? links : links.filter((l) => l.href !== '/discover')).map(({ href, label, Icon, match }) => {
            const active = match(path);
            return (
              <Link key={href} href={href} aria-disabled={offline || undefined}
                onClick={offline ? (e) => e.preventDefault() : undefined}
                className={`flex items-center gap-2 whitespace-nowrap rounded-full px-3.5 py-2 text-sm font-medium transition ${active ? 'bg-accent-soft text-accent' : 'text-fog-400 hover:text-fog-100'}${offline ? ' pointer-events-none opacity-35' : ''}`}>
                <Icon width={18} height={18} /> {tr(label)}
              </Link>
            );
          })}
        </nav>
        <button type="button" onClick={onSearchFocus}
          className="ms-auto flex w-72 items-center gap-2 rounded-full border border-ink-700 bg-ink-850 px-3.5 py-2 text-start transition hover:border-accent/50">
          <IcSearch width={18} height={18} className="text-fog-500" />
          <span className="w-full text-sm text-fog-500">{tr('Search…')}</span>
          <kbd className="shrink-0 rounded-md border border-ink-700 px-1.5 py-0.5 text-[10px] text-fog-500">⌘K</kbd>
        </button>
        {/* Secondary destination, so it sits in the right-hand cluster with Updates rather than becoming a
            sixth primary nav item -- the five on the left are the shape of the library, and Moments is a
            view of what you saved out of it. */}
        <Link href="/moments" title={tr('Moments')} aria-label={tr('Moments')}
          className={`grid h-10 w-10 place-items-center rounded-full border border-ink-700 transition hover:text-accent ${path.startsWith('/moments') ? 'text-accent' : 'text-fog-300'}`}>
          <IcMoments width={19} height={19} />
        </Link>
        {/* Admins only, and only while the last Health report was not clean (#101). */}
        <HealthMarker />
        <Link href="/updates" title={tr('Updates')} className="relative grid h-10 w-10 place-items-center rounded-full border border-ink-700 text-fog-300 hover:text-accent">
          <IcBell width={19} height={19} />
          {updCount > 0 && <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-accent px-1 text-[10px] font-bold text-black">{updCount > 9 ? '9+' : updCount}</span>}
        </Link>
        <button onClick={refresh} title={tr('Check for new chapters')}
          className={`grid h-10 w-10 place-items-center rounded-full border border-ink-700 text-fog-300 transition hover:text-accent ${refreshing ? 'animate-spin text-accent' : ''}`}>
          <IcRefresh width={19} height={19} />
        </button>
        <Link href="/profile" className="transition hover:opacity-80">
          <Avatar avatar={user?.avatar} size={40} />
        </Link>
      </div>
    </header>
  );
}
