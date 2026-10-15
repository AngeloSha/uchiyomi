import { useSyncExternalStore } from 'react';

// How wide the webtoon column is, as a percent of what Fit width / Original would give. This is a property of the
// screen it is read on (a phone wants 100, a wide monitor wants a narrow strip), so it lives in this browser only and is
// never part of the account's reader settings that follow you between devices.
const KEY = 'yomi_reader_width';
export const WIDTH_MIN = 30;
export const WIDTH_MAX = 100;

const listeners = new Set<() => void>();

export function readWidth(): number {
  try {
    const n = Number(localStorage.getItem(KEY));
    return Number.isFinite(n) && n >= WIDTH_MIN && n <= WIDTH_MAX ? Math.round(n) : WIDTH_MAX;
  } catch { return WIDTH_MAX; }
}

export function setWidth(pct: number) {
  const n = Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, Math.round(pct)));
  try { if (n === WIDTH_MAX) localStorage.removeItem(KEY); else localStorage.setItem(KEY, String(n)); } catch { /* private mode: lasts until reload */ }
  listeners.forEach((l) => l());
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  window.addEventListener('storage', cb);
  return () => { listeners.delete(cb); window.removeEventListener('storage', cb); };
};

export function useReaderWidth(): [number, (pct: number) => void] {
  return [useSyncExternalStore(subscribe, readWidth, () => WIDTH_MAX), setWidth];
}
