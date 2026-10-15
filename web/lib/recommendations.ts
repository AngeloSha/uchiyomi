// What /api/discover/recommendations answers, and the small rules the rail applies to it.

export interface Recommendation {
  title: string;
  altTitles: string[];
  cover: string | null;
  /** 0-100 community score, when a service gave one. */
  score: number | null;
  /** Each service that suggested it, and the series of the person's own that its suggestion came from. */
  sources: Array<{ provider: string; label: string; because: string; url: string | null }>;
}
export interface Recommendations {
  content: Recommendation[];
  sources: Array<{ provider: string; label: string; listed: number; seeds: number }>;
  /** A refresh is still running on the server; asking again shows more. */
  pending: boolean;
}

const SHORT: Record<string, string> = { anilist: 'AniList', myanimelist: 'MAL', kitsu: 'Kitsu' };

/** The card's corner badge: where the suggestion came from, short enough for a 9rem card. */
export const badgeOf = (r: Recommendation): string =>
  r.sources.map((s) => SHORT[s.provider] ?? s.label).join(' · ');

/** The series of the person's own that the first-named service built this from. */
export const becauseOf = (r: Recommendation): string | null => r.sources[0]?.because || null;

/** Every service and seed, for a tooltip: "AniList: Berserk · MyAnimeList: Vagabond". */
export const provenance = (r: Recommendation): string => r.sources.map((s) => `${s.label}: ${s.because}`).join(' · ');

/**
 * How long to wait before asking again. Only while the server says a refresh is still running, a few times
 * and no more: a service that is slow today must not turn an open tab into a poll.
 */
export const POLL_MS = 6000;
export const POLL_MAX = 6;
export function pollAfter(data: Recommendations | undefined, updates: number): number | false {
  return data?.pending && updates < POLL_MAX ? POLL_MS : false;
}
