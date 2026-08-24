'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { motion } from 'framer-motion';
import { IcHome, IcGrid, IcSearch, IcDownload, IcUser } from './icons';
import { keys, t as tr } from '@/lib/i18n';

// `keys()` is the identity function; it exists so these reach the translation extractor, which
// cannot see a label rendered as `tr(label)`. This nav shipped untranslated once already.
// See lib/i18n.ts.
const NAV_LABELS = keys('Home', 'Library', 'Search', 'Offline', 'You');
const items = [
  { href: '/', label: NAV_LABELS[0], Icon: IcHome, match: (p: string) => p === '/' },
  { href: '/library', label: NAV_LABELS[1], Icon: IcGrid, match: (p: string) => p.startsWith('/library') || p.startsWith('/series') },
  { href: '/search', label: NAV_LABELS[2], Icon: IcSearch, match: (p: string) => p.startsWith('/search') || p.startsWith('/browse') },
  { href: '/downloads', label: NAV_LABELS[3], Icon: IcDownload, match: (p: string) => p.startsWith('/downloads') },
  { href: '/profile', label: NAV_LABELS[4], Icon: IcUser, match: (p: string) => p.startsWith('/profile') || p.startsWith('/settings') || p.startsWith('/admin') },
];

export function BottomNav() {
  const path = usePathname();
  return (
    <nav className="safe-bottom fixed inset-x-0 bottom-0 z-40 lg:hidden">
      <div className="mx-auto max-w-2xl px-4 pb-2">
        <div className="glass grad-border flex items-center justify-around rounded-3xl px-2 py-1.5 shadow-lift">
          {items.map(({ href, label, Icon, match }) => {
            const active = match(path);
            return (
              <Link key={href} href={href} className="group relative flex flex-1 flex-col items-center gap-1 py-2">
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
