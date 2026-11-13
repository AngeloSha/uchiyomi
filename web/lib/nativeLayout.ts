'use client';
import { useEffect, useLayoutEffect, useState } from 'react';
import { nativeHost } from './native';

export type NativeNavigationLayout = 'side' | 'bottom';
export const NATIVE_LAYOUT_ATTRIBUTE = 'data-native-navigation-layout';
export const NATIVE_SIDEBAR_ATTRIBUTE = 'data-uchiyomi-native-sidebar';

/** A presentation hint, never a new navigation or authorization surface. */
export function nativeNavigationLayout(): NativeNavigationLayout | null {
  if (!nativeHost() || typeof document === 'undefined') return null;
  const value = document.documentElement.getAttribute(NATIVE_LAYOUT_ATTRIBUTE);
  return value === 'side' || value === 'bottom' ? value : null;
}

export function usesSideNavigation(wide: boolean, layout: NativeNavigationLayout | null): boolean {
  // A bottom hint restores the ordinary phone layout; it never overrides the established desktop rail.
  return wide || layout === 'side';
}

/** The wrapper owns its hint; only this validated consumer may activate the narrow-screen CSS. */
export function observeNativeNavigationLayout(active: boolean, changed: (layout: NativeNavigationLayout | null) => void): () => void {
  if (typeof document === 'undefined') { changed(null); return () => {}; }
  const root = document.documentElement;
  let live = true;
  const apply = () => {
    if (!live) return;
    const layout = nativeNavigationLayout();
    if (active && layout === 'side') root.setAttribute(NATIVE_SIDEBAR_ATTRIBUTE, '');
    else root.removeAttribute(NATIVE_SIDEBAR_ATTRIBUTE);
    changed(layout);
  };
  apply();
  const observer = nativeHost() && typeof MutationObserver !== 'undefined' ? new MutationObserver(apply) : null;
  observer?.observe(root, { attributes: true, attributeFilter: [NATIVE_LAYOUT_ATTRIBUTE] });
  return () => { live = false; observer?.disconnect(); root.removeAttribute(NATIVE_SIDEBAR_ATTRIBUTE); };
}

/**
 * Whether the iOS side layout is on now (the flag observeNativeNavigationLayout sets): read only, for a page whose own
 * measurements assumed a phone's bottom navigation, which that layout does not have.
 */
export function useNativeSidebar(): boolean {
  const [on, setOn] = useState(() => typeof document !== 'undefined' && document.documentElement.hasAttribute(NATIVE_SIDEBAR_ATTRIBUTE));
  useEffect(() => {
    const root = document.documentElement;
    const read = () => setOn(root.hasAttribute(NATIVE_SIDEBAR_ATTRIBUTE));
    read();
    if (typeof MutationObserver === 'undefined') return;
    const observer = new MutationObserver(read);
    observer.observe(root, { attributes: true, attributeFilter: [NATIVE_SIDEBAR_ATTRIBUTE] });
    return () => observer.disconnect();
  }, []);
  return on;
}

export function useNativeNavigationLayout(active: boolean): NativeNavigationLayout | null {
  const [layout, setLayout] = useState<NativeNavigationLayout | null>(nativeNavigationLayout);
  // Keep the rail's CSS geometry and the rendered navigation together before the frame is painted.
  useLayoutEffect(() => observeNativeNavigationLayout(active, setLayout), [active]);
  return layout;
}
