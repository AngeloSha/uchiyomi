// Best-effort sniffing for Add-a-site: fetch a site's homepage once and read which family-engine it runs and which
// language it says it is in, so the user can just paste a URL. Either is null when the page does not tell (then the
// user picks the engine; the language is the unstated one until the site's sheet says otherwise).
import { cfGet } from './flaresolverr';
import { editionLang } from '../lang';

export interface Sniffed { engine: string | null; lang: string | null }

export async function sniffSite(base: string): Promise<Sniffed> {
  let h = '';
  try { h = await cfGet(base.replace(/\/$/, '')); } catch { return { engine: null, lang: null }; }
  return { engine: engineOf(h), lang: siteLanguage(h) };
}

/** The engine a site's homepage runs, or null if it can't tell. */
export async function detectEngine(base: string): Promise<string | null> {
  return (await sniffSite(base)).engine;
}

function engineOf(h: string): string | null {
  const has = (re: RegExp) => re.test(h);
  // MangaThemesia (WP-Mangastream): distinctive bsx/listupd/bixbox cards + ts_reader on chapter pages
  if (has(/class="bsx"/i) || has(/\bts_reader\b/) || has(/class="listupd"/i) || has(/\bbixbox\b/i)) return 'mangathemesia';
  // Madara (WordPress wp-manga theme)
  if (has(/wp-manga/i) || has(/themes\/madara/i)) return 'madara';
  // Manganato / Mangakakalot family
  if (has(/class="story_name"/i) || has(/content-homepage-item/i) || has(/panel-content-homepage/i) || has(/\/search\/story\//i)) return 'manganato';
  return null;
}

const TAG = '([A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*)';
const HTML_LANG = new RegExp(`<html\\b[^>]*?[\\s:]lang\\s*=\\s*["']?${TAG}`, 'i');
const META = /<meta\b[^>]*>/gi;
const OG_LOCALE = /\bproperty\s*=\s*["']og:locale["']/i;
const CONTENT = new RegExp(`\\bcontent\\s*=\\s*["']${TAG}["']`, 'i');

/** The language a page says it is in: its `<html lang>`, else its og:locale, as a source's code (lib/lang.ts editionLang). */
export function pageLanguage(h: string): string | null {
  const tag = HTML_LANG.exec(h)?.[1]
    ?? (h.match(META) ?? []).filter((m) => OG_LOCALE.test(m)).map((m) => CONTENT.exec(m)?.[1]).find(Boolean);
  return tag ? editionLang(tag) : null;
}

/**
 * The language a site added by address is stored with (v0.62.0): the page's, except English. WordPress writes the
 * install's language into every page, and an install left at its default says en-US whatever it hosts, so English
 * from a page says nothing -- and storing it would read a Spanish site as English even on a server whose sites the
 * admin has said are Spanish (the unstated language). Any other language was set on purpose. Null: unstated.
 */
export function siteLanguage(h: string): string | null {
  const lang = pageLanguage(h);
  return lang && lang !== 'en' ? lang : null;
}
