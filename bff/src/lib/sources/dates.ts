// Best-effort parsing of the release dates manga sites print next to chapters. Handles absolute forms
// ("July 1, 2026", "Jul 01,2026 12:00", "2026-07-01") and the relative "N minutes/hours/days ago" style.
// Returns an ISO string, or undefined when the text isn't a date — callers treat the date as optional.
const UNIT_MS: Record<string, number> = {
  second: 1000, sec: 1000, min: 60_000, minute: 60_000, hour: 3_600_000, day: 86_400_000,
  week: 7 * 86_400_000, month: 30 * 86_400_000, year: 365 * 86_400_000,
};

export function parseWhen(raw?: string | null): string | undefined {
  const s = (raw || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  if (!s || s.length > 60) return undefined;
  const rel = s.match(/(\d+)\s*(second|sec|min(?:ute)?|hour|day|week|month|year)s?\s*ago/i);
  if (rel) return new Date(Date.now() - Number(rel[1]) * UNIT_MS[rel[2].toLowerCase().replace(/ute$/, '')]).toISOString();
  if (/^(today|new)$/i.test(s)) return new Date().toISOString();
  if (/^yesterday$/i.test(s)) return new Date(Date.now() - 86_400_000).toISOString();
  // "Jul 01,2026 12:00" (Manganato) needs a space after the comma for Date.parse
  const t = Date.parse(s.replace(/,(?=\S)/, ', '));
  if (!Number.isNaN(t) && t > Date.parse('1990-01-01') && t < Date.now() + 2 * 86_400_000) return new Date(t).toISOString();
  return undefined;
}
