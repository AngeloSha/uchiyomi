// Backup extensions (v0.82.0): the extensions Uchiyomi installs by itself to finish downloads, kept only while needed.
//
// The owner (2026-10-18): when downloads hit a rate limit or fail, Uchiyomi already carries on from a series' other
// sources and finds new ones (the scout, lib/sourceScout.ts); the extensions it installs to do that should be
// temporary -- "once everything is fully downloaded it removes those backup extensions it used just for this purpose
// and when there is new chapters it will just use main until it rate limits or fail again and then it can reinstall /
// reuse those" -- so Discover shows only the sources a person added, and the extension engine's memory is not spent on
// what nothing needs. Each package Uchiyomi installed (Fix everything's, lib/autofix.ts; the scout's) is a row of
// `backup_extensions`:
//   - hidden from Discover: register.ts marks its sources `backup`, and routes/sources.ts `discoverable` leaves them
//     out of every list a person picks from, while GET /api/sources still names them for the pages that show where a
//     chapter came from;
//   - needed (neededBackups) while a series uses it as its main source -- then it is never removed -- or it landed a
//     chapter in the last BACKUP_IDLE_DAYS, or a series is waiting for a chapter that only it lists, or that failed on
//     the series' other sources;
//   - removed ("parked") once it has not been needed for BACKUP_IDLE_DAYS. Its follows are kept in `backup_links` --
//     the series, its id there, its title there -- and taken off the series;
//   - put back when one of those series is stuck again (lib/sourceScout.ts tryLinks): one reinstall and one look, never
//     a search through every extension;
//   - at most BACKUP_EXTENSIONS_MAX installed at once, a series' main not counted: the one needed longest ago goes
//     first, and one needed now never does, so two series can never take turns installing and removing;
//   - a person's to keep: Keep, or installing, turning on or choosing it for a series themselves, makes it theirs
//     (adoptBackup) -- and one a person removes is never installed by Uchiyomi again (`refused`).
// One switch, "Finish downloads on their own": off, no backup is added or put back; the ones there still go when idle.
import { q, one } from './db';
import { logAudit } from './audit';
import { runtime } from './runtime';
import { forDesktop } from './desktop';
import { visibleToAll } from './visibility';
import { reloadAll, SW_PREFIX } from './sources';
import { setExtensionState, sourcesOfExtension, listExtensions } from './sources/suwayomi/extensions';
import { adoptExtensionSources, setSourcesEnabled } from './sources/suwayomi/langs';
import { wouldFit } from './sources/suwayomi/register';
import { withInstallLock, BUSY, installLockHolder } from './sources/suwayomi/installLock';
import { engineState } from './sources/suwayomi/engineState';
import { pruneOrphanedHealth } from './sourceHealth';
import { refileFailures } from './chapterFailures';
import { markInstalled } from './extensionMonitor';
import { canonLang, sameLanguage } from './lang';
import { finishDownloadsOn, REFUSAL_RETRY_CAP } from './finishDownloads';
import { findRunning } from './findSources';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const envInt = (name: string, fallback: number, min: number, max: number): number => {
  const raw = process.env[name];
  const n = raw === undefined || raw === '' ? NaN : Math.floor(Number(raw));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/**
 * The limits. `max` is BACKUP_EXTENSIONS_MAX (5, the desktop app 3; 0: Uchiyomi never installs a backup): backups
 * installed at once, a series' main not counted. `idleMs`: unneeded this long, a backup is removed. `stuckMs`: a series
 * waiting this long gets a backup back -- never for a cooldown of a few minutes. Tests narrow them (_setBackupLimits).
 */
const limits = {
  max: envInt('BACKUP_EXTENSIONS_MAX', forDesktop(5, 3), 0, 50),
  idleMs: 3 * DAY,
  stuckMs: HOUR,
};
export const BACKUP_IDLE_DAYS = 3;
export const backupLimits = (): Readonly<typeof limits> => ({ ...limits });
/** Tests only. */
export function _setBackupLimits(next: Partial<typeof limits>): void { Object.assign(limits, next); }

/** How often the upkeep runs (server.ts). */
export const BACKUP_UPKEEP_MS = 30 * MIN;

export type BackupState = 'trial' | 'active' | 'parked' | 'refused';
export type BackupVia = 'autofix' | 'scout';

export interface BackupRow {
  pkg_name: string;
  name: string | null;
  lang: string | null;
  state: BackupState;
  via: BackupVia | null;
  installed_at: Date | null;
  last_needed_at: Date;
  parked_at: Date | null;
  why: string | null;
}

/** Every backup row, by package. */
export async function backupRows(): Promise<Map<string, BackupRow>> {
  const rows = await q<BackupRow>(
    'SELECT pkg_name, name, lang, state, via, installed_at, last_needed_at, parked_at, why FROM backup_extensions').catch(() => []);
  return new Map(rows.map((r) => [r.pkg_name, r]));
}

/**
 * Whether Uchiyomi may install or put back a backup now: the switch "Finish downloads on their own" (both columns it
 * writes, as Admin -> Settings reads it), and BACKUP_EXTENSIONS_MAX above 0.
 */
export async function backupsAllowed(): Promise<boolean> {
  if (limits.max <= 0) return false;
  const r = await one<{ fin: boolean | null; auto: boolean | null }>(
    'SELECT finish_downloads AS fin, auto_follow_on_failure AS auto FROM server_settings WHERE id = 1').catch(() => null);
  return r?.fin === true && r?.auto !== false;
}

/** The engine's source ids an installed package provides, as recorded. */
export async function packageSourceIds(pkg: string): Promise<string[]> {
  return (await q<{ source_id: string }>('SELECT source_id FROM suwayomi_sources WHERE pkg_name = $1', [pkg]).catch(() => []))
    .map((r) => r.source_id);
}

/** The installed backup (trial or active) an `sw:` source belongs to, or null. */
export async function backupOfSource(sourceId: string): Promise<string | null> {
  if (!sourceId.startsWith(SW_PREFIX)) return null;
  const r = await one<{ pkg_name: string }>(
    `SELECT b.pkg_name FROM suwayomi_sources s JOIN backup_extensions b ON b.pkg_name = s.pkg_name
      WHERE s.source_id = $1 AND b.state IN ('trial', 'active')`, [sourceId.slice(SW_PREFIX.length)]).catch(() => null);
  return r?.pkg_name ?? null;
}

/** How many visible series read through any source of this package: as main, or as a follower. */
export async function packageUse(pkg: string): Promise<number> {
  const row = await one<{ n: number }>(
    `SELECT count(DISTINCT s.id)::int AS n FROM lib_series s
      WHERE ${visibleToAll('s')}
        AND (s.source_id IN (SELECT '${SW_PREFIX}' || source_id FROM suwayomi_sources WHERE pkg_name = $1)
          OR EXISTS (SELECT 1 FROM series_sources f WHERE f.series_id = s.id
                      AND f.source_id IN (SELECT '${SW_PREFIX}' || source_id FROM suwayomi_sources WHERE pkg_name = $1)))`,
    [pkg]).catch(() => null);
  return row?.n ?? 0;
}

/** A package Uchiyomi installed is a backup, as of now: needed now, and not parked. */
export async function recordBackup(pkg: string, o: { name?: string | null; lang?: string | null; via: BackupVia; state?: 'trial' | 'active' }): Promise<void> {
  await q(
    `INSERT INTO backup_extensions (pkg_name, name, lang, state, via, installed_at, last_needed_at, why, updated_at)
     VALUES ($1, $2, $3, $4, $5, now(), now(), NULL, now())
     ON CONFLICT (pkg_name) DO UPDATE SET state = EXCLUDED.state, name = COALESCE(EXCLUDED.name, backup_extensions.name),
       lang = COALESCE(EXCLUDED.lang, backup_extensions.lang), via = COALESCE(backup_extensions.via, EXCLUDED.via),
       installed_at = CASE WHEN backup_extensions.state IN ('trial', 'active') THEN backup_extensions.installed_at ELSE now() END,
       last_needed_at = now(), parked_at = NULL, why = NULL, updated_at = now()`,
    [pkg, o.name ?? null, o.lang ?? null, o.state ?? 'active', o.via],
  );
}

/**
 * A person's now (Keep; installing, turning on or choosing it themselves): no longer a backup. Its row and its parked
 * links go, and the reload shows it in Discover. A package with no row is theirs already: nothing happens. True when it
 * was a backup.
 */
export async function adoptBackup(pkg: string, o: { userId?: string | null; reload?: boolean } = {}): Promise<boolean> {
  const gone = await q<{ state: string }>('DELETE FROM backup_extensions WHERE pkg_name = $1 RETURNING state', [pkg]).catch(() => []);
  if (!gone.length) return false;
  if (gone[0].state === 'trial' || gone[0].state === 'active') {
    await logAudit('extension.keep', { userId: o.userId ?? null, detail: { pkgName: pkg } });
    if (o.reload !== false) await reloadAll().catch(() => null);
  }
  return true;
}

/** The package of an `sw:` source a person just chose for a series, adopted when it is a backup (adoptBackup). */
export async function adoptBackupOfSource(sourceId: string, userId: string | null): Promise<void> {
  const pkg = await backupOfSource(sourceId);
  if (pkg) await adoptBackup(pkg, { userId });
}

/**
 * A person removed it (Admin -> Extensions, or the engine's own page): Uchiyomi never installs it again. Its parked
 * links go with it -- the series they named will look elsewhere -- and, when it was a backup, the follows it still had
 * (`dropFollows`): they were Uchiyomi's, and a follow on a removed extension is a source nothing can ask.
 */
export async function refuseBackup(pkg: string, o: { why: 'by_admin' | 'outside'; dropFollows?: boolean } ): Promise<void> {
  if (o.dropFollows) {
    const ids = (await packageSourceIds(pkg)).map((id) => `${SW_PREFIX}${id}`);
    if (ids.length) await dropFollows(ids);
  }
  await q(
    `INSERT INTO backup_extensions (pkg_name, state, parked_at, why, updated_at) VALUES ($1, 'refused', now(), $2, now())
     ON CONFLICT (pkg_name) DO UPDATE SET state = 'refused', parked_at = now(), why = EXCLUDED.why, updated_at = now()`,
    [pkg, o.why]).catch(() => {});
  await q('DELETE FROM backup_links WHERE pkg_name = $1', [pkg]).catch(() => {});
}

/** Drop every follow of these sources, with their listing rows, and send what they failed to each series' main source. */
async function dropFollows(sourceIds: string[]): Promise<Array<{ series_id: string; source_id: string; source_series_id: string; title: string | null }>> {
  const gone = await q<{ series_id: string; source_id: string; source_series_id: string; title: string | null }>(
    'DELETE FROM series_sources WHERE source_id = ANY($1::text[]) RETURNING series_id, source_id, source_series_id, title', [sourceIds]);
  if (gone.length) {
    // The unfollow route's rule (routes/admin.ts, lib/retireSource.ts): the listing rows a follow carried go with it,
    // and what it failed is each series' main source's to retry.
    for (const g of gone) {
      await q('DELETE FROM series_listing WHERE series_id = $1 AND source_id = $2', [g.series_id, g.source_id]).catch(() => {});
    }
    await refileFailures(q, [...new Set(gone.map((g) => g.series_id))]).catch(() => 0);
  }
  return gone;
}

/** What the source pick of an install is: the package's source in `lang`, else one that serves every language. */
export function pickSource<T extends { lang: string | null }>(provided: readonly T[], lang: string | null): T | null {
  if (!lang) return provided.find((s) => !s.lang || s.lang === 'all') ?? provided[0] ?? null;
  return provided.find((s) => !!s.lang && !!canonLang(s.lang) && sameLanguage(canonLang(s.lang)!, lang))
    ?? provided.find((s) => !s.lang || s.lang === 'all')
    ?? null;
}

export interface Installed {
  /** `sw:<id>` of the source switched on, or '' when the package has none in the language asked. */
  sourceId: string;
  /** Every source id the package provides. */
  ids: string[];
}

/**
 * Install a package as a backup's trial, under the install lock: the engine's install, its audit, the monitor's
 * snapshot, its sources recorded and every one switched OFF, then only `want` (a source id, when one is known) or the
 * one in `lang` switched on, the backup row written as a trial BEFORE the reload -- so its sources register as backups,
 * never in Discover -- and the reload. BUSY when the lock is not free within `waitMs`; null when the engine refused.
 */
export async function installTrial(
  pkg: string,
  o: { name?: string | null; lang: string | null; via: BackupVia; who: string; waitMs?: number; want?: string | null; userId?: string | null; runId?: string },
): Promise<Installed | null | typeof BUSY> {
  // A package a person removed is never installed by Uchiyomi (the callers leave it out; this is the backstop).
  const refused = await one<{ n: number }>(`SELECT count(*)::int AS n FROM backup_extensions WHERE pkg_name = $1 AND state = 'refused'`, [pkg]).catch(() => null);
  if ((refused?.n ?? 0) > 0) return null;
  return withInstallLock(o.who, async () => {
    try {
      // A request the engine took without installing anything is no install either (extensionMonitor's rule).
      if (!(await setExtensionState(pkg, 'install'))) return null;
    } catch {
      return null;
    }
    await logAudit('extension.install',{ userId: o.userId ?? null, detail: { pkgName: pkg, via: o.via, ...(o.runId ? { runId: o.runId } : {}) } });
    await markInstalled(pkg, true);
    const provided = await sourcesOfExtension(pkg).catch(() => []);
    // Recorded, every one switched off; then only the one wanted. adoptExtensionSources records no package; the
    // registration's own remember() does, from the engine's answer -- written here too, so whether a package is used
    // never depends on the engine having said.
    await adoptExtensionSources(provided, false);
    const ids = provided.map((s) => s.id);
    await q('UPDATE suwayomi_sources SET pkg_name = $2 WHERE source_id = ANY($1::text[]) AND pkg_name IS NULL', [ids, pkg]).catch(() => {});
    const want = o.want ? provided.find((s) => s.id === o.want) ?? null : null;
    const pick = want ?? pickSource(provided, o.lang);
    await recordBackup(pkg, { name: o.name, lang: o.lang, via: o.via, state: 'trial' });
    if (pick) await setSourcesEnabled({ ids: [pick.id], enabled: true });
    await reloadAll().catch(() => null);
    return { sourceId: pick ? `${SW_PREFIX}${pick.id}` : '', ids };
  }, o.waitMs ?? 0);
}

/**
 * Remove a package Uchiyomi installed, the uninstall route's way, under the install lock: the engine's uninstall, its
 * sources' rows and their orphaned health rows, the monitor's snapshot, the audit, the reload. Then its row: `parked`
 * while a series' link remembers it (or `park`), else gone. Never a package a person installed: every caller holds a
 * backup's row or a trial it made. BUSY when the lock is not free within `waitMs`.
 */
export async function removePackage(
  pkg: string,
  o: RemoveOpts & { who: string; waitMs?: number },
): Promise<true | typeof BUSY> {
  return withInstallLock(o.who, async () => { await removeLocked(pkg, o); return true as const; }, o.waitMs ?? 0);
}

interface RemoveOpts { via: BackupVia | 'backup'; why: string; userId?: string | null; runId?: string; ids?: string[]; park?: boolean }

/** removePackage's work, for a caller already holding the install lock. */
async function removeLocked(pkg: string, o: RemoveOpts): Promise<void> {
  const provided = await sourcesOfExtension(pkg).catch(() => []);
  try { await setExtensionState(pkg, 'uninstall'); } catch { /* the engine's own; what is recorded goes regardless */ }
  const ids = [...new Set([...provided.map((s) => s.id), ...(o.ids ?? []), ...(await packageSourceIds(pkg))])];
  await q('DELETE FROM suwayomi_sources WHERE source_id = ANY($1)', [ids]).catch(() => {});
  await pruneOrphanedHealth(ids.map((x) => `${SW_PREFIX}${x}`)).catch(() => 0);
  await markInstalled(pkg, false);
  await logAudit('extension.uninstall', { userId: o.userId ?? null, detail: { pkgName: pkg, via: o.via, why: o.why, ...(o.runId ? { runId: o.runId } : {}) } });
  const linked = await one<{ n: number }>('SELECT count(*)::int AS n FROM backup_links WHERE pkg_name = $1', [pkg]).catch(() => null);
  if (o.park || (linked?.n ?? 0) > 0) {
    await q(`UPDATE backup_extensions SET state = 'parked', parked_at = now(), why = $2, updated_at = now() WHERE pkg_name = $1 AND state <> 'refused'`,
      [pkg, o.why]).catch(() => {});
  } else {
    await q(`DELETE FROM backup_extensions WHERE pkg_name = $1 AND state <> 'refused'`, [pkg]).catch(() => {});
  }
  await reloadAll().catch(() => null);
}

/**
 * A trial over: kept as an active backup when a series now reads through it, else removed at once. Never removes a
 * package that is not a backup's (a person adopted it meanwhile: no row). What it did.
 */
export async function settleTrial(pkg: string, o: { via: BackupVia; who: string; userId?: string | null; runId?: string; ids?: string[]; why?: string }): Promise<'kept' | 'removed' | 'theirs' | 'busy'> {
  const row = await one<{ state: string }>('SELECT state FROM backup_extensions WHERE pkg_name = $1', [pkg]).catch(() => null);
  if (!row) return 'theirs';
  if ((await packageUse(pkg)) > 0) {
    await q(`UPDATE backup_extensions SET state = 'active', last_needed_at = now(), updated_at = now() WHERE pkg_name = $1 AND state = 'trial'`, [pkg]).catch(() => {});
    return 'kept';
  }
  const r = await removePackage(pkg, { via: o.via, why: o.why ?? 'no_series', who: o.who, waitMs: 10 * MIN, userId: o.userId, runId: o.runId, ids: o.ids });
  return r === BUSY ? 'busy' : 'removed';
}

/**
 * Which installed backups are needed now, by package, and which of those a series uses as its main (`pinned`). One
 * read for every backup:
 *   - pinned: a series (deleted or merged ones not counting) has one of its sources as its main;
 *   - it landed a chapter within the idle window (download_log);
 *   - a monitored series anyone can see is waiting for a chapter one of its sources lists -- listed and available, at
 *     or above the series' floor, not here, under its retry cap -- that no other source of the series lists, or that
 *     already failed somewhere (chapter_failures). A chapter the main lists and has not failed is the main's to bring:
 *     that alone keeps no backup.
 */
export async function neededBackups(): Promise<Map<string, { pinned: boolean; needed: boolean }>> {
  const src = await q<{ pkg_name: string; source_id: string }>(
    `SELECT b.pkg_name, '${SW_PREFIX}' || s.source_id AS source_id FROM backup_extensions b JOIN suwayomi_sources s ON s.pkg_name = b.pkg_name
      WHERE b.state IN ('trial', 'active')`).catch(() => []);
  const out = new Map<string, { pinned: boolean; needed: boolean }>();
  for (const r of src) out.set(r.pkg_name, { pinned: false, needed: false });
  if (!src.length) return out;
  const pkgOf = new Map(src.map((r) => [r.source_id, r.pkg_name]));
  const ids = [...pkgOf.keys()];
  const mark = (sourceId: string, pinned: boolean) => {
    const pkg = pkgOf.get(sourceId);
    if (!pkg) return;
    const was = out.get(pkg)!;
    out.set(pkg, { pinned: was.pinned || pinned, needed: true });
  };
  for (const r of await q<{ source_id: string }>(
    `SELECT DISTINCT source_id FROM lib_series WHERE source_id = ANY($1::text[]) AND deleted_at IS NULL AND merged_into IS NULL`, [ids]).catch(() => [])) {
    mark(r.source_id, true);
  }
  for (const r of await q<{ source: string }>(
    `SELECT DISTINCT source FROM download_log WHERE source = ANY($1::text[]) AND status IN ('done', 'partial')
        AND finished_at > now() - ($2 || ' milliseconds')::interval`, [ids, String(limits.idleMs)]).catch(() => [])) {
    mark(r.source, false);
  }
  const finish = await finishDownloadsOn().catch(() => false);
  const base = Math.max(1, Number(process.env.CHAPTER_RETRY_CAP) || 3);
  for (const r of await q<{ src: string }>(
    `SELECT DISTINCT c.src FROM series_listing l
       JOIN lib_series s ON s.id = l.series_id AND s.auto_update AND ${visibleToAll('s')}
       CROSS JOIN LATERAL (SELECT cp->>'source' AS src FROM jsonb_array_elements(COALESCE(l.copies, '[]'::jsonb)) cp) c
      WHERE c.src = ANY($1::text[]) AND l.status = 'available'
        AND (s.chapter_floor IS NULL OR l.number >= s.chapter_floor)
        AND NOT EXISTS (SELECT 1 FROM lib_books b WHERE b.series_id = l.series_id AND b.number = l.number)
        AND (NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(l.copies, '[]'::jsonb)) o WHERE NOT (o->>'source' = ANY($1::text[])))
             OR EXISTS (SELECT 1 FROM chapter_failures f WHERE f.series_id = l.series_id AND f.number = l.number))
        AND NOT EXISTS (SELECT 1 FROM chapter_failures f WHERE f.series_id = l.series_id AND f.number = l.number
                         AND f.attempts >= CASE WHEN $2::boolean AND f.status IN ('rate_limited', 'blocked') THEN $3::int ELSE $4::int END)`,
    [ids, finish, Math.max(base, REFUSAL_RETRY_CAP), base]).catch(() => [])) {
    mark(r.src, false);
  }
  return out;
}

/** Stamp `last_needed_at` on every backup needed now. The map neededBackups answered. */
async function stampNeeded(needed: ReadonlyMap<string, { needed: boolean }>): Promise<void> {
  const pkgs = [...needed].filter(([, v]) => v.needed).map(([k]) => k);
  if (pkgs.length) {
    await q(`UPDATE backup_extensions SET last_needed_at = now() WHERE pkg_name = ANY($1::text[]) AND state IN ('trial', 'active')`, [pkgs]).catch(() => {});
  }
}

/**
 * Park one backup: its follows remembered in `backup_links` (the series, its id there, its title there) and taken off
 * the series, then the package removed. Never one a series uses as its main (the caller's rule, and checked again
 * here). What happened.
 */
export async function parkPackage(pkg: string, why: string): Promise<'parked' | 'pinned' | 'busy'> {
  const ids = (await packageSourceIds(pkg)).map((id) => `${SW_PREFIX}${id}`);
  const isMain = async () => ids.length > 0 && ((await one<{ n: number }>(
    'SELECT count(*)::int AS n FROM lib_series WHERE source_id = ANY($1::text[]) AND deleted_at IS NULL AND merged_into IS NULL', [ids]).catch(() => null))?.n ?? 0) > 0;
  if (await isMain()) return 'pinned';
  // Under the install lock from the follows' move to the reload, and with the scout told (parkingNow): nothing follows
  // one of its sources again while it goes.
  parking++;
  try {
    const r = await withInstallLock('backup', async () => {
      if (await isMain()) return 'pinned' as const;
      if (ids.length) {
        const gone = await dropFollows(ids);
        for (const g of gone) {
          await q(
            `INSERT INTO backup_links (series_id, source_id, pkg_name, source_series_id, their_title, parked_at)
             SELECT $1, $2, $3, $4, $5, now() WHERE EXISTS (SELECT 1 FROM lib_series WHERE id = $1)
             ON CONFLICT (series_id, source_id) DO UPDATE SET pkg_name = EXCLUDED.pkg_name, source_series_id = EXCLUDED.source_series_id,
               their_title = COALESCE(EXCLUDED.their_title, backup_links.their_title), parked_at = now()`,
            [g.series_id, g.source_id, pkg, g.source_series_id, g.title]).catch(() => {});
        }
      }
      await removeLocked(pkg, { via: 'backup', why, park: true });
      return 'parked' as const;
    }, 2 * MIN);
    return r === BUSY ? 'busy' : r;
  } finally {
    parking--;
  }
}

/** Backups being removed right now: the scout leaves every backup source alone meanwhile. */
let parking = 0;
export const parkingNow = (): boolean => parking > 0;

/**
 * Room for one more backup: under BACKUP_EXTENSIONS_MAX (a series' main not counted) and under the engine's source
 * limit (register.ts wouldFit). When the backups are at the limit, the one needed longest ago that is not needed now is
 * parked to make room; when every one is needed, there is none.
 */
export async function makeRoom(): Promise<boolean> {
  if (limits.max <= 0) return false;
  const rows = [...(await backupRows()).values()].filter((r) => r.state === 'trial' || r.state === 'active');
  const needed = await neededBackups();
  const counted = rows.filter((r) => !needed.get(r.pkg_name)?.pinned);
  // The ones that may go to make room, needed longest ago first. Reintroduce by taking the oldest whatever it does now
  // (plain least-recently-used): "the cap: the backup needed longest ago makes room, one needed now never does" in
  // backupExtensions.int.test.ts finds a needed one removed.
  const spare = counted
    .filter((r) => r.state === 'active' && !needed.get(r.pkg_name)?.needed)
    .sort((a, b) => new Date(a.last_needed_at).getTime() - new Date(b.last_needed_at).getTime());
  let over = counted.length - limits.max + 1;
  for (const victim of spare) {
    if (over <= 0) break;
    if ((await parkPackage(victim.pkg_name, 'room')) === 'parked') over--;
  }
  if (over > 0) return false;
  return wouldFit(['backup:new']);
}

/** The upkeep's own flag: one at a time. */
let upkeeping = false;

/**
 * The upkeep (server.ts, every BACKUP_UPKEEP_MS): what the engine has now, which backups are needed, and the ones
 * unneeded for BACKUP_IDLE_DAYS removed. Nothing while a sweep, a repair, Fix everything or a Find run has the
 * sources, the server stops, the engine is not up, or someone holds the install lock. What it did.
 */
export async function backupUpkeep(): Promise<{ parked: string[]; refused: string[]; settled: string[] } | null> {
  if (upkeeping || runtime.stopping || runtime.updating || runtime.repairing || runtime.autofixing || findRunning()) return null;
  if (engineState() !== 'up' || installLockHolder() !== null) return null;
  const rows = [...(await backupRows()).values()].filter((r) => r.state === 'trial' || r.state === 'active');
  if (!rows.length) return { parked: [], refused: [], settled: [] };
  upkeeping = true;
  const out = { parked: [] as string[], refused: [] as string[], settled: [] as string[] };
  try {
    // What the engine has: a backup it no longer has was removed in its own page -- a person's act, kept to. Never judged
    // against an engine with nothing installed at all: that is a wiped volume (or one still starting), which the
    // extension check puts back (lib/extensionMonitor.ts), not a person removing every extension. Reintroduce by
    // judging it anyway: "a wiped engine's backups are not taken for a person's removals" in
    // backupExtensions.int.test.ts finds the backup refused.
    let installed: Set<string> | null = null;
    try {
      installed = new Set((await listExtensions()).filter((e) => e.installed).map((e) => e.pkgName));
    } catch { /* the engine did not answer: nothing is judged gone this time */ }
    if (installed && installed.size === 0) installed = null;
    for (const r of rows) {
      if (installed && !installed.has(r.pkg_name)) {
        await refuseBackup(r.pkg_name, { why: 'outside', dropFollows: true });
        await markInstalled(r.pkg_name, false);
        out.refused.push(r.pkg_name);
      }
    }
    // A trial an hour old was cut short (a restart, the engine going away mid-look): settled as any trial is.
    for (const r of rows) {
      if (r.state === 'trial' && !out.refused.includes(r.pkg_name) && r.installed_at && Date.now() - new Date(r.installed_at).getTime() > HOUR) {
        if ((await settleTrial(r.pkg_name, { via: r.via ?? 'scout', who: 'backup', why: 'unfinished' })) !== 'busy') out.settled.push(r.pkg_name);
      }
    }
    const needed = await neededBackups();
    await stampNeeded(needed);
    const fresh = await backupRows();
    for (const r of fresh.values()) {
      if (r.state !== 'active' || runtime.stopping || runtime.updating || runtime.autofixing) continue;
      const n = needed.get(r.pkg_name);
      if (n?.pinned || n?.needed) continue;
      if (Date.now() - new Date(r.last_needed_at).getTime() < limits.idleMs) continue;
      if ((await parkPackage(r.pkg_name, 'idle')) === 'parked') out.parked.push(r.pkg_name);
    }
    if (out.parked.length || out.refused.length || out.settled.length) {
      console.log(`[backups] ${[
        out.parked.length ? `removed ${out.parked.length} unused for ${BACKUP_IDLE_DAYS} days (${out.parked.join(', ')})` : '',
        out.refused.length ? `${out.refused.length} removed outside Uchiyomi (${out.refused.join(', ')})` : '',
        out.settled.length ? `settled ${out.settled.length} unfinished trial${out.settled.length === 1 ? '' : 's'}` : '',
      ].filter(Boolean).join('; ')}`);
    }
    return out;
  } finally {
    upkeeping = false;
  }
}

export interface ParkedLink {
  series_id: string;
  source_id: string;
  pkg_name: string;
  source_series_id: string | null;
  their_title: string | null;
  name: string | null;
  lang: string | null;
  via: BackupVia | null;
}

/** A series' links to parked backups, newest first, leaving out a source an admin unfollowed from it. */
export async function parkedLinksFor(seriesId: string): Promise<ParkedLink[]> {
  return q<ParkedLink>(
    `SELECT l.series_id, l.source_id, l.pkg_name, l.source_series_id, l.their_title, b.name, b.lang, b.via
       FROM backup_links l JOIN backup_extensions b ON b.pkg_name = l.pkg_name AND b.state = 'parked'
      WHERE l.series_id = $1
        AND NOT EXISTS (SELECT 1 FROM scout_verdicts v WHERE v.series_id = l.series_id AND v.source_id = l.source_id AND v.verdict = 'removed')
      ORDER BY l.parked_at DESC`, [seriesId]).catch(() => []);
}

/** A link used: gone, whatever the look found (a follow replaces it; a miss is remembered by the scout's verdict). */
export async function dropLink(seriesId: string, sourceId: string): Promise<void> {
  await q('DELETE FROM backup_links WHERE series_id = $1 AND source_id = $2', [seriesId, sourceId]).catch(() => {});
}

/** Whether a series has waited long enough for a backup to be put back for it (series_scout.stuck_since). */
export async function stuckLongEnough(seriesId: string): Promise<boolean> {
  const r = await one<{ since: Date | null }>('SELECT stuck_since AS since FROM series_scout WHERE series_id = $1', [seriesId]).catch(() => null);
  return !!r?.since && Date.now() - new Date(r.since).getTime() >= limits.stuckMs;
}
