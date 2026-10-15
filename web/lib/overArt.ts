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

/**
 * Whether the window has scrolled past `px`: the bar turns back to glass from there.
 *
 * Watched, not measured (v0.67.3): a hidden 1-px mark sits `px` down the document and an IntersectionObserver says when it
 * leaves the top of the window. It read `window.scrollY` on every scroll event, and that read makes the browser finish its
 * style and layout on the spot -- once a frame while a wheel scrolls fast. Placed absolutely and hidden, the mark moves
 * nothing and takes no clicks.
 */
export function useScrolledPast(px: number): boolean {
  const [past, setPast] = useState(false);
  useEffect(() => {
    const mark = document.createElement('div');
    mark.setAttribute('aria-hidden', 'true');
    mark.dataset.scrollMark = String(px);
    mark.style.cssText = `position:absolute;top:${px}px;left:0;width:1px;height:1px;pointer-events:none;visibility:hidden`;
    document.body.appendChild(mark);
    const io = new IntersectionObserver(([e]) => setPast(!e.isIntersecting && e.boundingClientRect.top < 0));
    io.observe(mark);
    return () => { io.disconnect(); mark.remove(); };
  }, [px]);
  return past;
}
