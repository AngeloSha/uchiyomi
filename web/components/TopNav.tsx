'use client';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { IcSearch, IcBell } from './icons';
import { api } from '@/lib/api';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { ProfileMenu } from './ProfileMenu';
import { useChromeOverArt, useScrolledPast } from '@/lib/overArt';
import { t as tr } from '@/lib/i18n';

// The desktop top bar (UI refresh): search, Updates and you. Where to go lives in the sidebar
// (components/Sidebar.tsx) -- the links, Moments, the downloads ring and the Health mark moved there -- and the
// Refresh button became "Check for new chapters" on Updates (components/CheckForNew.tsx).
export function TopNav({ onSearchFocus }: { onSearchFocus?: () => void }) {
  const { status } = useAuth();
  const path = usePathname();
  const offline = status === 'offline';
  // `enabled`, not a conditional call: hooks must run in the same order every render. Offline this would be
  // a request at a dead network, and the browser harness counts every console error.
  const { data: upd } = useQuery({ queryKey: ['updates'], queryFn: () => api<{ content: any[] }>('/api/updates'), staleTime: 120000, enabled: !offline });
  const updCount = upd?.content?.length ?? 0;
  // See-through over a page's art at the top of the window (lib/overArt.ts), glass once the page scrolls.
  const overArt = useChromeOverArt();
  const scrolled = useScrolledPast(24);
  const clear = overArt && !scrolled;

  // ⚠️ IT HAS TO FIT AT 1024 px, in every language: with the sidebar's 72 px the row is 888 px there. The search is
  // the one thing that gives -- it takes what is left, down to its icon -- and the round keys keep their 40 px
  // (`shrink-0`). The button is a size container: the label and the ⌘K hint show only when it has room for them,
  // never as a sliver; the title and the accessible name stay. web/test/e2e/layout.mjs measures the header at
  // 1024 and 1280 px in de and ru. 65 px tall: the 40 px keys, py-3 and the border (--topbar-h).
  return (
    <header data-topbar data-clear={clear || undefined}
      className={`sticky top-0 z-40 hidden border-b transition-colors duration-300 lg:block ${clear ? 'border-transparent bg-transparent' : 'border-ink-800/70 bg-ink-950/80 backdrop-blur-xl'}`}>
      <div className="shell flex items-center gap-3 py-3 xl:gap-6">
        <button type="button" onClick={onSearchFocus} title={tr('Search…')} aria-label={tr('Search…')}
          className="flex min-w-0 max-w-xl flex-1 @container items-center justify-center gap-2 overflow-hidden rounded-xl border border-ink-700 bg-ink-850/80 px-3.5 py-2 text-start transition hover:border-accent/50">
          <IcSearch width={18} height={18} className="shrink-0 text-fog-500" />
          <span data-search-label className="hidden min-w-0 flex-1 truncate text-sm text-fog-500 @[4.5rem]:block">{tr('Search…')}</span>
          <kbd data-search-kbd className="hidden shrink-0 rounded-md border border-ink-700 px-1.5 py-0.5 text-[10px] text-fog-500 xl:@[12rem]:block">⌘K</kbd>
        </button>
        <div className="ms-auto flex shrink-0 items-center gap-3">
          <Link href="/updates" title={tr('Updates')} aria-label={tr('Updates')} className="relative grid h-10 w-10 shrink-0 place-items-center rounded-full border border-ink-700 text-fog-300 transition hover:text-accent">
            <IcBell width={19} height={19} />
            {/* A squared tag: a round one grows into a capsule at "9+". */}
            {updCount > 0 && <span data-updates-count className="absolute -end-1.5 -top-1 grid h-4 min-w-4 place-items-center rounded-[4px] bg-accent px-[3px] text-[10px] font-bold leading-none tabular-nums text-black">{updCount > 9 ? '9+' : updCount}</span>}
          </Link>
          <ProfileMenu active={path.startsWith('/profile')} />
        </div>
      </div>
    </header>
  );
}
