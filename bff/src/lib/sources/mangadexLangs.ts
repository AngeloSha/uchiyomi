// MangaDex in other languages (v0.52.0, #123): which ones an admin turned on, and the adapters that follows.
//
// English is the `mangadex` adapter and always on. Every other language MangaDex is offered in (lib/lang.ts
// MANGADEX_LANGS) is off until an admin turns it on in Admin → Providers; server_settings.mangadex_langs lists
// those, and each is an adapter of its own (sources/mangadex.ts makeMangadex). The setting lives in the database,
// not in an environment variable, so it works the same on a server, on the desktop app and on Umbrel, and it is
// applied live: the settings PATCH saves the list and calls syncMangadexSources, and no restart is involved.
import { q } from '../db';
import { MANGADEX_LANGS, canonLang } from '../lang';
import { getSource, listSources, registerAdapter, unregisterAdapter } from './loader';
import { MANGADEX_GROUP, makeMangadex, mangadexId } from './mangadex';

/** The languages besides English that are on, as app codes in MANGADEX_LANGS order. */
let langs: string[] = [];

/**
 * A list as stored: app codes MangaDex is offered in, English left out (it is always on), each once, in the
 * table's order, so the registry and the Providers card list the languages the same way every time. Anything else
 * is dropped -- the PATCH refuses it before it gets here; this is for what a database row may hold.
 */
export function cleanMangadexLangs(list: unknown): string[] {
  const want = new Set((Array.isArray(list) ? list : []).map((c) => canonLang(typeof c === 'string' ? c : null)));
  return MANGADEX_LANGS.map((l) => l.code).filter((c) => c !== 'en' && want.has(c));
}

/** The languages besides English that are on. Synchronous, for loadBuiltins (sources/builtins.ts). */
export function mangadexLangs(): string[] {
  return [...langs];
}

/** Set the list in memory; the settings PATCH does, right after writing it. Returns the list as kept. */
export function setMangadexLangs(list: unknown): string[] {
  langs = cleanMangadexLangs(list);
  return mangadexLangs();
}

/** Fill the list from server_settings, at boot before loadBuiltins (server.ts). */
export async function loadMangadexLangs(): Promise<string[]> {
  const [row] = await q<{ mangadex_langs: unknown }>('SELECT mangadex_langs FROM server_settings WHERE id = 1');
  return setMangadexLangs(row?.mangadex_langs);
}

/**
 * Make the registry match the list: register each language turned on that has no adapter yet, unregister each
 * MangaDex adapter whose language was turned off. English is never touched. Only adapters of the MangaDex rate
 * group are ever unregistered, so a plugin or a site with a similar id is safe. Returns the ids it changed.
 *
 * A reload needs none of this: it clears the registry and loadBuiltins registers from the same list.
 */
export function syncMangadexSources(): { added: string[]; removed: string[] } {
  const want = new Map(langs.map((code) => [mangadexId(code), code]));
  const added: string[] = [];
  const removed: string[] = [];
  for (const s of listSources()) {
    if (s.rateGroup !== MANGADEX_GROUP || s.id === 'mangadex' || want.has(s.id)) continue;
    if (unregisterAdapter(s.id)) removed.push(s.id);
  }
  for (const [id, code] of want) {
    if (!getSource(id) && registerAdapter(makeMangadex(code))) added.push(id);
  }
  return { added, removed };
}

/**
 * The language a MangaDex adapter id names when it is one of the languages an admin can turn on ("es-419" for
 * `mangadex-es-419`), else null -- English, and every id that is not MangaDex's. Health's frozen-series check reads
 * it: a series whose source is a language switched off says so, and says where to switch it back on.
 */
export function mangadexLangOf(sourceId: string | null | undefined): string | null {
  if (!sourceId?.startsWith('mangadex-')) return null;
  return MANGADEX_LANGS.find((l) => l.code !== 'en' && mangadexId(l.code) === sourceId)?.code ?? null;
}
