'use client';
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { adultShown, setAdultShown, onAdultChange } from '@/lib/adult';
import { t as tr } from '@/lib/i18n';

export interface LibraryRow { id: string; name: string; adult?: boolean }

/** The library list, shared by the toggle and by whatever renders library tabs. */
export function useLibraries() {
  return useQuery({
    queryKey: ['libraries'],
    queryFn: () => api<LibraryRow[]>('/api/libraries'),
    staleTime: 5 * 60 * 1000,
  });
}

/** Whether 18+ is currently revealed, kept in sync with the cookie another tab may have changed. */
export function useAdultShown(): boolean {
  // Starts false and is corrected after mount: this app is a static export, so the first render happens at
  // build time where there is no document to read a cookie from, and guessing would mean a hydration
  // mismatch on every load for anyone who had revealed.
  const [on, setOn] = useState(false);
  useEffect(() => {
    const sync = () => setOn(adultShown());
    sync();
    const off = onAdultChange(sync);
    // Another tab can flip it, and returning to a backgrounded tab is when a stale one would be noticed.
    window.addEventListener('focus', sync);
    return () => { off(); window.removeEventListener('focus', sync); };
  }, []);
  return on;
}

/**
 * Reveal libraries rated 18+, for this browser session.
 *
 * Renders nothing at all unless this account actually holds an 18+ library, because for almost every
 * install it is a control with nothing behind it. `/api/libraries` reports `adult` for exactly this, and it
 * already drops libraries above the viewer's age cap — so an account that may not open the 18+ shelf never
 * sees the button that would reveal it.
 *
 * Flipping it invalidates every query rather than a chosen list. The reveal changes what a dozen endpoints
 * return — the home rails, search, genres and their counts, collections, updates, history, bookmarks — and
 * enumerating them here would be one more list to forget to update.
 */
export function AdultToggle({ className = '' }: { className?: string }) {
  const qc = useQueryClient();
  const { data: libs } = useLibraries();
  const on = useAdultShown();

  if (!(libs ?? []).some((l) => l.adult)) return null;

  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={() => {
        setAdultShown(!on);
        qc.invalidateQueries();
      }}
      className={`chip whitespace-nowrap ${on ? 'chip-active' : ''} ${className}`}
    >
      {tr('Show 18+')}
    </button>
  );
}
