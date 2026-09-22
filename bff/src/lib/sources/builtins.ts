// Built-in sources bundled in the core (always on, no pack/config needed). Only MangaDex for now — an official,
// documented public API (no scraping, no Cloudflare bypass), the most defensible source to ship by default.
import { registerAdapter } from './loader';
import { mangadex } from './mangadex';
import { fakeSources } from './fake';

export function loadBuiltins(): number {
  let n = 0;
  // FAKE_SOURCE_URLS is an e2e-only opt-in. With it unset `fakeSources()` is empty, so the production
  // registry remains exactly MangaDex plus the operator's sites/extensions/plugins.
  for (const a of [mangadex, ...fakeSources()]) if (registerAdapter(a)) n++;
  return n;
}
