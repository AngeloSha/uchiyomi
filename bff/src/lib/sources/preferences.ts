// A source pack's declared settings, validated once at registration and served by the routes in
// lib/sourceSettings.ts. Kept free of the database so the loader can validate a pack without pulling one in.
import { say, type Part } from '../said';
import type { PrefType, PrefValue, SourcePreference } from './types';

const TYPES: readonly PrefType[] = ['switch', 'checkbox', 'list', 'multiselect', 'text'];
/** A key names a column in a pack's own configuration too: the same shape an env var has. */
const KEY = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;
/** Long enough for a full browser Cookie header, short enough that the field stays a setting and not a document. */
export const SETTING_TEXT_MAX = 4096;

export type SettingErrorCode = 'unknown_pref' | 'bad_value';

/** A refused write, with the sentence the settings sheet shows (lib/said.ts `setting.*`). */
export class SettingError extends Error {
  constructor(public code: SettingErrorCode, public said: Part) { super(said.text); }
}

/** Whether a stored value has the shape the declared type expects. */
export function fitsType(type: PrefType, value: unknown): value is PrefValue {
  switch (type) {
    case 'switch':
    case 'checkbox': return typeof value === 'boolean';
    case 'list': return typeof value === 'string';
    case 'multiselect': return Array.isArray(value) && value.every((v) => typeof v === 'string');
    case 'text': return typeof value === 'string';
  }
}

/**
 * The value to store for `p`, or a SettingError saying why not. Like an extension's write, the pack is not asked:
 * a list value outside its own entryValues is refused here rather than saved for the pack to trip over later.
 */
export function validateSettingValue(p: SourcePreference, value: unknown): PrefValue {
  const label = p.title || p.key;
  switch (p.type) {
    case 'switch':
    case 'checkbox':
      if (typeof value !== 'boolean') throw new SettingError('bad_value', say('setting.onOff', { label }));
      return value;
    case 'list':
      if (typeof value !== 'string' || !(p.entryValues ?? []).includes(value)) {
        throw new SettingError('bad_value', say('setting.noChoice', { label, value: String(value).slice(0, 40) }));
      }
      return value;
    case 'multiselect': {
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
        throw new SettingError('bad_value', say('setting.choices', { label }));
      }
      const bad = value.find((v) => !(p.entryValues ?? []).includes(v));
      if (bad !== undefined) throw new SettingError('bad_value', say('setting.noChoice', { label, value: String(bad).slice(0, 40) }));
      return [...new Set(value as string[])];
    }
    case 'text':
      if (typeof value !== 'string') throw new SettingError('bad_value', say('setting.text', { label }));
      if (value.length > SETTING_TEXT_MAX) throw new SettingError('bad_value', say('setting.tooLong', { label }));
      return value;
  }
}

/** A multi-select is a set: the same choices in another order are the same value. */
export function sameSettingValue(a: PrefValue | null | undefined, b: PrefValue | null | undefined): boolean {
  if (!Array.isArray(a) || !Array.isArray(b)) return !Array.isArray(a) && !Array.isArray(b) && (a ?? null) === (b ?? null);
  const x = [...new Set(a)].sort();
  const y = [...new Set(b)].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/**
 * The declarations a pack may offer: invalid entries are dropped one by one, never the whole source. A pack's
 * settings are a convenience around its own configuration, and a typo in one must not take the source away.
 */
export function validatePreferences(input: unknown): SourcePreference[] {
  const out: SourcePreference[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(input) ? input : []) {
    const p = raw as Partial<SourcePreference> | null;
    if (!p || typeof p.key !== 'string' || !KEY.test(p.key) || seen.has(p.key) || !TYPES.includes(p.type as PrefType)) continue;
    const type = p.type as PrefType;
    const entries = Array.isArray(p.entries) ? p.entries.filter((v): v is string => typeof v === 'string') : undefined;
    const entryValues = Array.isArray(p.entryValues) ? p.entryValues.filter((v): v is string => typeof v === 'string') : undefined;
    if ((type === 'list' || type === 'multiselect') && !entryValues?.length) continue;
    if (entries && entryValues && entries.length !== entryValues.length) continue;
    const pref: SourcePreference = {
      key: p.key,
      type,
      title: typeof p.title === 'string' && p.title.trim() ? p.title.trim().slice(0, 200) : p.key,
      ...(typeof p.summary === 'string' && p.summary.trim() ? { summary: p.summary.trim().slice(0, 500) } : {}),
      ...(entries?.length ? { entries } : {}),
      ...(entryValues?.length ? { entryValues } : {}),
      ...(p.numbering === true ? { numbering: true } : {}),
      // A secret is a text value by definition: a switch or a list has nothing to hide.
      ...(type === 'text' && p.secret === true ? { secret: true } : {}),
    };
    if (p.default !== undefined) {
      try { pref.default = validateSettingValue(pref, p.default); } catch { /* an unusable default is left out */ }
    }
    out.push(pref);
    seen.add(pref.key);
  }
  return out;
}

/** A setting as the settings sheet gets it: no stored secret ever leaves the server. */
export function wireSetting(p: SourcePreference, stored: { values: Map<string, PrefValue>; unreadable: Set<string> }) {
  const unreadable = stored.unreadable.has(p.key);
  const set = stored.values.has(p.key) || unreadable;
  return {
    key: p.key,
    type: p.type,
    title: p.title,
    summary: p.summary ?? null,
    visible: true,
    enabled: true,
    // A secret is answered as "set", never as its value. An unset setting shows its declared default, so the
    // sheet has something to edit -- `set` is what says whether the stored layer is active.
    value: p.secret ? null : set && !unreadable ? stored.values.get(p.key)! : p.default ?? null,
    default: p.default ?? null,
    ...(p.entries ? { entries: p.entries } : {}),
    ...(p.entryValues ? { entryValues: p.entryValues } : {}),
    dialogTitle: null,
    dialogMessage: null,
    numbering: !!p.numbering,
    secret: !!p.secret,
    set,
    unreadable,
  };
}

export type SettingWire = ReturnType<typeof wireSetting>;
