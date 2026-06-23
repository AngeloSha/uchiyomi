// Runtime source registry + plugin loader. Sources live OUTSIDE the core (the Suwayomi-style "user supplies
// sources" model): compiled CJS modules dropped into SOURCES_DIR are require()'d and registered at boot. One
// bad plugin is logged and skipped — it never crashes startup. The core ships with an empty registry, so an
// install with no sources mounted is the legal, scraper-free default.
import { readdirSync } from 'fs';
import { join } from 'path';
import type { SourceAdapter, SourceHost } from './types';
import { cfGet, cfPost, cfSession } from './flaresolverr';

const registry = new Map<string, SourceAdapter>();
// host services injected into a plugin's register(host) so plugins never import core internals by path.
const host: SourceHost = { cfGet, cfPost, cfSession };

function isAdapter(x: any): x is SourceAdapter {
  return !!x && typeof x.id === 'string' && typeof x.name === 'string' &&
    ['search', 'getSeries', 'listChapters', 'getPageUrls'].every((m) => typeof x[m] === 'function');
}

/** Register one adapter into the live registry. First write for an id wins (a duplicate is logged + skipped). */
export function registerAdapter(a: SourceAdapter): boolean {
  if (!isAdapter(a)) return false;
  if (registry.has(a.id)) { console.warn(`[sources] duplicate id '${a.id}' ignored`); return false; }
  registry.set(a.id, a);
  return true;
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
      for (const a of collect(mod)) if (registerAdapter(a)) { loaded++; any = true; }
      if (!any) console.warn(`[sources] ${f}: no valid SourceAdapter export`);
    } catch (e) { console.warn(`[sources] failed to load ${f}: ${(e as Error)?.message}`); }
  }
  return { loaded, files };
}

/** Drop everything and rescan (admin "reload" after dropping a new plugin into SOURCES_DIR). */
export function reloadSources(dir = process.env.SOURCES_DIR || '/sources'): { loaded: number; files: number } {
  registry.clear();
  for (const k of Object.keys(require.cache)) if (k.startsWith(dir)) delete require.cache[k];
  return loadSources(dir);
}

export function getSource(id: string): SourceAdapter | null { return registry.get(id) ?? null; }
export function listSources(): SourceAdapter[] { return [...registry.values()]; }
export function sourceIds(): string[] { return [...registry.keys()]; }
