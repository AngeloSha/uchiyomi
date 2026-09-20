'use client';
import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { readTab, withTab } from './tabParam';

/**
 * A console's current tab, read from `?tab=` on arrival and written back to it on every switch.
 *
 * Three rules, each one a failure this replaced:
 *
 *   * The query is read ONCE, in a lazy `useState`. An effect that re-read the params would snap a person
 *     back to the URL's tab on the next render after they tapped the rail -- and `useSearchParams` re-renders
 *     on every URL change, including the one this hook makes, so an effect would also fire against its own
 *     write.
 *   * The write is `history.replaceState`, never `pushState` and never `router.replace`. A push turns
 *     every tab tap into a history entry, so Back walks through the tabs instead of leaving the page; a
 *     router navigation re-renders the route and, in a static export, re-runs the page's Suspense fallback
 *     for a change that is purely cosmetic.
 *   * Nothing here touches `window` during render. The lazy initialiser goes through `useSearchParams`, so
 *     the prerendered HTML and the first client render agree; reading `location.search` directly would
 *     hydrate-mismatch and trip run.mjs's console-error check.
 *
 * ⚠️ Callers must sit under `<Suspense fallback={<div className="min-h-screen-d" />}>`: `useSearchParams`
 * in a statically exported page needs the boundary, and the build fails without one.
 *
 * The free win: I18nProvider remounts its whole subtree on a language change (`<div key={lang}>` in
 * lib/I18nProvider.tsx), which used to reset the profile to You from the very tab holding the language
 * picker. The tab is in the URL now, so the remount reads it straight back.
 */
export function useTabParam<T extends string>(tabs: readonly T[], fallback: T): [T, (t: T) => void] {
  const params = useSearchParams();
  const [tab, setTabState] = useState<T>(() => readTab(params.get('tab'), tabs, fallback));
  const setTab = (t: T) => {
    setTabState(t);
    window.history.replaceState(null, '', withTab(window.location.href, t, fallback));
  };
  return [tab, setTab];
}
