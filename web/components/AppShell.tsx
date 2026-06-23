'use client';
import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { runSmartOffline } from '@/lib/offlineSync';
import { BottomNav } from './BottomNav';
import { TopNav } from './TopNav';
import { LoginScreen } from './LoginScreen';
import { CinematicFX } from './CinematicFX';
import { PageTransition } from './PageTransition';
import { Mark } from './Brand';

function Splash() {
  return (
    <div className="flex min-h-screen-d items-center justify-center">
      <div className="animate-pulse-soft">
        <Mark size={56} />
      </div>
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { status, user } = useAuth();
  const path = usePathname();

  // smart offline: keep favorites' latest unread chapters downloaded
  const so = user?.settings?.smartOffline;
  useEffect(() => {
    if (status !== 'authed' || !so?.enabled) return;
    const go = () => runSmartOffline(so.perSeries || 3).catch(() => {});
    const t = setTimeout(go, 2500);
    const onVis = () => { if (document.visibilityState === 'visible') go(); };
    window.addEventListener('online', go);
    document.addEventListener('visibilitychange', onVis);
    return () => { clearTimeout(t); window.removeEventListener('online', go); document.removeEventListener('visibilitychange', onVis); };
  }, [status, so?.enabled, so?.perSeries]);

  if (status === 'loading') return <Splash />;
  if (status === 'anon') return <LoginScreen />;

  const immersive = path.startsWith('/reader');
  if (immersive) return <>{children}</>;

  return (
    <>
      <CinematicFX />
      <TopNav />
      <main className="relative z-[1] mx-auto max-w-2xl pb-28 lg:max-w-none lg:px-8 lg:pb-12">
        <PageTransition>{children}</PageTransition>
      </main>
      <BottomNav />
    </>
  );
}
