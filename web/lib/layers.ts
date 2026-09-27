'use client';
/**
 * What is on screen above the page: open dialogs, the phone's bottom nav, a fixed select toolbar (v0.49.0).
 *
 * The notices (components/Toast.tsx) need this to stay out of the way. The owner's rule is that a notice
 * never covers a dialog's title -- v0.48.3's lesson, where a banner painted over dialogs -- and on a phone
 * the one strip no dialog uses is the bottom-nav band (Modal, the console drawer and an `overBottomNav`
 * Sheet all leave it free). Where a notice goes therefore depends on whether a dialog is open, whether it
 * leaves that band free, whether there is a nav at all, and how tall a select toolbar above the nav is.
 *
 * Why a registry and not a CSS `body:has([aria-modal])`: the notice viewport renders in ToastProvider, above
 * AuthProvider and the app shell (app/providers.tsx), so it cannot read page state; and a `:has()` rule is
 * re-matched on every DOM change of a 200-tile library grid, the cost #71 measured. Each dialog primitive
 * registers itself with one `useLayer` line instead, and web/test/layers.test.ts proves every file that
 * says `aria-modal="true"` does.
 *
 * The store is the pattern of lib/effects.ts: a module value, listeners, useSyncExternalStore.
 */
import { useEffect, useSyncExternalStore, type RefObject } from 'react';

export type LayerKind = 'dialog' | 'nav' | 'toolbar';

export interface Layers {
  /** Open dialogs. */
  dialog: number;
  /** Mounted bottom navs (the phone's; it hides itself from lg up). */
  nav: number;
  /** Fixed toolbars above the nav: the library's and a series page's select bars. */
  toolbar: number;
  /** Every open dialog leaves the bottom-nav band free (true when none is open). */
  navBandFree: boolean;
  /** The tallest registered toolbar, measured, in px; 0 until measured. */
  toolbarHeight: number;
}

export interface LayerInfo {
  /** A dialog that keeps the bottom-nav band clear of itself, as Modal does below lg. */
  navBandFree?: boolean;
  /** A toolbar's measured height in px. */
  height?: number;
}

export interface LayerHandle {
  /** Change what this layer says about itself (a toolbar that wrapped to another row). */
  update(info: LayerInfo): void;
  /** Take it off the stack. Safe to call twice. */
  release(): void;
}

const EMPTY: Layers = Object.freeze({ dialog: 0, nav: 0, toolbar: 0, navBandFree: true, toolbarHeight: 0 });

interface Entry { kind: LayerKind; navBandFree: boolean; height: number }
const entries = new Map<number, Entry>();
let seq = 0;
let snapshot: Layers = EMPTY;
const listeners = new Set<() => void>();

function recompute(): void {
  const next = { dialog: 0, nav: 0, toolbar: 0, navBandFree: true, toolbarHeight: 0 };
  for (const e of entries.values()) {
    next[e.kind]++;
    if (e.kind === 'dialog' && !e.navBandFree) next.navBandFree = false;
    if (e.kind === 'toolbar') next.toolbarHeight = Math.max(next.toolbarHeight, e.height);
  }
  // The snapshot object is replaced only when something it says changed. useSyncExternalStore compares by
  // identity, and a fresh object on every read is an endless re-render.
  const same = (Object.keys(next) as (keyof Layers)[]).every((k) => next[k] === snapshot[k]);
  if (same) return;
  snapshot = Object.freeze(next);
  for (const l of [...listeners]) l();
}

/** Put a layer on the stack. Outside React for the tests; components use `useLayer`. */
export function registerLayer(kind: LayerKind, info: LayerInfo = {}): LayerHandle {
  const id = ++seq;
  entries.set(id, { kind, navBandFree: !!info.navBandFree, height: Math.max(0, info.height ?? 0) });
  recompute();
  return {
    update(next) {
      const e = entries.get(id);
      if (!e) return;
      entries.set(id, {
        kind,
        navBandFree: next.navBandFree ?? e.navBandFree,
        height: Math.max(0, next.height ?? e.height),
      });
      recompute();
    },
    release() {
      if (entries.delete(id)) recompute();
    },
  };
}

/** The current stack, for code outside render. */
export function layersNow(): Layers {
  return snapshot;
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

/**
 * Register this component's layer while it is mounted and `active`.
 *
 * `ref` makes it measured: a toolbar passes the element it renders, and its height follows it through a
 * ResizeObserver, because the series page's select bar wraps to three rows at 390 px and the library's to
 * two, so no constant offset fits both. `navBandFree` is for dialogs that leave the phone's nav band clear.
 */
export function useLayer(kind: LayerKind, active = true, opts: { navBandFree?: boolean; ref?: RefObject<HTMLElement | null> } = {}): void {
  const { navBandFree = false, ref } = opts;
  useEffect(() => {
    if (!active) return;
    const h = registerLayer(kind, { navBandFree });
    const el = ref?.current;
    let ro: ResizeObserver | null = null;
    if (el) {
      const measure = () => h.update({ height: Math.round(el.getBoundingClientRect().height) });
      measure();
      if (typeof ResizeObserver !== 'undefined') { ro = new ResizeObserver(measure); ro.observe(el); }
    }
    return () => { ro?.disconnect(); h.release(); };
  }, [kind, active, navBandFree, ref]);
}

/** The stack, re-rendering the caller when it changes. Nothing is open during the static export's render. */
export function useLayers(): Layers {
  return useSyncExternalStore(subscribe, layersNow, () => EMPTY);
}
