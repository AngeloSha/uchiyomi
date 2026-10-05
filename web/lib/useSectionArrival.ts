'use client';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useReducedMotion } from 'framer-motion';
import { useReduceEffects } from './effects';

/** How long the page has to stop changing before the scroll: its cards have loaded, so the target will not move. */
const SETTLE_MS = 300;
/** A page that never stops changing (a poll) still gets its scroll, this long after the card appeared. */
const AT_MOST_MS = 2000;
/** A card that never comes (the solver's, on a server without one) is waited for this long, then forgotten. */
const GIVE_UP_MS = 15_000;

/**
 * `?section=<id>` (v0.55.4): scroll that card into view once it is on the page, for the search palette's settings
 * (lib/destinations.ts) -- "Notice chapters" lands on the card, not on the top of Admin → Settings.
 *
 * The pattern is the Progress tracking card's (`?card=tracking`, components/ProfileConnections.tsx): read once on
 * arrival, scrolled to once, instant under reduced motion or Reduce effects, never again on a refetch. A plain `#hash`
 * cannot do it: the tab draws "Loading…" first and the card arrives with its answer -- and the cards above it arrive
 * with theirs, so the scroll waits until the page has stopped changing for a moment, or the target moves down under a
 * card that loaded late. A wheel, a touch or a key before then is the person scrolling: they are left where they went.
 * Then the address loses its `section`, so a language change (which remounts the page) or a refresh does not do it again.
 */
export function useSectionArrival(): void {
  const params = useSearchParams();
  const [id] = useState<string | null>(() => params.get('section'));
  const reduced = useReducedMotion();
  const fewer = useReduceEffects();
  const still = !!reduced || fewer;
  useEffect(() => {
    if (!id) return;
    const EVENTS = ['wheel', 'touchmove', 'keydown'] as const;
    let done = false;
    let seen = 0;
    let quiet: ReturnType<typeof setTimeout> | undefined;
    let giveUp: ReturnType<typeof setTimeout> | undefined;
    let mo: MutationObserver | undefined;
    const detach = () => {
      done = true;
      clearTimeout(quiet);
      clearTimeout(giveUp);
      mo?.disconnect();
      for (const ev of EVENTS) window.removeEventListener(ev, stop);
    };
    // Arrived (or given up on): the address loses its `section`, the way the tab hook writes its tab.
    const finish = () => {
      detach();
      const u = new URL(window.location.href);
      if (!u.searchParams.has('section')) return;
      u.searchParams.delete('section');
      window.history.replaceState(null, '', `${u.pathname}${u.search}${u.hash}`);
    };
    function stop() { if (!done) finish(); }
    const go = () => {
      if (done) return;
      const el = document.getElementById(id);
      if (!el) return;
      finish();
      el.scrollIntoView({ block: 'start', behavior: still ? 'auto' : 'smooth' });
    };
    // Every change to the page restarts the wait, once the card is there.
    const settle = () => {
      if (done) return;
      clearTimeout(quiet);
      if (!document.getElementById(id)) return;
      seen ||= Date.now();
      quiet = setTimeout(go, Date.now() - seen >= AT_MOST_MS ? 0 : SETTLE_MS);
    };
    mo = new MutationObserver(settle);
    mo.observe(document.body, { childList: true, subtree: true });
    for (const ev of EVENTS) window.addEventListener(ev, stop, { passive: true });
    giveUp = setTimeout(stop, GIVE_UP_MS);
    settle();
    return detach;
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps -- once per arrival; `still` is read when it scrolls
}
