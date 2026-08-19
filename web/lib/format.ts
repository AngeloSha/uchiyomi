export function bytes(n?: number | null): string {
  if (!n || n <= 0) return '0 MB';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}

export function progressOf(b: { media: { pagesCount: number }; readProgress?: { page: number; completed: boolean } | null }): number {
  if (!b.readProgress) return 0;
  if (b.readProgress.completed) return 1;
  const total = b.media?.pagesCount || 0;
  return total ? Math.min(1, b.readProgress.page / total) : 0;
}

// Volume-style archives ("Tome 01.cbr", "Berserk T41", "v01") should read "Vol. N", not "Ch. N".
// Chapter markers win so release-version suffixes ("Ch. 5 v2") stay chapters.
const CHAPTER_MARK = /\b(?:ch(?:ap(?:ter|itre)?)?|episode|ep)\b\.?\s*\d/i;
const VOLUME_WORD = /\b(?:tome|volume|vol)\.?\s*\d/i;
const VOLUME_SHORT = /\b[tv]\.?\s?\d/i; // T05 / v01 / t.3 — boundary keeps "Titan 05" a chapter
export function isVolumeName(name?: string | null): boolean {
  return !!name && !CHAPTER_MARK.test(name) && (VOLUME_WORD.test(name) || VOLUME_SHORT.test(name));
}

export function chapterLabel(b: { metadata?: { number?: string; title?: string }; number?: number; name?: string }): string {
  const n = b.metadata?.number ?? (b.number != null ? String(b.number) : '');
  if (n) return isVolumeName(b.name || b.metadata?.title) ? `Vol. ${n}` : `Ch. ${n}`;
  return b.name || '';
}

export function relativeTime(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso).getTime();
  const diff = Date.now() - d;
  const m = Math.round(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.round(h / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}
