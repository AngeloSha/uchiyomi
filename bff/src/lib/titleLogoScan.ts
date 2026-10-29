// Full-library title discovery is an opt-in, paced background scan. Per-series results are its durable cursor:
// an interrupted scan resumes from unchecked identities, and real misses/provider failures retain their own deadlines.
import { q, one } from './db';
import { FIRST_PAGE } from './seriesArt';
import { visibleToAll } from './visibility';
import { runtime } from './runtime';
import { cancelAutomaticTitleLogoQueue, pruneAutomaticTitleLogoQueue, queueTitleLogos, resumeTitleLogoQueue, titleLogoQueueState } from './titleArt';

// A raw default lookup_status='missing' without a matching lookup identity has never completed a lookup.
const FACTS = `WITH facts AS (
 SELECT s.id, COALESCE(a.mode,'automatic') AS mode, a.lookup_status, a.lookup_anilist_id, a.retry_at,
   t.external_id AS anilist_id, COALESCE(l.anilist_lookup,false) AS library_online,
   COALESCE(o.cover=$1,false) AS first_page,
   (t.external_id ~ '^[1-9][0-9]{0,15}$') IS TRUE AS checked_link,
   (a.auto_file IS NOT NULL AND a.auto_anilist_id=t.external_id AND (COALESCE(o.cover<>$1,true) OR a.auto_manual)) IS TRUE AS saved_logo,
   (a.lookup_anilist_id=t.external_id) IS TRUE AS current_attempt
 FROM lib_series s LEFT JOIN series_title_art a ON a.series_id=s.id
 LEFT JOIN series_trackers t ON t.series_id=s.id AND t.provider='anilist'
   AND (t.linked_by IS NOT NULL OR t.checked_at IS NOT NULL)
 LEFT JOIN libraries l ON l.id=s.library_id LEFT JOIN series_overrides o ON o.series_id=s.id
 WHERE ${visibleToAll('s')}
), scoped AS (
 SELECT *, (mode='automatic' AND checked_link AND library_online AND NOT first_page) AS eligible,
 CASE WHEN mode='custom' THEN 'custom' WHEN mode='text' THEN 'text' WHEN saved_logo THEN 'ready'
      WHEN current_attempt AND lookup_status='error' THEN 'error'
      WHEN current_attempt AND lookup_status='missing' THEN 'missing' ELSE 'unchecked' END AS state
 FROM facts
), due AS (
 SELECT *, (eligible AND NOT saved_logo AND (NOT current_attempt OR retry_at IS NULL OR retry_at<=now())) AS due_now
 FROM scoped
)
`;
interface CountRow {
  total: number; ready: number; missing: number; error: number; unchecked: number; custom: number; text: number;
  eligible: number; needsLink: number; libraryOptOut: number; firstPage: number; due: number; checked: number; next_retry: Date | null;
}
export interface TitleLogoScanStatus {
  enabled: boolean; running: boolean;
  counts: Omit<CountRow, 'checked' | 'next_retry'> & { pending: number };
  checked: number; nextRetryAt: string | null; providerRetryAt: string | null; lastScanAt: string | null;
}
type Log = { info(message: string): void; warn(message: string): void };
const QUIET_LOG: Log = { info() {}, warn() {} };
let batch: Promise<number> | null = null;
let lastScanAt: string | null = null;
let controller: { wake(): void; stop(): void } | null = null;
let scanGeneration = 0;
const future = (v: Date | string | null | undefined): number => v ? Math.max(0, new Date(v).getTime()) : 0;

/** Read-only derived progress: no lookups, queueing, retry resets or file writes. */
export async function titleLogoScanStatus(): Promise<TitleLogoScanStatus> {
  const [settings, row] = await Promise.all([
    one<{ automatic_title_logos: boolean; title_logo_retry_at: Date | null }>('SELECT automatic_title_logos,title_logo_retry_at FROM server_settings WHERE id=1'),
    one<CountRow>(FACTS + `SELECT count(*)::int AS total,
      count(*) FILTER(WHERE state='ready')::int AS ready,
      count(*) FILTER(WHERE state='missing')::int AS missing,
      count(*) FILTER(WHERE state='error')::int AS error,
      count(*) FILTER(WHERE state='unchecked')::int AS unchecked,
      count(*) FILTER(WHERE state='custom')::int AS custom,
      count(*) FILTER(WHERE state='text')::int AS text,
      count(*) FILTER(WHERE eligible)::int AS eligible,
      count(*) FILTER(WHERE mode='automatic' AND NOT checked_link)::int AS "needsLink",
      count(*) FILTER(WHERE mode='automatic' AND NOT library_online)::int AS "libraryOptOut",
      count(*) FILTER(WHERE mode='automatic' AND first_page)::int AS "firstPage",
      count(*) FILTER(WHERE due_now)::int AS due,
      count(*) FILTER(WHERE current_attempt)::int AS checked,
      min(retry_at) FILTER(WHERE eligible AND NOT saved_logo AND current_attempt AND retry_at>now()) AS next_retry
      FROM due`, [FIRST_PAGE]),
  ]);
  const state = titleLogoQueueState();
  const enabled = settings?.automatic_title_logos === true;
  const providerAt = future(settings?.title_logo_retry_at);
  const providerWait = providerAt > Date.now() ? providerAt : 0;
  const retry = row?.due ? providerWait : Math.max(future(row?.next_retry), providerWait);
  const { checked, next_retry: _next, ...counts } = row!;
  return { enabled, running: !!batch || state.ids.length > 0 || state.active || (enabled && counts.due > 0),
    counts: { ...counts, pending: state.ids.length }, checked,
    nextRetryAt: enabled && retry > Date.now() ? new Date(retry).toISOString() : null,
    providerRetryAt: providerWait ? new Date(providerWait).toISOString() : null, lastScanAt };
}

/** One bounded refill. Completed results/retry deadlines in PostgreSQL ensure >128 titles and restarts continue. */
export async function scanTitleLogos(options: { retryMissing?: boolean } = {}): Promise<number> {
  if (batch) { await batch; return options.retryMissing ? scanTitleLogos(options) : 0; }
  const generation = scanGeneration;
  const run = async () => {
    const settings = await one<{ automatic_title_logos: boolean }>('SELECT automatic_title_logos FROM server_settings WHERE id=1');
    if (!settings?.automatic_title_logos || runtime.stopping) { cancelAutomaticTitleLogoQueue(); return 0; }
    await pruneAutomaticTitleLogoQueue();
    if (options.retryMissing) {
      await q(FACTS + `UPDATE series_title_art a SET retry_at=NULL FROM due d
        WHERE a.series_id=d.id AND d.eligible AND d.state='missing' AND d.current_attempt`, [FIRST_PAGE]);
    }
    const state = titleLogoQueueState(); const room = Math.max(0, state.capacity - state.ids.length);
    let ids: string[] = [];
    if (room) ids = (await q<{ id: string }>(FACTS + `SELECT id FROM due WHERE due_now AND id<>ALL($2::text[])
      ORDER BY current_attempt, retry_at NULLS FIRST, id LIMIT $3`, [FIRST_PAGE, state.ids, room])).map((r) => r.id);
    if (!runtime.stopping && generation === scanGeneration) { await queueTitleLogos(ids); resumeTitleLogoQueue(); }
    lastScanAt = new Date().toISOString();
    return ids.length;
  };
  batch = run();
  try { return await batch; } finally { batch = null; }
}

/** Preserve an old version's still-active provider waits on the first upgrade to the full scanner. */
async function restoreProviderWait(): Promise<void> {
  await q(FACTS + `UPDATE server_settings SET title_logo_retry_at=(
      SELECT max(retry_at) FROM due WHERE eligible AND state='error' AND current_attempt AND retry_at>now())
    WHERE id=1 AND automatic_title_logos AND title_logo_retry_at IS NULL`, [FIRST_PAGE]);
}

export interface TitleLogoScanTimers {
  initialMs?: number; intervalMs?: number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}
/** Starts once at boot; timers are unreferenced and shutdown clears them plus outstanding automatic jobs. */
export function startTitleLogoScan(log: Log = QUIET_LOG, timers: TitleLogoScanTimers = {}): () => void {
  controller?.stop();
  let timer: ReturnType<typeof setTimeout> | null = null; let stopped = false; let ticking = false;
  const set = timers.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clear = timers.clearTimer ?? clearTimeout;
  const arm = (ms: number) => {
    if (stopped || runtime.stopping) return;
    if (timer) clear(timer);
    timer = set(() => { timer = null; void tick(); }, ms); timer.unref?.();
  };
  const tick = async () => {
    if (stopped || runtime.stopping || ticking) return;
    ticking = true;
    try { await restoreProviderWait(); if (!stopped && !runtime.stopping) await scanTitleLogos(); }
    catch { log.warn('title logos: the library scan will retry'); }
    finally { ticking = false; if (!stopped && !runtime.stopping) arm(timers.intervalMs ?? 30_000); }
  };
  const own = { wake() { if (!stopped && !ticking) arm(0); }, stop() {
    stopped = true; scanGeneration++; if (timer) clear(timer); timer = null; cancelAutomaticTitleLogoQueue();
    if (controller === own) controller = null;
  } };
  controller = own;
  arm(timers.initialMs ?? 15_000);
  return own.stop;
}
/** Settings/explicit scan wake the existing schedule; they never create another background scheduler. */
export function wakeTitleLogoScan(): void { controller?.wake(); }
