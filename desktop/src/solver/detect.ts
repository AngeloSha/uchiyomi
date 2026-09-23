// Challenge detection, ported verbatim from FlareSolverr 3.5.2 src/flaresolverr_service.py:25-54.
// The lists are FlareSolverr's own so a page counts as "challenged", "blocked" or "clean" exactly where it
// would there -- the contract test diffs these arrays against that file.
//
// Pure (no Electron): browser.ts runs PROBE_SOURCE inside the page and feeds the result to these helpers.

export const ACCESS_DENIED_TITLES = [
  // Cloudflare
  'Access denied',
  // Cloudflare http://bitturk.net/ Firefox
  'Attention Required! | Cloudflare',
];
export const ACCESS_DENIED_SELECTORS = [
  // Cloudflare
  'div.cf-error-title span.cf-code-label span',
  // Cloudflare http://bitturk.net/ Firefox
  '#cf-error-details div.cf-error-overview h1',
];
export const CHALLENGE_TITLES = [
  // Cloudflare
  'Just a moment...',
  // DDoS-GUARD
  'DDoS-Guard',
];
export const CHALLENGE_SELECTORS = [
  // Cloudflare
  '#cf-challenge-running', '.ray_id', '.attack-box', '#cf-please-wait', '#challenge-spinner', '#trk_jschal_js', '#turnstile-wrapper', '.lds-ring',
  // Custom CloudFlare for EbookParadijs, Film-Paleis, MuziekFabriek and Puur-Hollands
  'td.info #js_info',
  // Fairlane / pararius.com
  'div.vc div.text-box h2',
];
export const TURNSTILE_SELECTORS = [
  "input[name='cf-turnstile-response']",
];

/** What one look at the page says. Filled in by PROBE_SOURCE. */
export interface Probe {
  title: string;
  href: string;
  readyState: string;
  denied: string[];
  challenge: string[];
  turnstile: string[];
}

/**
 * The script browser.ts evaluates (in an isolated world, so the page's own JS cannot shadow querySelector).
 * An invalid selector must not throw the whole probe, hence the per-selector try.
 */
export const PROBE_SOURCE = `(() => {
  const has = (s) => { try { return !!document.querySelector(s); } catch (e) { return false; } };
  return {
    title: String(document.title || ''),
    href: String(location.href),
    readyState: String(document.readyState),
    denied: ${JSON.stringify(ACCESS_DENIED_SELECTORS)}.filter(has),
    challenge: ${JSON.stringify(CHALLENGE_SELECTORS)}.filter(has),
    turnstile: ${JSON.stringify(TURNSTILE_SELECTORS)}.filter(has),
  };
})()`;

/** flaresolverr_service.py:403-412: title STARTS WITH, or a denied selector is present. */
export function isAccessDenied(p: Probe): boolean {
  return ACCESS_DENIED_TITLES.some((t) => p.title.startsWith(t)) || p.denied.length > 0;
}

/** flaresolverr_service.py:415-428: title EQUALS (case-insensitively), or a challenge selector is present. */
export function isChallenge(p: Probe): boolean {
  return CHALLENGE_TITLES.some((t) => t.toLowerCase() === p.title.toLowerCase()) || p.challenge.length > 0;
}

/** Why it counted as a challenge, for the log (FlareSolverr logs "Title found: …" / "Selector found: …"). */
export function challengeReason(p: Probe): string {
  const t = CHALLENGE_TITLES.find((x) => x.toLowerCase() === p.title.toLowerCase());
  return t ? `title:${t}` : p.challenge.length ? `selector:${p.challenge[0]}` : '';
}

/**
 * Where the Turnstile checkbox is, for the one trusted click of §3.5.
 *
 * The managed-challenge page puts the widget iframe inside a CLOSED shadow root, so the iframe itself is
 * not reachable from script. The shadow HOST is, and the hidden `cf-turnstile-response` input lives beside
 * it in the light DOM; the checkbox sits ~30 px in from the host's left edge, vertically centred.
 */
export const TURNSTILE_RECT_SOURCE = `(() => {
  const pick = () => {
    const f = [...document.querySelectorAll('iframe')].find((x) => /challenges\\.cloudflare\\.com/.test(x.src || ''));
    if (f) return f;
    const inp = document.querySelector("input[name='cf-turnstile-response']");
    if (inp && inp.parentElement) return inp.parentElement;
    return document.querySelector('#turnstile-wrapper, .cf-turnstile, [id^="cf-chl-widget"]');
  };
  const el = pick();
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  return { x: r.left, y: r.top, w: r.width, h: r.height, tag: el.tagName, id: el.id || '' };
})()`;
