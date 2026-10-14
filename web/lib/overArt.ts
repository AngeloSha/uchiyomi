'use client';
// Art under the chrome (UI refresh). A page whose art starts at the top of the window -- Home's hero, a series'
// banner -- says so while it is mounted, and the desktop top bar draws itself see-through over it until the page
// scrolls; after that it is the usual glass, so text never scrolls under a clear bar. A counter rather than a flag:
// a page change mounts the next page's art before the last one's leaves.
import { useEffect, useState, useSyncExternalStore } from 'react';

let count = 0;
const subs = new Set<() => void>();
const emit = () => { for (const f of subs) f(); };
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };

/** One page's "my art runs under the top bar", until the returned function takes it back. */
export function enterArt(): () => void {
  count++; emit();
  let left = false;
  return () => { if (left) return; left = true; count--; emit(); };
}

/** Whether any page has art under the top bar right now. */
export const overArtNow = (): boolean => count > 0;

/** Say "my art runs under the top bar" while `active`. */
export function useArtUnderChrome(active = true): void {
  useEffect(() => (active ? enterArt() : undefined), [active]);
}

/** Whether a page has art under the top bar right now. */
export function useChromeOverArt(): boolean {
  return useSyncExternalStore(subscribe, overArtNow, () => false);
}

/** Whether the window has scrolled past `px`: the bar turns back to glass from there. */
export function useScrolledPast(px: number): boolean {
  const [past, setPast] = useState(false);
  useEffect(() => {
    const on = () => setPast(window.scrollY > px);
    on();
    window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, [px]);
  return past;
}
