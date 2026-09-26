/**
 * Every chapter the server is downloading, and what came in today, whatever started it (bff
 * lib/downloadActivity.ts) -- the `activity` field of `GET /api/sources/jobs`.
 *
 * The pill used to know only the jobs a button started, which in practice meant an add from Discover. A
 * source followed from "Find missing chapters" downloads at the series' next check; the scheduled check
 * downloads for every series; so do Check now, the repair and a bulk "Fetch newest" -- and none of it showed
 * anywhere. These are the rules for showing it, apart from the components, so a test can hold them.
 */
import { t as tr } from './i18n';

export type Origin = 'add' | 'fetch' | 'fill' | 'check' | 'sweep' | 'repair' | 'bulk' | 'refetch' | 'server';

export interface ActivityEntry {
  id: number;
  seriesId: string | null;
  /** The series folder: what a job card is keyed by, so the pill does not show one chapter twice. */
  folder: string;
  title: string;
  number: number;
  /** The source's display name. */
  source: string;
  origin: Origin;
  status: 'queued' | 'downloading' | 'done' | 'partial' | 'failed';
  startedAt: number;
  finishedAt?: number;
  pages?: number;
  reason?: string;
  mine?: boolean;
}

export interface Activity { active: ActivityEntry[]; recent: ActivityEntry[] }

/** What started a download, in the words the person would use for it. */
export function originLabel(o: Origin): string {
  switch (o) {
    case 'add': return tr('Added from Discover');
    case 'fetch': return tr('Fetch');
    case 'fill': return tr('Find missing chapters');
    case 'check': return tr('Check for new chapters');
    case 'sweep': return tr('Scheduled check');
    case 'repair': return tr('Library repair');
    case 'bulk': return tr('Fetch newest');
    case 'refetch': return tr('Fetch again');
    default: return tr('The server');
  }
}

/**
 * Chapter numbers as a short span: `Ch. 12–14, 16`. Runs of consecutive whole numbers fold into a range;
 * a half chapter stands alone, since 12.5 between 12 and 13 is not what a range promises.
 */
export function chapterSpan(numbers: readonly number[]): string {
  const ns = [...new Set(numbers)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < ns.length;) {
    let j = i;
    while (j + 1 < ns.length && Number.isInteger(ns[j]) && ns[j + 1] === ns[j] + 1) j++;
    parts.push(j > i + 1 ? `${ns[i]}–${ns[j]}` : j === i + 1 ? `${ns[i]}, ${ns[j]}` : `${ns[i]}`);
    i = j + 1;
  }
  return parts.length ? tr('Ch. {n}', { n: parts.join(', ') }) : '';
}

export interface ActivityGroup {
  key: string;
  seriesId: string | null;
  title: string;
  /** What landed: saved whole, or saved with pages missing. */
  numbers: number[];
  partial: number;
  failed: ActivityEntry[];
  origins: Origin[];
  /** The newest finish in the group: what the list is ordered by. */
  at: number;
}

/**
 * What came in, one line per series: "Solo Leveling · Ch. 180–182 · Scheduled check · 2 h ago". A chapter
 * that failed and then landed from another source is shown once, as landed.
 */
export function groupRecent(recent: readonly ActivityEntry[]): ActivityGroup[] {
  const groups = new Map<string, ActivityGroup>();
  for (const e of recent) {
    const key = e.seriesId ?? e.folder;
    let g = groups.get(key);
    if (!g) {
      g = { key, seriesId: e.seriesId, title: e.title, numbers: [], partial: 0, failed: [], origins: [], at: 0 };
      groups.set(key, g);
    }
    if (e.status === 'done' || e.status === 'partial') {
      g.numbers.push(e.number);
      if (e.status === 'partial') g.partial++;
    } else if (e.status === 'failed') g.failed.push(e);
    if (!g.origins.includes(e.origin)) g.origins.push(e.origin);
    g.at = Math.max(g.at, e.finishedAt ?? e.startedAt);
  }
  for (const g of groups.values()) {
    const landed = new Set(g.numbers);
    // Failed once, then taken from another source: that chapter is here, and a red line about it would lie.
    g.failed = g.failed.filter((f) => !landed.has(f.number));
  }
  return [...groups.values()].filter((g) => g.numbers.length || g.failed.length).sort((a, b) => b.at - a.at);
}

/** The server downloads a job card does not already show: the pill lists each chapter once. */
export function beyondJobs(active: readonly ActivityEntry[], jobFolders: ReadonlySet<string>): ActivityEntry[] {
  return active.filter((e) => !jobFolders.has(e.folder));
}
