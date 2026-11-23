'use client';
import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth, canDownload } from '@/lib/auth';
import { useDownloadsRing } from '@/lib/useServerDownloads';
import { useLayers } from '@/lib/layers';
import { keys, t as tr } from '@/lib/i18n';
import { navigationPresentation, type NavigationAppearance } from '@/lib/hostNavigation/model';
import { navigationTransport } from '@/lib/hostNavigation/ios';
import { useHostNavigation } from '@/lib/hostNavigation/useHostNavigation';
import { readNavigationAppearance, rasterizeNavigationIcons } from '@/lib/hostNavigation/artwork';
import { IcHome, IcGrid, IcSearch, IcPlus, IcDownload, IcUser, IcBookmark, IcClock, IcMoments, IcBell, IcShield, IcMore } from './icons';

// These are the actual web glyphs, not copies of their paths or native system-symbol substitutes.
export const NAVIGATION_ICONS = {
  home: IcHome, library: IcGrid, search: IcSearch, discover: IcPlus, offline: IcDownload, profile: IcUser,
  lists: IcBookmark, history: IcClock, moments: IcMoments, updates: IcBell, admin: IcShield, more: IcMore,
};
const LABELS = keys('More');

/** The web owns destinations, permissions and appearance; the host only presents them. */
export function HostNavigation() {
  const { status, user } = useAuth();
  const path = usePathname(), router = useRouter(), ring = useDownloadsRing(), layers = useLayers();
  const artwork = useRef<HTMLDivElement>(null);
  const [appearance, setAppearance] = useState<NavigationAppearance>();
  useEffect(() => {
    if (!navigationTransport() || !artwork.current) return;
    let live = true;
    const root = document.documentElement;
    let icons: Record<string, string> | undefined;
    const update = () => {
      if (live && icons) setAppearance({ ...readNavigationAppearance(), icons, moreLabel: tr(LABELS[0]) });
    };
    // Rasterize once per document at 3x. Native treats these bounded PNGs as tintable templates.
    void rasterizeNavigationIcons(artwork.current).then(value => { icons = value; update(); }).catch(() => {});
    const observer = new MutationObserver(update);
    observer.observe(root, { attributes: true, attributeFilter: ['style', 'class', 'data-tone', 'lang', 'dir'] });
    return () => { live = false; observer.disconnect(); };
  }, []);
  const state = navigationPresentation({ path, auth: status, downloader: canDownload(user), admin: user?.role === 'admin', ring, blocked: layers.dialog > 0 });
  state.appearance = appearance;
  useHostNavigation(state, { account: user?.id ?? null, navigate: href => router.push(href) });
  return <div ref={artwork} hidden aria-hidden="true" data-navigation-artwork>
    {Object.entries(NAVIGATION_ICONS).map(([id, Icon]) => <Icon key={id} data-navigation-icon={id} />)}
  </div>;
}
