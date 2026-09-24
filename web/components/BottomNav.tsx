'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { motion } from 'framer-motion';
import { IcHome, IcGrid, IcSearch, IcDownload, IcUser, IcPlus } from './icons';
import { useAuth, canDownload } from '@/lib/auth';
import { keys, t as tr } from '@/lib/i18n';
import { isDesktop, DESKTOP_HIDDEN } from '@/lib/desktop';

// `keys()` is the identity function; it exists so these reach the translation extractor, which
// cannot see a label rendered as `tr(label)`. This nav shipped untranslated once already.
// See lib/i18n.ts.
const NAV_LABELS = keys('Home', 'Library', 'Search', 'Discover', 'Offline', 'You');
const items = [
  { href: '/', label: NAV_LABELS[0], Icon: IcHome, match: (p: string) => p === '/' },
  { href: '/library', label: NAV_LABELS[1], Icon: IcGrid, match: (p: string) => p.startsWith('/library') || p.startsWith('/series') },
  { href: '/search', label: NAV_LABELS[2], Icon: IcSearch, match: (p: string) => p.startsWith('/search') },
  // Discover had no entry here at all, on a phone-first PWA, while being item five of five on the desktop
  // nav. The page that adds new series was reachable only from a small + on the library page.
  { href: '/discover', label: NAV_LABELS[3], Icon: IcPlus, match: (p: string) => p.startsWith('/discover') },
  { href: '/downloads', label: NAV_LABELS[4], Icon: IcDownload, match: (p: string) => p.startsWith('/downloads') },
  { href: '/profile', label: NAV_LABELS[5], Icon: IcUser, match: (p: string) => p.startsWith('/profile') || p.startsWith('/settings') || p.startsWith('/admin') },
];

export function BottomNav() {
  const path = usePathname();
  const { user, status } = useAuth();
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
        <div className="glass grad-border flex items-center justify-around rounded-3xl px-2 py-1.5 shadow-lift">
          {shown.map(({ href, label, Icon, match }) => {
            const active = match(path);
            const dead = offline && href !== '/downloads';
            return (
              <Link key={href} href={href} aria-disabled={dead || undefined}
                onClick={dead ? (e) => e.preventDefault() : undefined}
                className={`group relative flex flex-1 flex-col items-center gap-1 py-2${dead ? ' pointer-events-none opacity-35' : ''}`}>
                {active && (
                  <motion.span layoutId="navpill" className="absolute inset-x-2 inset-y-1 rounded-2xl bg-accent-soft" transition={{ type: 'spring', stiffness: 420, damping: 34 }} />
                )}
                <span className={`relative z-10 transition ${active ? 'text-accent' : 'text-fog-500 group-active:text-fog-300'}`}>
                  <Icon width={22} height={22} />
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
