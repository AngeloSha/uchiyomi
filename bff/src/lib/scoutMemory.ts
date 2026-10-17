// What each source said when the server looked for a series on it (v0.80.0, `scout_verdicts`).
//
// The scout (lib/sourceScout.ts) and the sweep's hunt (lib/sourceHunt.ts) both search other sources for a series, and
// each search is a real request to a site. Before this, the hunt asked the same first six sources once a day, every
// day, and threw their answers away; the nightly repair did the same for its holes. Now an answer is kept for as long
// as it is likely to stay true, and a source that said "not this series" is not asked again until then:
//
//   - `no_hit`, `title_differs`, `language_differs`: 14 days. A site rarely starts carrying a title it did not carry.
//   - `numbering_differs`: 14 days, or until the series' own listing has moved by a tenth (its numbers are what the
//     candidate was measured against).
//   - `unreachable`: 1 day. The site, the solver or the extension was down; tomorrow is another day.
//   - `ok`: 7 days. It IS this series. Remembered with its id there, so it is judged again without a search, and first.
//   - `removed`: for good. An admin unfollowed it from this series; nothing automatic follows it again until an admin
//     follows it by hand (which clears it).
import { q } from './db';

export type ScoutVerdict = 'ok' | 'no_hit' | 'title_differs' | 'language_differs' | 'numbering_differs' | 'unreachable' | 'removed';

const DAY = 24 * 3600_000;
/** How long each verdict is believed. `removed` has no end. */
export const VERDICT_TTL_MS: Readonly<Record<Exclude<ScoutVerdict, 'removed'>, number>> = {
  ok: 7 * DAY,
  no_hit: 14 * DAY,
  title_differs: 14 * DAY,
  language_differs: 14 * DAY,
  numbering_differs: 14 * DAY,
  unreachable: 1 * DAY,
};

export interface VerdictRow {
  source_id: string;
  verdict: ScoutVerdict;
  their_title: string | null;
  source_series_id: string | null;
  coverage: number | null;
  our_count: number | null;
  at: string | Date;
}

/**
 * Whether a verdict still holds: within its lifetime, and for `numbering_differs`, while the series lists about as
 * many numbers as it did when the candidate was measured (within a tenth). Pure.
 */
export function verdictHolds(v: Pick<VerdictRow, 'verdict' | 'at' | 'our_count'>, ourCount: number, now = Date.now()): boolean {
  if (v.verdict === 'removed') return true;
  const ttl = VERDICT_TTL_MS[v.verdict as Exclude<ScoutVerdict, 'removed'>];
  if (ttl === undefined) return false;
  if (now - new Date(v.at).getTime() >= ttl) return false;
  if (v.verdict === 'numbering_differs' && v.our_count != null && v.our_count > 0) {
    if (Math.abs(ourCount - v.our_count) / v.our_count >= 0.1) return false;
  }
  return true;
}

/** When a holding verdict stops holding (ms since the epoch), or null for `removed`. Pure. */
export function verdictExpires(v: Pick<VerdictRow, 'verdict' | 'at'>): number | null {
  if (v.verdict === 'removed') return null;
  const ttl = VERDICT_TTL_MS[v.verdict as Exclude<ScoutVerdict, 'removed'>] ?? 0;
  return new Date(v.at).getTime() + ttl;
}

/** Every verdict on record for a series, holding or not, by source. A read that fails is none: search as before. */
export async function verdictsFor(seriesId: string): Promise<Map<string, VerdictRow>> {
  const rows = await q<VerdictRow>(
    `SELECT source_id, verdict, their_title, source_series_id, coverage, our_count, at FROM scout_verdicts WHERE series_id = $1`,
    [seriesId],
  ).catch(() => [] as VerdictRow[]);
  return new Map(rows.map((r) => [r.source_id, r]));
}

/**
 * The sources a search for this series should leave out now: a negative verdict that still holds, or `removed`.
 * An `ok` is not left out -- it is the first to be judged again.
 */
export async function sourcesToSkip(seriesId: string, ourCount: number, now = Date.now()): Promise<Set<string>> {
  const out = new Set<string>();
  for (const v of (await verdictsFor(seriesId)).values()) {
    if (v.verdict !== 'ok' && verdictHolds(v, ourCount, now)) out.add(v.source_id);
  }
  return out;
}

/**
 * Remember what a source said. `removed` is never overwritten by an automatic verdict: only an admin's own follow
 * (forgetVerdict) clears it. Best effort.
 */
export async function recordVerdict(
  seriesId: string,
  sourceId: string,
  verdict: Exclude<ScoutVerdict, 'removed'>,
  facts: { theirTitle?: string | null; sourceSeriesId?: string | null; coverage?: number | null; ourCount?: number | null } = {},
): Promise<void> {
  await q(
    `INSERT INTO scout_verdicts (series_id, source_id, verdict, their_title, source_series_id, coverage, our_count, at)
     SELECT $1, $2, $3, $4, $5, $6, $7, now() WHERE EXISTS (SELECT 1 FROM lib_series WHERE id = $1)
     ON CONFLICT (series_id, source_id) DO UPDATE SET verdict = EXCLUDED.verdict, their_title = EXCLUDED.their_title,
       source_series_id = COALESCE(EXCLUDED.source_series_id, scout_verdicts.source_series_id),
       coverage = EXCLUDED.coverage, our_count = EXCLUDED.our_count, at = now()
      WHERE scout_verdicts.verdict <> 'removed'`,
    [seriesId, sourceId, verdict, facts.theirTitle ?? null, facts.sourceSeriesId ?? null, facts.coverage ?? null, facts.ourCount ?? null],
  ).catch(() => {});
}

/** An admin unfollowed this source from this series: nothing automatic follows it there again. Best effort. */
export async function markRemoved(seriesId: string, sourceId: string): Promise<void> {
  await q(
    `INSERT INTO scout_verdicts (series_id, source_id, verdict, at) SELECT $1, $2, 'removed', now()
      WHERE EXISTS (SELECT 1 FROM lib_series WHERE id = $1)
     ON CONFLICT (series_id, source_id) DO UPDATE SET verdict = 'removed', at = now()`,
    [seriesId, sourceId],
  ).catch(() => {});
}

/** An admin followed this source by hand: whatever was remembered about it for this series no longer applies. */
export async function forgetVerdict(seriesId: string, sourceId: string): Promise<void> {
  await q('DELETE FROM scout_verdicts WHERE series_id = $1 AND source_id = $2', [seriesId, sourceId]).catch(() => {});
}
