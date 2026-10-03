/**
 * Admin → Sources (v0.54.0): the part of components/SourcesPanel.tsx and SourceSheet.tsx with no React in it -- what
 * the one list of sources says about each source, which key a row and the sheet offer, what Needs attention holds,
 * and what Replace says it will do -- so a test can hold the rules.
 *
 * The owner, about Admin → Providers and Extensions: "why do we have 2 when they are basically the same … the
 * providers tab is super cluttered and non user friendly … i have to go one by one test and find replacement sources".
 * The two tabs were one source list cut three ways (Providers, Extensions, and Health's Source health), with five
 * off-switches over three stores and no way at all to move a series off a dead main source. Now one tab lists every
 * source of every kind from one answer (GET /api/admin/sources/overview), says each in one line, and offers at most
 * one key per row; a dead source's series move with one press, Replace.
 */
import { keys, t as tr } from './i18n';
import { activeLocale, languageName, numberText } from './format';
import { adultShown } from './adult';
import { dayText } from './said';
import { stateReason, stateWord } from './sourceHealth';
import { extSourceIdOf } from './sourcePrefs';
import type { Tone } from './status';
import type { LiveVerdict, Stage, StageLine } from './sourceEvidence';
import type { HealthItem, SourceState } from './types';

// ---- the server's shapes ---------------------------------------------------------------------------------------

/** Where a source comes from: a built-in engine, MangaDex, a site added by address, an extension, a source pack. */
export type SourceKind = 'builtin' | 'mangadex' | 'site' | 'extension' | 'pack';

/** Whether updates can use it (bff lib/sourceStanding.ts standingOf). */
export type SourceStanding = 'usable' | 'cooling' | 'failing' | 'off' | 'not_loaded';

/** One source of GET /api/admin/sources/overview (the v0.54.0 contract, §1). */
export interface OverviewSource {
  /** `sw:<id>` for an extension's source, `mangadex` / `mangadex-<code>`, a site's slug, a built-in's id. */
  id: string;
  name: string;
  kind: SourceKind;
  lang: string | null;
  /** An extension source's package. */
  pkgName?: string | null;
  standing: SourceStanding;
  /** Who switched it off: an admin (here or in Health), its extension's switch, or a hidden language. */
  offBy?: 'admin' | 'extension' | 'language' | null;
  /** The one word, as Health's Source health says it (v0.53.0), plus `ok`. */
  state: SourceState | 'ok';
  stage?: Stage | null;
  cooldown?: { status: string; until: string | null } | null;
  /** The site answers with its own "temporarily offline" page. */
  offline?: boolean;
  /** Series whose MAIN source it is. */
  main: number;
  /** Series that follow it without it being their main source. */
  followed: number;
  /** Of `main`: series that already follow a usable source -- what Replace moves at once. */
  withBackup: number;
  lastTestedAt?: string | null;
  /** GET /img/sources/icon/:id serves an extension's logo. */
  icon?: boolean;
  /** A site added by address: where it lives. */
  address?: string | null;
}

export interface SourcesAttention {
  /** Failing or switched off, and main to at least one series. */
  replace: string[];
  /** Confirmed failing, and used by no series. */
  failingUnused: string[];
  /** Extensions with an update waiting. */
  updates: number;
}

export interface SourcesOverview {
  sources: OverviewSource[];
  attention: SourcesAttention;
}

/**
 * One row of GET /api/admin/sources: the stored health with #115's evidence. The sheet's Details reads its stage lines
 * and last live check, and a failing source's row says since when from its open failures.
 */
export interface SourceEvidenceRow {
  source_id: string;
  last_error?: string | null;
  last_fail_at?: string | null;
  consecutive?: number;
  disabled?: boolean;
  failing?: Array<{ stage: string; since: string; error: string | null; kind: string; by: string; streak: number }>;
  live?: (LiveVerdict & { code: string | null }) | null;
  evidence?: StageLine[];
}

/**
 * Under `['sources']`, so every change that already asks the source lists again (an extension installed, a language
 * shown, a site added) asks this again too.
 */
export const OVERVIEW_KEY = ['sources', 'overview'] as const;

/**
 * The admin's list is every source, the adult ones included, whatever the "Show 18+" reveal says: this is where a
 * source is tested, switched off or replaced, and nobody can act on a row that is not on the page. The parameter
 * only while the reveal is OFF (lib/api.ts adds its own when it is on; two copies read as "hidden"), the rule the
 * admin page's GET /api/sources has followed since #64.
 */
export const overviewUrl = (): string => (adultShown() ? '/api/admin/sources/overview' : '/api/admin/sources/overview?adult=1');

/**
 * The names Admin's Sources tab went by before v0.54.0: both land on it. `card=mangadex`, `view=installed|browse` and
 * `settings=<id>` stay in the address for the panel to read (initialView, settingsTarget).
 */
export const SOURCES_TAB_ALIASES = { Providers: 'Sources', Extensions: 'Sources' } as const;

// ---- which view, from the address ------------------------------------------------------------------------------

export type SourcesView = 'yours' | 'add';

/**
 * The view an address asks for: Extensions' `view=browse` (and `add`) and the add dialog's `card=mangadex` open Add
 * sources; anything else, Your sources.
 */
export function initialView(params: { get(name: string): string | null }): SourcesView {
  const v = params.get('view');
  if (v === 'browse' || v === 'add') return 'add';
  if (v === 'installed' || v === 'yours') return 'yours';
  return params.get('card') === 'mangadex' ? 'add' : 'yours';
}

/**
 * `settings=<source id>` (the Extensions tab's deep link, which Health, the series page and the add dialog give): the
 * extension source whose sheet opens on its settings, as the overview names it (`sw:<id>`). Null for anything else.
 */
export function settingsTarget(params: { get(name: string): string | null }): string | null {
  const id = params.get('settings');
  return id && /^-?\d{1,20}$/.test(id) ? `sw:${id}` : null;
}

// ---- one source in words ---------------------------------------------------------------------------------------

/** Declared through keys(): they reach tr() through kindLabel's switch (lib/i18n.ts). */
export const KIND_LABELS = keys('Built-in', 'Site', 'Extension', 'Source pack');

/** The squared tag after a source's name. MangaDex is a name, and stays one in every language. */
export function kindLabel(k: SourceKind): string {
  switch (k) {
    case 'builtin': return tr(KIND_LABELS[0]);
    case 'mangadex': return 'MangaDex';
    case 'site': return tr(KIND_LABELS[1]);
    case 'extension': return tr(KIND_LABELS[2]);
    case 'pack': return tr(KIND_LABELS[3]);
  }
  return '';
}

/** How many series use it, as main or as a followed source. */
export const usedBy = (s: Pick<OverviewSource, 'main' | 'followed'>): number => (s.main ?? 0) + (s.followed ?? 0);

/** "125 series", or "not used". */
export function usedText(s: Pick<OverviewSource, 'main' | 'followed'>): string {
  const n = usedBy(s);
  return n === 0 ? tr('not used') : n === 1 ? tr('1 series') : tr('{n} series', { n: numberText(n) });
}

/** A source's language in the reader's words; nothing for one that does not say. */
export function langText(lang: string | null | undefined): string {
  if (!lang) return '';
  return lang === 'all' ? tr('Multiple languages') : languageName(lang);
}

/**
 * Since when a failing source has failed: the oldest of its open failures (GET /api/admin/sources `failing`), else
 * its last failure. Null when nothing is known.
 */
export function failingSince(row: SourceEvidenceRow | null | undefined): string | null {
  const open = (row?.failing ?? []).map((f) => f.since).filter((t) => Number.isFinite(Date.parse(t)));
  if (open.length) return open.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b));
  return row?.last_fail_at && Number.isFinite(Date.parse(row.last_fail_at)) ? row.last_fail_at : null;
}

/** The fields Health's words read (lib/sourceHealth.ts stateWord / stateReason), from an overview row. */
const asItem = (s: OverviewSource): HealthItem => ({
  title: s.name, detail: '', state: s.state === 'ok' ? undefined : s.state, stage: s.stage ?? undefined,
  cooldown: s.cooldown ?? undefined, offBy: s.offBy ?? undefined,
});

export interface SourceSays {
  /** The state, in a word or two: "Healthy", "Rate-limited", "Offline since 23 Sep". */
  word: string;
  /** What follows it after a dash: when a cooldown ends, the step a failure is at. Empty for the rest. */
  reason: string;
  tone: Tone;
}

/**
 * A source's state as its row and its sheet say it. The words are Health's (one source reads alike on both pages);
 * a site that serves its own offline page says so first, since when where the evidence knows, whatever else is true
 * of it -- aqua is switched off AND offline, and "offline" is why it needs replacing. Amber only for a real problem:
 * a source failing, cooling down, offline or not loaded that series use, or one switched off that is still some
 * series' main source. A source switched off that nothing needs is grey, and a healthy one says so in green.
 */
export function sourceSays(s: OverviewSource, since?: string | null, now = Date.now()): SourceSays {
  const used = usedBy(s) > 0;
  const date = since ? dayText(since) : '';
  if (s.offline) {
    return { word: date ? tr('Offline since {date}', { date }) : tr('Site offline'), reason: '', tone: s.standing === 'off' && !s.main ? 'off' : 'warn' };
  }
  if (s.standing === 'not_loaded') return { word: tr('Not loaded'), reason: '', tone: used ? 'warn' : 'off' };
  if (s.standing === 'off' || s.state === 'off') {
    return { word: stateWord({ ...asItem(s), state: 'off' }) ?? tr('Turned off'), reason: '', tone: s.main > 0 ? 'warn' : 'off' };
  }
  if (s.state === 'failing') {
    return { word: date ? tr('Failing since {date}', { date }) : (stateWord(asItem(s)) ?? ''), reason: stateReason(asItem(s), now), tone: 'warn' };
  }
  if (s.state === 'blocked') return { word: stateWord(asItem(s)) ?? '', reason: stateReason(asItem(s), now), tone: 'warn' };
  if (s.state === 'ok') return { word: tr('Healthy'), reason: '', tone: 'ok' };
  // Slow, empty, a Test that did not finish, not checked since it failed: worth a look in the sheet, not an alarm.
  return { word: stateWord(asItem(s)) ?? '', reason: '', tone: 'info' };
}

/** A row's one line after its state: how many series use it, and its language. */
export function rowFacts(s: OverviewSource): string[] {
  return [usedText(s), langText(s.lang)].filter(Boolean);
}

// ---- the list ---------------------------------------------------------------------------------------------------

/**
 * Your sources, as the tab shows them: every source in the server's order (Needs attention's first, then the most
 * used, then by name), the switched-off ones apart, folded under "Switched off".
 */
export function splitSources(list: readonly OverviewSource[]): { on: OverviewSource[]; off: OverviewSource[] } {
  return { on: list.filter((s) => s.standing !== 'off'), off: list.filter((s) => s.standing === 'off') };
}

/**
 * The one key a row offers, or none -- then the row is a chevron and opens the source's sheet. Turn on, for a source
 * switched off that series still use: the one thing to do about it in the list. Not for one Needs attention already
 * offers Replace for: a dead source's series want a new source, and its own key is up there.
 */
export function rowAction(s: OverviewSource, a: Pick<SourcesAttention, 'replace'>): 'turn-on' | null {
  if (a.replace.includes(s.id)) return null;
  return s.standing === 'off' && usedBy(s) > 0 ? 'turn-on' : null;
}

/** Whether there is anything for Needs attention to say. */
export const needsAttention = (a: SourcesAttention | null | undefined): boolean =>
  !!a && (a.replace.length > 0 || a.failingUnused.length > 0 || a.updates > 0);

/** How many rows Needs attention holds, for its head: one per source to replace, one for the rest of each kind. */
export const attentionRows = (a: SourcesAttention): number =>
  a.replace.length + (a.failingUnused.length ? 1 : 0) + (a.updates ? 1 : 0);

/**
 * A source to replace, in one line: why (offline, failing, switched off or not loaded), how many series it is the
 * main source of, and how many of those already follow a working source -- the ones Replace moves at once.
 */
export function replaceLine(s: OverviewSource, since?: string | null): string[] {
  const date = since ? dayText(since) : '';
  const why = s.offline ? (date ? tr('Offline since {date}', { date }) : tr('Site offline'))
    : s.standing === 'off' ? tr('Turned off')
    : s.standing === 'not_loaded' ? tr('Not loaded')
    : date ? tr('Failing since {date}', { date }) : tr('Failing');
  const main = s.main === 1 ? tr('main source of 1 series') : tr('main source of {n} series', { n: numberText(s.main) });
  const backup = !s.withBackup ? '' : s.withBackup === 1 ? tr('1 already has a working backup')
    : tr('{n} already have a working backup', { n: numberText(s.withBackup) });
  return [why, main, backup].filter(Boolean);
}

/**
 * What goes between names in a list the page draws name by name (each in its own direction): "A, B" / "A、B" / "A، B".
 * A Latin comma in an Arabic line sat on the wrong side of each name.
 */
export const namesSep = (): string => (/^(ja|zh)/.test(activeLocale()) ? '、' : activeLocale() === 'ar' ? '، ' : ', ');

/** The head of the failing-and-unused row. */
export const failingUnusedTitle = (n: number): string =>
  (n === 1 ? tr('1 source nothing uses is failing') : tr('{n} sources nothing uses are failing', { n }));

/** The head of the updates row. */
export const updatesTitle = (n: number): string =>
  (n === 1 ? tr('1 extension has an update') : tr('{n} extensions have an update', { n }));

// ---- the sheet's keys --------------------------------------------------------------------------------------------

export type SheetKey = 'replace' | 'test' | 'unblock' | 'turn-off' | 'turn-on' | 'remove';

/**
 * What a source's sheet offers, in the order its keys sit:
 * - Replace, the one filled key, while it cannot serve the series it is main to: failing, switched off or not loaded;
 * - Test, for a source Uchiyomi has loaded (a source its extension switched off is not, and its Test would only say so);
 * - Clear block, while a cooldown holds it;
 * - Turn off, or Turn on for one switched off;
 * - Remove, for a site added by address -- built-ins and packs have nothing to remove, an extension's source goes with
 *   its extension.
 */
export function sheetKeys(s: OverviewSource, a?: Pick<SourcesAttention, 'replace'> | null): SheetKey[] {
  const out: SheetKey[] = [];
  const dead = s.standing === 'failing' || s.standing === 'off' || s.standing === 'not_loaded' || !!a?.replace.includes(s.id);
  if (dead && s.main > 0) out.push('replace');
  const loaded = s.standing !== 'not_loaded' && !(s.standing === 'off' && (s.offBy === 'extension' || s.offBy === 'language'));
  if (loaded) out.push('test');
  if (s.standing === 'cooling' || s.state === 'blocked') out.push('unblock');
  if (s.standing === 'off') out.push('turn-on');
  else if (s.standing !== 'not_loaded') out.push('turn-off');
  if (s.kind === 'site') out.push('remove');
  return out;
}

/** The request behind Turn on: undo what switched it off -- an admin's switch, or its extension's. */
export function turnOnRequest(s: Pick<OverviewSource, 'id' | 'kind' | 'offBy'>): { path: string; json?: unknown } {
  const raw = extSourceIdOf(s.id);
  if (s.kind === 'extension' && raw && (s.offBy === 'extension' || s.offBy === 'language')) {
    return { path: '/api/admin/extensions/sources/bulk', json: { ids: [raw], enabled: true } };
  }
  return { path: `/api/admin/sources/${encodeURIComponent(s.id)}/enable` };
}

/**
 * The request behind Turn off. An extension's source through its extension's own switch -- the one its language row
 * flips -- so the sheet never shows a language switched on beside a source switched off (the old Providers' Disable
 * wrote another store, and its extension sheet kept the switch on with no word about it). Every other kind through
 * the admin's switch.
 */
export function turnOffRequest(s: Pick<OverviewSource, 'id' | 'kind'>): { path: string; json?: unknown } {
  const raw = extSourceIdOf(s.id);
  if (s.kind === 'extension' && raw) return { path: '/api/admin/extensions/sources/bulk', json: { ids: [raw], enabled: false } };
  return { path: `/api/admin/sources/${encodeURIComponent(s.id)}/disable` };
}

/** What Turn off asks when series use the source: what stops, and that nothing is deleted. */
export function turnOffQuestion(s: Pick<OverviewSource, 'main' | 'followed'>): string {
  const n = usedBy(s);
  return n === 1 ? tr('1 series uses it. It stops getting new chapters from this source until you turn it back on. Nothing is deleted.')
    : tr('{n} series use it. They stop getting new chapters from this source until you turn it back on. Nothing is deleted.', { n: numberText(n) });
}

/** The Library, filtered to the series whose main source this is (LibraryFilters' Main source), or that follow it. */
export function libraryHref(s: Pick<OverviewSource, 'id' | 'main'>): string {
  return s.main > 0 ? `/library/?src=${encodeURIComponent(s.id)}` : `/library/?anysrc=${encodeURIComponent(s.id)}`;
}

/** The line that leads to them: "Used by 195 series" for its main ones, "Followed by 2 series" for the rest. */
export function usedByLink(s: Pick<OverviewSource, 'main' | 'followed'>): string | null {
  if (s.main > 0) return s.main === 1 ? tr('Used by 1 series') : tr('Used by {n} series', { n: numberText(s.main) });
  if (s.followed > 0) return s.followed === 1 ? tr('Followed by 1 series') : tr('Followed by {n} series', { n: numberText(s.followed) });
  return null;
}

/** The sheet's facts under its name: kind, language, and what it is to the library. */
export function sheetFacts(s: OverviewSource): string[] {
  return [
    kindLabel(s.kind),
    langText(s.lang),
    s.main > 0 ? (s.main === 1 ? tr('main source of 1 series') : tr('main source of {n} series', { n: numberText(s.main) })) : '',
    s.followed > 0 ? (s.followed === 1 ? tr('followed by 1 series') : tr('followed by {n} series', { n: numberText(s.followed) })) : '',
  ].filter(Boolean);
}

/** A refused Remove (retire `{how: 'remove'}`, or the custom-site DELETE), in words: 409 `in_use` names how many. */
export function retireRefusal(code: string | null | undefined, main?: number): string | null {
  if (code !== 'in_use') return null;
  const n = Number(main ?? 0);
  return n === 1 ? tr('It is still the main source of 1 series. Replace it first.')
    : n > 1 ? tr('It is still the main source of {n} series. Replace it first.', { n: numberText(n) })
    : tr('Series still use it as their main source. Replace it first.');
}

// ---- Replace -------------------------------------------------------------------------------------------------------

/** GET /api/admin/sources/:id/replace-preview: what Replace would do, before Start. */
export interface ReplacePreview {
  main: number;
  /** Already follow a usable source: that one becomes their main source, no search. */
  withBackup: number;
  /** Are searched for on the other sources. */
  toSearch: number;
  /** Numbered by posting order: refused, and left on the source. */
  postingOrder: number;
  /** Another search for other sources is running: Start waits for it. */
  busy: boolean;
}

/**
 * The numbered lines of the Replace dialog: the series that move at once, the ones searched for, the ones numbered by
 * posting order (which stay), and -- with "Turn it off when done" -- the source turned off at the end.
 */
export function replacePlan(p: ReplacePreview, name: string, turnOff: boolean): string[] {
  const lines: string[] = [];
  if (p.withBackup > 0) {
    lines.push(p.withBackup === 1 ? tr('1 already follows a working source: it becomes its main source.')
      : tr('{n} already follow a working source: it becomes their main source.', { n: numberText(p.withBackup) }));
  }
  if (p.toSearch > 0) {
    lines.push(p.withBackup > 0
      ? (p.toSearch === 1 ? tr('The other 1 is searched for on your other sources.') : tr('The other {n} are searched for on your other sources.', { n: numberText(p.toSearch) }))
      : (p.toSearch === 1 ? tr('It is searched for on your other sources.') : tr('All {n} are searched for on your other sources.', { n: numberText(p.toSearch) })));
  }
  if (p.postingOrder > 0) {
    lines.push(p.postingOrder === 1 ? tr('1 numbered by posting order stays as it is.')
      : tr('{n} numbered by posting order stay as they are.', { n: numberText(p.postingOrder) }));
  }
  if (turnOff) lines.push(tr('{name} is turned off once nothing uses it.', { name: `⁨${name}⁩` }));
  return lines;
}

/** "195 series use it as their main source", under the dialog's title. */
export const replaceSubtitle = (main: number): string =>
  (main === 1 ? tr('1 series uses it as its main source') : tr('{n} series use it as their main source', { n: numberText(main) }));
