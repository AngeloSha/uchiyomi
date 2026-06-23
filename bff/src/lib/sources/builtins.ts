// Built-in sources bundled in the core (always on, no pack/config needed). Only MangaDex for now — an official,
// documented public API (no scraping, no Cloudflare bypass), the most defensible source to ship by default.
import { registerAdapter } from './loader';
import { mangadex } from './mangadex';

export function loadBuiltins(): number {
  let n = 0;
  for (const a of [mangadex]) if (registerAdapter(a)) n++;
  return n;
}
