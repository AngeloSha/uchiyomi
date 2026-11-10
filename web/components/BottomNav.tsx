'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useRef } from 'react';
import { motion } from 'framer-motion';
import { IcHome, IcGrid, IcSearch, IcDownload, IcUser, IcPlus } from './icons';
import { useAuth, canDownload } from '@/lib/auth';
import { t as tr } from '@/lib/i18n';
import { isDesktop, DESKTOP_HIDDEN } from '@/lib/desktop';
import { useLayer } from '@/lib/layers';
import { useDownloadsRing } from '@/lib/useServerDownloads';
import { LibraryTabIcon } from './DownloadsRing';
import { PRIMARY_DESTINATIONS, selectedDestination } from '@/lib/hostNavigation/model';

// Labels and route selection are shared with the host navigation presentation model.
const icons = { home: IcHome, library: IcGrid, search: IcSearch, discover: IcPlus, offline: IcDownload, profile: IcUser };
const items = PRIMARY_DESTINATIONS.map(i => ({ ...i, href: i.href.replace(/\/$/, '') || '/', Icon: icons[i.id] }));

export function BottomNav() {
  const path = usePathname();
  const { user, status } = useAuth();
  // On the notices' layer stack (lib/layers.ts): with the nav up, a notice sits above it rather than under it,
  // and while a dialog is open a notice takes the bar's place -- measured, so it covers the bar exactly
  // rather than leaving half of its icons showing above it.
  const barRef = useRef<HTMLDivElement>(null);
  useLayer('nav', true, { ref: barRef });
  // What the server is fetching, on the Library tab (v0.49.0; the floating pill is gone). The tab still leads
  // to the Library -- a destination that changed with the server's state would surprise -- and Downloads is
  // one tap away there. Nothing at all for an account that may not download.
  const ring = useDownloadsRing();
  // Offline, only Downloads leads anywhere: every other tab is assembled from the server. They stay VISIBLE
  // and go inert rather than disappearing -- a nav that loses four of its six items reads as the app having
  // broken, which is the opposite of what an offline mode should communicate.
  const offline = status === 'offline';
  // An account that may not add series has nothing to do on Discover -- every route the page calls is now
  // refused for it -- so the tab is a promise the app cannot keep. The page itself says so if you type it.
  const allowed = canDownload(user) ? items : items.filter((i) => i.href !== '/discover');
  // Uchiyomi Desktop has no Offline tab: the chapters are already on this disk (lib/desktop.ts).
  const shown = isDesktop() ? allowed.filter((i) => !(DESKTOP_HIDDEN.navHrefs as readonly string[]).includes(i.href)) : allowed;
  return (
    <nav className="safe-bottom fixed inset-x-0 bottom-0 z-40 lg:hidden">
      <div className="mx-auto max-w-2xl px-4 pb-2">
        <div ref={barRef} className="glass grad-border flex items-center justify-around rounded-3xl px-2 py-1.5 shadow-lift">
          {shown.map(({ id, href, label, Icon }) => {
            const active = selectedDestination(path) === id;
            const dead = offline && href !== '/downloads';
            const ringed = href === '/library' && ring.show;
            return (
              <Link key={href} href={href} aria-disabled={dead || undefined}
                onClick={dead ? (e) => e.preventDefault() : undefined}
                aria-label={ringed && ring.label ? `${tr(label)} · ${ring.label}` : undefined}
                className={`group relative flex flex-1 flex-col items-center gap-1 py-2${dead ? ' pointer-events-none opacity-35' : ''}`}>
                {active && (
                  <motion.span layoutId="navpill" className="absolute inset-x-2 inset-y-1 rounded-2xl bg-accent-soft" transition={{ type: 'spring', stiffness: 420, damping: 34 }} />
                )}
                <span className={`relative z-10 transition ${active ? 'text-accent' : 'text-fog-500 group-active:text-fog-300'}`}>
                  {ringed ? <LibraryTabIcon ring={ring}><Icon width={22} height={22} /></LibraryTabIcon> : <Icon width={22} height={22} />}
                </span>
                <span className={`relative z-10 whitespace-nowrap text-[10px] font-medium ${active ? 'text-accent' : 'text-fog-500'}`}>{tr(label)}</span>
              </Link>
            );
          })}
        </div>
      </div>
    </nav>
  );
}
