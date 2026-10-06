import { api } from './api';

let inflight = false;

/**
 * What a scan said (v0.49.0). `scanned: false` with a reason, instead of every refusal and failure folded
 * into one silent `false`: the admin's "Scan library now" used to drop the answer entirely, so a scan
 * refused because one ran a minute ago looked exactly like a scan that found nothing. The counts come from
 * the owned library's scan (POST /api/refresh); a Komga-backed server answers without them.
 */
export interface RefreshAnswer {
  scanned: boolean;
  reason?: 'rate_limited' | 'in_flight' | 'error';
  /** v0.55.6: why the scan failed, in the server's words (an admin's answer only). */
  message?: string;
  series?: number;
  books?: number;
  ms?: number;
  /** Folders the scan could not index; Health's Library scan card names them. */
  skipped?: number;
  /** v0.55.6: the scan was still running when the server answered, started at `since` by the server's clock. */
  running?: boolean;
  since?: string;
}

/** How far the running scan has got (bff lib/library.ts ScanProgress). */
export interface ScanProgress { startedAt: string; phase: 'waiting' | 'walking' | 'indexing' | 'finishing'; done: number; total: number }

/** GET /api/refresh (v0.55.6): whether a scan runs; for an admin also its progress, how the last ended, and the server's clock. */
export interface ScanStatus {
  running: boolean;
  now?: string;
  progress?: ScanProgress;
  last?: { at: string; series: number; books: number; ms: number; skipped: number };
  failed?: { at: string; message: string };
}

/** How often a running scan is asked after, how long it is followed at most, and how many status reads may fail in a row. */
export const followTiming = { everyMs: 2000, maxMs: 60 * 60_000, misses: 5 };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Ask the BFF to rescan the library (and, on Komga, to pick up new Suwayomi chapters), and follow the scan to its
 * end (v0.55.6, #150). The server answers within seconds now, `running` when the scan takes longer; the scan is then
 * followed through GET /api/refresh, `onProgress` hearing how far it has got. A request cut off on the way -- the
 * proxy in front of the server giving up on a long one, which every press of a big library's scan met on v0.55.4
 * and read "Scan failed" -- is not the scan failing either: the scan it started is followed all the same.
 */
export async function triggerRefresh(onProgress?: (p: ScanProgress) => void): Promise<RefreshAnswer> {
  if (inflight) return { scanned: false, reason: 'in_flight' };
  inflight = true;
  const asked = Date.now();
  try {
    let r: RefreshAnswer | null = null;
    try {
      r = await api<RefreshAnswer>('/api/refresh', { method: 'POST' });
    } catch {
      r = null;
    }
    if (r && !r.running) return r;
    return await followScan(r?.since ?? null, asked, onProgress);
  } finally {
    inflight = false;
  }
}

/**
 * The scan running on the server, followed to its end: its counts, or why it failed. `since` is when the server
 * started it, by the server's clock; when the POST was cut off it has none, and the start is worked out from the
 * server's `now` less the time since the press, measured here -- the two clocks are never compared with each other.
 * A member's status says only whether a scan runs: once it has ended, the answer is "scanned", without counts.
 * Reintroduce "Scan failed" for a cut-off request (return the error when the POST throws): "a request cut off on the
 * way follows the scan it started" in refreshFollow.test.ts reads the failure.
 */
export async function followScan(since: string | null, asked: number, onProgress?: (p: ScanProgress) => void): Promise<RefreshAnswer> {
  let from = since ? Date.parse(since) : null;
  let misses = 0;
  let ran = !!since;
  while (Date.now() - asked < followTiming.maxMs) {
    let s: ScanStatus;
    try {
      s = await api<ScanStatus>('/api/refresh');
      misses = 0;
    } catch {
      if (++misses >= followTiming.misses) return { scanned: false, reason: 'error' };
      await sleep(followTiming.everyMs);
      continue;
    }
    // A second of slack: the press and the server's start are not the same instant.
    if (from === null && s.now) from = Date.parse(s.now) - (Date.now() - asked) - 1000;
    if (s.running) {
      ran = true;
      if (s.progress) onProgress?.(s.progress);
      await sleep(followTiming.everyMs);
      continue;
    }
    const after = (at?: string) => !!at && from !== null && Date.parse(at) >= from;
    const lastAt = s.last ? Date.parse(s.last.at) : -Infinity;
    if (s.failed && after(s.failed.at) && Date.parse(s.failed.at) >= lastAt) return { scanned: false, reason: 'error', message: s.failed.message };
    if (s.last && after(s.last.at)) return { scanned: true, series: s.last.series, books: s.last.books, ms: s.last.ms, skipped: s.last.skipped };
    // Nothing that ended since the press: a member's status, after a scan it saw run, or a request that never started one.
    return ran ? { scanned: true } : { scanned: false, reason: 'error' };
  }
  return { scanned: true, running: true };
}
