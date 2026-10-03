// The extensions in Admin → Sources (v0.54.0; Admin → Extensions' own tab in v0.53.0), the part with no React in it:
// what the engine's strip says, how the installed extensions are joined to their sources, what Browse asks the server,
// an extension's language rows, and the words for the counts.
//
// The redesign answers discussion #121, where a real user on a 1,300-extension repository found the old single card
// unusable: the catalogue stopped at "Showing 400 of 570 matches -- narrow the search", "18+" read as a filter to
// adult extensions only, a language select in an extension's settings looked like it chose the language, the count
// of sources read as a count of extensions, and an extension installed in the engine's own page showed as installed
// with no way to switch its sources on but Remove and Add again. Each of those is a rule below, tested in
// web/test/extensions.test.ts. Since v0.54.0 the installed extensions are no list of their own: their sources are rows
// of Your sources (lib/sourcesPanel.ts), and an extension's languages are its source's sheet's section.
import { t as tr } from './i18n';
import { languageName, numberText } from './format';
import { sourceMark, type Tone } from './status';
import { headline, type EngineReport, type Headline } from './engineSetup';
import { providerStatus, type AdminSourceRow, type SrcStatus } from './providerGroups';

/** One row of GET /api/admin/extensions/catalog. */
export interface CatalogExt {
  pkgName: string;
  name: string;
  /** The extension's language: one code, or `all` for an extension with a source per language. */
  lang: string | null;
  versionName: string | null;
  iconUrl: string | null;
  installed: boolean;
  hasUpdate: boolean;
  obsolete: boolean;
  nsfw: boolean;
}

/** One page of GET /api/admin/extensions/catalog (bff routes/admin.ts). `offset`/`limit` are absent from an older server. */
export interface CatalogPage {
  content: CatalogExt[];
  total: number;
  matched: number;
  shown: number;
  offset?: number;
  limit?: number;
  installed: number;
  updatable: number;
  /** The 18+ extensions the other filters match and the 18+ filter keeps out. */
  hiddenAdult: number;
  /** The whole catalogue's 18+ extensions that are not installed, whatever was asked (absent from an older server). */
  adultTotal?: number;
  langs: string[];
}

/** One row of GET /api/admin/extensions/sources: a source an installed extension provides, one per language. */
export interface ExtSource {
  id: string;
  name: string;
  lang: string | null;
  nsfw: boolean;
  enabled: boolean;
  pkgName: string | null;
  /** Series in the library that came from it (v0.53.0; absent from an older server). */
  used?: number;
}

/** One language of the overview the same route sends (`langs`): what hiding it would cost. */
export interface ExtLang {
  lang: string | null;
  sources: number;
  enabled: number;
  used: number;
  hidden: boolean;
}

export interface ExtSourcesAnswer {
  content: ExtSource[];
  reachable: boolean;
  total?: number;
  langs?: ExtLang[];
  hiddenLangs?: string[];
}

/** GET /api/admin/extensions/status, as the panel reads it: the engine's report plus the source counts. */
export interface ExtStatus extends EngineReport {
  enabled?: number;
  known?: number;
  /** What search actually reaches; differs from `enabled` by `skipped` when SUWAYOMI_MAX_SOURCES bites. */
  registered?: number;
  skipped?: number;
  cap?: number;
  hiddenLangs?: string[];
}

/**
 * The engine's built-in Local source: listed with the installed extensions' sources, under a language code of its own
 * (`localsourcelang`) that no reader reads. It reads the engine's own folder, which Uchiyomi never uses, so it is not
 * offered as a language to show or hide.
 */
export const LOCAL_SOURCE_LANG = 'localsourcelang';
export const isLocalSource = (s: { lang: string | null }): boolean => s.lang === LOCAL_SOURCE_LANG;

/** An installed extension with its sources: what one row of Installed, and the detail sheet, show. */
export interface InstalledExt extends CatalogExt {
  sources: ExtSource[];
  /** Sources switched on. */
  on: number;
  /** Series that came from any of its sources. */
  used: number;
}

/** A language's name for an extension or a source: "Multiple languages" for `all`, "No language" for none. */
export function extLanguageName(code: string | null): string {
  if (!code) return tr('No language');
  if (code === 'all') return tr('Multiple languages');
  return languageName(code);
}

/** The short tag a language wears on an installed row: the code, upper-cased, as Mihon prints it. */
export const langTag = (code: string | null): string => (code ? code.toUpperCase() : '—');

/**
 * The installed extensions, each with its sources, in the order the list shows them: an update waiting first, then
 * one with no source on (the case to act on: installed in the engine's own page, or every language switched off),
 * then by name. Sources are in their languages' names' order. An extension the engine lists as installed with no
 * source listed keeps its row: it says so in its sheet.
 */
export function installedList(exts: readonly CatalogExt[], sources: readonly ExtSource[]): InstalledExt[] {
  const byPkg = new Map<string, ExtSource[]>();
  for (const s of sources) {
    if (!s.pkgName || isLocalSource(s)) continue;
    const list = byPkg.get(s.pkgName) ?? [];
    list.push(s);
    byPkg.set(s.pkgName, list);
  }
  const named = (s: ExtSource) => extLanguageName(s.lang);
  return exts
    .filter((e) => e.installed)
    .map((e) => {
      const own = [...(byPkg.get(e.pkgName) ?? [])].sort((a, b) => named(a).localeCompare(named(b)) || a.id.localeCompare(b.id));
      return {
        ...e,
        sources: own,
        on: own.filter((s) => s.enabled).length,
        used: own.reduce((n, s) => n + (s.used ?? 0), 0),
      };
    })
    .sort((a, b) => Number(b.hasUpdate) - Number(a.hasUpdate)
      || Number(a.on > 0 || !a.sources.length) - Number(b.on > 0 || !b.sources.length)
      || a.name.localeCompare(b.name));
}

/** An installed extension that has sources and none of them on: the row offers "Turn on". */
export const needsTurningOn = (e: Pick<InstalledExt, 'on' | 'sources'>): boolean => e.on === 0 && e.sources.length > 0;

/**
 * What an extension reads in, for its row and its sheet: its one language, or how many its sources cover. A
 * multi-language extension whose sources are not listed yet (or that has none) says "Multiple languages".
 */
export function extLanguagesText(e: Pick<InstalledExt, 'lang' | 'sources'>): string {
  const langs = [...new Set(e.sources.map((s) => s.lang))];
  if (langs.length === 1) return extLanguageName(langs[0]);
  if (langs.length > 1) return tr('{n} languages', { n: numberText(langs.length) });
  return extLanguageName(e.lang);
}

/** An engine's version as the strip prints it: "v2.3.2243", whether or not the engine sent its "v". */
export const versionText = (v: string): string => (/^\d/.test(v) ? `v${v}` : v);

// ---- the status strip -----------------------------------------------------------------------------------------

/**
 * The engine's state, as the strip's first cell says it beside "Extension engine". The strip is only drawn for an
 * engine that answers (the setup screen is every other state), so its word is the short "Ready"; the version and
 * the sources on are the muted line under it (engineMeta). ⚠️ "Ready" is the engine's alone: the Installed group of
 * extensions that need nothing is "Ready · {n}", a key of its own, so each agrees with its own noun in translation.
 */
export function engineLine(s: ExtStatus): { state: Headline; tone: Tone; label: string } {
  const h = headline(s);
  if (h === 'ready') return { state: h, tone: 'ok', label: tr('Ready') };
  if (h === 'unreachable') return { state: h, tone: 'problem', label: tr('The extension engine isn’t answering') };
  if (h === 'switched_off') return { state: h, tone: 'off', label: tr('Extensions are turned off') };
  return { state: h, tone: 'info', label: tr('No extension engine is set up') };
}

/**
 * The strip's muted line under "Extension engine": its version and the sources on against the limit -- "v2.3.2243 ·
 * 5 of 25 sources on". The extensions installed are not here any more: the Installed tab counts them.
 */
export function engineMeta(s: Pick<ExtStatus, 'version' | 'enabled' | 'cap'>): string {
  return [s.version ? versionText(s.version) : null, sourcesOnText(s.enabled ?? 0, s.cap ?? 0)].filter(Boolean).join(' · ');
}

export type HelperState = 'connected' | 'own' | 'off' | 'localhost' | 'unsupported';

/**
 * The engine's own Cloudflare helper, as the strip's second cell says it, and the one thing to do about it: Connect
 * when Uchiyomi has a helper to share, else set FLARESOLVERR_URL first. Null when there is nothing to say: the
 * engine is not answering, or its settings could not be read.
 *
 * `detail` is the one muted line under the mark, and there is none for a helper that works: round 1 put a paragraph
 * under every state, and "Extensions get past Cloudflare through Uchiyomi's helper." under a green "Connected" was a
 * sentence saying the mark again. Not connected (off, or pointed at localhost where no helper runs) is one short
 * line beside Connect; the long why stays on Health's Extension engine row.
 */
export function helperLine(solver: EngineReport['solver'] | undefined): {
  state: HelperState; tone: Tone; label: string; detail: string | null; action: 'connect' | 'set_url' | null;
} | null {
  if (!solver) return null;
  const fix = solver.connectable ? 'connect' as const : 'set_url' as const;
  switch (solver.wiring) {
    case 'ok':
      return { state: 'connected', tone: 'ok', label: tr('Connected'), detail: null, action: null };
    case 'other':
      return { state: 'own', tone: 'ok', label: tr('Connected'), detail: null, action: null };
    case 'off':
      return { state: 'off', tone: 'warn', label: tr('Not connected'), detail: tr('Needed for sites behind Cloudflare.'), action: fix };
    case 'localhost':
      return { state: 'localhost', tone: 'warn', label: tr('Not connected'), detail: tr('Needed for sites behind Cloudflare.'), action: fix };
    default:
      return { state: 'unsupported', tone: 'off', label: tr('Not available'), detail: tr('This engine has no Cloudflare helper setting.'), action: null };
  }
}

/**
 * Whether the sheet says the limit across all extensions: from 80 % of it, or once something is over it. Below
 * that it was one more sentence under every extension's languages that nobody needed.
 */
export function nearSourceLimit(s: Pick<ExtStatus, 'enabled' | 'cap' | 'skipped'>): boolean {
  if (s.skipped) return true;
  const cap = s.cap ?? 0;
  return cap > 0 && (s.enabled ?? 0) >= cap * 0.8;
}

// ---- counts, in words -----------------------------------------------------------------------------------------

/**
 * Sources on, against the server's limit (SUWAYOMI_MAX_SOURCES): "18 of 25 sources on". Said with its unit every
 * time -- a bare count beside the extensions was read as a count of extensions (#121: "I added only 12").
 */
export const sourcesOnText = (on: number, max: number): string => tr('{n} of {max} sources on', { n: numberText(on), max: numberText(max) });

/** An extension's own languages: "2 of 5 on". */
export const languagesOnText = (on: number, total: number): string => tr('{n} of {total} on', { n: numberText(on), total: numberText(total) });

/** The over-the-limit sentence, or '' when nothing is over it. */
export function overLimitText(skipped: number | undefined, cap: number | undefined): string {
  if (!skipped) return '';
  return skipped === 1
    ? tr('1 enabled source is not registered — over the limit of {cap}.', { cap: cap ?? 0 })
    : tr('{n} enabled sources are not registered — over the limit of {cap}.', { n: skipped, cap: cap ?? 0 });
}

/**
 * The engine's own words for a failure, as one line: up to its stack trace, which the engine sends inside the message
 * ("…: repo.example: Name or service not known at kotlin.coroutines…") and which buried the reason under twelve lines
 * of frames. At most 240 characters.
 */
export function reasonLine(raw: string | null | undefined): string {
  const s = String(raw ?? '').split(/\r?\n/)[0].split(/\s+at\s+[\w$.]+\(/)[0].replace(/\s+/g, ' ').trim();
  return s.length > 240 ? `${s.slice(0, 239)}…` : s;
}

// ---- Browse --------------------------------------------------------------------------------------------------

/** How many extensions one Browse page asks for. Small enough to draw at once, and the next page loads as it scrolls. */
export const BROWSE_PAGE = 60;

export interface BrowseFilters {
  q: string;
  /** A language code, `all` for the multi-language extensions, '' for every language. */
  lang: string;
  /**
   * The catalogue's own filters, which Browse no longer offers (v0.53.0 round 2): its Installed and Has an update
   * chips were the Installed tab again. The route keeps them, and so does this.
   */
  installed: boolean;
  updates: boolean;
  /** Show 18+ extensions: off, they are left out of the list (never "only 18+", which is how "18+" read). */
  adult: boolean;
}

export const NO_FILTERS: BrowseFilters = { q: '', lang: '', installed: false, updates: false, adult: false };

/** Whether anything narrows the list beyond the search: the "clear" a no-match state offers. The 18+ switch is not a narrowing. */
export const narrowed = (f: BrowseFilters): boolean => !!f.q.trim() || !!f.lang || f.installed || f.updates;

/** The catalogue's query string for one page. ⚠️ `lang=all` is a real filter here (the multi-language extensions). */
export function catalogQuery(f: BrowseFilters, offset: number, limit = BROWSE_PAGE): string {
  const p = new URLSearchParams();
  if (f.q.trim()) p.set('q', f.q.trim());
  if (f.lang) p.set('lang', f.lang === 'all' ? 'all' : f.lang);
  if (f.installed) p.set('installed', 'true');
  if (f.updates) p.set('updates', 'true');
  if (f.adult) p.set('nsfw', 'true');
  p.set('offset', String(offset));
  p.set('limit', String(limit));
  return p.toString();
}

/**
 * The offset of the page after `last`, or undefined at the end. An older server answers no `offset` and every match
 * at once, which reads as the end.
 */
export function nextOffset(last: Pick<CatalogPage, 'offset' | 'shown' | 'matched'> | undefined): number | undefined {
  if (!last || typeof last.offset !== 'number') return undefined;
  const next = last.offset + last.shown;
  return last.shown > 0 && next < last.matched ? next : undefined;
}

/**
 * The language filter's options: every language, then the multi-language extensions, then each language by its
 * name in the reader's language. The catalogue sends bare codes ("es-419", "all"), which the old select showed as
 * they came.
 */
export function languageOptions(codes: readonly string[]): Array<{ value: string; label: string }> {
  const named = codes.filter((c) => c && c !== 'all' && c !== LOCAL_SOURCE_LANG)
    .map((c) => ({ value: c, label: languageName(c) }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return [
    { value: '', label: tr('All languages') },
    ...(codes.includes('all') ? [{ value: 'all', label: tr('Multiple languages') }] : []),
    ...named,
  ];
}

// ---- a source's health, in the detail sheet --------------------------------------------------------------------

/**
 * One language of an installed extension, as its row in the detail sheet marks it: off, on but over the source limit
 * (enabled, yet not in the registry the search reaches), or its status -- the public status with #115's confirmed
 * failures over it (lib/providerGroups.ts providerStatus).
 */
export function sourceHealth(
  s: Pick<ExtSource, 'id' | 'enabled'>,
  registry: ReadonlyMap<string, { status?: SrcStatus | null }> | null,
  adminRows: ReadonlyMap<string, AdminSourceRow> | null,
): { tone: Tone; label: string; over: boolean } {
  if (!s.enabled) return { tone: 'off', label: tr('Turned off'), over: false };
  const id = `sw:${s.id}`;
  const pub = registry?.get(id);
  // Not yet known (the registry is still loading): healthy rather than over the limit.
  if (registry && !pub) return { tone: 'warn', label: tr('Over the source limit'), over: true };
  const st = providerStatus(pub?.status ?? 'ok', adminRows?.get(id) ?? null);
  return { ...sourceMark(st), over: false };
}

/**
 * What a language's row in the sheet says under its name: a problem only -- failing, blocked by the site, over the
 * source limit and the like -- or nothing. "Turned off" and "Healthy" under every row said what its switch says.
 */
export function languageProblem(h: { tone: Tone; label: string }): { tone: Tone; label: string } | null {
  return h.tone === 'ok' || h.tone === 'off' ? null : { tone: h.tone, label: h.label };
}
