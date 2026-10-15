// Health: the checks that read the library's own records rather than its chapters -- covers, details, disk space and
// folders, leftover reading data, and tracker sign-ins. Each is the same shape as the checks in lib/health.ts:
// findings first, info rows never turn a card amber, an ignore keyed `series:ID` / `folder:KIND` / `PROVIDER:USER`.
import { readdir, stat, statfs } from 'fs/promises';
import { q, one } from './db';
import { env } from '../env';
import { visibleToAll } from './visibility';
import { DL_ROOT, LIBRARY_ROOT } from './library';
import { applyIgnores, noIgnores, type IgnoreCtx } from './healthIgnore';
import { DAY_MS, hiddenPart, ignoredPart, truncate, verdict } from './healthKit';
import { detailOf, noteOf, say, saidOf, summaryOf } from './said';
import type { HealthCheck, HealthItem, HealthStatus } from './health';

type Keyed = HealthItem & { members?: string[] };

// ---- covers -------------------------------------------------------------------------------------------------

/**
 * Series with nothing to show as a cover: none set by hand, none fetched, and no chapter whose first page could
 * stand in (routes/images.ts serveLibSeriesThumb's order). A cover that is present but blank cannot be told from
 * here, and is not claimed.
 */
export async function seriesCovers(ctx: IgnoreCtx = noIgnores()): Promise<HealthCheck> {
  const rows = await q<{ id: string; title: string }>(
    `SELECT s.id, s.title
       FROM lib_series s
       LEFT JOIN series_overrides o ON o.series_id = s.id
       LEFT JOIN series_art a ON a.series_id = s.id
      WHERE ${visibleToAll('s')}
        AND COALESCE(o.cover, '') = '' AND COALESCE(a.cover, '') = ''
        AND NOT EXISTS (SELECT 1 FROM lib_books b WHERE b.series_id = s.id AND b.pruned_at IS NULL)
      ORDER BY s.title`,
  );
  const all: Keyed[] = rows.map((r) => ({
    seriesId: r.id, title: r.title, ...detailOf([say('covers.detail')]), key: `series:${r.id}`, members: [],
  }));
  const ignored = applyIgnores('covers', all, ctx);
  const n = all.filter((i) => !i.info).length;
  const { items, hidden } = truncate(all);
  return {
    id: 'covers', title: 'Series covers',
    status: verdict(all),
    ...summaryOf([n ? say('covers.bad', { n }) : say('covers.ok'), ignoredPart(ignored)]),
    ...noteOf([say('covers.note'), hiddenPart(hidden)]),
    items,
  };
}

// ---- details ------------------------------------------------------------------------------------------------

export async function seriesDetails(ctx: IgnoreCtx = noIgnores()): Promise<HealthCheck> {
  // A series with no description is only a finding when its source gives descriptions to other series: a source that
  // gives none to any of them simply has none to give, and that is not something to fix here.
  const rows = await q<{ id: string; title: string; summary: boolean; genres: boolean; author: boolean }>(
    `WITH src AS (
       SELECT source_id FROM lib_series
        WHERE source_id IS NOT NULL AND NULLIF(btrim(summary), '') IS NOT NULL
        GROUP BY source_id
     ), d AS (
       SELECT s.id, s.title,
              (COALESCE(NULLIF(btrim(o.summary), ''), NULLIF(btrim(s.summary), '')) IS NULL
                 AND s.source_id IN (SELECT source_id FROM src)) AS summary,
              COALESCE(cardinality(COALESCE(NULLIF(o.genres, '{}'::text[]), s.genres)), 0) = 0 AS genres,
              COALESCE(NULLIF(btrim(o.author), ''), NULLIF(btrim(s.author), '')) IS NULL AS author
         FROM lib_series s LEFT JOIN series_overrides o ON o.series_id = s.id
        WHERE ${visibleToAll('s')}
     )
     SELECT id, title, summary, genres, author FROM d WHERE summary OR genres OR author ORDER BY title`,
  );
  const all: Keyed[] = rows.map((r) => ({
    seriesId: r.id, title: r.title,
    ...detailOf([say('details.missing', { summary: r.summary, genres: r.genres, author: r.author })]),
    key: `series:${r.id}`, members: [],
    // Only an author missing is listed for reference: plenty of series have none anywhere.
    ...(r.summary || r.genres ? {} : { info: true }),
  }));
  const ignored = applyIgnores('details', all, ctx);
  const n = all.filter((i) => !i.info).length;
  const { items, hidden } = truncate(all);
  return {
    id: 'details', title: 'Series details',
    status: verdict(all),
    ...summaryOf([n ? say('details.bad', { n }) : say('details.ok'), ignoredPart(ignored)]),
    ...noteOf([say('details.note'), hiddenPart(hidden)]),
    items,
  };
}

// ---- disk ---------------------------------------------------------------------------------------------------

/** Free space that is worth a word: under 5 % free AND under 200 GB (5 % of an array is plenty), or under 2 % or 5 GB. */
export function spaceStatus(free: number, total: number): 'ok' | 'warn' | 'problem' {
  const GB = 1024 ** 3;
  if (!total) return 'ok';
  const share = free / total;
  if (share < 0.02 || free < 5 * GB) return 'problem';
  if (share < 0.05 && free < 200 * GB) return 'warn';
  return 'ok';
}

const gb = (n: number): number => Math.round((n / 1024 ** 3) * 10) / 10;

interface Where { kind: 'library' | 'downloads' | 'config'; dir: string }

export async function diskAndFolders(ctx: IgnoreCtx = noIgnores()): Promise<HealthCheck> {
  const where: Where[] = [
    { kind: 'library', dir: LIBRARY_ROOT },
    ...(DL_ROOT !== LIBRARY_ROOT ? [{ kind: 'downloads' as const, dir: DL_ROOT }] : []),
    { kind: 'config', dir: env.CONFIG_DIR },
  ];
  const counts = new Map((await q<{ root: string; n: number }>(
    `SELECT b.root, count(*)::int AS n FROM lib_books b JOIN lib_series s ON s.id = b.series_id
      WHERE b.pruned_at IS NULL AND ${visibleToAll('s')} GROUP BY b.root`,
  ).catch(() => [])).map((r) => [r.root, r.n]));
  const title = (w: Where) => {
    const t = say('disk.where', { kind: w.kind });
    return { title: t.text, titleSaid: saidOf(t) };
  };
  const all: Keyed[] = [];
  const levels = new Map<string, HealthStatus>();
  const devices = new Set<number>();
  for (const w of where) {
    const key = `folder:${w.kind}`;
    const st = await stat(w.dir).catch((e: NodeJS.ErrnoException) => e);
    const books = counts.get(w.dir) ?? 0;
    if (st instanceof Error) {
      // A root nobody has chapters under and that is not there is an install without that folder, not a finding.
      if (w.kind !== 'config' && !books && st.code === 'ENOENT') continue;
      all.push({ ...title(w), ...detailOf([say('disk.cannotRead', { error: String(st.message).slice(0, 160) })]), key, members: [] });
      levels.set(key, 'problem');
      continue;
    }
    if (w.kind !== 'config') {
      const names = await readdir(w.dir).catch((e: Error) => e);
      if (names instanceof Error) {
        all.push({ ...title(w), ...detailOf([say('disk.cannotRead', { error: String(names.message).slice(0, 160) })]), key, members: [] });
        levels.set(key, 'problem');
        continue;
      }
      if (!names.length && books) {
        all.push({ ...title(w), ...detailOf([say('disk.looksEmpty', { n: books })]), key, members: [] });
        levels.set(key, 'problem');
        continue;
      }
    }
    if (devices.has(st.dev)) continue;
    devices.add(st.dev);
    const fs = await statfs(w.dir).catch(() => null);
    if (!fs || !fs.blocks) continue;
    const free = fs.bavail * fs.bsize;
    const total = fs.blocks * fs.bsize;
    const level = spaceStatus(free, total);
    all.push({
      ...title(w),
      ...detailOf([say(level === 'ok' ? 'disk.free' : 'disk.low', { free: gb(free), total: gb(total) })]),
      key: `space:${w.kind}`, members: [],
      ...(level === 'ok' ? { info: true } : {}),
    });
    levels.set(`space:${w.kind}`, level);
  }
  const ignored = applyIgnores('disk', all, ctx);
  // An ignored finding no longer counts.
  const live = all.filter((i) => !i.info);
  const status: HealthStatus = live.some((i) => levels.get(i.key!) === 'problem') ? 'problem' : live.length ? 'warn' : 'ok';
  const { items, hidden } = truncate(all);
  return {
    id: 'disk', title: 'Disk space and folders', status,
    ...summaryOf([live.length ? say('disk.bad', { n: live.length }) : say('disk.ok'), ignoredPart(ignored)]),
    ...noteOf([say('disk.note'), hiddenPart(hidden)]),
    items,
  };
}

// ---- orphaned reading data ----------------------------------------------------------------------------------

type Orphan = 'eventsSeries' | 'eventsChapter' | 'trackerSeries' | 'downloads' | 'removed';

/** Reading history and tracker records pointing at things that are gone. Counted, never deleted. */
export async function orphanedData(): Promise<HealthCheck> {
  const n = (sql: string) => one<{ n: number }>(sql).then((r) => r?.n ?? 0).catch(() => 0);
  const counts: Record<Orphan, number> = {
    eventsSeries: await n(`SELECT count(*)::int AS n FROM reading_events e WHERE NOT EXISTS (SELECT 1 FROM lib_series s WHERE s.id = e.series_id)`),
    eventsChapter: await n(
      `SELECT count(*)::int AS n FROM reading_events e
        WHERE EXISTS (SELECT 1 FROM lib_series s WHERE s.id = e.series_id) AND NOT EXISTS (SELECT 1 FROM lib_books b WHERE b.id = e.book_id)`),
    trackerSeries: await n(`SELECT count(*)::int AS n FROM tracker_progress t WHERE NOT EXISTS (SELECT 1 FROM lib_series s WHERE s.id = t.series_id)`),
    downloads: await n(`SELECT count(*)::int AS n FROM offline_downloads d WHERE NOT EXISTS (SELECT 1 FROM lib_books b WHERE b.id = d.book_id)`),
    removed: await n(
      `SELECT ((SELECT count(*) FROM favorites f JOIN lib_series s ON s.id = f.series_id WHERE s.deleted_at IS NOT NULL OR s.merged_into IS NOT NULL)
             + (SELECT count(*) FROM read_progress p JOIN lib_series s ON s.id = p.series_id WHERE s.deleted_at IS NOT NULL OR s.merged_into IS NOT NULL))::int AS n`),
  };
  const kinds = (Object.keys(counts) as Orphan[]).filter((k) => counts[k] > 0);
  const items: HealthItem[] = kinds.map((k) => {
    const t = say('orphans.kind', { kind: k });
    return { title: t.text, titleSaid: saidOf(t), info: true, ...detailOf([say('orphans.rows', { n: counts[k] })]) };
  });
  const total = kinds.reduce((a, k) => a + counts[k], 0);
  return {
    id: 'orphans', title: 'Reading data', status: 'ok',
    ...summaryOf([total ? say('orphans.some', { n: total }) : say('orphans.none')]),
    ...noteOf([say('orphans.note')]),
    items,
  };
}

// ---- trackers -----------------------------------------------------------------------------------------------

const PROVIDER_NAME: Record<string, string> = { anilist: 'AniList', myanimelist: 'MyAnimeList', kitsu: 'Kitsu', mangaupdates: 'MangaUpdates' };
const SOON_MS = 14 * DAY_MS;
const HEADS_UP_MS = 30 * DAY_MS;

export async function trackerSync(ctx: IgnoreCtx = noIgnores()): Promise<HealthCheck> {
  const rows = await q<{
    user_id: string; provider: string; username: string | null; enabled: boolean;
    expires_at: Date | null; last_error: string | null;
  }>(
    `SELECT t.user_id, t.provider, u.username, t.enabled, t.expires_at, t.last_error
       FROM user_trackers t JOIN users u ON u.id = t.user_id ORDER BY t.provider, u.username`,
  );
  const now = Date.now();
  const all: Keyed[] = [];
  for (const r of rows) {
    const left = r.expires_at ? new Date(r.expires_at).getTime() - now : null;
    const parts = [
      !r.enabled ? say('trackers.rejected') : null,
      r.last_error ? say('trackers.error', { error: r.last_error.slice(0, 160) }) : null,
      left !== null && left <= 0 ? say('trackers.expired', { at: new Date(r.expires_at!).toISOString() })
        : left !== null && left <= HEADS_UP_MS ? say('trackers.expiring', { at: new Date(r.expires_at!).toISOString() })
        : null,
    ];
    if (!parts.some(Boolean)) continue;
    const finding = !r.enabled || !!r.last_error || (left !== null && left <= SOON_MS);
    all.push({
      title: `${PROVIDER_NAME[r.provider] ?? r.provider} · ${r.username ?? '?'}`,
      ...detailOf(parts),
      key: `${r.provider}:${r.user_id}`, members: [],
      ...(finding ? {} : { info: true }),
    });
  }
  const ignored = applyIgnores('trackers', all, ctx);
  const n = all.filter((i) => !i.info).length;
  const { items, hidden } = truncate(all);
  return {
    id: 'trackers', title: 'Tracker sync',
    status: verdict(all),
    ...summaryOf([
      n ? say('trackers.bad', { n }) : rows.length ? say('trackers.ok', { n: rows.length }) : say('trackers.none'),
      ignoredPart(ignored),
    ]),
    ...noteOf([say('trackers.note'), hiddenPart(hidden)]),
    items,
  };
}
