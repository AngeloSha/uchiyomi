import { READ_NUMBERS_MAX, type BackupEntry, type BackupTracker } from './tachibk';
import { normTitle } from './titleMatch';

export interface ImportEntry extends BackupEntry {
  altTitles?: string[];
  tracker?: BackupTracker['provider'];
  externalId?: string;
  progress?: number;
  private?: boolean;
}
const providers = new Set(['anilist', 'myanimelist', 'kitsu', 'mangaupdates']);
export const IMPORT_ENTRY_MAX = 10_000;
export function trackerLinksOf(row: { tracker_links?: unknown; trackerLinks?: unknown; tracker?: string | null; external_id?: string | null; externalId?: string; progress?: number | null; backup_title?: string; title?: string }): BackupTracker[] {
  const raw = row.tracker_links ?? row.trackerLinks;
  const list = Array.isArray(raw) ? raw : [];
  const out: BackupTracker[] = [];
  for (const link of list.slice(0, 16)) {
    if (!link || !providers.has(link.provider) || !/^\d{1,16}$/.test(String(link.externalId)) || !(Number(link.externalId) > 0) || !Number.isSafeInteger(Number(link.externalId))) continue;
    if (out.some(v => v.provider === link.provider && v.externalId === String(link.externalId))) continue;
    out.push({ provider: link.provider, externalId: String(link.externalId), title: String(link.title ?? row.title ?? row.backup_title ?? '').slice(0, 300),
      progress: Number.isFinite(link.progress) ? Math.max(0, Math.min(2_147_483_647, Math.floor(link.progress))) : 0, private: link.private === true });
  }
  if (!out.length && row.tracker && (row.external_id || row.externalId) && providers.has(row.tracker)) {
    // Legacy rows contain trusted adapter output; untrusted backup identities are validated above.
    out.push({ provider: row.tracker as BackupTracker['provider'], externalId: (row.external_id || row.externalId)!, title: row.backup_title || row.title || '', progress: row.progress ?? 0, private: false });
  }
  return out;
}
/**
 * An entry's read chapters as a batch keeps them (#433): finite, 0 to 1e6 -- the range the mark route holds a `real` to
 * (routes/catalog.ts) -- each once, ascending, at most READ_NUMBERS_MAX. The parser already answers so; this is for the
 * JSON a continued batch reads back (remaining_entries), which is the database's word rather than the file's.
 */
export function readNumbersOf(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const out = new Set<number>();
  for (const v of raw) {
    if (out.size >= READ_NUMBERS_MAX) break;
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1e6) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}
export function importSkipKeys(row: Parameters<typeof trackerLinksOf>[0]): string[] {
  const links = trackerLinksOf(row);
  if (links.length) return links.map(v => `t:${v.provider}:${v.externalId}`);
  const key = normTitle(row.backup_title || row.title || '');
  return key ? [`n:${key}`] : [];
}
/** JSON snapshots retain no tokens, arbitrary properties or remote URLs beyond the original source-relative identity. */
export function normalizeImportEntries(raw: unknown): ImportEntry[] {
  if (!Array.isArray(raw) || raw.length > IMPORT_ENTRY_MAX) throw new Error('too_many_titles');
  return raw.map((row): ImportEntry => {
    if (!row || typeof row.title !== 'string' || !row.title.trim()) throw new Error('invalid_import_entry');
    const title = row.title.trim().slice(0, 300);
    const trackerLinks = trackerLinksOf(row);
    const altTitles = [...(Array.isArray(row.altTitles) ? row.altTitles : []), ...trackerLinks.map(t => t.title)]
      .filter((v): v is string => typeof v === 'string' && !!normTitle(v) && normTitle(v) !== normTitle(title));
    const seen = new Set<string>();
    const readNumbers = readNumbersOf(row.readNumbers);
    return { title, ...(row.sourceIdUnsigned ? { sourceIdUnsigned: String(row.sourceIdUnsigned).slice(0, 30) } : {}),
      ...(readNumbers.length ? { readNumbers } : {}),
      ...(row.sourceIdSigned ? { sourceIdSigned: String(row.sourceIdSigned).slice(0, 30) } : {}),
      ...(row.url ? { url: String(row.url).slice(0, 16384) } : {}),
      altTitles: altTitles.filter(v => { const key = normTitle(v); if (seen.has(key)) return false; seen.add(key); return true; }).slice(0, 3).map(v => v.slice(0, 300)),
      ...(row.tracker && providers.has(row.tracker) ? { tracker: row.tracker, externalId: row.externalId, progress: Math.max(0, Math.floor(row.progress || 0)) } : {}),
      ...(trackerLinks.length ? { trackerLinks } : {}), ...(row.private===true ? {private:true} : {}) };
  });
}
