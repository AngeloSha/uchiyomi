// The series page's ratings panel, the parts that decide (v0.60.0): what a tap on a star does, the request that stores
// it, and what AniList's tile shows. components/RatingsPanel.tsx draws them; test/ratingsPanel.test.ts holds them.
//
// The owner asked for the rating to be said once and to look better: AniList's score and the reader's own stars had
// been said up to three times on one page (a chip over the banner, the meta line, the line under the stars).
import { compactText } from './format';
import { t as tr } from './i18n';
import type { AniListNumbers } from './types';

/**
 * What a tap on star `tapped` makes the rating: that many stars -- or none, when it is the rating already. Tapping
 * your current star again is how a rating is taken back; there was no way to do it before (the server's
 * `DELETE /api/ratings/:seriesId` existed and the web never called it).
 */
export const nextRating = (current: number | null | undefined, tapped: number): number | null =>
  (current === tapped ? null : tapped);

/** The request that stores `next` for a series: PUT with the stars, or DELETE to clear it. */
export function ratingRequest(seriesId: string, next: number | null): { path: string; init: { method: 'PUT' | 'DELETE'; json?: { stars: number } } } {
  const path = `/api/ratings/${encodeURIComponent(seriesId)}`;
  return next === null ? { path, init: { method: 'DELETE' } } : { path, init: { method: 'PUT', json: { stars: next } } };
}

/** What AniList's tile shows: the score out of 100, how many people list it, and the entry's page when the id is known. */
export interface AniListTile {
  /** 0-100, whole; null when AniList has no average (too few ratings yet). */
  score: number | null;
  /** How many AniList users list it; null (or 0) when unknown. */
  popularity: number | null;
  /** `https://anilist.co/manga/<id>`, or null without an id (a server older than v0.60.0). */
  url: string | null;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * `yomi.anilist` as the server sends it, made safe to draw -- or null when there is no tile to draw: no checked AniList
 * link (null), a server older than v0.58.0 (absent), or neither number known yet. Read here rather than through
 * lib/sortValue.ts `anilistNumbers`, which keeps only the two numbers: the tile needs the id as well. An id that is not
 * an AniList id (digits) is not linked.
 */
export function anilistTile(raw: AniListNumbers | null | undefined): AniListTile | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = num(raw.score);
  const p = num(raw.popularity);
  // A popularity of 0 says nothing either: no one lists it, and the tile would be a bare "0".
  if (s === null && !p) return null;
  const rawId: unknown = raw.id;
  const id = typeof rawId === 'number' ? String(rawId) : typeof rawId === 'string' ? rawId.trim() : '';
  return {
    score: s === null ? null : Math.min(100, Math.max(0, Math.round(s))),
    popularity: p === null ? null : Math.max(0, Math.round(p)),
    url: /^\d+$/.test(id) ? `https://anilist.co/manga/${id}` : null,
  };
}

/** A count shortened the reader's way ("287K", "28,7 k", "29万"), isolated as the other AniList counts are. */
const countOf = (n: number): string => `⁨${compactText(n)}⁩`;

/** "287K readers", one of a pair: "1 reader". */
export const readersText = (popularity: number): string =>
  (popularity === 1 ? tr('1 reader') : tr('{n} readers', { n: countOf(popularity) }));

/**
 * The tile's name for a screen reader, in the app's own words for each number: "84% on AniList · 287K readers". The
 * tile itself shows the score large over "/ 100", which is no sentence.
 */
export function anilistTileName(tile: AniListTile): string {
  const parts: string[] = [];
  if (tile.score !== null) parts.push(tr('{score}% on AniList', { score: tile.score }));
  if (tile.popularity) parts.push(tile.score !== null ? readersText(tile.popularity) : tr('{count} on AniList', { count: countOf(tile.popularity) }));
  return parts.join(' · ');
}
