// Built-in sources bundled in the core (always on, no pack/config needed). Only MangaDex for now — an official,
// documented public API (no scraping, no Cloudflare bypass), the most defensible source to ship by default.
// English, plus one adapter per other language the admin turned on (sources/mangadexLangs.ts, v0.52.0).
import { registerAdapter } from './loader';
import { makeMangadex, mangadex } from './mangadex';
import { mangadexLangs } from './mangadexLangs';
import { fakeSources } from './fake';

export function loadBuiltins(): number {
  let n = 0;
  // FAKE_SOURCE_URLS is an e2e-only opt-in. With it unset `fakeSources()` is empty, so the production
  // registry remains exactly MangaDex plus the operator's sites/extensions/plugins.
  for (const a of [mangadex, ...mangadexLangs().map(makeMangadex), ...fakeSources()]) if (registerAdapter(a)) n++;
  return n;
}
