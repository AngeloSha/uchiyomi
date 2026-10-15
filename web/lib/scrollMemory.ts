'use client';
// Back and Forward put a page back where it was left (2026-10-15).
//
// The page fade (components/PageTransition.tsx) keeps the page being left on screen while it fades out, so the page being
// returned to only mounts once that is done. The browser puts the scroll back at the moment of Back -- onto the page still
// fading out, which jumped, and which is usually too short for it: a Library left 2000 px down came back 145 px down. So
// the app keeps the positions itself (`history.scrollRestoration = 'manual'`): where each address was left, put back once
// Back or Forward has returned to it and its page has mounted. A click on a link still opens the next page at its top
// (Next scrolls it there). Pinned in web/test/scrollMemory.test.ts; run.mjs walks it.

type Win = {
  location: { pathname: string; search: string };
  history: { scrollRestoration: string };
  scrollY: number;
  scrollTo(x: number, y: number): void;
  addEventListener(type: string, fn: () => void, opts?: AddEventListenerOptions): void;
  removeEventListener(type: string, fn: () => void, opts?: EventListenerOptions): void;
  requestAnimationFrame(fn: () => void): number;
  performance: { now(): number };
};

/** How long a return keeps trying while the page grows into its old height (its rows still arriving). */
export const SETTLE_MS = 1500;

export function createScrollMemory(win: Win) {
  const left = new Map<string, number>();
  /** Set by Back/Forward, cleared once that page is in place: until then no scroll belongs to anyone. */
  let returning: { url: string; y: number } | null = null;
  let stopped = false;
  const here = () => win.location.pathname + win.location.search;
  const onScroll = () => { if (!returning) left.set(here(), win.scrollY); };
  const onPop = () => { returning = { url: here(), y: left.get(here()) ?? 0 }; };
  // A person scrolling while a return settles takes over: never fight them for the page.
  const onInput = () => { if (returning) stopped = true; };
  return {
    install() {
      win.history.scrollRestoration = 'manual';
      win.addEventListener('scroll', onScroll, { passive: true });
      win.addEventListener('popstate', onPop);
      for (const t of ['wheel', 'touchstart', 'keydown']) win.addEventListener(t, onInput, { passive: true });
    },
    /**
     * A page arrived (it mounted, or its search params changed): if Back or Forward brought it back, put it where it was
     * left. A return to some other address is stale -- another navigation overtook it -- and is dropped, or the memory
     * would stop recording for good.
     */
    putBack() {
      const r = returning;
      if (!r) return;
      if (r.url !== here()) { returning = null; return; }
      stopped = false;
      const until = win.performance.now() + SETTLE_MS;
      const step = () => {
        if (!stopped) win.scrollTo(0, r.y);
        const done = stopped || Math.abs(win.scrollY - r.y) <= 1 || win.performance.now() > until;
        if (done) { returning = null; left.set(r.url, win.scrollY); return; }
        win.requestAnimationFrame(step);
      };
      step();
    },
    /** For tests. */
    where: (url: string) => left.get(url),
  };
}

let memory: ReturnType<typeof createScrollMemory> | null = null;

/** The app's one memory, installed on first use in a browser. */
export function scrollMemory() {
  if (!memory) {
    memory = createScrollMemory(window as unknown as Win);
    memory.install();
  }
  return memory;
}
