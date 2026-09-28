// "The site says it is offline" (v0.49.1): a site engine's page that is the site's own maintenance notice.
//
// Since 2026-09-23 aqua (a Madara site, the owner's main source) has answered every request with a small "Aqua Manga
// is temporarily offline" page -- HTTP 200, a card with a Discord link, none of the theme's markup. Every engine
// parse of it was an empty list, and an empty list is an ordinary answer (a search for a title the site lacks), so
// the updater took it as a listing with nothing in it and Health guessed "markup may not match this engine". The
// site was saying exactly what was wrong, and nothing read it.
//
// So an engine that parses NOTHING out of a page asks this whether the page is such a notice, and throws a
// classified error when it is: the updater then treats the source as one that did not answer (no empty listing, no
// empty streak, the listing left standing), the #115 evidence records a `site_offline` failure at that stage
// (sourceHealth.ts noteStage reads the kind off the message), and the diagnosis says so (sourceDiagnosis.ts).
//
// ⚠️ Conservative on purpose. Calling a working site "offline" would be a new wrong answer, so a page counts only
// when ALL of these hold: it is small (under OFFLINE_MAX_BYTES of HTML -- a theme's real pages are far larger), its
// <title> or first <h1> says so in so many words, and it carries none of the engine's own markup. And it is only
// ever asked about a page that parsed to nothing: a page with results is never an offline page, whatever it says.
//
// ⚠️ What it does not change: the cooldowns. Discover (routes/sources.ts, the latest and popular pages) and global
// search (lib/searchAll.ts) report this error as they report any failure -- reportFail, classified `down` -- so an
// offline site someone keeps browsing or searching is put in the normal escalating cooldown, five minutes growing to
// thirty. The sweep skips a source in a cooldown (updater.ts, blockedNow), so the first sweep check after the site
// comes back can wait up to thirty minutes. Deliberate: a site that answers only its notice has failed the request,
// and the escalation is what keeps a down site from being asked on every visit. docs/api.md says so too.
import { plainText } from '../htmlText';

/** The kind every classified error carries, and the prefix of its message (what a stored error is read by). */
export const SITE_OFFLINE = 'site_offline';
/** A maintenance page is a notice, not a site: a theme's real listing or series page is many times this. */
export const OFFLINE_MAX_BYTES = 8 * 1024;
/** What the notice must say in its <title> or first <h1>. */
const OFFLINE_WORDS = /temporarily offline|maintenance|under maintenance|temporarily unavailable|be back soon/i;

export type SiteOfflineError = Error & { kind: typeof SITE_OFFLINE; said: string };

/** The error an engine throws: the prefix makes it recognisable after it has become a stored string. */
export function siteOffline(said: string): SiteOfflineError {
  return Object.assign(new Error(`${SITE_OFFLINE}: the site says it is offline ("${said}")`), { kind: SITE_OFFLINE, said } as const);
}

/** Is this error (or the message it left behind in source_health) a site saying it is offline? */
export function isSiteOffline(e: unknown): boolean {
  if ((e as { kind?: unknown } | null)?.kind === SITE_OFFLINE) return true;
  const m = typeof e === 'string' ? e : (e as Error | null)?.message;
  return typeof m === 'string' && m.startsWith(`${SITE_OFFLINE}:`);
}

/**
 * What the page says, when it is the site's own offline notice (see the header for the three conditions), else
 * null. `engineMarkup` is the engine's own: any trace of it and the page is the site working.
 */
export function offlineNotice(html: string | null | undefined, engineMarkup: RegExp): string | null {
  if (!html || Buffer.byteLength(html, 'utf8') >= OFFLINE_MAX_BYTES) return null;
  if (engineMarkup.test(html)) return null;
  const title = plainText((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
  const h1 = plainText((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || '');
  const said = [title, h1].find((t) => OFFLINE_WORDS.test(t));
  return said ? said.slice(0, 120) : null;
}

/** Throw the classified error when the page is an offline notice; otherwise do nothing. */
export function throwIfOffline(html: string | null | undefined, engineMarkup: RegExp): void {
  const said = offlineNotice(html, engineMarkup);
  if (said) throw siteOffline(said);
}
