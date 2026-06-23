// Best-effort engine detection for Add-a-site: fetch a site's homepage and sniff which family-engine it runs,
// so the user can just paste a URL. Returns the engine id, or null if it can't tell (then the user picks).
import { cfGet } from './flaresolverr';

export async function detectEngine(base: string): Promise<string | null> {
  let h = '';
  try { h = await cfGet(base.replace(/\/$/, '')); } catch { return null; }
  const has = (re: RegExp) => re.test(h);
  // MangaThemesia (WP-Mangastream): distinctive bsx/listupd/bixbox cards + ts_reader on chapter pages
  if (has(/class="bsx"/i) || has(/\bts_reader\b/) || has(/class="listupd"/i) || has(/\bbixbox\b/i)) return 'mangathemesia';
  // Madara (WordPress wp-manga theme)
  if (has(/wp-manga/i) || has(/themes\/madara/i)) return 'madara';
  // Manganato / Mangakakalot family
  if (has(/class="story_name"/i) || has(/content-homepage-item/i) || has(/panel-content-homepage/i) || has(/\/search\/story\//i)) return 'manganato';
  return null;
}
