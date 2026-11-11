import { normTitle } from './titleMatch';

const EDITION_WORD = /official|colou?red|colou?r|full|digital|manhwa|manhua|manga|webtoon|webcomic|comics?|edition|uncensored|fan|english|eng|hd|hq/g;
const SEQUEL_MARK = /\d|season|part|novel|ragnarok|super|arc|gaiden|sequel|prequel|spinoff|sidestory|next|before|after|chapter|vol|fanbook|anthology|artbook/;
const ROMAN_NUMERAL = /^(ii|iii|iv|vi|vii|viii|ix)$/;

/** Same attention rule as web/lib/importBatch: a title substring is not proof of the same work. */
export function importContainsDiverges(title: string, matchTitle: string): boolean {
  const a = normTitle(title), b = normTitle(matchTitle);
  if (!a || !b || a === b) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (!long.startsWith(short)) return true;
  const extra = long.slice(short.length);
  if (!extra.replace(EDITION_WORD, '')) return false;
  return SEQUEL_MARK.test(extra) || ROMAN_NUMERAL.test(extra) || extra.length > short.length;
}

/** Persist this on automatic suggestions; only the explicit manual-pick route can confirm one. */
export function importMatchNeedsReview(row: {
  confidence: string | null; backup_title: string; alt_titles?: string[] | null; match_title: string | null;
  backup_url?: string | null; backup_source_id_unsigned?: string | null; backup_source_id_signed?: string | null; match_source?: string | null;
}): boolean {
  // Older rows can predate path-conflict review. A home-source title suggestion without the saved
  // identity proof still needs confirmation, even when the two titles happen to be spelled exactly alike.
  if (row.confidence !== 'same_source' && row.backup_url?.trim().replace(/\//g, '') && row.match_source &&
    [row.backup_source_id_unsigned, row.backup_source_id_signed].some((id) => !!id && row.match_source === `sw:${id}`)) return true;
  if (row.confidence === 'fuzzy') return true;
  return row.confidence === 'contains' && (!row.match_title ||
    [row.backup_title, ...(row.alt_titles ?? [])].every((t) => importContainsDiverges(t, row.match_title!)));
}
