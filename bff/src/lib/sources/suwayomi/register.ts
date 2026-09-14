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
  /** The extension package this source belongs to, and the extension's own name. Null when the engine did not say. */
  pkg_name: string | null;
  ext_name: string | null;
}

export async function enabledSourceIds(): Promise<Set<string>> {
  const rows = await q<{ source_id: string }>('SELECT source_id FROM suwayomi_sources WHERE enabled = true');
  return new Set(rows.map((r) => r.source_id));
}

/** Remember what Suwayomi offered, so the admin list still renders when Suwayomi is briefly unreachable. */
async function remember(sources: RemoteSource[]): Promise<void> {
  for (const s of sources) {
    await q(
      // `nsfw` is refreshed on every re-register alongside the name and language: an extension that turns
      // adult in a later version must not keep an old `false` and stay reachable by a capped account.
      // `pkg_name`/`ext_name` are refreshed the same way so the Providers page can fold one extension's
      // language variants into one card; both are null rather than '' when the engine did not say, because
      // '' is a real (if silly) package name and would fold every unknown source into one group.
      `INSERT INTO suwayomi_sources (source_id, name, lang, nsfw, enabled, pkg_name, ext_name) VALUES ($1,$2,$3,$4,false,$5,$6)
       ON CONFLICT (source_id) DO UPDATE SET name = EXCLUDED.name, lang = EXCLUDED.lang, nsfw = EXCLUDED.nsfw,
         pkg_name = EXCLUDED.pkg_name, ext_name = EXCLUDED.ext_name`,
      [
        String(s.id), s.displayName?.trim() || s.name, s.lang ?? null, !!s.isNsfw,
        s.extension?.pkgName?.trim() || null, s.extension?.name?.trim() || null,
      ],
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

// The most recent load, kept so the cap overflow is readable after the fact. Until this existed the only
// record of "skipped 30 over the limit" was one console.warn at boot, which is exactly where nobody looks
// when search quietly stops covering half their sources; the status route and the health page read it now.
let last: LoadResult | null = null;
export const lastSuwayomiLoad = (): LoadResult | null => last;

/**
 * Called at boot and from reloadAll(). Returns a summary rather than throwing, so a dead extension server
 * degrades to "no extension sources" instead of taking the server down with it.
 */
export async function loadSuwayomiSources(list: () => Promise<RemoteSource[]> = listRemoteSources): Promise<LoadResult> {
  last = await load(list);
  return last;
}

async function load(list: () => Promise<RemoteSource[]>): Promise<LoadResult> {
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

/**
 * Keep trying, quietly, after a failed first load.
 *
 * The engine is a JVM and takes longer to accept connections than Uchiyomi does to boot, so on a cold
 * `docker compose up` the first attempt reliably fails. Without this the extension sources stay missing and
 * the panel says "unreachable" until someone thinks to hit reload -- which is exactly the kind of "turn it on
 * yourself" friction this feature is not supposed to have.
 *
 * Backs off and gives up rather than retrying forever: if it is still refusing after a few minutes it is
 * genuinely not there, and the panel says so honestly.
 */
export function scheduleSuwayomiRetry(delaysMs: number[] = [5_000, 15_000, 30_000, 60_000, 120_000]): void {
  if (!suwayomiConfigured()) return;
  let i = 0;
  const attempt = async (): Promise<void> => {
    if (i >= delaysMs.length) return;
    const wait = delaysMs[i++];
    setTimeout(() => {
      void loadSuwayomiSources()
        .then((r) => {
          if (r.reachable) {
            console.log(`[sources] suwayomi: connected on retry (${r.registered} extension source(s))`);
            return;
          }
          void attempt();
        })
        .catch(() => attempt());
    }, wait).unref?.();
  };
  void attempt();
}
