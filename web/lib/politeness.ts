/**
 * The numbers under Admin → Settings → Downloads → Downloads & politeness, the part with no React in it so a test can hold the rules.
 */

// ---- GET /api/admin/limits ----------------------------------------------------------------------------------------------

export interface Limit { key: string; value: number; unit: 'count' | 'ms' | 'bytes' | 'files' }

/** How a limit is said: a plain number, seconds, or gigabytes -- which the component then puts in the reader's words. */
export function limitParts(l: Pick<Limit, 'value' | 'unit'>): { kind: 'plain' | 's' | 'gb'; n: string } {
  const round = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
  if (l.unit === 'ms') return { kind: 's', n: round(l.value / 1000) };
  if (l.unit === 'bytes') return { kind: 'gb', n: round(l.value / 2 ** 30) };
  return { kind: 'plain', n: String(l.value) };
}
