// Every source the server knows, of every kind, in one answer (v0.54.0, GET /api/admin/sources/overview).
//
// The owner: "why do we have 2 when they are baisicly the same". Providers and Extensions were one source list cut
// across three places -- each with its own reads, and each disagreeing with the others: Providers listed only the
// extension sources registered, Extensions counted every source of an extension, Health merged the off-switches with
// SQL of its own. The one Sources section reads this. Nothing is computed twice: every fact comes from the read that
// already owns it --
//   - a row's state, stage, cooldown, where it was switched off, its logo and its group: Source health's own rows
//     (lib/health.ts sourceTrouble), so the overview and Health never word one source two ways;
//   - its standing (lib/sourceStanding.ts), which Replace, Health and the Sources sheet also read;
//   - how many series it is the main source of (lib/findScope.ts mainSourceCounts, what Health's buttons count), and of
//     those, how many already follow a source that can take over (lib/replaceSource.ts, the Replace preview's rule);
//   - its language and extension package as GET /api/sources says them.
// `attention` is what the section leads with: the sources to replace (off or failing, and some series' main source --
// Health's `replace_source` rule), the failing ones nothing uses (Health's `unused` group, the one its summary counts),
// and how many extensions have an update waiting.
// The extension engine's own state stays GET /api/admin/extensions/status's: it asks the engine, and this asks nothing.
import { q } from './db';
import { env } from '../env';
import { getSource, listSources, isPackSource, isSwAdapterId, SW_PREFIX, suwayomiConfigured, withTimeout } from './sources';
import { leftOutByLimit } from './sources/suwayomi/register';
import { MANGADEX_GROUP } from './sources/mangadex';
import { readSites } from './sources/customSites';
import { extensionsGeneration, listExtensions } from './sources/suwayomi/extensions';
import { visibleToAll } from './visibility';
import { mainSourceCounts } from './findScope';
import { sourceTrouble, sourceLabel, type HealthItem } from './health';
import { loadIgnores } from './healthIgnore';
import { EXTENSION_OFF_BY, standingOf, standingRows, type Standing } from './sourceStanding';
import { currentFailures, type Stage, type Stages } from './sourceEvidence';
import { replaceCountsByMain } from './replaceSource';

export type SourceKind = 'builtin' | 'mangadex' | 'site' | 'extension' | 'pack';
export type OverviewState = 'blocked' | 'failing' | 'slow' | 'empty' | 'inconclusive' | 'untested' | 'off' | 'ok';

export interface OverviewSource {
  id: string;
  name: string;
  kind: SourceKind;
  lang: string | null;
  /** Extension sources only: the package that provides it. */
  pkgName?: string | null;
  standing: Standing;
  offBy: 'admin' | 'extension' | 'language' | null;
  state: OverviewState;
  stage: Stage | null;
  cooldown: { status: string; until: string | null } | null;
  /** The site answers with its own offline notice (lib/sources/offline.ts), confirmed. */
  offline: boolean;
  /** Series whose main source it is; series that follow it without it being their main; of `main`, the ones a working follower would take over. */
  main: number;
  followed: number;
  withBackup: number;
  lastTestedAt: string | null;
  icon: boolean;
  /** A site added by address: its address. */
  address?: string;
  /**
   * v0.55.1: not loaded because the engine's source limit is full -- switched on, offered, and left out by the last load
   * (register.ts leftOutByLimit), with the limit it is over. Not broken, and Replace is not its fix: room under the limit
   * is. Absent for every other source.
   */
  overLimit?: { limit: number };
}

export interface SourcesOverview {
  sources: OverviewSource[];
  attention: { replace: string[]; failingUnused: string[]; updates: number };
}

/** How long the engine may take to say which extensions have an update, and how long its answer is kept. */
const UPDATES_MS = 4_000;
const UPDATES_KEEP_MS = 30_000;
let updatesSeen: { at: number; n: number; gen: number } | null = null;

/**
 * Extensions with an update waiting: the engine's own word, asked briefly and kept half a minute (a section that is
 * open polls); when it does not answer in time, the last extension check's (server_settings.extension_last_result: what
 * was waiting and was not updated) -- kept as long, so an engine that is away costs one wait, not one a poll. Never
 * kept past an install, update or removal, or a re-read of the repositories (extensionsGeneration): the Update of
 * Needs attention's own row left the row up until the copy ran out. Reintroduce by dropping the generation:
 * "an update applied is no longer counted, at once" in extensionCatalog.int.test.ts still counts it.
 */
async function updatesWaiting(): Promise<number> {
  if (!suwayomiConfigured()) return 0;
  // Read before the engine is asked: a change landing while it answers leaves this copy behind it.
  const gen = extensionsGeneration();
  if (updatesSeen && updatesSeen.gen === gen && Date.now() - updatesSeen.at < UPDATES_KEEP_MS) return updatesSeen.n;
  let n: number;
  try {
    n = (await withTimeout(listExtensions(), UPDATES_MS)).filter((e) => e.installed && e.hasUpdate).length;
  } catch {
    const r = await q<{ last: { updatesAvailable?: string[]; updated?: Array<{ name: string }> } | null }>(
      'SELECT extension_last_result AS last FROM server_settings WHERE id = 1').catch(() => []);
    const last = r[0]?.last;
    const done = new Set((last?.updated ?? []).map((u) => u.name));
    n = (last?.updatesAvailable ?? []).filter((name) => !done.has(name)).length;
  }
  updatesSeen = { at: Date.now(), n, gen };
  return n;
}

/** Tests: forget the engine's last answer. */
export function forgetUpdates(): void { updatesSeen = null; }

export async function sourcesOverview(): Promise<SourcesOverview> {
  const now = Date.now();
  const health = await sourceTrouble(await loadIgnores());
  const rows = new Map<string, HealthItem>(health.items.filter((i) => i.sourceId).map((i) => [i.sourceId!, i]));
  const sw = new Map((await q<{ source_id: string; name: string | null; lang: string | null; pkg_name: string | null }>(
    'SELECT source_id, name, lang, pkg_name FROM suwayomi_sources').catch(() => [])).map((r) => [`${SW_PREFIX}${r.source_id}`, r]));
  const sites = new Map((await readSites()).filter((s) => s.id).map((s) => [s.id!, s]));
  const used = await q<{ source_id: string }>(
    `SELECT DISTINCT x.source_id FROM (
       SELECT s.source_id FROM lib_series s WHERE s.source_id IS NOT NULL AND ${visibleToAll('s')}
       UNION SELECT ss.source_id FROM series_sources ss JOIN lib_series s ON s.id = ss.series_id WHERE ${visibleToAll('s')}) x`,
  );
  // Every source the server knows: loaded, an extension's (switched on or off), one a series still names, one Health
  // lists.
  const ids = [...new Set([...listSources().map((s) => s.id), ...sw.keys(), ...used.map((r) => r.source_id), ...rows.keys()])];

  const standing = await standingRows(ids);
  const off = new Map((await q<{ id: string; off_by: string | null; admin: boolean | null; live_at: string | Date | null }>(
    `SELECT i.id, ${EXTENSION_OFF_BY('i.id')} AS off_by, sh.disabled AS admin, sh.live_at
       FROM unnest($1::text[]) AS i(id) LEFT JOIN source_health sh ON sh.source_id = i.id`, [ids])).map((r) => [r.id, r]));
  const main = await mainSourceCounts(ids);
  const followed = new Map((await q<{ source_id: string; n: number }>(
    `SELECT ss.source_id, count(DISTINCT s.id)::int AS n FROM series_sources ss JOIN lib_series s ON s.id = ss.series_id
      WHERE ss.source_id = ANY($1::text[]) AND ss.source_id IS DISTINCT FROM s.source_id AND ${visibleToAll('s')}
      GROUP BY ss.source_id`, [ids])).map((r) => [r.source_id, Number(r.n)]));
  // Of each source's series, the ones a working follower would take over: the Replace preview's own count, for every
  // source with series at once.
  const mains = ids.filter((id) => (main.get(id) ?? 0) > 0);
  const series = mains.length
    ? await q<{ id: string }>(`SELECT s.id FROM lib_series s WHERE s.source_id = ANY($1::text[]) AND ${visibleToAll('s')}`, [mains])
    : [];
  const backups = await replaceCountsByMain(series.map((r) => r.id), null);

  const kindOf = (id: string): SourceKind => {
    if (isSwAdapterId(id)) return 'extension';
    if (getSource(id)?.rateGroup === MANGADEX_GROUP || /^mangadex(-|$)/.test(id)) return 'mangadex';
    if (sites.has(id)) return 'site';
    // A pack's, loaded from SOURCES_DIR; anything else not loaded now was most likely one (a pack is the one kind of
    // source this server has no record of beside the series that name it).
    return isPackSource(id) || !getSource(id) ? 'pack' : 'builtin';
  };
  const sources: OverviewSource[] = ids.map((id) => {
    const src = getSource(id);
    const row = rows.get(id);
    const st = standingOf(id, standing.get(id), now);
    const ext = sw.get(id);
    const o = off.get(id);
    const site = sites.get(id);
    const lang = src?.lang ?? (isSwAdapterId(id) ? ext?.lang ?? null : null);
    // Health lists every source with something to say; one it does not list has nothing wrong with it -- unless it is an
    // extension's source switched off with no health row at all, which Health's read never sees.
    const state: OverviewState = (row?.state as OverviewState | undefined) ?? (st === 'off' ? 'off' : 'ok');
    const offBy = row?.offBy ?? (st === 'off' ? (o?.off_by as OverviewSource['offBy']) ?? (o?.admin ? 'admin' : null) : null);
    return {
      id,
      name: src?.name || sourceLabel(id, ext?.name),
      kind: kindOf(id),
      lang: lang?.trim() ? lang : null,
      ...(isSwAdapterId(id) ? { pkgName: ext?.pkg_name ?? null } : {}),
      standing: st,
      offBy: st === 'off' ? offBy : null,
      state,
      stage: row?.stage ?? null,
      cooldown: row?.cooldown ?? null,
      offline: currentFailures(standing.get(id)?.stages as Stages | null | undefined, now).some((f) => f.kind === 'site_offline'),
      main: main.get(id) ?? 0,
      followed: followed.get(id) ?? 0,
      withBackup: backups.get(id)?.withBackup ?? 0,
      lastTestedAt: o?.live_at ? new Date(o.live_at).toISOString() : null,
      icon: !!src?.iconUrl,
      ...(site?.base ? { address: site.base } : {}),
      // Health's frozen row for its series offers Free a slot by the same record (lib/health.ts frozenSeries), and lands
      // here: the sheet says why it is not loaded instead of offering Replace. Reintroduce by leaving it out: "a source
      // the limit left out says so" in sourcesOverview.int.test.ts finds nothing.
      ...(st === 'not_loaded' && leftOutByLimit(id) ? { overLimit: { limit: env.SUWAYOMI_MAX_SOURCES } } : {}),
    };
  });

  // Health's `replace_source` rule: off or failing, and some series' main source.
  const replace = sources.filter((s) => (s.standing === 'off' || s.standing === 'failing') && s.main > 0).map((s) => s.id);
  const failingUnused = health.items.filter((i) => i.group === 'unused' && i.sourceId).map((i) => i.sourceId!);
  const attention = new Set([...replace, ...failingUnused]);
  // What needs a look first, then what the library uses most, then by name; switched off last.
  const rank = (s: OverviewSource) => (attention.has(s.id) ? 0 : s.standing === 'off' ? 2 : 1);
  sources.sort((a, b) => rank(a) - rank(b)
    || (b.main + b.followed) - (a.main + a.followed)
    || a.name.localeCompare(b.name, 'en', { sensitivity: 'base', numeric: true })
    || a.id.localeCompare(b.id));
  return { sources, attention: { replace, failingUnused, updates: await updatesWaiting() } };
}
