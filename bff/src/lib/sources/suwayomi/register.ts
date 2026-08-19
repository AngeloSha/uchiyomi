// Register the Suwayomi sources the operator has switched on.
//
// Registration is opt-in per source, and that is not a preference — it is what keeps the feature usable.
// GET /api/sources/search-all fans out to EVERY registered source with a 20s timeout each, so registering
// the several hundred sources a full extension set exposes would make cross-source search unusable and
// would hit every one of those sites at once.
//
// Everything here fails soft. Suwayomi being unset, down, or unauthorised must leave Uchiyomi booting and
// working exactly as it does without it.
import { q } from '../../db';
import { env } from '../../../env';
import { registerAdapter } from '../loader';
import { listRemoteSources, makeSuwayomiAdapter, type RemoteSource } from './sources';
import { suwayomiConfigured } from './client';

export interface EnabledRow {
  source_id: string;
  name: string;
  lang: string | null;
  enabled: boolean;
}

export async function enabledSourceIds(): Promise<Set<string>> {
  const rows = await q<{ source_id: string }>('SELECT source_id FROM suwayomi_sources WHERE enabled = true');
  return new Set(rows.map((r) => r.source_id));
}

/** Remember what Suwayomi offered, so the admin list still renders when Suwayomi is briefly unreachable. */
async function remember(sources: RemoteSource[]): Promise<void> {
  for (const s of sources) {
    await q(
      `INSERT INTO suwayomi_sources (source_id, name, lang, enabled) VALUES ($1,$2,$3,false)
       ON CONFLICT (source_id) DO UPDATE SET name = EXCLUDED.name, lang = EXCLUDED.lang`,
      [String(s.id), s.displayName?.trim() || s.name, s.lang ?? null],
    ).catch(() => {});
  }
}

export interface LoadResult {
  configured: boolean;
  reachable: boolean;
  available: number;
  registered: number;
  skipped: number;
  error?: string;
}

/**
 * Called at boot and from reloadAll(). Returns a summary rather than throwing, so a dead extension server
 * degrades to "no extension sources" instead of taking the server down with it.
 */
export async function loadSuwayomiSources(list: () => Promise<RemoteSource[]> = listRemoteSources): Promise<LoadResult> {
  if (!suwayomiConfigured()) return { configured: false, reachable: false, available: 0, registered: 0, skipped: 0 };

  let remote: RemoteSource[];
  try {
    remote = await list();
  } catch (e) {
    const msg = (e as Error)?.message || 'unreachable';
    console.warn(`[sources] suwayomi: could not list sources (${msg})`);
    return { configured: true, reachable: false, available: 0, registered: 0, skipped: 0, error: msg };
  }

  await remember(remote);
  const enabled = await enabledSourceIds().catch(() => new Set<string>());
  const wanted = remote.filter((s) => enabled.has(String(s.id)));

  let registered = 0;
  let skipped = 0;
  for (const s of wanted) {
    // Cap registrations rather than silently letting search fan out forever. Say what was dropped.
    if (registered >= env.SUWAYOMI_MAX_SOURCES) {
      skipped++;
      continue;
    }
    if (registerAdapter(makeSuwayomiAdapter(s))) registered++;
  }
  if (skipped) {
    console.warn(
      `[sources] suwayomi: registered ${registered} source(s); skipped ${skipped} over the SUWAYOMI_MAX_SOURCES limit of ${env.SUWAYOMI_MAX_SOURCES}`,
    );
  }
  return { configured: true, reachable: true, available: remote.length, registered, skipped };
}
