'use client';
/**
 * One 1-second clock for every ticking row (v0.49.0).
 *
 * A working action shows its elapsed time, "1:24", ticking. A Fix all issues run can put dozens of Health
 * rows into "working" at once, and an interval per row would wake the main thread dozens of times a second
 * -- on exactly the modest machines #71 was about. So every row reads one shared clock: one interval,
 * started by the first row that needs it and cleared when the last one stops.
 *
 * The clock is a cached `Date.now()` that changes only on a tick, which is what makes it safe as a
 * useSyncExternalStore snapshot: a getter returning a fresh Date.now() on every call would never read the
 * same twice, and React re-renders forever on a snapshot like that.
 */
import { useSyncExternalStore } from 'react';

export interface Ticker {
  subscribe(listener: () => void): () => void;
  now(): number;
}

type SetI = (fn: () => void, ms: number) => unknown;
type ClearI = (id: any) => void;

/**
 * A clock that ticks every second while anyone listens. The timer functions and the time source are
 * parameters so a test can count the intervals it starts.
 *
 * It does not tick while the page is hidden: nobody is watching the clock, and a background tab that
 * re-renders every second costs battery for nothing. It catches up on the first tick after the page shows.
 */
export function createTicker(setI: SetI = setInterval, clearI: ClearI = clearInterval, clock: () => number = Date.now): Ticker {
  const listeners = new Set<() => void>();
  let id: unknown = null;
  let current = clock();
  const tick = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    current = clock();
    for (const l of [...listeners]) l();
  };
  return {
    subscribe(listener) {
      listeners.add(listener);
      if (id === null) {
        // Fresh at the moment a row starts watching, so its first frame does not show a stale time; React
        // re-reads the snapshot after subscribing and picks this up.
        current = clock();
        id = setI(tick, 1000);
      }
      return () => {
        if (!listeners.delete(listener)) return;
        if (listeners.size === 0 && id !== null) { clearI(id); id = null; }
      };
    },
    now: () => current,
  };
}

const shared = createTicker();
const noSubscribe = () => () => {};

/**
 * The shared clock's time, re-rendering the caller every second while `active`. Inactive rows subscribe to
 * nothing, so a page of idle and finished rows costs no timer at all. The server snapshot is 0: the static
 * export never renders a working row.
 */
export function useTicker(active: boolean): number {
  return useSyncExternalStore(active ? shared.subscribe : noSubscribe, shared.now, () => 0);
}
