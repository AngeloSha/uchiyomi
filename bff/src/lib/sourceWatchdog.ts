// Check the sources and extensions on a schedule, so a dead one is noticed by the server rather than by a
// reader wondering why a dot is grey.
//
// This exists because of a real six-week failure. Aqua Manga -- 189 of 215 series on the install this was
// written for -- had its domain quietly repurposed into an unrelated website. The adapter kept returning an
// empty list, which throws nothing, so nothing was ever recorded and the source went on reporting healthy.
// Two more sites had moved their listing path and failed the same silent way, one of them for months.
//
// What it will do on its own is deliberately narrow. A moved domain has exactly one correct answer and is
// verifiable before committing to it, so it is followed automatically. An extension with an update
// available is likewise unambiguous. Everything else -- markup drift, a CDN refusing us, a dead host -- is
// reported and left alone, because "disable it" and "wait, it is a blip" look identical from here and
// getting that wrong turns a two-hour outage into a source nobody notices is off.
import { q } from './db';
import { getSource, listSources, reloadAll } from './sources';
import { readSites, writeSites } from './sources/customSites';
import { listExtensions, setExtensionState } from './sources/suwayomi/extensions';
import { smokeTest, probeBase } from './sourceProbe';
import { diagnose, Diagnosis } from './sourceDiagnosis';
import { clearBlock, SourceHealth } from './sourceHealth';
import { notifyAdmins } from './push';
import { logAudit } from './audit';

export interface SourceVerdict {
  id: string;
  name: string;
  code: Diagnosis['code'];
  reason: string;
  fix: string;
  ok: boolean;
  /** What the watchdog changed by itself, if anything. */
  action?: 'followed-move' | 'extension-updated';
}

/** An update that was attempted and did not take, with a reason a person can act on. */
export interface ExtensionUpdateFailure {
  pkgName: string;
  name: string;
  reason: string;
}

export interface WatchdogResult {
  checkedAt: string;
  sources: SourceVerdict[];
  extensionsUpdated: string[];
  /**
   * Updates that were tried and failed. Reported rather than swallowed: an extension whose update 404s stays
   * on its old version for good, and until this existed that outcome looked exactly like having no update.
   */
  extensionsFailed: ExtensionUpdateFailure[];
  /** Verdicts an operator needs to act on. */
  needsAttention: SourceVerdict[];
}

/** Only the codes where doing nothing is the wrong answer. `quiet` and `ok` are not problems to report. */
const ACTIONABLE = new Set<Diagnosis['code']>([
  'moved', 'edge_403', 'cf_challenge', 'solver_crash', 'solver_down', 'solver_timeout',
  'markup_drift', 'unreachable', 'upstream_down',
]);

async function healthOf(id: string): Promise<SourceHealth | null> {
  return q<SourceHealth>(
    `SELECT source_id, status, consecutive, last_error, last_fail_at, last_ok_at, blocked_until, disabled,
            empty_streak, last_empty_at, updated_at FROM source_health WHERE source_id = $1`,
    [id],
  ).then((r) => r[0] ?? null).catch(() => null);
}

/**
 * Follow a site to its new address, but only on proof.
 *
 * The probe having been redirected is not enough on its own: aquareader.net redirected to a chat community
 * and coffeemanga.io to a 404 page wearing a 200. Both would have been "moved" by redirect alone. So the
 * new address has to actually behave like the source before anything is written down, and the id never
 * changes, because the library is keyed on it.
 */
export interface MoveDeps {
  readSites: typeof readSites;
  writeSites: typeof writeSites;
  reloadAll: () => Promise<unknown>;
  getSource: typeof getSource;
  smokeTest: (src: any) => Promise<{ ok: boolean }>;
}
const REAL: MoveDeps = { readSites, writeSites, reloadAll, getSource, smokeTest };

export async function followMove(id: string, to: string, deps: MoveDeps = REAL): Promise<boolean> {
  const { readSites, writeSites, reloadAll, getSource, smokeTest } = deps;
  const list = await readSites();
  const site = list.find((s) => s.id === id);
  if (!site) return false;
  const origin = (() => { try { return new URL(to).origin; } catch { return null; } })();
  if (!origin || origin === site.base) return false;

  const from = site.base;
  site.base = origin;
  await writeSites(list);
  await reloadAll();

  const moved = getSource(id);
  const proof = moved ? await smokeTest(moved) : { ok: false };
  if (!proof.ok) {
    // Put it back. A half-followed move is worse than a broken source: the old address at least still
    // matches what every recorded failure is talking about.
    site.base = from;
    await writeSites(list);
    await reloadAll();
    return false;
  }
  await clearBlock(id).catch(() => {});
  await q(`UPDATE source_health SET empty_streak = 0, last_error = NULL WHERE source_id = $1`, [id]).catch(() => {});
  await logAudit('source.auto_move', { detail: { id, from, to: origin } });
  return true;
}

/**
 * A failed extension update, phrased for whoever has to do something about it.
 *
 * 404 is the one worth naming outright, because it is both the most common and the most misleading: it means
 * the repository's index still advertises a version whose APK is no longer where the index says it is. That
 * is the repository's problem rather than this server's, and nobody reading "HTTP error 404" can tell.
 */
function updateFailureReason(err: unknown): string {
  const msg = (err instanceof Error ? err.message : String(err ?? '')).trim() || 'no reason given';
  if (/\b404\b/.test(msg)) return 'the repository no longer offers that version to download (404)';
  if (/\b(408|timed?[ _-]?out|ETIMEDOUT|abort)/i.test(msg)) return 'the extension server did not answer in time';
  if (/\b5\d\d\b/.test(msg)) return 'the repository host returned a server error';
  return msg.slice(0, 160);
}

/** Injected so the failure paths below can be tested; module-export mocking silently no-ops under esbuild. */
export interface ExtensionDeps {
  listExtensions: typeof listExtensions;
  setExtensionState: typeof setExtensionState;
  logAudit: typeof logAudit;
}

const liveExtensionDeps: ExtensionDeps = { listExtensions, setExtensionState, logAudit };

/**
 * Extensions the extension server says have a newer version. Unambiguous, so just take them.
 *
 * Every outcome is recorded. The previous version ended each attempt with `.catch(() => false)`, which made a
 * failed update indistinguishable from no update being available: nothing logged, nothing surfaced, nothing
 * for anyone to notice. An extension can sit broken behind that silence indefinitely.
 */
export async function updateExtensions(
  deps: ExtensionDeps = liveExtensionDeps,
): Promise<{ updated: string[]; failed: ExtensionUpdateFailure[] }> {
  const updated: string[] = [];
  const failed: ExtensionUpdateFailure[] = [];
  const exts = await deps.listExtensions().catch(() => []);
  for (const e of exts) {
    if (!e.installed || !e.hasUpdate) continue;
    const name = e.name || e.pkgName;
    let ok = false;
    let reason = '';
    try {
      ok = await deps.setExtensionState(e.pkgName, 'update');
      // A falsy result is its own failure: the server took the request and did not install anything.
      if (!ok) reason = 'the extension server accepted the request but did not install it';
    } catch (err) {
      reason = updateFailureReason(err);
    }
    if (ok) {
      updated.push(name);
      await deps.logAudit('extension.auto_update', { detail: { pkgName: e.pkgName, name } });
    } else {
      failed.push({ pkgName: e.pkgName, name, reason });
      await deps.logAudit('extension.auto_update_failed', { detail: { pkgName: e.pkgName, name, reason } });
    }
  }
  return { updated, failed };
}

/**
 * One sweep: probe every enabled source, diagnose it, fix what is safe to fix, report the rest.
 *
 * Sources are checked one at a time on purpose. Each check is a real scrape of a real site and several of
 * them share one Cloudflare solver; running forty at once is how you turn a health check into the thing
 * that makes everything unhealthy.
 */
let running = false;
/** True while a sweep is in flight, so the schedule and the admin button cannot overlap. */
export const checkRunning = (): boolean => running;

export async function runSourceCheck(opts: { autoFix?: boolean } = {}): Promise<WatchdogResult> {
  if (running) throw Object.assign(new Error('a source check is already running'), { busy: true });
  running = true;
  try {
    return await sweep(opts);
  } finally {
    running = false;
  }
}

async function sweep(opts: { autoFix?: boolean }): Promise<WatchdogResult> {
  const autoFix = opts.autoFix !== false;
  const verdicts: SourceVerdict[] = [];

  for (const src of listSources()) {
    const h = await healthOf(src.id);
    if (h?.disabled) continue; // switched off deliberately; not a fault to report

    const bare = src.base ? await probeBase(src.base) : undefined;
    const smoke = await smokeTest(src);
    // The adapter's own result and whether this source is solver-fronted are both live evidence, and both
    // outrank a bare homepage request. Without them a Cloudflare-protected site that works perfectly reads
    // as a 403 block, because the probe deliberately does not use the solver.
    const probe = bare && { ...bare, adapterOk: smoke.ok, needsSolver: !!src.requiresCloudflare };
    const parsedNothing = smoke.checks[0]?.ok === false && /no results/.test(smoke.checks[0]?.detail || '');
    let d = diagnose(
      {
        status: h?.status ?? 'ok',
        lastError: h?.last_error ?? null,
        consecutive: h?.consecutive ?? 0,
        lastOkAt: h?.last_ok_at ?? null,
        emptyStreak: parsedNothing ? Math.max(h?.empty_streak ?? 0, 3) : (h?.empty_streak ?? 0),
        blockedUntil: h?.blocked_until ?? null,
        slowStreak: h?.slow_streak ?? 0,
        disabled: false,
      },
      probe,
      src.base,
    );

    let action: SourceVerdict['action'] | undefined;
    if (autoFix && d.code === 'moved' && probe?.finalUrl && await followMove(src.id, probe.finalUrl)) {
      action = 'followed-move';
      d = { ...d, code: 'ok', reason: '', fix: '', silent: false, needsProbe: false, actor: 'none' };
    }

    await q(
      `INSERT INTO source_health (source_id, checked_at, check_code, updated_at)
       VALUES ($1, now(), $2, now())
       ON CONFLICT (source_id) DO UPDATE SET checked_at = now(), check_code = $2, updated_at = now()`,
      [src.id, d.code],
    ).catch(() => {});

    verdicts.push({ id: src.id, name: src.name, code: d.code, reason: d.reason, fix: d.fix, ok: smoke.ok, action });
  }

  const ext = autoFix
    ? await updateExtensions()
    : { updated: [] as string[], failed: [] as ExtensionUpdateFailure[] };
  const { updated: extensionsUpdated, failed: extensionsFailed } = ext;
  const needsAttention = verdicts.filter((v) => ACTIONABLE.has(v.code));

  if (needsAttention.length) {
    const lead = needsAttention[0];
    await notifyAdmins(
      needsAttention.length === 1 ? `${lead.name} needs attention` : `${needsAttention.length} sources need attention`,
      needsAttention.length === 1 ? lead.reason : needsAttention.map((v) => v.name).join(', '),
    ).catch(() => {});
  }

  // A source needing attention and an extension that will not update are different jobs for the operator, so
  // they get their own notification rather than being folded into a count of "things wrong".
  if (extensionsFailed.length) {
    const lead = extensionsFailed[0];
    await notifyAdmins(
      extensionsFailed.length === 1
        ? `${lead.name} could not be updated`
        : `${extensionsFailed.length} extensions could not be updated`,
      extensionsFailed.map((f) => `${f.name}: ${f.reason}`).join(' \u00b7 ').slice(0, 300),
      '/admin/',
      'extensions',
    ).catch(() => {});
  }

  return {
    checkedAt: new Date().toISOString(),
    sources: verdicts,
    extensionsUpdated,
    extensionsFailed,
    needsAttention,
  };
}
