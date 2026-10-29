import type { Series, SeriesTitleArt, TitleArtStyle } from './types';
import { keys } from './i18n';

export const TITLE_ART_STYLES = ['auto', 'action', 'fantasy', 'scifi', 'soft', 'noir', 'plain'] as const;
const LABELS = keys('Automatic style', 'Action', 'Fantasy', 'Science fiction', 'Romance and everyday life', 'Horror and mystery', 'Plain title');
export const TITLE_ART_STYLE_LABELS: Record<TitleArtStyle, string> = {
  auto: LABELS[0], action: LABELS[1], fantasy: LABELS[2], scifi: LABELS[3], soft: LABELS[4], noir: LABELS[5], plain: LABELS[6],
};

/** Stable priority, independent of the order in which metadata providers return genres. */
export function titleArtStyle(genres: readonly string[] = [], chosen: TitleArtStyle = 'auto'): Exclude<TitleArtStyle, 'auto'> {
  if (chosen !== 'auto') return chosen;
  const words = genres.map((g) => g.toLowerCase().replace(/[-_]/g, ' '));
  if (words.some((g) => /horror|mystery|thriller|psychological/.test(g))) return 'noir';
  if (words.some((g) => /romance|slice of life|comedy|iyashikei/.test(g))) return 'soft';
  if (words.some((g) => /sci.?fi|science fiction|mecha|cyberpunk|game/.test(g))) return 'scifi';
  if (words.some((g) => /fantasy|historical|supernatural|isekai/.test(g))) return 'fantasy';
  if (words.some((g) => /action|adventure|martial arts|sports|superhero/.test(g))) return 'action';
  return 'plain';
}

/** Letter spacing and decorative Latin fonts must not interfere with connected Arabic/Hebrew or CJK text. */
export const titleNeedsNaturalScript = (title: string): boolean => /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u.test(title);

/** A light accent remains readable even when the cover's dominant colour is nearly black. */
export function titleArtAccent(color?: string | null): string {
  const hex = color?.replace(/^#/, '') ?? '';
  if (!/^[a-f\d]{6}$/i.test(hex)) return '193 176 255';
  return [0, 2, 4].map((n) => Math.round(parseInt(hex.slice(n, n + 2), 16) * 0.36 + 255 * 0.64)).join(' ');
}

/** Only the authenticated image route belongs in a hero, never an untrusted remote artwork URL. */
export function titleLogoUrl(id: string, art?: SeriesTitleArt): string | null {
  if (!art || art.mode === 'text' || !art.logoUrl) return null;
  const root = `/img/series/${encodeURIComponent(id)}/logo`;
  return art.logoUrl === root || art.logoUrl.startsWith(root + '?') ? art.logoUrl : null;
}

/** Unclassified artwork is never assumed to be readable English. */
export const titleLogoNeedsCaption = (art?: SeriesTitleArt): boolean => !!art && (art.showReadableTitle || art.language !== 'en');

export const TITLE_ART_POLL_MS = 2500;
export const TITLE_ART_POLL_LIMIT_MS = 60_000;
export function titleArtPending(series: readonly Pick<Series, 'titleArt'>[]): boolean {
  return series.some((s) => s.titleArt?.status === 'pending');
}
export const titleArtPollAllowed = (startedAt: number, now: number): boolean => now >= startedAt && now - startedAt < TITLE_ART_POLL_LIMIT_MS;
