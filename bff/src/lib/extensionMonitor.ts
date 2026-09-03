/**
 * Keeping the installed Mihon/Tachiyomi extensions current with the repositories they came from.
 *
 * THE BUG THIS EXISTS TO FIX. An auto-updater was already here: the daily source watchdog called
 * `updateExtensions()`, which installed anything the engine flagged `hasUpdate`. It had almost certainly
 * never updated anything on its own, on any install, because of one missing call.
 *
 * Suwayomi does not poll. It recomputes "an update is available" only when its repositories are re-read --
 * the `fetchExtensions` mutation, our `refreshExtensions()`. That was called from exactly three places, all
 * of them admin buttons. So the nightly job read a catalogue whose freshness depended on a human having
 * pressed Refresh, found `hasUpdate: false` on everything, and reported success. On the install this was
 * written for: one repository, 1394 extensions known, 15 installed, 0 flagged -- while upstream pushed
 * roughly every fifteen hours.
 *
 * A guard that only re-ordered the two calls would fix the symptom. What this module adds beyond that is
 * everything the missing call was hiding:
 *
 *   * A refresh that FAILS is now an outcome with a name. Before, an unreachable repository and a genuinely
 *     up-to-date catalogue produced the same silence.
 *   * The repository URLs are kept here as well as in the engine. They lived only in the engine's own
 *     settings, inside the volume people delete when it misbehaves, and they are not in our backup -- so
 *     wiping that volume silently un-configured the whole feature with nothing to restore from.
 *   * A snapshot of the catalogue, so "new upstream", "dropped upstream" and "an extension we had is gone"
 *     are questions that can be answered at all.
 *
 * Its own job rather than a step in the watchdog, on purpose. The watchdog is a daily, deliberately serial
 * scrape of every source at up to 45 seconds each; this is one index download and one list query. Coupling
 * them means either running the expensive thing four times a day or catching a push a day late. Two
 * schedulers driving the same install mutation with two separate busy flags is also how you get one APK
 * installed twice at once, which is why the watchdog's copy is removed rather than kept as a fallback.
 */
import { q, one } from './db';
import { logAudit as liveLogAudit } from './audit';
import { notifyAdmins as liveNotifyAdmins } from './push';
import { reloadAll as liveReloadAll } from './sources/reload';
import { runtime } from './runtime';
import { gql as defaultGql, type Gql } from './sources/suwayomi/client';
import {
  listExtensions, refreshExtensions, setExtensionState, getRepos, setRepos,
  type ExtensionInfo,
} from './sources/suwayomi/extensions';

/** Re-reading every repository index is slower than one person waiting on a button; give it more room. */
const REFRESH_TIMEOUT_MS = 300_000;

/** An update that was attempted and did not take, with a reason a person can act on. */
export interface ExtensionUpdateFailure {
  pkgName: string;
  name: string;
  reason: string;
}

/** What one check did, and what it found. Stored as `server_settings.extension_last_result`. */
export interface ExtensionCheckResult {
  checkedAt: string;
  ms: number;
  /** Whether the repositories were successfully re-read. Everything below is meaningless when false. */
  refreshed: boolean;
  refreshError?: string;
  known: number;
  installed: number;
  autoUpdate: boolean;
  /** Updates were found but a library sweep held the engine, so they wait for the next check. */
  deferred?: boolean;
  /** Installed extensions the refreshed catalogue says have a newer version. */
  updatesAvailable: string[];
  updated: Array<{ name: string; from: string | null; to: string | null }>;
  failed: ExtensionUpdateFailure[];
  /** Installed, but no configured repository offers it any more. Reported; never uninstalled. */
  obsolete: string[];
  newUpstream: number;
  removedUpstream: number;
  reposRestored: string[];
  reinstalled: string[];
  /** Installed last time, not installed now, and not by us. Someone used the engine's own interface. */
  removedOutside: string[];
  reloaded: boolean;
}

export interface SnapshotRow {
  pkgName: string;
  name: string;
  installed: boolean;
  versionName: string | null;
}

export interface ExtensionSettings {
  hours: number;
  autoUpdate: boolean;
  repos: string[];
  last: ExtensionCheckResult | null;
}

/** The database seam. A unit test hands in an in-memory one and needs no Postgres. */
export interface ExtensionStore {
  settings(): Promise<ExtensionSettings>;
  saveRepos(urls: string[]): Promise<void>;
  snapshot(): Promise<SnapshotRow[]>;
  saveSnapshot(rows: ExtensionInfo[], seenAt: Date): Promise<void>;
  saveResult(r: ExtensionCheckResult): Promise<void>;
}

export const liveStore: ExtensionStore = {
  async settings() {
    const r = await one<{ hours: number; auto: boolean; repos: unknown; last: unknown }>(
      `SELECT extension_hours AS hours, extension_auto_update AS auto, extension_repos AS repos,
              extension_last_result AS last
         FROM server_settings WHERE id = 1`,
    );
    return {
      hours: r?.hours ?? 6,
      autoUpdate: r?.auto ?? true,
      repos: Array.isArray(r?.repos) ? (r!.repos as string[]).filter((u) => typeof u === 'string') : [],
      last: (r?.last as ExtensionCheckResult | null) ?? null,
    };
  },
  async saveRepos(urls) {
    await q(`UPDATE server_settings SET extension_repos = $1 WHERE id = 1`, [JSON.stringify(urls)]);
  },
  async snapshot() {
    return q<SnapshotRow>(
      `SELECT pkg_name AS "pkgName", name, installed, installed_version AS "versionName" FROM extension_catalog`,
    );
  },
  async saveSnapshot(rows, seenAt) {
    if (!rows.length) return;
    // One statement, not one per extension: a full catalogue is ~1400 rows and this runs every few hours.
    await q(
      `INSERT INTO extension_catalog
         (pkg_name, name, lang, repo, version_name, installed, obsolete, nsfw, installed_version, last_seen, updated_at)
       SELECT t.*, $10::timestamptz, $10::timestamptz FROM unnest(
         $1::text[], $2::text[], $3::text[], $4::text[], $5::text[],
         $6::boolean[], $7::boolean[], $8::boolean[], $9::text[]
       ) AS t(pkg_name, name, lang, repo, version_name, installed, obsolete, nsfw, installed_version)
       ON CONFLICT (pkg_name) DO UPDATE SET
         name = EXCLUDED.name, lang = EXCLUDED.lang, repo = EXCLUDED.repo,
         version_name = EXCLUDED.version_name, installed = EXCLUDED.installed,
         obsolete = EXCLUDED.obsolete, nsfw = EXCLUDED.nsfw,
         installed_version = EXCLUDED.installed_version,
         last_seen = EXCLUDED.last_seen, updated_at = EXCLUDED.updated_at`,
      [
        rows.map((e) => e.pkgName), rows.map((e) => e.name), rows.map((e) => e.lang),
        rows.map((e) => e.repo), rows.map((e) => e.versionName),
        rows.map((e) => e.installed), rows.map((e) => e.obsolete), rows.map((e) => e.nsfw),
        rows.map((e) => (e.installed ? e.versionName : null)),
        seenAt.toISOString(),
      ],
    );
  },
  async saveResult(r) {
    await q(
      `UPDATE server_settings SET extension_last_run = now(), extension_last_result = $1 WHERE id = 1`,
      [JSON.stringify(r)],
    );
  },
};

export interface ExtensionCheckDeps {
  gql: Gql;
  store: ExtensionStore;
  reloadAll: typeof liveReloadAll;
  logAudit: typeof liveLogAudit;
  notifyAdmins: typeof liveNotifyAdmins;
  /** A library sweep is using the engine's extensions right now, so updating one would break it mid-fetch. */
  sweepRunning: () => boolean;
}

const LIVE: ExtensionCheckDeps = {
  gql: defaultGql,
  store: liveStore,
  reloadAll: liveReloadAll,
  logAudit: liveLogAudit,
  notifyAdmins: liveNotifyAdmins,
  sweepRunning: () => runtime.updating,
};

/**
 * A failed extension update, phrased for whoever has to do something about it.
 *
 * 404 is the one worth naming outright, because it is both the most common and the most misleading: it means
 * the repository's index still advertises a version whose APK is no longer where the index says it is. That
 * is the repository's problem rather than this server's, and nobody reading "HTTP error 404" can tell.
 */
export function updateFailureReason(err: unknown): string {
  const msg = (err instanceof Error ? err.message : String(err ?? '')).trim() || 'no reason given';
  if (/\b404\b/.test(msg)) return 'the repository no longer offers that version to download (404)';
  if (/\b(408|timed?[ _-]?out|ETIMEDOUT|abort)/i.test(msg)) return 'the extension server did not answer in time';
  if (/\b5\d\d\b/.test(msg)) return 'the repository host returned a server error';
  return msg.slice(0, 160);
}

/**
 * Install the updates in a list the caller has already refreshed.
 *
 * Takes the list rather than fetching it, which is the whole point: its previous version called
 * `listExtensions()` itself, and no caller could tell it to look at a freshly re-read catalogue.
 *
 * One extension at a time. The engine offers a bulk mutation, but a GraphQL error aborts the whole call, so
 * one repository serving a 404 would lose the outcome of every other extension in the batch -- and the set
 * is fifteen items, not fifteen thousand.
 *
 * Every outcome is recorded. An older version ended each attempt with `.catch(() => false)`, which made a
 * failed update indistinguishable from no update being available.
 */
export async function updateExtensions(
  exts: ExtensionInfo[],
  deps: { setExtensionState: typeof setExtensionState; logAudit: typeof liveLogAudit; gql?: Gql },
): Promise<{ updated: string[]; failed: ExtensionUpdateFailure[] }> {
  const updated: string[] = [];
  const failed: ExtensionUpdateFailure[] = [];
  for (const e of exts) {
    if (!e.installed || !e.hasUpdate) continue;
    const name = e.name || e.pkgName;
    let ok = false;
    let reason = '';
    try {
      ok = await deps.setExtensionState(e.pkgName, 'update', deps.gql);
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

/** Live state for the admin Tasks panel. Mirrors `runtime`, which this deliberately does not extend. */
export const extState = {
  running: false,
  lastRun: 0,
  lastResult: null as ExtensionCheckResult | null,
};

/** How many checks in a row have deferred their updates to a sweep. Three is worth a warning. */
let deferrals = 0;

/**
 * One check: reconcile repositories, re-read them, diff, update, report.
 *
 * The order is the fix. Refresh happens before anything reads `hasUpdate`, and a refresh that throws stops
 * the run rather than letting a stale catalogue be mistaken for an up-to-date one.
 */
export async function runExtensionCheck(
  opts: { forceUpdate?: boolean } = {},
  deps: ExtensionCheckDeps = LIVE,
): Promise<ExtensionCheckResult> {
  const startedAt = new Date();
  const t0 = Date.now();
  const settings = await deps.store.settings();

  const result: ExtensionCheckResult = {
    checkedAt: startedAt.toISOString(), ms: 0, refreshed: false,
    known: 0, installed: 0, autoUpdate: settings.autoUpdate,
    updatesAvailable: [], updated: [], failed: [], obsolete: [],
    newUpstream: 0, removedUpstream: 0, reposRestored: [], reinstalled: [], removedOutside: [],
    reloaded: false,
  };

  // --- repositories -----------------------------------------------------------------------------------
  // The engine's copy is authoritative while it exists; ours is the one that survives the volume being
  // deleted. First run after upgrade adopts whatever the engine has, so nobody has to re-enter anything.
  let wiped = false;
  const live = await getRepos(deps.gql).catch(() => null);
  if (live) {
    if (!settings.repos.length && live.length) {
      await deps.store.saveRepos(live);
      settings.repos = live;
    } else if (settings.repos.length) {
      wiped = live.length === 0;
      const missing = settings.repos.filter((u) => !live.includes(u));
      if (missing.length) {
        await setRepos([...live, ...missing], deps.gql).catch(() => {});
        result.reposRestored = missing;
        await deps.logAudit('extension.repo_restored', { detail: { urls: missing } });
      }
    }
  }

  // --- refresh ----------------------------------------------------------------------------------------
  try {
    result.known = await refreshExtensions(deps.gql, REFRESH_TIMEOUT_MS);
    result.refreshed = true;
  } catch (e) {
    result.refreshed = false;
    result.refreshError = (e instanceof Error ? e.message : String(e)).slice(0, 200);
    result.ms = Date.now() - t0;
    await deps.store.saveResult(result);
    extState.lastResult = result;
    extState.lastRun = Date.now();
    await deps.logAudit('extension.check', { detail: { refreshed: false, error: result.refreshError } });
    // Edge-triggered: an engine that is down stays down, and four pushes a day about it is not information.
    if (settings.last?.refreshed !== false) {
      await deps.notifyAdmins(
        'Extension repositories could not be read',
        `${result.refreshError}. Installed extensions keep working; updates are paused until this clears.`,
        '/admin/', 'extensions',
      ).catch(() => {});
    }
    return result;
  }

  // --- diff -------------------------------------------------------------------------------------------
  const before = await listExtensions(deps.gql);
  const prev = await deps.store.snapshot();
  const prevByPkg = new Map(prev.map((p) => [p.pkgName, p]));
  const nowByPkg = new Map(before.map((e) => [e.pkgName, e]));

  const installedNow = before.filter((e) => e.installed);
  result.installed = installedNow.length;
  if (!result.known) result.known = before.length;
  result.updatesAvailable = installedNow.filter((e) => e.hasUpdate).map((e) => e.name);
  result.obsolete = installedNow.filter((e) => e.obsolete).map((e) => e.name);
  if (prev.length) {
    result.newUpstream = before.filter((e) => !prevByPkg.has(e.pkgName)).length;
    result.removedUpstream = prev.filter((p) => !nowByPkg.has(p.pkgName)).length;
  }
  // Installed last time, not installed now. Either the volume was wiped or somebody used the engine's UI.
  const goneOutside = prev.filter((p) => p.installed && !nowByPkg.get(p.pkgName)?.installed);

  // --- recover a wiped engine -------------------------------------------------------------------------
  // ONLY on the wipe signature. If the repositories are intact, an extension disappearing is a person
  // uninstalling it, and reinstalling it behind their back is the wrong answer twice over.
  if (wiped && goneOutside.length) {
    for (const p of goneOutside) {
      const ok = await setExtensionState(p.pkgName, 'install', deps.gql).catch(() => false);
      if (ok) result.reinstalled.push(p.name);
    }
    if (result.reinstalled.length) {
      await deps.logAudit('extension.reinstalled', { detail: { names: result.reinstalled } });
    }
  } else {
    result.removedOutside = goneOutside.map((p) => p.name);
  }

  // --- update -----------------------------------------------------------------------------------------
  let updatedNames: string[] = [];
  const mayUpdate = settings.autoUpdate || !!opts.forceUpdate;
  if (mayUpdate && result.updatesAvailable.length && deps.sweepRunning()) {
    // The engine is serving a sweep right now; swapping an extension's classes under it fails the fetch.
    result.deferred = true;
    deferrals += 1;
  } else if (mayUpdate) {
    deferrals = 0;
    const r = await updateExtensions(before, {
      setExtensionState, logAudit: deps.logAudit, gql: deps.gql,
    });
    result.failed = r.failed;
    updatedNames = r.updated;
  }

  // --- re-register, once, if the engine's extensions changed at all --------------------------------------
  //
  // Keyed on "did anything install", NOT on "did we run the updater". Reinstalling after a wiped volume
  // happens above and is not gated on the kill switch -- putting back what was already there is repair, not
  // a new version -- so tying the reload to the update branch would leave those extensions installed on the
  // engine and absent from `suwayomi_sources` until something else happened to reload.
  //
  // reloadAll() re-runs remember(), which is what refreshes each source's name, language and adult flag.
  if (updatedNames.length || result.reinstalled.length) {
    // A second read, so the digest can say what each extension moved from and to.
    const after = await listExtensions(deps.gql).catch(() => before);
    const afterByName = new Map(after.map((e) => [e.name, e.versionName]));
    const beforeByName = new Map(before.map((e) => [e.name, e.versionName]));
    result.updated = updatedNames.map((name) => ({
      name, from: beforeByName.get(name) ?? null, to: afterByName.get(name) ?? null,
    }));
    await deps.reloadAll().catch(() => {});
    result.reloaded = true;
    await deps.store.saveSnapshot(after, startedAt);
  } else {
    await deps.store.saveSnapshot(before, startedAt);
  }

  result.ms = Date.now() - t0;
  await deps.store.saveResult(result);
  extState.lastResult = result;
  extState.lastRun = Date.now();

  // --- report -----------------------------------------------------------------------------------------
  const happened = result.updated.length || result.failed.length || result.reinstalled.length ||
    result.reposRestored.length || result.obsolete.length || result.removedOutside.length;
  if (happened) {
    await deps.logAudit('extension.check', {
      detail: {
        updated: result.updated.map((u) => u.name), failed: result.failed.length,
        obsolete: result.obsolete, reinstalled: result.reinstalled,
        reposRestored: result.reposRestored, removedOutside: result.removedOutside,
      },
    });
  }

  const changed = <T>(now: T[], was: T[] | undefined) =>
    now.length > 0 && JSON.stringify([...now].sort()) !== JSON.stringify([...(was ?? [])].sort());

  if (result.updated.length) {
    await deps.notifyAdmins(
      result.updated.length === 1 ? `${result.updated[0].name} updated` : `${result.updated.length} extensions updated`,
      result.updated.map((u) => `${u.name} ${u.from ?? '?'} → ${u.to ?? '?'}`).join(' · ').slice(0, 300),
      '/admin/', 'extensions',
    ).catch(() => {});
  }
  if (result.failed.length) {
    const lead = result.failed[0];
    await deps.notifyAdmins(
      result.failed.length === 1 ? `${lead.name} could not be updated` : `${result.failed.length} extensions could not be updated`,
      result.failed.map((f) => `${f.name}: ${f.reason}`).join(' · ').slice(0, 300),
      '/admin/', 'extensions',
    ).catch(() => {});
  }
  if (!mayUpdate && changed(result.updatesAvailable, settings.last?.updatesAvailable)) {
    await deps.notifyAdmins(
      `${result.updatesAvailable.length} extension update${result.updatesAvailable.length === 1 ? '' : 's'} waiting`,
      `${result.updatesAvailable.join(', ')}. Automatic updates are switched off; update them from Admin.`.slice(0, 300),
      '/admin/', 'extensions',
    ).catch(() => {});
  }
  if (changed(result.obsolete, settings.last?.obsolete)) {
    await deps.notifyAdmins(
      `${result.obsolete.length} installed extension${result.obsolete.length === 1 ? ' is' : 's are'} no longer offered`,
      `${result.obsolete.join(', ')}. They keep working, but will not get updates. Check the repository still lists them.`.slice(0, 300),
      '/admin/', 'extensions',
    ).catch(() => {});
  }
  if (result.reposRestored.length) {
    await deps.notifyAdmins(
      'Extension repositories restored',
      `The extension server had lost ${result.reposRestored.length} repository setting(s); Uchiyomi put them back.`,
      '/admin/', 'extensions',
    ).catch(() => {});
  }

  return result;
}

/** The part of a Fastify logger this reports through. A test hands in one that captures. */
export type ExtensionLog = { info(msg: string): void; warn(msg: string): void; error(err: unknown): void };

/**
 * Run one check the way the schedule runs it: flagged while it goes, refused if one is already running, its
 * result kept for the admin panel, one summary line in the log.
 *
 * Deliberately the same shape as `runSweep` in updater.ts, including returning `false` SYNCHRONOUSLY when
 * busy so two starts in one turn of the event loop cannot both get through, and resolving `null` rather than
 * throwing so no caller needs a `.catch(() => {})` that swallows the reason.
 */
export function runExtensionMonitor(
  log: ExtensionLog,
  check: typeof runExtensionCheck = runExtensionCheck,
): Promise<ExtensionCheckResult | null> | false {
  if (extState.running) return false;
  extState.running = true;
  return (async () => {
    try {
      const r = await check();
      if (!r.refreshed) {
        log.warn(`extensions: could not read the repositories (${r.refreshError})`);
      } else {
        const bits = [
          `refreshed ${r.known}`,
          `${r.installed} installed`,
          `${r.updated.length} updated`,
        ];
        if (r.failed.length) bits.push(`${r.failed.length} failed`);
        if (r.obsolete.length) bits.push(`${r.obsolete.length} obsolete`);
        if (r.deferred) bits.push('deferred (sweep running)');
        if (r.reinstalled.length) bits.push(`${r.reinstalled.length} reinstalled`);
        const line = `extensions: ${bits.join(', ')}`;
        if (r.failed.length) log.warn(line);
        else log.info(line);
        if (r.deferred && deferrals >= 3) {
          log.warn(`extensions: updates have waited for a library sweep ${deferrals} checks running`);
        }
      }
      return r;
    } catch (e) {
      // Same rule as the sweep and the backup: the panel must not keep showing the last good run as if it
      // were this one.
      extState.lastRun = Date.now();
      extState.lastResult = null;
      log.error(e);
      return null;
    } finally {
      extState.running = false;
    }
  })();
}
