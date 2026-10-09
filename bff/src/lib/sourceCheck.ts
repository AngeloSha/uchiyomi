// One live check of one source, shared by the admin's Test button and the daily check (#115, v0.49.0).
//
// The two used to be written twice, and had to be guarded against drifting apart (sourceWatchdog.test.ts: THE
// DROPPED VERDICT, the slow streak). They drifted anyway in the one way nobody guarded: neither recorded what it
// found where Health looks. Test wrote nothing at all; the sweep wrote a check_code nothing read. So "Manga Ball
// (EN)" failed its Test while Health said "All good". One function now runs the check, and one records it.
//
// What recording may touch is the whole design: the live_* columns and the per-stage evidence, never the cooldown
// (status, consecutive, blocked_until, last_error) and never checked_at -- see sourceHealth.ts recordLive.
import type { FastifyRequest } from 'fastify';
import { one } from './db';
import { logAudit } from './audit';
import { env } from '../env';
import type { SourceAdapter } from './sources/types';
import { smokeTest, probeBase, buildProbe, type SmokeResult } from './sourceProbe';
import { diagnose, currentError, type Diagnosis, type DiagnosisCode, type Probe } from './sourceDiagnosis';
import { recordLive, slowStreakNow, type SourceHealth } from './sourceHealth';
import { liveStagesPatch, type Stage } from './sourceEvidence';
import { scheduleHealthSummaryRefresh } from './healthSummary';

export interface LiveCheck {
  smoke: SmokeResult;
  probe: Probe;
  diagnosis: Diagnosis;
  state: SmokeResult['state'];
  /** Where it failed, when it did (or where it ran out of time). */
  stage: Stage | null;
  /** The last live verdict before this one, so the sweep can push only a NEW failure. Null: never checked. */
  prev: { state: string; stage: string | null; code: string | null } | null;
  /** In a cooldown right now. */
  blocked: boolean;
  disabled: boolean;
}

/**
 * Go and look at `src` right now, and say what is wrong with it. Records nothing: see recordLiveResult.
 * Separate so the sweep can follow a moved site first and record the outcome of that.
 */
export async function checkSourceLive(src: SourceAdapter, opts: { by: 'test' | 'sweep'; timeoutMs?: number }): Promise<LiveCheck> {
  // ⚠️ `slow_streak` must stay in this list: diagnose() reads it before any stored-error rule, and without the
  // column the streak reads as 0 and `too_slow` can never come out of a Test or the sweep (it did not, for two
  // releases; only Discover, via healthAll(), could say it). last_slow_at is what currentError() needs to tell
  // a stale error from a current one, and the live_* columns are the previous verdict.
  const h = await one<SourceHealth>(
    `SELECT source_id, status, consecutive, last_error, last_fail_at, last_ok_at, last_slow_at, blocked_until, disabled,
            empty_streak, last_empty_at, slow_streak, updated_at, live_state, live_stage, live_code FROM source_health WHERE source_id = $1`,
    [src.id],
  ).catch(() => null);
  // The site first, and without the solver: when the solver is the broken part, asking it tells us nothing.
  // This one request separates "moved", "refused" and "solver down" from each other. Not every adapter has a
  // `base` to probe this way -- Suwayomi/extension sources never do, since the engine, not this server, talks to
  // the site -- so `bare` stays undefined for those and the homepage-status rules simply do not apply.
  const bare = src.base ? await probeBase(src.base) : undefined;
  const smoke = await smokeTest(src, opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {});
  // The adapter's own result, its failing stage and whether it is solver-fronted are live evidence, and all of
  // them outrank a bare homepage request. ⚠️ Do not inline this as `bare && {...}`: that dropped `adapterOk`
  // for every extension source (issue #54's second half).
  const probe = buildProbe(bare, smoke, src);
  const diagnosis = diagnose(
    {
      status: h?.status ?? 'ok',
      // The live error, when there is one, arrives through the probe and beats anything stored; a stored one is
      // offered only while it is current (a success since makes it history).
      lastError: smoke.failure?.kind === 'error' ? null : currentError(h),
      consecutive: h?.consecutive ?? 0,
      lastOkAt: h?.last_ok_at ?? null,
      emptyStreak: h?.empty_streak ?? 0,
      blockedUntil: h?.blocked_until ?? null,
      // While somebody is still running into it: a streak nobody has added to in a day is history (v0.55.10).
      slowStreak: slowStreakNow(h),
      // The same budget Discover's latestPage runs out of, so the too_slow sentence names a real number.
      budgetMs: env.SOURCE_LATEST_TIMEOUT_MS,
      disabled: !!h?.disabled,
    },
    probe,
    src.base,
  );
  return {
    smoke,
    probe,
    diagnosis,
    state: smoke.state,
    stage: smoke.failure?.stage ?? null,
    prev: h?.live_state ? { state: h.live_state, stage: h.live_stage ?? null, code: h.live_code ?? null } : null,
    blocked: !!(h?.blocked_until && new Date(h.blocked_until).getTime() > Date.now()),
    disabled: !!h?.disabled,
  };
}

/**
 * Write what a live check found as evidence: live_* and the stages it reached. Never the cooldown, never
 * checked_at (the sweep writes that itself, as it always has). `code` may be overridden by a caller that acted
 * on the verdict (the sweep after following a move).
 */
export async function recordLiveResult(
  sourceId: string, r: Pick<LiveCheck, 'smoke' | 'state' | 'stage'> & { diagnosis: { code: DiagnosisCode } }, by: 'test' | 'sweep',
): Promise<void> {
  // A pass recorded over a failed smoke test (the sweep, after following a moved site and proving the new
  // address) writes the stages that passed and no failure.
  const run = r.state === 'pass' ? { passed: r.smoke.passed } : r.smoke;
  await recordLive(sourceId, {
    by,
    state: r.state,
    code: r.diagnosis.code,
    stage: r.state === 'pass' ? null : r.stage,
    detail: r.state === 'pass' ? null : r.smoke.failure?.error ?? null,
    checks: r.smoke.checks,
    patch: liveStagesPatch(run, by, new Date().toISOString()),
  });
  // The header's Health mark follows a Test, instead of waiting up to six hours for the server's own refresh.
  // During a sweep this asks nothing: the sweep holds the summary and refreshes it once, at its end
  // (sourceWatchdog.ts runSourceCheck; lib/healthSummary.ts has the rules, the repair's included).
  scheduleHealthSummaryRefresh();
}

/** Sources being Tested right now, by id: one Test of a source at a time, whoever asks. */
const testing = new Set<string>();

/**
 * Test one source now: the live check, recorded, and audited as `source.test`. POST /api/admin/sources/:id/test and
 * Fix everything's sources phase (v0.55.0, lib/autofix.ts, `via: 'autofix'`) both run it, so the two can never test
 * a source two ways -- and never at once: `busy` while a Test of that source is going. Clearing a block stays the
 * caller's decision (the route's `canClear`: it passed, and it is blocked).
 */
export async function testSource(
  src: SourceAdapter, o: { userId: string | null; req?: FastifyRequest; via?: 'autofix'; runId?: string },
): Promise<LiveCheck | 'busy'> {
  if (testing.has(src.id)) return 'busy';
  testing.add(src.id);
  try {
    // The same function the scheduled sweep runs, so the button and the schedule cannot disagree.
    const r = await checkSourceLive(src, { by: 'test' });
    await recordLiveResult(src.id, r, 'test');
    await logAudit('source.test', {
      userId: o.userId,
      detail: { source: src.id, ok: r.smoke.ok, code: r.diagnosis.code, state: r.state, stage: r.stage, ...(o.via ? { via: o.via, runId: o.runId } : {}) },
      req: o.req,
    });
    return r;
  } finally {
    testing.delete(src.id);
  }
}
