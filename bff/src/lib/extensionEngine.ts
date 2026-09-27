// What Admin → Extensions and Health say about the extension engine, and the one change they may make to it (#72).
//
// Three readers, three different needs:
//   * GET /api/admin/extensions/status asks the engine LIVE on every call, because it is what "Check again" and
//     the setup screen's polling read, and it heals a registration that missed the engine coming back;
//   * Health asks through a 30-second memo with a 3-second limit (engineProbe), because GET /api/admin/health
//     is mounted by every admin page and re-run after every repair, and must never wait on a JVM;
//   * POST /api/admin/extensions/solver points the engine's own Cloudflare helper at Uchiyomi's, when an admin
//     presses Connect -- never by itself (sources/suwayomi/engineSolver.ts says why).
import { q, one } from './db';
import { env } from '../env';
import { isDesktop } from './desktop';
import { installPlatform } from './platform';
import { aboutServer, gql, suwayomiConfigured, type Gql } from './sources/suwayomi/client';
import { engineHost, engineOffReason } from './sources/suwayomi/engineState';
import {
  getEngineSolver, ourSolverUrl, setEngineSolver, solverHost, solverWiring, type EngineSolver, type SolverWiring,
} from './sources/suwayomi/engineSolver';
import {
  lastSuwayomiLoad, lastSuwayomiLoadAt, onSuwayomiReconnect, retrySuwayomiNow, suwayomiRetryState,
} from './sources/suwayomi/register';
import { getHiddenLangs } from './sources/suwayomi/langs';

/**
 * Series added through an extension, which is what the engine's data is worth: each one is routed by an id that
 * only the engine knows. The warning that names this number is the reason nobody deletes the engine's volume.
 */
export async function linkedSeriesCount(): Promise<number> {
  const r = await one<{ n: number }>(
    `SELECT count(*)::int AS n FROM lib_series WHERE source_id LIKE 'sw:%' AND deleted_at IS NULL`,
  ).catch(() => null);
  return r?.n ?? 0;
}

/** The engine's Cloudflare helper, as the status route sends it. The address never goes to a desktop page. */
export interface SolverView {
  supported: boolean;
  enabled: boolean;
  wiring: SolverWiring;
  /** Whether Uchiyomi has a solver of its own to connect the engine to (FLARESOLVERR_URL). */
  connectable: boolean;
  url?: string;
}

export function solverView(s: EngineSolver, ours = ourSolverUrl(), desktop = isDesktop()): SolverView {
  return {
    supported: s.supported,
    enabled: s.supported ? s.enabled : false,
    wiring: solverWiring(s, ours, desktop),
    connectable: !!ours,
    // ⚠️ Never on desktop: the shell's helper address carries its access token in the path.
    ...(s.supported && !desktop ? { url: s.url } : {}),
  };
}

const iso = (ms: number | null): string | null => (ms ? new Date(ms).toISOString() : null);

/**
 * GET /api/admin/extensions/status.
 *
 * Not configured: why (`off`: the switch, or no address), the platform the setup steps open on, and how many
 * series wait for an engine. Configured: the engine's answer, what registration reached, the retry's progress,
 * the platform, the linked series and, when it answers, its Cloudflare helper.
 *
 * ⚠️ It HEALS a missed registration: when the engine answers now but the last registration found nobody there,
 * it registers before replying (single-flight with the retry loop). That is what makes "Check again" -- a plain
 * refetch of this route -- bring the extensions back the moment the engine does, instead of up to five minutes
 * later when the loop next looks.
 */
export async function engineStatusReport() {
  const platform = installPlatform();
  const linkedSeries = await linkedSeriesCount();
  if (!suwayomiConfigured()) {
    return { configured: false, reachable: false, off: engineOffReason() ?? 'unset', platform, linkedSeries };
  }
  let version: string | null = null;
  let reachable = false;
  let error: string | undefined;
  try {
    version = (await aboutServer()).version;
    reachable = true;
  } catch (e) {
    error = (e as Error)?.message || 'unreachable';
  }
  if (reachable && !lastSuwayomiLoad()?.reachable) await retrySuwayomiNow().catch(() => null);
  let solver: SolverView | undefined;
  if (reachable) {
    // Short: this is a page load, and a helper that cannot be read just leaves the line out.
    solver = await getEngineSolver(gql, 5000).then((s) => solverView(s), () => undefined);
  }
  const counts = await one<{ enabled: number; known: number }>(
    `SELECT count(*) FILTER (WHERE enabled)::int AS enabled, count(*)::int AS known FROM suwayomi_sources`,
  );
  // `enabled` is what the operator asked for; `registered` is what search actually reaches. They differ
  // by `skipped` whenever the cap bites, and until the panel showed all three that gap was invisible.
  const load = lastSuwayomiLoad();
  return {
    configured: true, reachable, version, error, enabled: counts?.enabled ?? 0, known: counts?.known ?? 0,
    registered: load?.registered ?? 0, skipped: load?.skipped ?? 0, cap: env.SUWAYOMI_MAX_SOURCES,
    hiddenLangs: await getHiddenLangs().catch(() => [] as string[]),
    engine: engineHost(), platform, retry: suwayomiRetryState(), lastTry: iso(lastSuwayomiLoadAt()), linkedSeries,
    ...(solver ? { solver } : {}),
  };
}

export type ConnectResult =
  | { ok: true; enabled: boolean; wiring: SolverWiring; audit: { wasEnabled: boolean; host: string } }
  | { ok: false; status: 400 | 502; error: 'no_solver' | 'unsupported' | 'unreachable'; message: string };

/**
 * POST /api/admin/extensions/solver: point the engine's Cloudflare helper at the solver Uchiyomi uses, and switch
 * it on. The caller has checked that there is an engine at all (the route's needExt).
 */
export async function connectEngineSolver(run: Gql = gql): Promise<ConnectResult> {
  const ours = ourSolverUrl();
  if (!ours) {
    return {
      ok: false, status: 400, error: 'no_solver',
      message: 'Uchiyomi has no Cloudflare helper of its own to share: set FLARESOLVERR_URL on Uchiyomi first.',
    };
  }
  let r: Awaited<ReturnType<typeof setEngineSolver>>;
  try {
    r = await setEngineSolver(ours, run);
  } catch (e) {
    return { ok: false, status: 502, error: 'unreachable', message: (e as Error)?.message || 'The extension engine did not answer.' };
  }
  if (!r.after.supported) {
    return { ok: false, status: 400, error: 'unsupported', message: 'This extension engine has no Cloudflare helper setting.' };
  }
  forgetEngineProbe();
  return {
    ok: true,
    enabled: r.after.enabled,
    wiring: solverWiring(r.after, ours, isDesktop()),
    audit: { wasEnabled: r.before.supported ? r.before.enabled : false, host: solverHost(ours) },
  };
}

// ---- the memoised probe Health reads ----------------------------------------------------------------------------

/** How long Health trusts one look at the engine, and the most one look may take. */
export const PROBE_TTL_MS = 30_000;
export const PROBE_TIMEOUT_MS = 3_000;

export interface EngineProbe {
  reachable: boolean;
  version: string | null;
  error: string | null;
  /** Null when the engine did not answer, or its settings could not be read. */
  solver: EngineSolver | null;
}

let memo: { at: number; p: Promise<EngineProbe> } | null = null;

/**
 * One look at the engine for Health: its version and its Cloudflare helper, asked together, each cut off at
 * PROBE_TIMEOUT_MS, and the answer reused for PROBE_TTL_MS (concurrent callers share the one in flight).
 *
 * ⚠️ The limit is the point. The status route's aboutServer waits 8 s and the settings read 15 s, and before
 * this nothing on the Health page talked to the engine at all; a Health GET that waits on a JVM stuck in a GC
 * pause holds every admin page that mounts it.
 */
export function engineProbe(now: number = Date.now()): Promise<EngineProbe> {
  if (memo && now - memo.at < PROBE_TTL_MS) return memo.p;
  // gql's own timeout, whatever each helper asks for: this is the one caller that must not wait.
  const run = (<T,>(query: string, variables: Record<string, unknown> = {}) => gql<T>(query, variables, PROBE_TIMEOUT_MS)) as Gql;
  const p = Promise.allSettled([aboutServer(run), getEngineSolver(run, PROBE_TIMEOUT_MS)]).then(([about, solver]) => ({
    reachable: about.status === 'fulfilled',
    version: about.status === 'fulfilled' ? about.value.version : null,
    error: about.status === 'rejected' ? String((about.reason as Error)?.message || about.reason || 'unreachable') : null,
    solver: about.status === 'fulfilled' && solver.status === 'fulfilled' ? solver.value : null,
  }));
  memo = { at: now, p };
  return p;
}

/** The next Health read asks again: after Connect, and when a retry brings the engine back. */
export function forgetEngineProbe(): void {
  memo = null;
}
onSuwayomiReconnect(forgetEngineProbe);

// ---- Cloudflare evidence on extension sources ---------------------------------------------------------------------

/** Suwayomi's own words when its helper is off (its CloudflareInterceptor), as #54 and #115 recorded them. */
const BYPASS_OFF = 'cloudflare bypass currently disabled';
/** Any other sign that a site is behind Cloudflare. */
const CLOUDFLARE = 'cloudflare|cf[-_]chl|just a moment|cf-mitigated';

export interface CloudflareEvidence {
  sourceId: string;
  name: string;
  /** The engine refused with "Cloudflare bypass currently disabled": the helper being off IS the failure. */
  bypass: boolean;
}

/**
 * Extension sources seen behind Cloudflare in the last week, from what source_health recorded: ordinary use's
 * last error, the last live check (#115's Test and daily check), and #115's per-stage failures. A source someone
 * turned off is left out. Best-effort: a read that fails is no evidence, never an error on the Health page.
 */
export async function cloudflareEvidence(): Promise<CloudflareEvidence[]> {
  const rows = await q<{ source_id: string; name: string; bypass: boolean }>(
    `WITH ev AS (
       SELECT sh.source_id, COALESCE(ss.name, sh.source_id) AS name,
              concat_ws(' ',
                CASE WHEN sh.last_fail_at > now() - interval '7 days' THEN sh.last_error END,
                CASE WHEN sh.live_at > now() - interval '7 days' THEN sh.live_detail END,
                (SELECT string_agg(st.value->>'error', ' ') FROM jsonb_each(COALESCE(sh.stages, '{}'::jsonb)) st
                  WHERE jsonb_typeof(st.value) = 'object'
                    AND st.value->>'failAt' > to_char((now() - interval '7 days') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS'))
              ) AS said
         FROM source_health sh
         LEFT JOIN suwayomi_sources ss ON 'sw:' || ss.source_id = sh.source_id
        WHERE sh.source_id LIKE 'sw:%' AND NOT sh.disabled
     )
     SELECT source_id, name, said ~* $1 AS bypass FROM ev WHERE said ~* $2 ORDER BY name`,
    [BYPASS_OFF, `${BYPASS_OFF}|${CLOUDFLARE}`],
  ).catch(() => [] as Array<{ source_id: string; name: string; bypass: boolean }>);
  return rows.map((r) => ({ sourceId: r.source_id, name: r.name, bypass: !!r.bypass }));
}
