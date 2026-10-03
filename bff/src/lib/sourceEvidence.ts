// What a source has been SEEN doing, per stage, and what that evidence means (#115, v0.49.0).
//
// Before this, one `status` column carried everything, and anything could reset it. A search failure in
// Discover wrote last_error; one downloaded chapter (reportOk) or the nightly lapsed-block reset put status back
// to 'ok'; Health read only status, so "Manga Ball (EN)" failed its Test while its card said "ok" and Health
// said "All good". Test itself wrote nothing, and the daily check wrote a check_code nothing read.
//
// So evidence is kept per STAGE -- search, chapters (series page + chapter list), pages (the page-URL list) and
// images (downloaded bytes) -- in one `source_health.stages` jsonb, and only a success at the SAME stage closes
// a failure: a download proves nothing about search. `images` is its own stage because the smoke test never
// fetches a byte, so a passing Test must not be able to clear a downloader's byte failure either.
//
// Pure on purpose: no db, no imports beyond types, so the rules are unit-tested against the verbatim shapes the
// writers in sourceHealth.ts store (their SQL does the same merge, row-locked, and must stay in step with this).

export type Stage = 'search' | 'chapters' | 'pages' | 'images';
export const STAGES: readonly Stage[] = ['search', 'chapters', 'pages', 'images'];

/** Who saw it: an admin's Test, the daily check (or "Check all now"), or ordinary use. */
export type EvidenceBy = 'test' | 'sweep' | 'traffic';
/**
 * How a stage failed. A live run that hit OUR deadline is not a failure at all and is never stored as one.
 * `site_offline` (v0.49.1): the site answered with its own offline or maintenance notice (lib/sources/offline.ts).
 * `rate_limited` (v0.55.1): the site asked us to slow down (HTTP 429) -- a cooldown, never a failure (isRateLimit).
 */
export type FailKind = 'error' | 'empty' | 'unnumbered' | 'site_offline' | 'rate_limited';

/**
 * The words that say a site asked us to slow down: the ones classify() (lib/sourceHealth.ts) files as `rate_limited`
 * and the diagnosis reads the same way (lib/sourceDiagnosis.ts).
 */
export const RATE_LIMIT_WORDS = /\b429\b|rate.?limit|too many requests|slow down/i;

/**
 * Is this failure the site asking for room (v0.55.1)? Recorded as `rate_limited` since v0.55.1; before that every
 * failure was `error`, and the downloader's own words say it: "0/32 pages downloaded (HTTP 429)".
 *
 * A rate limit is a cooldown, never a failure: the site works and asked us to wait. Counted as a failure it made a
 * source whose image server answered 429 -- Mangakakalot, whose searches and chapter lists answered fine -- a Replace
 * target, and Fix everything moved 14 series off a source that works (the owner's first run, 2026-10-03).
 */
export const isRateLimit = (f: { kind?: FailKind | string | null; error?: string | null }): boolean =>
  f.kind === 'rate_limited' || ((f.kind ?? 'error') === 'error' && RATE_LIMIT_WORDS.test(f.error ?? ''));

export interface StageRecord {
  okAt?: string | null;
  okBy?: EvidenceBy | null;
  /** The most recent failure. */
  failAt?: string | null;
  failBy?: EvidenceBy | null;
  /** When the failure that is open now began; absent on rows written before it existed (failAt stands in). */
  since?: string | null;
  error?: string | null;
  kind?: FailKind | null;
  /** Failures in a row at this stage; any success resets it. */
  streak?: number | null;
}
export type Stages = Partial<Record<Stage, StageRecord>>;

/**
 * Three failures in a row in ordinary use are a finding; one is noise. The same number as EMPTY_SUSPECT, and
 * for the same reason: one Discover search that failed once is how the v0.41.0 page stayed amber for sources
 * nobody could fix (health.ts, "a source NOTHING uses").
 */
export const TRAFFIC_CONFIRM = 3;
/** Evidence nobody has refreshed for a week is shown greyed, as "test again", never as a current failure. */
export const LIVE_STALE_MS = 7 * 24 * 60 * 60 * 1000;

export interface OpenFailure {
  stage: Stage;
  since: string;
  /** The latest failure at this stage. */
  at: string;
  error: string | null;
  kind: FailKind;
  by: EvidenceBy;
  streak: number;
  /** From a live check, or TRAFFIC_CONFIRM traffic failures in a row. */
  confirmed: boolean;
  /** Nothing has failed (or passed) here for LIVE_STALE_MS. */
  stale: boolean;
}

const ms = (t: string | null | undefined): number => {
  const n = t ? Date.parse(t) : NaN;
  return Number.isFinite(n) ? n : 0;
};

/** Is this stage's failure still open: it failed, and nothing at THIS stage has succeeded since. */
export function isOpen(r: StageRecord | undefined | null): boolean {
  if (!r?.failAt) return false;
  return ms(r.failAt) > ms(r.okAt);
}

/**
 * The failures that are open now, in stage order.
 *
 * ⚠️ `okAt` is compared per stage and never against another stage's (or `last_ok_at`, which reportOk stamps
 * for a download): that comparison is exactly how one chapter download used to erase a search failure.
 */
export function openFailures(stages: Stages | null | undefined, now = Date.now()): OpenFailure[] {
  const out: OpenFailure[] = [];
  if (!stages || typeof stages !== 'object') return out;
  for (const stage of STAGES) {
    const r = stages[stage];
    if (!r || !isOpen(r)) continue;
    const by: EvidenceBy = r.failBy === 'test' || r.failBy === 'sweep' ? r.failBy : 'traffic';
    const streak = Math.max(1, Number(r.streak) || 1);
    const at = r.failAt!;
    out.push({
      stage,
      since: r.since || at,
      at,
      error: r.error ?? null,
      kind: r.kind === 'empty' || r.kind === 'unnumbered' || r.kind === 'site_offline' || r.kind === 'rate_limited' ? r.kind : 'error',
      by,
      streak,
      confirmed: by !== 'traffic' || streak >= TRAFFIC_CONFIRM,
      stale: now - ms(at) > LIVE_STALE_MS,
    });
  }
  return out;
}

/**
 * The failures Health, Providers and the push treat as real: confirmed and current -- and never a rate limit (v0.55.1),
 * which is a cooldown: currentRateLimits says those. Reintroduce by keeping them: "images failing with 429 are a
 * cooldown" in sourceStanding.test.ts reads failing.
 */
export const currentFailures = (stages: Stages | null | undefined, now = Date.now()): OpenFailure[] =>
  openFailures(stages, now).filter((f) => f.confirmed && !f.stale && !isRateLimit(f));

/** The rate limits that are confirmed and current: what makes a source `cooling` (lib/sourceStanding.ts) after its cooldown. */
export const currentRateLimits = (stages: Stages | null | undefined, now = Date.now()): OpenFailure[] =>
  openFailures(stages, now).filter((f) => f.confirmed && !f.stale && isRateLimit(f));

/** One line per stage for the admin surfaces: what was last seen there, whichever way it went. */
export interface StageLine {
  stage: Stage;
  state: 'ok' | 'fail' | 'unknown';
  at: string | null;
  by: EvidenceBy | null;
  kind: FailKind | null;
  error: string | null;
}

export function stageLines(stages: Stages | null | undefined): StageLine[] {
  return STAGES.map((stage) => {
    const r = stages?.[stage];
    if (r && isOpen(r)) {
      return { stage, state: 'fail', at: r.failAt ?? null, by: r.failBy ?? null, kind: r.kind ?? 'error', error: r.error ?? null };
    }
    if (r?.okAt) return { stage, state: 'ok', at: r.okAt, by: r.okBy ?? null, kind: null, error: null };
    return { stage, state: 'unknown', at: null, by: null, kind: null, error: null };
  });
}

/** What a live run (Test or the daily check) found, as the smoke test reports it. */
export interface LiveRun {
  passed: readonly Stage[];
  failure?: { stage: Stage; kind: FailKind | 'timeout'; error?: string } | null;
}

/**
 * The per-stage patch a live run writes. Passed stages get their success; the failing stage gets its failure;
 * stages the run never reached are left exactly as they were.
 *
 * ⚠️ Two things it must never write. `images`: the smoke test fetches no bytes, so a pass says nothing about
 * them. And a `timeout` failure: that is our own deadline, which proves nothing about the source (the reportSlow
 * lesson, sourceHealth.ts) -- the run is recorded as 'inconclusive' in live_state and the stage keeps whatever it
 * had. `since`, `streak` and a traffic failure's `failBy` are the writer's job, because they depend on what the
 * row holds at the moment of the write (sourceHealth.ts STAGE_MERGE).
 */
export function liveStagesPatch(run: LiveRun, by: 'test' | 'sweep', nowIso: string): Stages {
  const patch: Stages = {};
  for (const stage of run.passed) {
    if (stage === 'images') continue;
    patch[stage] = { okAt: nowIso, okBy: by, streak: 0 };
  }
  const f = run.failure;
  if (f && f.kind !== 'timeout' && f.stage !== 'images') {
    patch[f.stage] = { failAt: nowIso, failBy: by, error: (f.error ?? '').slice(0, 300) || null, kind: f.kind };
  }
  return patch;
}
