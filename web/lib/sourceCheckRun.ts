// "Check all now" on Admin → Providers (#115, v0.49.0).
//
// The server used to hold ONE request open while it tested every source in turn -- forty extension sources at up
// to 45 s each is half an hour, and a reverse proxy cuts a request at a minute. It now starts the sweep in the
// background and answers at once (202); GET on the same path says how far it has got, and holds the sweep's answer
// once `running` is false. This walks that protocol, so the caller still gets the one answer it always got.

/** GET /api/admin/sources/check, as bff/src/lib/sourceWatchdog.ts CheckProgress. */
export interface SourceCheckProgress {
  running: boolean;
  by: 'schedule' | 'admin' | null;
  startedAt: string | null;
  finishedAt: string | null;
  total: number;
  done: number;
  current: { id: string; name: string } | null;
  /** The finished sweep's answer: {checkedAt, sources, needsAttention, inconclusive, notified}. */
  result: any | null;
  error: string | null;
}

type Call = <T>(path: string, opts?: { method?: string }) => Promise<T>;
export const SOURCE_CHECK_PATH = '/api/admin/sources/check';

/** Wait `ms`, or less when `signal` aborts first: a page that went away does not wait out its poll. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((res) => {
    if (signal?.aborted) return res();
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); res(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** Read GETs until the sweep ends (or `signal` says the page has gone), and return its last reading. */
async function follow(
  call: Call, p: SourceCheckProgress, onProgress?: (p: SourceCheckProgress) => void, everyMs = 2000, signal?: AbortSignal,
): Promise<SourceCheckProgress> {
  while (p.running && !signal?.aborted) {
    await sleep(everyMs, signal);
    if (signal?.aborted) break;
    p = await call<SourceCheckProgress>(SOURCE_CHECK_PATH);
    // An answer that lands after the page left is nobody's to show.
    if (signal?.aborted) break;
    onProgress?.(p);
  }
  return p;
}

const ended = (p: SourceCheckProgress): any => {
  if (!p.result) throw new Error(p.error || 'The check did not finish');
  return p.result;
};

/**
 * Start the sweep, follow it until it ends, and return its result. `onProgress` sees every reading (the first is
 * the POST's own answer), so a page can show "7 of 40 · Manga Ball (EN)" while it runs.
 *
 * A 409 means a sweep is already running -- the daily one, or one another tab started -- and it is followed instead
 * of reported as a failure: its answer is the one the admin asked for anyway. Null once `signal` aborts: the page
 * that asked has gone, and it stops asking.
 */
export async function checkAllSources(
  call: Call, onProgress?: (p: SourceCheckProgress) => void, everyMs = 2000, signal?: AbortSignal,
): Promise<any | null> {
  let p: SourceCheckProgress;
  try {
    p = await call<SourceCheckProgress>(SOURCE_CHECK_PATH, { method: 'POST' });
  } catch (e: any) {
    if (e?.status !== 409) throw e;
    p = await call<SourceCheckProgress>(SOURCE_CHECK_PATH);
  }
  if (signal?.aborted) return null;
  onProgress?.(p);
  p = await follow(call, p, onProgress, everyMs, signal);
  return p.running || signal?.aborted ? null : ended(p);
}

/**
 * Follow a sweep somebody else started, if one is running: Providers opened in the middle of the daily check
 * shows its progress instead of an idle "Check all now" that would only answer 409. Null when none is running,
 * or when the page went away first.
 */
export async function followRunningCheck(
  call: Call, onProgress?: (p: SourceCheckProgress) => void, everyMs = 2000, signal?: AbortSignal,
): Promise<any | null> {
  const first = await call<SourceCheckProgress>(SOURCE_CHECK_PATH);
  if (!first.running || signal?.aborted) return null;
  onProgress?.(first);
  const p = await follow(call, first, onProgress, everyMs, signal);
  return p.running || signal?.aborted ? null : ended(p);
}

/** What a page does with a sweep it follows. */
export interface CheckAllHooks {
  /** A reading while it runs: the button's "Checking 7 of 40 · Manga Ball (EN)". */
  progress(p: SourceCheckProgress): void;
  /** The sweep's answer (the notice). Once per sweep per page. */
  done(result: any): void;
  /** The press could not start or follow a sweep. */
  failed(e: unknown): void;
  /** Nothing this page shows is running any more: the button is idle again. */
  idle(): void;
}
export interface CheckAllSession {
  /** On mount: follow a sweep already running, if there is one. */
  follow(): Promise<void>;
  /** "Check all now". */
  press(): Promise<void>;
  /** On unmount: stop asking, and say nothing more. */
  leave(): void;
}

/**
 * One visit to the Providers tab and the sweep it shows, with ONE owner of the sweep's answer: the follower the
 * visit starts with, or a press of "Check all now" -- never both, and neither once the tab is left.
 *
 * The admin page unmounts Providers on every tab switch. A press's loop kept polling after that until the sweep
 * ended (tens of minutes), and coming back started a follower for the same sweep, so the admin got the notice
 * twice; a press landing before the mount's first GET answered did the same. Now a press stops the visit's
 * follower first, and leaving stops both: whichever visit is on screen when the sweep ends says so, once.
 */
export function checkAllSession(call: Call, hooks: CheckAllHooks, everyMs = 2000): CheckAllSession {
  const visit = new AbortController();
  // The mount-time follower's own switch: a press takes the answer over, and leaving ends it too.
  const watching = new AbortController();
  let pressed = false;
  return {
    async follow() {
      let took = false;
      try {
        const r = await followRunningCheck(call, (p) => { took = true; hooks.progress(p); }, everyMs, watching.signal);
        if (r && !watching.signal.aborted) hooks.done(r);
      } catch { /* the button still works; its own press reports its own failure */ }
      // Only a follow that took the button over hands it back: a press meanwhile owns it itself.
      if (took && !watching.signal.aborted) hooks.idle();
    },
    async press() {
      if (pressed || visit.signal.aborted) return;
      pressed = true;
      watching.abort();
      try {
        const r = await checkAllSources(call, (p) => hooks.progress(p), everyMs, visit.signal);
        if (r && !visit.signal.aborted) hooks.done(r);
      } catch (e) {
        if (!visit.signal.aborted) hooks.failed(e);
      }
      pressed = false;
      if (!visit.signal.aborted) hooks.idle();
    },
    leave() {
      watching.abort();
      visit.abort();
    },
  };
}
