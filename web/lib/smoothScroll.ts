import type Lenis from 'lenis';

// The page's running Lenis (app/providers.tsx), for the few things that must stop its glide. None while Reduce
// effects or prefers-reduced-motion keep the browser's own scrolling.
let current: Lenis | null = null;

export function setSmoothScroll(lenis: Lenis | null) { current = lenis; }

/**
 * Stops a wheel's glide where the page is now. A menu opened mid-glide closed again at once: the page was still
 * moving under it for up to a second after the wheel stopped, and a moving page closes a menu (ContextMenu.tsx).
 */
export function haltSmoothScroll() { current?.scrollTo(current.actualScroll, { immediate: true, force: true }); }
