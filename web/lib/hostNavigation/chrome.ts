'use client';
import { useSyncExternalStore } from 'react';

// Shared with portal-based sheets/notices outside AppShell's React subtree.
let active = false;
const listeners = new Set<() => void>();
export function setHostNavigationActive(value: boolean): void {
  if (active === value) return;
  active = value;
  if (typeof document !== 'undefined') document.documentElement.toggleAttribute('data-host-navigation', value);
  for (const listener of [...listeners]) listener();
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function useHostNavigationActive(): boolean {
  return useSyncExternalStore(subscribe, () => active, () => false);
}
