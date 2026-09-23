'use client';
import { useSyncExternalStore } from 'react';

/**
 * Reduce effects: the performance mode (#71).
 *
 * The app's look is deliberate and stays the default for everyone: the drifting accent mesh, the film grain,
 * the vignette, glass that blurs what scrolls under it, momentum scrolling, covers that sharpen in. On a
 * modest PC that finish is what a frame pays for: a 200-series library at 1440 scrolls at about 40 fps in
 * headless Chrome at a 4x CPU throttle, and at under 8 in headless Firefox; with this switch on, 60 and 58
 * (web/test/perf/README.md has the table). This switch is the answer the reporter asked for, rather than a
 * cheaper default nobody chose: one setting per account, turning off exactly the things that cost frames.
 *
 * Three places hold it, each for a reason:
 *  - the ACCOUNT (`reduceEffects` in `/api/settings`), so it follows you to another device, like the accent;
 *  - `html.reduce-effects`, which is what the CSS in app/globals.css keys on -- one class, so a component that
 *    never heard of this module still loses its backdrop blur;
 *  - a localStorage mirror, for the one start that cannot ask the server: an offline launch.
 *
 * ⚠️ It is applied SYNCHRONOUSLY, from lib/auth.tsx, before the status that renders the app shell is set.
 * CinematicFX mounts in the same commit as `status: 'authed'`, so if the class arrived one effect later the
 * mesh, grain and vignette would paint for a frame on every reload with the switch on.
 *
 * ⚠️ `prefers-reduced-motion` is NOT folded into this. The system setting keeps doing exactly what it did
 * before this switch existed (no mesh drift, no Lenis, no tilt, near-zero durations) and gains no new visual
 * change: someone who asked their OS for less motion did not ask for the grain or the glass to go. The two
 * are checked side by side where both apply (Lenis, tilt), never merged into one flag.
 */

const KEY = 'uchiyomi.reduceEffects';
const CLASS = 'reduce-effects';

let reduced = false;
const listeners = new Set<() => void>();

/** The device's copy, `'1'` when on. Unreadable storage (a private window, a blocked origin) reads as off. */
export function readReduceEffectsMirror(): boolean {
  try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
}

/**
 * Turn the mode on or off NOW: the html class, the mirror, and every component using `useReduceEffects`.
 *
 * Called with the account's value on every sign-in and session refresh, so a device follows the account in
 * both directions -- a switch turned off on the phone is off on the laptop at its next refresh, and the next
 * person to sign in on a shared tablet gets their own setting, not the previous person's.
 */
export function applyReduceEffects(on: boolean): void {
  reduced = on;
  try { document.documentElement.classList.toggle(CLASS, on); } catch { /* no document: nothing to style */ }
  try {
    if (on) localStorage.setItem(KEY, '1');
    else localStorage.removeItem(KEY);
  } catch { /* storage refused: the account still holds the setting, only the offline launch forgets it */ }
  for (const l of listeners) l();
}

/** Re-apply the device's copy: an offline launch, and the first render before the server has answered. */
export function restoreReduceEffects(): void {
  applyReduceEffects(readReduceEffectsMirror());
}

/** The current value, for code outside React's render (an event handler deciding whether to tilt a card). */
export function effectsReduced(): boolean {
  return reduced;
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

/**
 * Whether Reduce effects is on, re-rendering the caller when it changes.
 *
 * An external store rather than context: the value is set from lib/auth.tsx, which renders BELOW Providers
 * (where Lenis lives), so a context would have to be lifted over the whole tree for one boolean. The server
 * snapshot is `false` -- the static export never renders the app shell (it is behind the splash until
 * /auth/refresh answers), so nothing effect-bearing is ever hydrated against it.
 */
export function useReduceEffects(): boolean {
  return useSyncExternalStore(subscribe, effectsReduced, () => false);
}
