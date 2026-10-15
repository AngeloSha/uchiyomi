'use client';
// Back and Forward put a page back where it was left (2026-10-15).
//
// The page fade (components/PageTransition.tsx) keeps the page being left on screen while it fades out, so the page being
// returned to only mounts once that is done. The browser puts the scroll back at the moment of Back -- onto the page still
// fading out, which jumped, and which is usually too short for it: a Library left 2000 px down came back 145 px down. So
// the app keeps the positions itself (`history.scrollRestoration = 'manual'`): where each address was left, put back once
// Back or Forward has returned to it and its page has mounted. A click on a link still opens the next page at its top
// (Next scrolls it there). Pinned in web/test/scrollMemory.test.ts; run.mjs walks it.
//
// ⚠️ Never read `scrollY` on every scroll event (v0.67.3). Reading it makes the browser finish its style and layout on the
// spot, and a wheel scrolls every frame: v0.67.2 did, and that read was the costliest script of a fast scroll (half a
// millisecond a frame on the Library). A position is filed once the scrolling pauses, or at once when Back leaves it.

type Win = {
  location: { pathname: string; search: string };
  history: { scrollRestoration: string };
  scrollY: number;
  scrollTo(x: number, y: number): void;
  addEventListener(type: string, fn: () => void, opts?: AddEventListenerOptions): void;
  removeEventListener(type: string, fn: () => void, opts?: EventListenerOptions): void;
  requestAnimationFrame(fn: () => void): number;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
  performance: { now(): number };
};

/** How long a return keeps trying while the page grows into its old height (its rows still arriving). */
export const SETTLE_MS = 1500;
/** How long the scrolling must pause before a position is filed. */
export const RECORD_MS = 120;

export function createScrollMemory(win: Win) {
  const left = new Map<string, number>();
  /** Set by Back/Forward, cleared once that page is in place: until then no scroll belongs to anyone. */
  let returning: { url: string; y: number } | null = null;
  let stopped = false;
  /** The address whose page is on screen, set on every arrival: a position filed late still goes to the right page. */
  let current = '';
  let timer: number | null = null;
  const here = () => win.location.pathname + win.location.search;
  const file = () => { timer = null; if (!returning && current) left.set(current, win.scrollY); };
  const onScroll = () => {
    if (returning) return;
    if (timer !== null) win.clearTimeout(timer);
    timer = win.setTimeout(file, RECORD_MS);
  };
  const onPop = () => {
    // The page being left is still on screen where it was left (the browser restores nothing now): file it first.
    if (timer !== null) { win.clearTimeout(timer); timer = null; }
    if (!returning && current) left.set(current, win.scrollY);
    returning = { url: here(), y: left.get(here()) ?? 0 };
  };
  // A person scrolling while a return settles takes over: never fight them for the page.
  const onInput = () => { if (returning) stopped = true; };
  return {
    install() {
      current = here();
      win.history.scrollRestoration = 'manual';
      win.addEventListener('scroll', onScroll, { passive: true });
      win.addEventListener('popstate', onPop);
      for (const t of ['wheel', 'touchstart', 'keydown']) win.addEventListener(t, onInput, { passive: true });
    },
    /**
     * A page arrived (it mounted, or its search params changed): it is the page on screen from now on, and if Back or
     * Forward brought it back, it goes where it was left. A return to some other address is stale -- another navigation
     * overtook it -- and is dropped, or the memory would stop recording for good.
     */
    putBack() {
      current = here();
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
