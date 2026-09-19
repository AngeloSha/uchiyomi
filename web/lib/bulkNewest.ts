// Following the library bar's "Fetch newest" job: POST starts it on the server, GET reports it, and this is
// the loop between them. Kept out of app/library/page.tsx so the three ways it can end -- finished, lost,
// cancelled -- are decided in one place and can be driven by a unit test with a fake poll and no browser.

export type BulkNewestOutcome = 'downloaded' | 'up_to_date' | 'skipped' | 'failed';

/** What `GET /api/library/bulk/newest` answers. `results` is in the order the series were started. */
export interface BulkNewestStatus {
  running: boolean;
  done: number;
  total: number;
  startedAt?: string | null;
  results: { id: string; title?: string; outcome: BulkNewestOutcome; reason?: string }[];
}

/** How the follow ended. `status` is the last answer seen, if any. */
export interface BulkNewestEnd {
  outcome: 'finished' | 'lost' | 'cancelled';
  status: BulkNewestStatus | null;
}

/** Between polls, the same 2 s the series page waits on a source job. */
export const BULK_NEWEST_POLL_MS = 2000;
/** Unanswered polls in a row before the loop gives up. */
export const BULK_NEWEST_MAX_MISSES = 3;

/**
 * Read the job's status every `wait()` until `running` drops, three polls in a row go unanswered, or the
 * caller cancels.
 *
 * `finished` is the only outcome that carries a summary worth showing: `status.results` is complete. `lost`
 * means the server is gone or we are offline; the job itself carries on server-side, and the last status
 * seen -- if any -- is a PARTIAL one, because a poll that said `running: false` would have ended the loop
 * as `finished`. ⚠️ So a lost run is never summarised: "Fetched 1 chapter" over a status that still said
 * running reports a run that is still going as done, in success tone, and with results the next minute
 * will contradict. Until v0.37.0's fix pass the lost-track toast fired only when NO poll had ever
 * answered, and a partial status fell through to the summary. Reintroduce by returning `'finished'`
 * whenever `status` is non-null after the miss cap: "one poll answered then three misses is a lost run,
 * not a summary" in test/library.test.ts reads `finished`.
 *
 * `cancelled` is the bar's Cancel chip during a run: polling stops right away, nothing is reported, and
 * the job completes server-side (the GET stays available). `cancelled()` is read after every wait and
 * every poll so a tap lands within one interval even while a request is in flight.
 */
export async function followBulkNewest(opts: {
  poll: () => Promise<BulkNewestStatus | null>;
  onProgress?: (s: BulkNewestStatus) => void;
  wait?: () => Promise<void>;
  cancelled?: () => boolean;
}): Promise<BulkNewestEnd> {
  const wait = opts.wait ?? (() => new Promise<void>((r) => setTimeout(r, BULK_NEWEST_POLL_MS)));
  const cancelled = opts.cancelled ?? (() => false);
  let misses = 0;
  let last: BulkNewestStatus | null = null;
  for (;;) {
    await wait();
    if (cancelled()) return { outcome: 'cancelled', status: last };
    const st = await opts.poll().catch(() => null);
    if (cancelled()) return { outcome: 'cancelled', status: st ?? last };
    // Three unanswered polls in a row: the server is gone or we are offline. Stop asking rather than spin
    // forever with the bar frozen; the job itself carries on server-side.
    if (!st) { if (++misses >= BULK_NEWEST_MAX_MISSES) break; continue; }
    misses = 0;
    last = st;
    opts.onProgress?.(st);
    if (!st.running) return { outcome: 'finished', status: st };
  }
  // Only reachable through the miss cap, so whatever `last` holds still said `running: true`.
  return { outcome: 'lost', status: last };
}
