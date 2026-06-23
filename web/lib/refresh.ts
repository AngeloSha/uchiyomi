import { api } from './api';

let inflight = false;

/** Ask the BFF to trigger a Komga rescan (picks up new Suwayomi chapters). */
export async function triggerRefresh(): Promise<{ scanned: boolean }> {
  if (inflight) return { scanned: false };
  inflight = true;
  try {
    return await api<{ scanned: boolean }>('/api/refresh', { method: 'POST' });
  } catch {
    return { scanned: false };
  } finally {
    inflight = false;
  }
}
