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
  series?: number;
  books?: number;
  ms?: number;
  /** Folders the scan could not index; Health's Library scan card names them. */
  skipped?: number;
}

/** Ask the BFF to rescan the library (and, on Komga, to pick up new Suwayomi chapters). */
export async function triggerRefresh(): Promise<RefreshAnswer> {
  if (inflight) return { scanned: false, reason: 'in_flight' };
  inflight = true;
  try {
    const r = await api<RefreshAnswer>('/api/refresh', { method: 'POST' });
    return r ?? { scanned: false, reason: 'error' };
  } catch {
    return { scanned: false, reason: 'error' };
  } finally {
    inflight = false;
  }
}
