'use client';
import { useContext, useRef } from 'react';
import { usePathname } from 'next/navigation';
import { LayoutRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import {
  NavigationPromisesContext, PathnameContext, PathParamsContext, SearchParamsContext,
} from 'next/dist/shared/lib/hooks-client-context.shared-runtime';
import { AnimatePresence, motion } from 'framer-motion';
import { useReduceEffects } from '@/lib/effects';

/**
 * The page a fade is taking away, held as it was (2026-10-15).
 *
 * The router hands a page its route through contexts, not through `children`, so the wrapper AnimatePresence keeps for
 * the fade-out rendered the NEW route: a click showed the next page at once inside the outgoing fade, faded it away to
 * nothing and faded the same page in again -- and built it twice, once in each wrapper. Here the outgoing page keeps
 * every context it read its route from (the route itself, the path, the search params, the params) as they were when it
 * was the current page, so the old page is what fades out, unchanged -- a series fading away is still that series, not
 * the same page asked for a series with no id -- and the new one is built once, as it fades in. While its path is still
 * the current one a page follows the live contexts, so a change of search params alone (one series to another,
 * `/series/?id=…`) updates it in place as before.
 *
 * ⚠️ These contexts are Next's internals (next/dist/shared/lib): web/test/pageTransition.test.ts checks they still exist
 * and that `usePathname` and `useSearchParams` still read them, so a Next upgrade that moves them fails a test, not the fade.
 */
function FrozenRoute({ path, children }: { path: string; children: React.ReactNode }) {
  const live = {
    layout: useContext(LayoutRouterContext),
    pathname: useContext(PathnameContext),
    search: useContext(SearchParamsContext),
    params: useContext(PathParamsContext),
    promises: useContext(NavigationPromisesContext),
  };
  const held = useRef(live);
  if (live.pathname === path) held.current = live;
  const h = held.current;
  return (
    <LayoutRouterContext.Provider value={h.layout}>
      <PathnameContext.Provider value={h.pathname}>
        <SearchParamsContext.Provider value={h.search}>
          <PathParamsContext.Provider value={h.params}>
            <NavigationPromisesContext.Provider value={h.promises}>{children}</NavigationPromisesContext.Provider>
          </PathParamsContext.Provider>
        </SearchParamsContext.Provider>
      </PathnameContext.Provider>
    </LayoutRouterContext.Provider>
  );
}

export function PageTransition({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  // Under Reduce effects (#71) the new page is simply there.  A zero-duration exit is not equivalent to
  // having no exit while AnimatePresence is in `wait` mode: Framer can retain the old keyed page without
  // ever admitting the new one after a client-side navigation (#174).  Keep the same wrapper, but mount the
  // incoming page synchronously and give the outgoing page no exit target at all.
  const reduced = useReduceEffects();
  return (
    <AnimatePresence mode={reduced ? 'sync' : 'wait'} initial={false}>
      <motion.div
        key={path}
        initial={reduced ? false : { opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        exit={reduced ? undefined : { opacity: 0, y: -6 }}
        transition={reduced ? { duration: 0 } : { duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
      >
        <FrozenRoute path={path}>{children}</FrozenRoute>
      </motion.div>
    </AnimatePresence>
  );
}
