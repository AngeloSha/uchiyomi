'use client';
import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { runSmartOffline } from '@/lib/offlineSync';
import { BottomNav } from './BottomNav';
import { TopNav } from './TopNav';
import { DownloadsIndicator } from './DownloadsIndicator';
import { LoginScreen } from './LoginScreen';
import { DesktopReconnect } from './DesktopReconnect';
import { CinematicFX } from './CinematicFX';
import { PageTransition } from './PageTransition';
import { CommandPalette, usePaletteHotkeys } from './CommandPalette';
import { Mark } from './Brand';
import { IcWifiOff } from './icons';
import { t as tr } from '@/lib/i18n';
import { desktopShell, isDesktop } from '@/lib/desktop';

function Splash() {
  return (
    <div className="flex min-h-screen-d items-center justify-center">
      <div className="animate-pulse-soft">
        <Mark size={56} />
      </div>
    </div>
  );
}

/**
 * What an offline launch shows for the beat between arriving at `/` and landing on the downloads.
 *
 * NOT `children`: `start_url` is `/`, and the home page fires several queries at a dead network the moment
 * it mounts. The browser test harness fails a run on any console error, so rendering it here would either
 * redden every offline run or force the harness to be loosened -- which is how offline assertions go
 * vacuous. The plain link is the fallback for the case where the client-side hop does not happen: it is a
 * real document navigation, which the service worker can answer from its precached shell.
 */
function OfflineLanding() {
  return (
    <div className="flex min-h-screen-d flex-col items-center justify-center gap-4">
      <div className="animate-pulse-soft"><Mark size={56} /></div>
      <a href="/downloads/" className="text-sm text-fog-400 underline">{tr('Open your downloads')}</a>
    </div>
  );
}

/**
 * ⚠️ Names the account. On a shared household tablet this is the one thing the screen must not leave out:
 * offline, the app cannot re-check who you are, so it says who it BELIEVES you are and lets you disagree.
 */
function OfflineBanner({ name }: { name: string }) {
  return (
    <div className="flex items-center justify-center gap-2 bg-ink-800 px-4 py-1.5 text-[11px] text-fog-300">
      <IcWifiOff width={12} height={12} />
      <span>{tr('Offline — showing {name}’s downloads', { name })}</span>
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { status, user } = useAuth();
  const path = usePathname();
  const router = useRouter();
  const [palette, setPalette] = useState(false);
  const [paletteSeed, setPaletteSeed] = useState('');

  /**
   * An offline launch arrives at `/` -- the manifest's `start_url` -- which is a home screen assembled
   * entirely from the server. Send it to the one screen that is built from IndexedDB instead.
   *
   * The trailing slash matters: the export is written with `trailingSlash: true`, and `/downloads` ->
   * `/downloads/` is a redirect the server issues. Offline there is no server to issue it.
   */
  useEffect(() => {
    if (status !== 'offline') return;
    if (path.startsWith('/downloads') || path.startsWith('/reader')) return;
    router.replace('/downloads/');
  }, [status, path, router]);
  // Ctrl/Cmd+K, "/", or just typing, anywhere in the app (reader keeps its own keys; palette skipped there)
  usePaletteHotkeys(setPalette, status === 'authed' && !path.startsWith('/reader'), setPaletteSeed);

  // smart offline: keep favorites' latest unread chapters downloaded. Never on desktop, where "Save offline"
  // is hidden: it would copy chapters already on this disk into the window's storage (lib/desktop.ts).
  const so = user?.settings?.smartOffline;
  useEffect(() => {
    if (status !== 'authed' || !so?.enabled || isDesktop()) return;
    const go = () => runSmartOffline(so.perSeries || 3).catch(() => {});
    const t = setTimeout(go, 2500);
    const onVis = () => { if (document.visibilityState === 'visible') go(); };
    window.addEventListener('online', go);
    document.addEventListener('visibilitychange', onVis);
    return () => { clearTimeout(t); window.removeEventListener('online', go); document.removeEventListener('visibilitychange', onVis); };
  }, [status, so?.enabled, so?.perSeries]);

  if (status === 'loading') return <Splash />;
  // ⚠️ Stays ABOVE the reader hatch below. `anon` means the SERVER refused us -- or that this device has no
  // saved session at all -- and either way the reader must not open: `owner()` would be `'anon'`, so it
  // would be a chrome-less black screen with no pages in it. Reintroduce by moving the reader hatch above
  // this line and an unauthenticated visitor gets exactly that.
  // In the desktop app's own window there is no password to type: DesktopReconnect retries the app's own
  // sign-in instead. Anywhere else, including a browser tab on the desktop app's port, the sign-in screen.
  if (status === 'anon') return desktopShell() ? <DesktopReconnect /> : <LoginScreen />;

  // Reachable for `offline` as well as `authed`: a downloaded chapter is the whole point of opening the app
  // with no network, and everything the reader needs is already in IndexedDB.
  const immersive = path.startsWith('/reader');
  if (immersive) return <>{children}</>;

  // Offline, only the downloads are real. Everything else is built from the server.
  if (status === 'offline' && !path.startsWith('/downloads')) return <OfflineLanding />;

  return (
    <>
      <CinematicFX />
      {status === 'offline' && <OfflineBanner name={user?.displayName || ''} />}
      <TopNav onSearchFocus={() => { setPaletteSeed(''); setPalette(true); }} />
      <main className="shell relative z-[1] pb-28 lg:pb-12">
        <PageTransition>{children}</PageTransition>
      </main>
      <BottomNav />
      {/* Renders nothing unless something is downloading or has failed. */}
      {status === 'authed' && <DownloadsIndicator />}
      {status === 'authed' && <CommandPalette open={palette} seed={paletteSeed} onClose={() => setPalette(false)} />}
    </>
  );
}
