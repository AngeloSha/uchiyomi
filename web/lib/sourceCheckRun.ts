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

/**
 * Start the sweep, follow it until it ends, and return its result. `onProgress` sees every reading (the first is
 * the POST's own answer), so a page can show "7 of 40 · Manga Ball (EN)" while it runs.
 */
export async function checkAllSources(
  call: Call, onProgress?: (p: SourceCheckProgress) => void, everyMs = 2000,
): Promise<any> {
  let p = await call<SourceCheckProgress>(SOURCE_CHECK_PATH, { method: 'POST' });
  onProgress?.(p);
  while (p.running) {
    await new Promise((r) => setTimeout(r, everyMs));
    p = await call<SourceCheckProgress>(SOURCE_CHECK_PATH);
    onProgress?.(p);
  }
  if (!p.result) throw new Error(p.error || 'The check did not finish');
  return p.result;
}
