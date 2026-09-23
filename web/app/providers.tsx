'use client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useState, ReactNode } from 'react';
import Lenis from 'lenis';
import { effectsReduced, restoreReduceEffects, useReduceEffects } from '@/lib/effects';
import { AuthProvider } from '@/lib/auth';
import { ToastProvider } from '@/components/Toast';
import { I18nProvider } from '@/lib/I18nProvider';
import { flushOutbox } from '@/lib/downloads';

export function Providers({ children }: { children: ReactNode }) {
  const [qc] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          // Refetch when you come back to the tab. Reading is inherently multi-device -- finish a chapter
          // on your phone, pick up the laptop -- and with this off a tab left open all day would happily
          // show you this morning's state forever. There is no manual refresh on desktop either:
          // PullToRefresh is touch-only, so the only escape was reloading the page.
          queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: true, refetchOnReconnect: true },
        },
      }),
  );

  // Real viewport height for the immersive reader (mobile URL-bar proof).
  useEffect(() => {
    const set = () => document.documentElement.style.setProperty('--vh', `${window.innerHeight * 0.01}px`);
    set();
    window.addEventListener('resize', set);
    window.addEventListener('orientationchange', set);
    return () => {
      window.removeEventListener('resize', set);
      window.removeEventListener('orientationchange', set);
    };
  }, []);

  // Register the service worker (PWA + offline) and keep it self-updating — installed iOS PWAs are sticky,
  // so we proactively check for a new worker on launch/foreground and reload once it takes control.
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    let reloaded = false;
    const onController = () => { if (!reloaded) { reloaded = true; window.location.reload(); } };
    navigator.serviceWorker.addEventListener('controllerchange', onController);
    let onVis: (() => void) | null = null;
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      reg.update().catch(() => {});
      onVis = () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); };
      document.addEventListener('visibilitychange', onVis);
    }).catch(() => {});
    return () => {
      navigator.serviceWorker.removeEventListener('controllerchange', onController);
      if (onVis) document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  // The device's copy of Reduce effects, before the first paint of the splash or the sign-in screen. The
  // account's own value replaces it the moment /auth/refresh answers (lib/auth.tsx).
  useLayoutEffect(restoreReduceEffects, []);
  const reduceEffects = useReduceEffects();

  // Momentum scroll on desktop wheel (native touch on mobile; reader opts out via data-lenis-prevent).
  //
  // ⚠️ Not under Reduce effects (#71). Lenis takes the wheel away from the browser and scrolls from a
  // main-thread animation frame loop that never stops, so every main-thread stall becomes a scroll stall --
  // native scrolling runs off the main thread. Keyed on the switch, so turning it on destroys the running
  // instance (destroy() also removes its `lenis` classes) and turning it off starts a fresh one. The store
  // is read again inside because the layout effect above may have changed it after this render was taken.
  // prefers-reduced-motion keeps its own check, unchanged.
  useEffect(() => {
    if (reduceEffects || effectsReduced()) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const lenis = new Lenis({ duration: 1.05, smoothWheel: true });
    let raf = requestAnimationFrame(function loop(t) {
      lenis.raf(t);
      raf = requestAnimationFrame(loop);
    });
    return () => {
      cancelAnimationFrame(raf);
      lenis.destroy();
    };
  }, [reduceEffects]);

  // Capture the Android install prompt + flush the offline progress outbox when back online.
  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      (window as any).__yomiInstall = e;
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    const flush = () => flushOutbox().catch(() => {});
    window.addEventListener('online', flush);
    const t = setTimeout(flush, 4000);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('online', flush);
      clearTimeout(t);
    };
  }, []);

  return (
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <ToastProvider>
          <AuthProvider>{children}</AuthProvider>
        </ToastProvider>
      </I18nProvider>
    </QueryClientProvider>
  );
}
