// An extension's own settings, as the settings sheet draws them (#116, components/ExtensionSettings.tsx).
//
// The server reads the preference screen through the extension engine and answers every setting in one shape
// (bff lib/sources/suwayomi/prefs.ts). What is left here is pure: which control a setting gets, what its summary
// says, and what a numbering setting's warning counts. ⚠️ A write names the setting's KEY; no position is ever
// answered or sent -- the engine's positions move when an extension is updated.
import { t as tr } from './i18n';
import { saidText, type Said } from './said';

/** The five kinds the engine has: SwitchPreference, CheckBoxPreference, ListPreference, MultiSelectListPreference, EditTextPreference. */
export type PrefType = 'switch' | 'checkbox' | 'list' | 'multiselect' | 'text';
export type PrefValue = boolean | string | string[];

export interface SourcePref {
  key: string;
  type: PrefType;
  title: string | null;
  summary: string | null;
  visible: boolean;
  enabled: boolean;
  value: PrefValue | null;
  default: PrefValue | null;
  entries?: string[];
  entryValues?: string[];
  dialogTitle?: string | null;
  dialogMessage?: string | null;
  /** Changing it changes the chapter numbers the source gives: the sheet warns before it is changed. */
  numbering: boolean;
}

export interface SourcePrefsAnswer {
  source: { id: string; name: string; lang: string | null; pkgName: string | null; extensionName: string | null };
  siblings: Array<{ id: string; name: string; lang: string | null }>;
  preferences: SourcePref[];
  /** Series in the library from this source. */
  usedBy: number;
  /** Of those, the ones a numbering change renumbers (not the ones numbered by posting order). */
  renumbers: number;
}

export interface PrefWriteAnswer extends Omit<SourcePrefsAnswer, 'source' | 'siblings'> {
  ok: true;
  changed: boolean;
  /** The engine holds the value asked for. */
  applied: boolean;
  /** Series marked to be renumbered, for a numbering setting. */
  remap: number;
}

/**
 * The control a setting gets. A switch and a checkbox are both on/off, and both get the app's Switch; a list is
 * a select; a multi-select a list of checkboxes; a text field an input with its own Save (a keystroke is not a
 * change worth sending to the engine). A setting the extension hides is not drawn at all.
 */
export type PrefControl = 'switch' | 'select' | 'checks' | 'text' | 'hidden';
export function prefControl(p: Pick<SourcePref, 'type' | 'visible'>): PrefControl {
  if (!p.visible) return 'hidden';
  switch (p.type) {
    case 'switch':
    case 'checkbox': return 'switch';
    case 'list': return 'select';
    case 'multiselect': return 'checks';
    case 'text': return 'text';
    default: return 'hidden';
  }
}

/** The label a list shows for a value: its entry, else the value itself. */
export function entryLabel(p: Pick<SourcePref, 'entries' | 'entryValues'>, value: string): string {
  const i = (p.entryValues ?? []).indexOf(value);
  return i >= 0 ? (p.entries ?? [])[i] ?? value : value;
}

/**
 * The line under a setting's title. Android lets a list's summary be `%s`, "the selected entry" -- Webtoons'
 * image quality says exactly that -- so it is filled in here rather than shown as a literal "%s".
 */
export function prefSummary(p: Pick<SourcePref, 'summary' | 'type' | 'value' | 'entries' | 'entryValues'>): string {
  const s = (p.summary ?? '').trim();
  if (!s.includes('%s')) return s;
  const v = typeof p.value === 'string' ? entryLabel(p, p.value) : Array.isArray(p.value) ? p.value.map((x) => entryLabel(p, x)).join(', ') : '';
  return s.replace(/%s/g, v).trim();
}

/** A multi-select's value with one choice turned on or off, in the extension's own order. */
export function toggleChoice(p: Pick<SourcePref, 'entryValues' | 'value'>, choice: string, on: boolean): string[] {
  const now = new Set(Array.isArray(p.value) ? p.value : []);
  if (on) now.add(choice); else now.delete(choice);
  return (p.entryValues ?? []).filter((v) => now.has(v));
}

/**
 * Does changing this setting need a second word? A numbering setting renumbers every series from the source
 * that uses its numbers, so it does -- when there is one to renumber. With none in the library it is only a
 * setting, and a confirm would be a speed bump that says nothing.
 */
export const needsRenumberConfirm = (p: Pick<SourcePref, 'numbering'>, renumbers: number): boolean => p.numbering && renumbers > 0;

/**
 * The deep link to one extension source's settings: its sheet in Admin → Sources, open on them (the Extensions tab's
 * until v0.54.0, whose address lands there too). Health, the series page and the add dialog use it.
 */
export const extensionSettingsHref = (extSourceId: string): string =>
  `/admin/?tab=Sources&settings=${encodeURIComponent(extSourceId)}`;

/** The extension's own source id inside an adapter id (`sw:2522335540328470744`); null for every other source. */
export function extSourceIdOf(adapterId: string | null | undefined): string | null {
  const m = /^sw:(-?\d{1,20})$/.exec(adapterId ?? '');
  return m ? m[1] : null;
}

/**
 * A refused settings read or write, in words: in the reader's language by its code (`messageSaid`, v0.49.1), the
 * extension's own exception inside `extension_error` as it is. From an older server, the 502 `unreachable` -- the
 * ENGINE not answering (bff routes/numbering.ts engineFailure) -- by its error and the component's name everywhere
 * else in the app (its English message said "the extension server"), and anything else as sent.
 */
export function prefErrorText(e: unknown, fallback: string): string {
  let j: { error?: string; message?: string; messageSaid?: Said } = {};
  try { j = JSON.parse((e as { body?: string } | null)?.body || '{}'); } catch { /* not JSON: the fallback */ }
  const old = j.error === 'unreachable' ? tr('The extension engine did not answer. Try again in a moment.') : j.message || fallback;
  return saidText(j.messageSaid, old);
}
