// An extension's own settings (#116): the preference screen Mihon shows for a source, read and written through
// the extension engine.
//
// Issue #116 is the reason this exists. The Webtoons extension numbers a post from the first `ep`/`ch` token in
// its title, so Istrevelia's 226 posts land on 13 numbers, and it has a switch -- "Use sequential chapter
// numbering" -- that gives exactly 1..226. Uchiyomi had no way to reach it.
//
// ⚠️ A WRITE IS ADDRESSED BY KEY, NEVER BY POSITION. The engine's updateSourcePreference takes a list POSITION,
// and it indexes the screen built by the LAST read of that source's preferences (Source.setSourcePreference,
// v2.3.2243). A position a browser read a minute ago can name a different preference after an extension update
// reorders its screen -- a write meant for "Image quality" would land on whatever sits there now. So the client
// names the key, and writeSourcePref reads the screen again, finds the key's CURRENT position, checks the value
// against that preference's own type and choices, and only then sends it. The read also builds the screen the
// engine resolves the position against, which a write with no read before it does not have (a
// NullPointerException on the engine).
//
// ⚠️ THE UNION IS SELECTED WITH ALIASES. `currentValue` and `default` are Boolean on a switch, String on a list
// and [String!] on a multi-select. graphql-java refuses two fields with one response name and different types
// in one selection (OverlappingFieldsCanBeMerged holds even across the members of a union), so each shape gets
// its own name. The fake engine does not model that rule (bff/test/fixtures/fakeSuwayomiEngine.mjs says so);
// the aliases are for the real one.
//
// Field names, argument and input shapes were read off the pinned engine's schema
// (test/fixtures/suwayomi-v2.3.2243-schema.json: Preference, SourcePreferenceChangeInput, UpdateSourcePreferencePayload).
import { gql as defaultGql, type Gql } from './client';
import { say, type Part } from '../../said';

/** The five kinds of preference, as the settings sheet draws them. `text` is the engine's EditTextPreference. */
export type PrefType = 'switch' | 'checkbox' | 'list' | 'multiselect' | 'text';
export type PrefValue = boolean | string | string[];

export interface SourcePref {
  key: string;
  /** Where it sits on the engine's screen right now. Server-side only: a client never addresses a write by it. */
  position: number;
  type: PrefType;
  title: string | null;
  summary: string | null;
  visible: boolean;
  /** A disabled preference is left alone by the engine, silently -- so it is refused here, with a reason. */
  enabled: boolean;
  value: PrefValue | null;
  default: PrefValue | null;
  entries?: string[];
  entryValues?: string[];
  dialogTitle?: string | null;
  dialogMessage?: string | null;
  /** Changing it changes the chapter numbers the source gives (isNumberingPref): the settings sheet warns. */
  numbering: boolean;
}

export interface PrefSource {
  id: string;
  name: string;
  lang: string | null;
  pkgName: string | null;
  extensionName: string | null;
}

export interface SourcePrefs {
  source: PrefSource;
  /** Every source the same extension provides (one per language), this one included: the sheet's language select. */
  siblings: Array<{ id: string; name: string; lang: string | null }>;
  preferences: SourcePref[];
}

const SHAPES = `__typename
  ... on SwitchPreference { key title summary visible enabled bool: currentValue boolDefault: default }
  ... on CheckBoxPreference { key title summary visible enabled bool: currentValue boolDefault: default }
  ... on EditTextPreference { key title summary visible enabled str: currentValue strDefault: default text dialogTitle dialogMessage }
  ... on ListPreference { key title summary visible enabled str: currentValue strDefault: default entries entryValues }
  ... on MultiSelectListPreference { key title summary visible enabled strs: currentValue strsDefault: default entries entryValues dialogTitle dialogMessage }`;

/** One source's preference screen, with the source and its extension's other sources. */
export const SOURCE_PREFS_Q = `query($id:LongString!){ source(id:$id){ id name displayName lang
  extension { pkgName name source { nodes { id name displayName lang } } }
  preferences { ${SHAPES} } } }`;

/** The one state field each kind is written through (SourcePreferenceChangeInput), and its GraphQL type. */
const STATE: Record<PrefType, { field: string; type: string }> = {
  switch: { field: 'switchState', type: 'Boolean' },
  checkbox: { field: 'checkBoxState', type: 'Boolean' },
  text: { field: 'editTextState', type: 'String' },
  list: { field: 'listState', type: 'String' },
  multiselect: { field: 'multiSelectState', type: '[String!]' },
};

/**
 * The write, for one kind: the position and that kind's state alone. Only the matching field is sent -- the
 * engine reads the one field of the preference's class ("Expected change to <Class>" when it is missing) and a
 * state for another class would be noise at best. The field and its type come from STATE, never from a request.
 */
export const updatePrefMutation = (type: PrefType): string => {
  const s = STATE[type];
  return `mutation($source:LongString!,$position:Int!,$value:${s.type}){
  updateSourcePreference(input:{source:$source,change:{position:$position,${s.field}:$value}}){ preferences { ${SHAPES} } } }`;
};

/**
 * Does this preference change the chapter numbers the source gives? Then changing it moves every series from
 * the source onto other numbers under their files (the settings sheet warns, and the route queues a remap). Read
 * from the key and the title, because that is all an extension says about a preference: Webtoons' "Use
 * sequential chapter numbering", and the "chapter number" / "episode number" wordings other extensions use.
 */
export const isNumberingPref = (p: { key?: string | null; title?: string | null }): boolean =>
  /sequential|numbering|chapter.?number|episode.?number/i.test(`${p.key ?? ''} ${p.title ?? ''}`);

const TYPE_OF: Record<string, PrefType> = {
  SwitchPreference: 'switch',
  CheckBoxPreference: 'checkbox',
  EditTextPreference: 'text',
  ListPreference: 'list',
  MultiSelectListPreference: 'multiselect',
};

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/**
 * Every node of the engine's screen in one shape, in screen order, with its position. A node without a key, or
 * of a kind this version does not know, keeps its place in the count -- positions index the WHOLE screen -- but
 * is not offered: it cannot be addressed by key, and a kind we do not know we cannot validate.
 */
export function toPrefs(nodes: unknown): SourcePref[] {
  const out: SourcePref[] = [];
  (Array.isArray(nodes) ? nodes : []).forEach((n: any, position) => {
    const type = TYPE_OF[n?.__typename];
    if (!type || typeof n.key !== 'string' || !n.key) return;
    const base = {
      key: n.key as string, position, type, title: strOrNull(n.title), summary: strOrNull(n.summary),
      visible: n.visible !== false, enabled: n.enabled !== false,
    };
    let p: SourcePref;
    if (type === 'switch' || type === 'checkbox') {
      p = { ...base, value: typeof n.bool === 'boolean' ? n.bool : null, default: typeof n.boolDefault === 'boolean' ? n.boolDefault : null, numbering: false };
    } else if (type === 'list') {
      p = { ...base, value: strOrNull(n.str), default: strOrNull(n.strDefault), entries: strs(n.entries), entryValues: strs(n.entryValues), numbering: false };
    } else if (type === 'multiselect') {
      p = {
        ...base, value: Array.isArray(n.strs) ? strs(n.strs) : null, default: Array.isArray(n.strsDefault) ? strs(n.strsDefault) : null,
        entries: strs(n.entries), entryValues: strs(n.entryValues), dialogTitle: strOrNull(n.dialogTitle), dialogMessage: strOrNull(n.dialogMessage), numbering: false,
      };
    } else {
      // currentValue, then `text` (the older field), then the default: an EditText the extension never wrote.
      p = {
        ...base, value: strOrNull(n.str) ?? strOrNull(n.text), default: strOrNull(n.strDefault),
        dialogTitle: strOrNull(n.dialogTitle), dialogMessage: strOrNull(n.dialogMessage), numbering: false,
      };
    }
    p.numbering = isNumberingPref(p);
    out.push(p);
  });
  return out;
}

export type PrefErrorCode = 'unknown_pref' | 'ambiguous_pref' | 'disabled' | 'bad_value';
/** A write the client got wrong: its code, and its sentence with the code the web words it by (lib/said.ts `pref.*`). */
export class PrefError extends Error {
  constructor(public code: PrefErrorCode, public said: Part) { super(said.text); }
}

/** The longest text an EditText takes from here: a user agent or a base URL, not a document. */
export const PREF_TEXT_MAX = 2000;

/**
 * The value to send for `p`, or a PrefError saying why not. The engine checks none of this -- it stores a list
 * value outside entryValues as readily as one inside (measured, v2.3.2243) -- and an extension reading back a
 * value it never offered is an extension that fails on the site, far from here.
 */
export function validatePrefValue(p: SourcePref, value: unknown): PrefValue {
  const label = p.title || p.key;
  switch (p.type) {
    case 'switch':
    case 'checkbox':
      if (typeof value !== 'boolean') throw new PrefError('bad_value', say('pref.onOff', { label }));
      return value;
    case 'list':
      if (typeof value !== 'string' || !(p.entryValues ?? []).includes(value)) throw new PrefError('bad_value', say('pref.noChoice', { label, value: String(value).slice(0, 40) }));
      return value;
    case 'multiselect': {
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) throw new PrefError('bad_value', say('pref.choices', { label }));
      const bad = value.find((v) => !(p.entryValues ?? []).includes(v));
      if (bad !== undefined) throw new PrefError('bad_value', say('pref.noChoice', { label, value: String(bad).slice(0, 40) }));
      return [...new Set(value as string[])];
    }
    case 'text':
      if (typeof value !== 'string') throw new PrefError('bad_value', say('pref.text', { label }));
      if (value.length > PREF_TEXT_MAX) throw new PrefError('bad_value', say('pref.tooLong', { label }));
      return value;
  }
}

/** The one preference a key names on the current screen, or why a write cannot go to it. */
export function prefByKey(prefs: readonly SourcePref[], key: string): SourcePref {
  const hits = prefs.filter((p) => p.key === key);
  if (!hits.length) throw new PrefError('unknown_pref', say('pref.unknown'));
  // Two preferences under one key: no position could be the right one, so neither is written.
  if (hits.length > 1) throw new PrefError('ambiguous_pref', say('pref.ambiguous'));
  return hits[0];
}

/** A multi-select is a set: the same choices in another order are the same value. */
export function samePrefValue(a: PrefValue | null | undefined, b: PrefValue | null | undefined): boolean {
  if (!Array.isArray(a) || !Array.isArray(b)) return !Array.isArray(a) && !Array.isArray(b) && (a ?? null) === (b ?? null);
  const x = [...new Set(a)].sort();
  const y = [...new Set(b)].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

const nameOf = (s: { name?: string | null; displayName?: string | null }): string => s.displayName?.trim() || s.name?.trim() || '';

/** Read one source's preference screen (and, on the engine, build the screen its next write resolves against). */
export async function readSourcePrefs(id: string, run: Gql = defaultGql): Promise<SourcePrefs> {
  const d = await run<{ source: any }>(SOURCE_PREFS_Q, { id }, 20000);
  const s = d?.source;
  const ext = s?.extension ?? null;
  const siblings = (ext?.source?.nodes ?? [])
    .filter((n: any) => n && n.id != null)
    .map((n: any) => ({ id: String(n.id), name: nameOf(n) || String(n.id), lang: n.lang ?? null }));
  return {
    source: { id: String(s?.id ?? id), name: nameOf(s ?? {}) || id, lang: s?.lang ?? null, pkgName: ext?.pkgName ?? null, extensionName: ext?.name ?? null },
    siblings: siblings.length ? siblings : [{ id: String(s?.id ?? id), name: nameOf(s ?? {}) || id, lang: s?.lang ?? null }],
    preferences: toPrefs(s?.preferences),
  };
}

export interface PrefWrite {
  /** The preference as it stood before the write, and after. */
  before: SourcePref;
  after: SourcePref | null;
  /** The screen the engine answered with. */
  preferences: SourcePref[];
  /** The value changed (a write of the value it already had changes nothing and queues nothing). */
  changed: boolean;
  /** The engine holds the value asked for. */
  applied: boolean;
}

/**
 * Change one preference, addressed by key: read the screen again, resolve the key's position NOW, validate the
 * value against that preference, send the typed state. Throws PrefError for anything the client got wrong, and
 * the engine's own error for anything else.
 */
export async function writeSourcePref(id: string, key: string, value: unknown, run: Gql = defaultGql): Promise<PrefWrite> {
  const { preferences } = await readSourcePrefs(id, run);
  const before = prefByKey(preferences, key);
  if (!before.enabled) throw new PrefError('disabled', say('pref.disabled', { label: before.title || before.key }));
  const v = validatePrefValue(before, value);
  const d = await run<{ updateSourcePreference: { preferences: unknown } | null }>(
    updatePrefMutation(before.type), { source: id, position: before.position, value: v }, 20000,
  );
  const after = toPrefs(d?.updateSourcePreference?.preferences);
  const now = after.find((p) => p.key === key) ?? null;
  return { before, after: now, preferences: after, changed: !samePrefValue(before.value, v), applied: !!now && samePrefValue(now.value, v) };
}
