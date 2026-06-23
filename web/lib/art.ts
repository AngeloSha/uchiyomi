// Generated cinematic key-art (Higgsfield), served from /public/art.
export const ART = {
  login: '/art/login.webp',
  splash: '/art/splash.webp',
  hero: '/art/hero.webp',
  section: '/art/section.webp',
  wrapped: '/art/wrapped.webp',
  emptyLibrary: '/art/empty-library.webp',
  emptyDownloads: '/art/empty-downloads.webp',
  emptyUpdates: '/art/empty-updates.webp',
};

const GENRE: Record<string, string> = {
  action: 'action', adventure: 'action', 'martial arts': 'action', superhero: 'action', war: 'action', military: 'action',
  fantasy: 'fantasy', magic: 'fantasy', cultivation: 'fantasy', supernatural: 'fantasy', demons: 'fantasy', reincarnation: 'fantasy', isekai: 'fantasy', dungeons: 'fantasy', monsters: 'fantasy',
  romance: 'romance', drama: 'romance', josei: 'romance', shoujo: 'romance', harem: 'romance', ecchi: 'romance',
  horror: 'horror', thriller: 'horror', mystery: 'horror', psychological: 'horror', tragedy: 'horror', crime: 'horror', gore: 'horror',
  'sci-fi': 'scifi', 'science fiction': 'scifi', mecha: 'scifi', game: 'scifi', system: 'scifi', apocalypse: 'scifi', cyberpunk: 'scifi', 'video games': 'scifi',
  comedy: 'comedy', 'slice of life': 'comedy', cooking: 'comedy', school: 'comedy', 'school life': 'comedy', sports: 'comedy', historical: 'comedy', 'gender bender': 'comedy', music: 'comedy',
};

export function genreArt(genre: string): string | null {
  const m = GENRE[genre.toLowerCase().trim()];
  return m ? `/art/genre-${m}.webp` : null;
}

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
