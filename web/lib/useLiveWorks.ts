'use client';
/**
 * Asking the server again about the names on Discover it had not placed (v0.56.0).
 *
 * The wall and search answer with a `work` per row at once, and a name the server has not placed yet is `n:…`: it looks
 * it up on AniList, MangaDex and MangaUpdates in the background, once, and GET /api/discover/works says what each such
 * key is now. So while those cards are on screen the page asks: right after a load (the first answer, or a page of
 * infinite scroll), then every 20 s while the server says it is still looking -- ten rounds a load at most, nothing
 * while the page is hidden, and never before the first paint, which renders the rows as they came. lib/wall.ts
 * `applyWorks` lays the answers over the rows, so cards fold and owned ones leave the wall without a reload.
 *
 * The poller is plain code with its timers as parameters, like lib/ticker.ts, so a test can run its clock; the hook
 * below is the page's handle on it.
 */
import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { WorkNow } from './wall';

/** The most keys the route takes in one request. */
export const WORKS_CHUNK = 200;
/**
 * The most characters of keys in one request's URL. 200 keys in a non-Latin script run past 8 KB once encoded, and
 * nginx -- in the image, and in most proxies in front of it -- answers 414 to a request line longer than that.
 */
export const WORKS_URL_MAX = 6000;
/** How often to ask again while the server says it is still looking. */
export const WORKS_POLL_MS = 20_000;
/** Rounds per load: a name no service knows is never placed, and the page stops asking. */
export const WORKS_MAX_ROUNDS = 10;
/**
 * How long new keys wait for the rest of their burst. The wall's sources land one by one within seconds, and a search
 * fills in every 1.5 s; one request a second after the first new keys asks for them all.
 */
export const WORKS_SETTLE_MS = 1000;

/** GET /api/discover/works: the asked keys' current works, and how many of them the server is still looking up. */
export interface WorksAnswer { works: Record<string, WorkNow>; pending: number }

/** The keys in requests the route takes: at most 200 a request, and short enough for a proxy's request line. */
export function worksChunks(keys: readonly string[], max = WORKS_CHUNK, chars = WORKS_URL_MAX): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  let len = 0;
  for (const k of keys) {
    const n = encodeURIComponent(k).length + 1;
    if (cur.length && (cur.length >= max || len + n > chars)) { out.push(cur); cur = []; len = 0; }
    cur.push(k);
    len += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** The request for one chunk. Keys never hold a comma (the route's contract), so they are joined by one. */
export const worksUrl = (keys: readonly string[]) => `/api/discover/works?keys=${keys.map(encodeURIComponent).join(',')}`;

export interface WorksPoller {
  /** The keys on screen now. A key never asked before starts a new load: its first round shortly, ten at most. */
  set(keys: readonly string[]): void;
  /** The page is visible again: a round that came due while it was hidden runs now. */
  wake(): void;
  /** Unmounted: no more rounds, and the answer in flight is dropped. */
  stop(): void;
}

type SetT = (fn: () => void, ms: number) => unknown;
type ClearT = (id: any) => void;

/**
 * The asking, without React. `ask` fetches one chunk; `onWorks` receives each round's answers.
 *
 * A round asks only the keys still open -- unknown, or answered as themselves -- since a key answered with another
 * work is placed for good. It is skipped while the page is hidden or nothing is on screen (`set([])`) and runs when
 * the page comes back, without spending a round. A failed request -- an older server without the route, or the
 * network -- ends the load quietly: the cards stay as the server first named them.
 */
export function createWorksPoller(
  ask: (keys: string[], signal: AbortSignal) => Promise<WorksAnswer>,
  onWorks: (works: Record<string, WorkNow>) => void,
  {
    hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
    setT = setTimeout as SetT,
    clearT = clearTimeout as ClearT,
  }: { hidden?: () => boolean; setT?: SetT; clearT?: ClearT } = {},
): WorksPoller {
  let keys: readonly string[] = [];
  const asked = new Set<string>();
  const known: Record<string, WorkNow> = {};
  // Which load the rounds belong to, and how many it has had. A load is the keys that were new together.
  let load = 0;
  let rounds = 0;
  let timer: unknown = null;
  let settling = false;
  let due = false;
  let flight: AbortController | null = null;
  let stopped = false;

  const schedule = (ms: number) => {
    if (timer !== null) clearT(timer);
    timer = setT(() => { timer = null; void round(); }, ms);
  };

  async function round(): Promise<void> {
    settling = false;
    if (stopped) return;
    if (hidden() || !keys.length) { due = true; return; }
    due = false;
    const open = keys.filter((k) => !known[k] || known[k].work === k);
    if (!open.length) return;
    const mine = load;
    rounds++;
    // One round at a time: a round for new keys replaces one still in flight, and asks its keys again.
    flight?.abort();
    const ctl = new AbortController();
    flight = ctl;
    let pending = 0;
    try {
      const answers = await Promise.all(worksChunks(open).map((c) => ask(c, ctl.signal)));
      if (stopped || ctl.signal.aborted) return;
      const works: Record<string, WorkNow> = {};
      for (const a of answers) Object.assign(works, a.works ?? {});
      Object.assign(known, works);
      pending = answers.reduce((n, a) => n + (a.pending ?? 0), 0);
      onWorks(works);
    } catch {
      // Replaced by a newer round, stopped, or refused (an older server has no such route): this load asks no more.
      return;
    } finally {
      if (flight === ctl) flight = null;
    }
    // Reintroduce by dropping `rounds < WORKS_MAX_ROUNDS`: "a load asks more than ten times" in liveWorks.test.ts.
    if (mine === load && pending > 0 && rounds < WORKS_MAX_ROUNDS) schedule(WORKS_POLL_MS);
  }

  return {
    set(next) {
      if (stopped) return;
      keys = next;
      const fresh = next.filter((k) => !asked.has(k));
      if (fresh.length) {
        for (const k of fresh) asked.add(k);
        // A new load, with rounds of its own. Not restarted by more new keys while it settles: a search that keeps
        // filling in would otherwise never be asked about at all.
        if (!settling) { settling = true; load++; rounds = 0; schedule(WORKS_SETTLE_MS); }
      } else if (due && next.length && !settling) {
        void round();
      }
    },
    wake() {
      if (!stopped && due && !settling && !hidden()) void round();
    },
    stop() {
      stopped = true;
      if (timer !== null) clearT(timer);
      timer = null;
      flight?.abort();
    },
  };
}

/**
 * What the server has said since about the works among `keys` (the `n:` ones on screen), asked while `active`.
 * Answers accumulate for the life of the page, keyed by the key that was asked.
 */
export function useLiveWorks(keys: readonly string[], active: boolean): Readonly<Record<string, WorkNow>> {
  const [works, setWorks] = useState<Record<string, WorkNow>>({});
  const poller = useRef<WorksPoller | null>(null);
  useEffect(() => {
    const p = createWorksPoller(
      (chunk, signal) => api<WorksAnswer>(worksUrl(chunk), { signal }),
      (w) => setWorks((prev) => ({ ...prev, ...w })),
    );
    poller.current = p;
    const onVisible = () => p.wake();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      p.stop();
      poller.current = null;
    };
  }, []);
  // One string, so a new array holding the same keys -- every render makes one -- is not a change.
  const sig = active ? keys.join(',') : '';
  useEffect(() => { poller.current?.set(sig ? sig.split(',') : []); }, [sig]);
  return works;
}
