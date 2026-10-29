// Runtime source registry + plugin loader. Sources live OUTSIDE the core (the Suwayomi-style "user supplies
// sources" model): compiled CJS modules dropped into SOURCES_DIR are require()'d and registered at boot. One
// bad plugin is logged and skipped — it never crashes startup. The core ships with an empty registry, so an
// install with no sources mounted is the legal, scraper-free default.
import { readdirSync } from 'fs';
import { join } from 'path';
import { UNNUMBERED, unnumberedOf, type SourceAdapter, type SourceChapter, type SourceHost } from './types';
import { cfGet, cfPost, cfSession } from './flaresolverr';
import { learnImageHosts } from './imageHosts';

const registry = new Map<string, SourceAdapter>();
/** The ids a source pack in SOURCES_DIR registered (v0.54.0): what the sources overview calls a pack's source. */
const fromPack = new Set<string>();
// host services injected into a plugin's register(host) so plugins never import core internals by path.
const host: SourceHost = { cfGet, cfPost, cfSession };

function isAdapter(x: any): x is SourceAdapter {
  return !!x && typeof x.id === 'string' && typeof x.name === 'string' &&
    ['search', 'getSeries', 'listChapters', 'getPageUrls'].every((m) => typeof x[m] === 'function');
}

/**
 * A chapter list without the chapters a source numbers below zero: -1 is a source's "number unknown" (Mihon's
 * convention). The library files a chapter by its number, and `Chapter -1.cbz` is read back as chapter 1
 * (lib/naming.ts), so Natomanga, whose list carried chapter 1 a second time as -1 at the same address, gave ten series
 * chapter 1 twice. The extension adapter has always dropped these (lib/sources/suwayomi/sources.ts toChapter); this is
 * that rule for every other source. Reintroduce by returning the list as it came: "a chapter a source numbers below
 * zero is never listed" in chapterSpellings.test.ts finds the -1.
 */
export const fileableChapters = (list: SourceChapter[]): SourceChapter[] => {
  if (!Array.isArray(list)) return list;
  const out = list.filter((c) => !(Number(c?.number) < 0));
  // Array.filter loses non-enumerable adapter metadata. A partial list must remain partial at the registry boundary,
  // or destructive cleanup can mistake a dropped/unnumbered chapter for a proven absence on the retained source.
  const dropped = unnumberedOf(list) + list.length - out.length;
  if (dropped > 0) Object.defineProperty(out, UNNUMBERED, { value: dropped });
  return out;
};

/** The adapters whose listChapters already goes through fileableChapters: a re-registered one is not wrapped twice. */
const fileable = new WeakSet<SourceAdapter>();

function fileableOnly(a: SourceAdapter): void {
  if (fileable.has(a)) return;
  const list = a.listChapters;
  try {
    a.listChapters = async function (this: SourceAdapter, seriesId: string) { return fileableChapters(await list.call(this, seriesId)); };
    fileable.add(a);
  } catch { /* a frozen adapter keeps its own list */ }
}

/** Register one adapter into the live registry. First write for an id wins (a duplicate is logged + skipped). */
export function registerAdapter(a: SourceAdapter): boolean {
  if (!isAdapter(a)) return false;
  if (registry.has(a.id)) { console.warn(`[sources] duplicate id '${a.id}' ignored`); return false; }
  // Every source enters here, so this is where the cover hosts it serves are learned -- the only hosts the
  // Cloudflare solver may open for a caller-supplied cover URL (see imageHosts.ts) -- and where its chapter list
  // loses the numbers the library cannot file.
  learnImageHosts(a);
  fileableOnly(a);
  registry.set(a.id, a);
  return true;
}

/**
 * Take one adapter out of the live registry: a MangaDex language switched off in Admin → Providers
 * (sources/mangadexLangs.ts). Everything else leaves only with the whole registry, on a reload. Its series stay
 * where they are and read as frozen until the adapter is back. False when nothing had that id.
 */
export function unregisterAdapter(id: string): boolean {
  return registry.delete(id);
}

/** Extract adapters from a loaded module: a register(host) export and/or named/default const adapter(s). */
function collect(mod: any): SourceAdapter[] {
  const out: SourceAdapter[] = [];
  if (typeof mod?.register === 'function') {
    const r = mod.register(host);
    for (const a of Array.isArray(r) ? r : [r]) if (isAdapter(a)) out.push(a);
  }
  if (isAdapter(mod?.default)) out.push(mod.default);
  else if (Array.isArray(mod?.default)) for (const a of mod.default) if (isAdapter(a)) out.push(a);
  for (const v of Object.values(mod || {})) if (isAdapter(v)) out.push(v);
  return out;
}

/** Scan SOURCES_DIR for compiled .js/.cjs source plugins and register each. Missing dir → empty registry. */
export function loadSources(dir = process.env.SOURCES_DIR || '/sources'): { loaded: number; files: number } {
  let files = 0, loaded = 0, names: string[] = [];
  try { names = readdirSync(dir); } catch { return { loaded: 0, files: 0 }; }
  for (const f of names) {
    if (!/\.(js|cjs)$/.test(f) || /\.d\./.test(f) || f.startsWith('.')) continue;
    files++;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require(join(dir, f));
      let any = false;
      for (const a of collect(mod)) if (registerAdapter(a)) { loaded++; any = true; fromPack.add(a.id); }
      if (!any) console.warn(`[sources] ${f}: no valid SourceAdapter export`);
    } catch (e) { console.warn(`[sources] failed to load ${f}: ${(e as Error)?.message}`); }
  }
  return { loaded, files };
}

/** Drop everything and rescan (admin "reload" after dropping a new plugin into SOURCES_DIR). */
export function reloadSources(dir = process.env.SOURCES_DIR || '/sources'): { loaded: number; files: number } {
  registry.clear();
  fromPack.clear();
  for (const k of Object.keys(require.cache)) if (k.startsWith(dir)) delete require.cache[k];
  return loadSources(dir);
}

export function getSource(id: string): SourceAdapter | null { return registry.get(id) ?? null; }
export function listSources(): SourceAdapter[] { return [...registry.values()]; }
export function sourceIds(): string[] { return [...registry.keys()]; }
/** Whether a loaded source came from a source pack (SOURCES_DIR), not the core or the admin's settings. */
export function isPackSource(id: string): boolean { return fromPack.has(id) && registry.has(id); }
