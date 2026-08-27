// User-added "template" sites (Admin → Providers → Add a site). The core writes a JSON list; this reads it and
// instantiates a generic-engine adapter per entry, registering each. Re-run at boot + on reload, so adding a
// site needs no rebuild. (loader.ts must NOT import this file — keep the dependency one-directional.)
import { readFileSync } from 'fs';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import type { SourceAdapter } from './types';
import { registerAdapter } from './loader';
import { makeMadara } from './engines/madara';
import { makeManganato } from './engines/manganato';
import { makeMangaThemesia } from './engines/mangathemesia';

export interface Site { engine?: string; id?: string; name?: string; base?: string; order?: number }
/** Where the operator's template sites live. Written by Admin, read by the pack on every reload. */
export const FILE = process.env.CUSTOM_SITES_FILE || '/config/sites.json';

/**
 * The operator's site list, as a file.
 *
 * These were closures inside the admin routes. The watchdog needs them too, because following a site to a
 * new domain means rewriting this list, and that is the one auto-fix worth having: a moved domain is the
 * most common way a source dies and the only one with an unambiguous correct answer.
 */
export async function readSites(): Promise<Site[]> {
  try {
    const j = JSON.parse(await readFile(FILE, 'utf8'));
    return Array.isArray(j) ? j : [];
  } catch { return []; }
}

export async function writeSites(list: Site[]): Promise<void> {
  await mkdir(dirname(FILE), { recursive: true }).catch(() => {});
  await writeFile(FILE, JSON.stringify(list, null, 2));
}

function build(s: Site): SourceAdapter | null {
  if (!s.id || !s.base) return null;
  const cfg = { id: s.id, name: s.name || s.id, base: s.base, order: s.order };
  if (s.engine === 'madara') return makeMadara(cfg);
  if (s.engine === 'manganato') return makeManganato(cfg);
  if (s.engine === 'mangathemesia') return makeMangaThemesia(cfg);
  return null;
}

/** Register every site from CUSTOM_SITES_FILE via its generic engine. Returns the count registered. */
export function loadCustomSites(): number {
  let sites: Site[] = [];
  try { sites = JSON.parse(readFileSync(FILE, 'utf8')); } catch { return 0; } // no file yet → nothing
  let n = 0;
  for (const s of Array.isArray(sites) ? sites : []) {
    const a = build(s);
    if (a && registerAdapter(a)) n++;
  }
  return n;
}
