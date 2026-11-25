// The values behind a source pack's declared settings (SourceAdapter.preferences), kept by the server because a pack
// has no engine to keep them and its files are mounted read-only. The pack reads them through SourceHost.settings,
// which returns ONLY the keys saved here -- so a pack keeps its own `stored ?? env ?? file ?? constant` chain.
//
// A secret is sealed with lib/secretbox.ts (AES-256-GCM under JWT_SECRET, which lives outside the database): a
// database dump alone yields no usable cookie or token, and a rotated JWT_SECRET makes the value unreadable rather
// than wrong -- the sheet asks for it again.
import { q } from './db';
import { open, seal } from './secretbox';
import { fitsType, sameSettingValue, validateSettingValue } from './sources/preferences';
import type { PrefValue, SourcePreference } from './sources/types';

const PURPOSE = 'sourcepref' as const;

export interface StoredSettings {
  /** Only the keys that were saved, decrypted where the declaration says secret. */
  values: Map<string, PrefValue>;
  /** A row that exists but cannot be read (a rotated JWT_SECRET, or a value of the wrong shape). */
  unreadable: Set<string>;
}

/** Every stored value for one source, limited to the settings the loaded adapter declares now. */
export async function readSourceSettings(id: string, prefs: readonly SourcePreference[]): Promise<StoredSettings> {
  const out: StoredSettings = { values: new Map(), unreadable: new Set() };
  if (!prefs.length) return out;
  const rows = await q<{ key: string; value: unknown }>('SELECT key, value FROM source_settings WHERE source_id = $1', [id]);
  const stored = new Map(rows.map((r) => [r.key, r.value]));
  for (const p of prefs) {
    if (!stored.has(p.key)) continue;
    const raw = stored.get(p.key);
    if (p.secret) {
      const opened = typeof raw === 'string' ? open(raw, PURPOSE) : null;
      if (opened === null) out.unreadable.add(p.key); else out.values.set(p.key, opened);
    } else if (fitsType(p.type, raw)) {
      out.values.set(p.key, raw);
    } else {
      out.unreadable.add(p.key);
    }
  }
  return out;
}

/** Save one setting; false when it already held that value (a switch flipped back, a text field re-saved). */
export async function writeSourceSetting(id: string, p: SourcePreference, value: unknown): Promise<{ changed: boolean; value: PrefValue }> {
  const v = validateSettingValue(p, value);
  const { values } = await readSourceSettings(id, [p]);
  if (sameSettingValue(values.get(p.key), v)) return { changed: false, value: v };
  const raw = p.secret ? seal(String(v), PURPOSE) : v;
  await q(
    `INSERT INTO source_settings (source_id, key, value, updated_at) VALUES ($1, $2, $3::jsonb, now())
     ON CONFLICT (source_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [id, p.key, JSON.stringify(raw)],
  );
  return { changed: true, value: v };
}

/** Drop the stored value: the pack falls back to its own configuration again. */
export async function clearSourceSetting(id: string, key: string): Promise<void> {
  await q('DELETE FROM source_settings WHERE source_id = $1 AND key = $2', [id, key]);
}
