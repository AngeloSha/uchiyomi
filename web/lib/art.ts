// Generated cinematic key-art (Higgsfield), served from /public/art.
export const ART = {
  login: '/art/login.webp',
  // The login screen's cover wall. Built from this app's own key art by scripts/login-wall.py, NOT from the
  // library: the login screen is pre-auth, /img/* is 401 there, and a public page fed from the library would
  // walk straight past per-library grants, max_age_rating and the 18+ hide.
  loginWall: '/art/login-wall.webp',
  // A 5120-wide twin for high-DPI screens. Without it a 2K display at devicePixelRatio 2 asks for 5120
  // device pixels, gets 2560, and upscales -- which reads as a soft, pixelated backdrop no amount of
  // WebP quality fixes, because the loss is in the scaling rather than the encoding.
  loginWall2x: '/art/login-wall@2x.webp',
  splash: '/art/splash.webp',
  hero: '/art/hero.webp',
  section: '/art/section.webp',
  wrapped: '/art/wrapped.webp',
  emptyLibrary: '/art/empty-library.webp',
  emptyDownloads: '/art/empty-downloads.webp',
  emptyUpdates: '/art/empty-updates.webp',
};

/** Backdrop URL builder — shared by <Backdrop> and preloaders (e.g. the hero preloading its next slide). */
export const backdropUrl = (seriesId: string, opts: { hero?: boolean; wide?: boolean; version?: number } = {}) => {
  const params = [opts.version ? `av=${opts.version}` : '', opts.hero ? `style=hero&ar=${opts.wide ? 'wide' : 'tall'}` : ''].filter(Boolean).join('&');
  return `/img/series/${encodeURIComponent(seriesId)}/backdrop${params ? `?${params}` : ''}`;
};

/**
 * The automatic banner (v0.51.0): four crops of a series' own pages, which the server makes for a series with no
 * banner of its own. `seed` is the payload's `autoHero.seed`, so a new banner (Shuffle) is a new URL; `tall` asks for
 * the 2 x 2 frame a portrait hero needs, where a 3:1 strip would show the gap between its middle two panels.
 */
export const autoHeroUrl = (seriesId: string, seed: number, tall = false) =>
  `/img/series/${encodeURIComponent(seriesId)}/hero?v=${seed}${tall ? '&ar=tall' : ''}`;

/**
 * What a series' backdrop tries, in order, each the fallback of the one before: the automatic banner when the series
 * has one, then the server's backdrop (its AniList banner, or its cover over a blur of itself), then the genre art.
 * The server answers 404 for an automatic banner it cannot make, so a failure lands on today's look, never on nothing.
 */
export function backdropSources(
  seriesId: string | undefined,
  autoHero: { seed: number } | null | undefined,
  opts: { hero?: boolean; wide?: boolean; version?: number },
  fallback: string,
): string[] {
  if (!seriesId) return [fallback];
  const real = backdropUrl(seriesId, opts);
  return autoHero ? [autoHeroUrl(seriesId, autoHero.seed, !!opts.hero && !opts.wide), real, fallback] : [real, fallback];
}

// NOTE: `GENRE`, `genreArt()` and `genreGradient()` used to live here, with six generated key-art files
// mapped from about forty genre names. On a real library that is ninety-nine genres, so the same picture
// appeared under seven of them at once and fifty-six got a near-black gradient rectangle instead. /browse
// now builds every tile from the covers the library actually holds (`GET /api/genres/overview`), which
// cannot repeat and cannot be wrong, so the map, both functions and the six `genre-*.webp` files are gone.
//
// `genreBackdrop` below is a DIFFERENT and larger set (twelve wide banners) and is very much alive: it is
// <Backdrop>'s onError fallback on the series page, the home hero and both admin/profile heroes.

// Wide cinematic backdrop banners (clean, dark, no text) matched to a series' genre.
const BG: Record<string, string> = {
  action: 'action', adventure: 'action', 'martial arts': 'action', superhero: 'action', war: 'action', military: 'action',
  fantasy: 'fantasy', magic: 'fantasy', isekai: 'fantasy', dungeons: 'fantasy', demons: 'fantasy', reincarnation: 'fantasy', monsters: 'fantasy', mythology: 'fantasy',
  cultivation: 'murim', wuxia: 'murim', xianxia: 'murim', murim: 'murim',
  romance: 'romance', josei: 'romance', shoujo: 'romance', harem: 'romance', ecchi: 'romance', smut: 'romance',
  drama: 'drama', tragedy: 'drama', mature: 'drama',
  horror: 'horror', gore: 'horror',
  mystery: 'mystery', thriller: 'mystery', psychological: 'mystery', crime: 'mystery', detective: 'mystery',
  'sci-fi': 'scifi', 'science fiction': 'scifi', mecha: 'scifi', cyberpunk: 'scifi', game: 'scifi', system: 'scifi', apocalypse: 'scifi', 'video games': 'scifi',
  comedy: 'comedy', 'slice of life': 'comedy', cooking: 'comedy', school: 'comedy', 'school life': 'comedy', 'gender bender': 'comedy', music: 'comedy', food: 'comedy',
  historical: 'historical',
  supernatural: 'supernatural', ghosts: 'supernatural',
  sports: 'sports',
};
const BG_ALL = ['action', 'fantasy', 'romance', 'horror', 'scifi', 'comedy', 'drama', 'murim', 'historical', 'supernatural', 'mystery', 'sports'];

export function genreBackdrop(genres?: string[]): string {
  for (const g of genres ?? []) {
    const m = BG[g.toLowerCase().trim()];
    if (m) return `/art/bg/${m}.webp`;
  }
  const seed = genres?.[0] || 'yomi';
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % BG_ALL.length;
  return `/art/bg/${BG_ALL[h]}.webp`;
}

/** Stable dark gradient fallback for genres without bespoke art. */
export function genreGradient(genre: string): string {
  let h = 0;
  for (let i = 0; i < genre.length; i++) h = (h * 31 + genre.charCodeAt(i)) % 360;
  return `linear-gradient(135deg, hsl(${h} 55% 16%), hsl(${(h + 45) % 360} 50% 7%))`;
}
