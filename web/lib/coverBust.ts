// A cover changed on this device shows at once, everywhere.
//
// A series' thumbnail has a stable address that the browser may hold for a day (the server's cache-control), and the
// lists that draw it (library, home, search) do not carry the series' art version the series page busts it with. So a
// cover picked a moment ago kept showing its old picture on every card until the browser let go of it. The id is
// remembered here with the time of the change and `Img` adds that to the address of its thumbnail, which makes it a new
// address: the card fetches the new picture, and keeps doing so after a reload (the record lives in localStorage).
import { useSyncExternalStore } from 'react';

const KEY = 'yomi.coverBust';
/** Longer than the browser's stale-while-revalidate window for a thumbnail (a day plus a week). */
const KEEP_MS = 9 * 24 * 3600_000;
const MAX = 300;

const THUMB = /^\/img\/series\/([^/?]+)\/thumb(\?.*)?$/;

let marks: Record<string, number> = {};
let version = 0;
const listeners = new Set<() => void>();

function load(): void {
  if (typeof window === 'undefined') return;
  try {
    const raw = JSON.parse(window.localStorage.getItem(KEY) || '{}') as Record<string, unknown>;
    const now = Date.now();
    for (const [id, at] of Object.entries(raw)) if (typeof at === 'number' && now - at < KEEP_MS) marks[id] = at;
    if (Object.keys(marks).length) version = 1;
  } catch { /* unreadable: nothing remembered */ }
}
load();

/** This series' cover has just changed: every thumbnail of it is fetched again, from now on. */
export function bustCover(seriesId: string): void {
  if (!seriesId) return;
  marks[seriesId] = Date.now();
  const entries = Object.entries(marks).sort((a, b) => b[1] - a[1]).slice(0, MAX);
  marks = Object.fromEntries(entries);
  version++;
  try { window.localStorage.setItem(KEY, JSON.stringify(marks)); } catch { /* private mode: this tab still shows it */ }
  for (const l of listeners) l();
}

/** The address of a series thumbnail with the change time of its cover added; any other address is returned as it came. */
export function withCoverBust(src: string): string {
  const m = THUMB.exec(src);
  if (!m) return src;
  const at = marks[decodeURIComponent(m[1])];
  return at ? `${src}${m[2] ? '&' : '?'}cb=${at}` : src;
}

/** Re-renders the caller when a cover changes; the value is only a render key. */
export function useCoverBust(): number {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    () => version,
    () => 0,
  );
}
