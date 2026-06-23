'use client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState, ReactNode } from 'react';
import Lenis from 'lenis';
import { AuthProvider } from '@/lib/auth';
import { ToastProvider } from '@/components/Toast';
import { flushOutbox } from '@/lib/downloads';

export function Providers({ children }: { children: ReactNode }) {
  const [qc] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 60_000, retry: 1, refetchOnWindowFocus: false },
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

  // Momentum scroll on desktop wheel (native touch on mobile; reader opts out via data-lenis-prevent).
  useEffect(() => {
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
  }, []);

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
      <ToastProvider>
        <AuthProvider>{children}</AuthProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}
