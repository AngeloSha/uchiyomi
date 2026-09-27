// Check the sources and extensions on a schedule, so a dead one is noticed by the server rather than by a
// reader wondering why a dot is grey.
//
// This exists because of a real six-week failure. Aqua Manga -- 189 of 215 series on the install this was
// written for -- had its domain quietly repurposed into an unrelated website. The adapter kept returning an
// empty list, which throws nothing, so nothing was ever recorded and the source went on reporting healthy.
// Two more sites had moved their listing path and failed the same silent way, one of them for months.
//
// What it will do on its own is deliberately narrow. A moved domain has exactly one correct answer and is
// verifiable before committing to it, so it is followed automatically. Everything else -- markup drift, a CDN
// refusing us, a dead host -- is reported and left alone, because "disable it" and "wait, it is a blip" look
// identical from here, and getting that wrong turns a two-hour outage into a source nobody notices is off.
//
// Extension updates used to be the second thing it did on its own. They are their own scheduled job now
// (lib/extensionMonitor.ts), because they need the engine's repositories re-read first -- which this never
// did, so it installed updates it could not see -- and because two schedulers with two busy flags can drive
// the same install mutation at once.
import { q } from './db';
import { getSource, listSources, reloadAll } from './sources';
import { readSites, writeSites } from './sources/customSites';
import { smokeTest } from './sourceProbe';
import { Diagnosis, STAGE_WORD } from './sourceDiagnosis';
import { clearBlock } from './sourceHealth';
import { checkSourceLive, recordLiveResult } from './sourceCheck';
import { holdSummaryWhile, refreshHealthSummaryNow } from './healthSummary';
import type { Stage } from './sourceEvidence';
import { notifyAdmins } from './push';
import { logAudit } from './audit';

export interface SourceVerdict {
  id: string;
  name: string;
  code: Diagnosis['code'];
  reason: string;
  fix: string;
  ok: boolean;
  /** pass / fail / inconclusive (our own deadline ended the test before anything failed). */
  state: 'pass' | 'fail' | 'inconclusive';
  /** Where it failed, or ran out of time; null on a pass. */
  stage: Stage | null;
  kind: string | null;
  actor: Diagnosis['actor'];
  /** What the watchdog changed by itself, if anything. */
  action?: 'followed-move';
}

export interface WatchdogResult {
  checkedAt: string;
  sources: SourceVerdict[];
  /** Verdicts an operator needs to act on: every confirmed live failure that waiting will not fix, and moves. */
  needsAttention: SourceVerdict[];
  /** Tests our own deadline cut short: shown, never counted as failing, never pushed. */
  inconclusive: SourceVerdict[];
  /** The ids pushed to admins this run: failures that are new, or failing somewhere new, since the last check. */
  notified: string[];
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
 * One sweep: probe every enabled source, diagnose it, fix what is safe to fix, report the rest.
 *
 * Sources are checked one at a time on purpose. Each check is a real scrape of a real site and several of
 * them share one Cloudflare solver; running forty at once is how you turn a health check into the thing
 * that makes everything unhealthy.
 */
let running = false;
/** True while a sweep is in flight, so the schedule and the admin button cannot overlap. */
export const checkRunning = (): boolean => running;
// A sweep is ONE refresh of the header's summary, at its end: nothing a source records asks for one meanwhile.
// Reintroduce by dropping this: "the header Health mark is refreshed once for a whole sweep" in
// sourceCheck.int.test.ts counts a refresh per source.
holdSummaryWhile(checkRunning);

/**
 * Where the current (or last) sweep is, for "Check all now" (#115). The button used to hold one request open
 * for the whole sweep -- forty sources at up to 45 s each is half an hour behind a reverse proxy that cuts
 * it at one minute -- so the route now starts the sweep and answers at once, and the page reads this. In
 * memory: the last result is the one this process produced, and a restart forgets it (the evidence each
 * check recorded does not depend on it: Health reads source_health).
 */
export interface CheckProgress {
  running: boolean;
  /** 'schedule' for the daily run, 'admin' for the button. */
  by: 'schedule' | 'admin' | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** Sources this sweep will look at (the enabled ones), and how many it has finished. */
  total: number;
  done: number;
  /** The source being tested now. */
  current: { id: string; name: string } | null;
  /** The finished sweep's answer, kept until the next one starts. */
  result: WatchdogResult | null;
  error: string | null;
}
let progress: CheckProgress = {
  running: false, by: null, startedAt: null, finishedAt: null, total: 0, done: 0, current: null, result: null, error: null,
};
export const checkProgress = (): CheckProgress => ({ ...progress, current: progress.current && { ...progress.current } });

export async function runSourceCheck(opts: { autoFix?: boolean; by?: 'schedule' | 'admin' } = {}): Promise<WatchdogResult> {
  if (running) throw Object.assign(new Error('a source check is already running'), { busy: true });
  running = true;
  progress = {
    running: true, by: opts.by ?? 'schedule', startedAt: new Date().toISOString(), finishedAt: null,
    total: 0, done: 0, current: null, result: null, error: null,
  };
  try {
    const r = await sweep(opts);
    progress = { ...progress, result: r };
    return r;
  } catch (e) {
    progress = { ...progress, error: (e as Error)?.message || 'the check failed' };
    throw e;
  } finally {
    // The header's Health mark, once for the whole sweep (nothing it recorded asked for one), and BEFORE the sweep
    // says it is over: "Check all now" refetches the summary the moment it reads `running: false`, and not again
    // for a minute, so a refresh that came after would leave the header on the pre-sweep summary. Under the repair
    // flag it is put off instead (lib/healthSummary.ts). Reintroduce by flipping `running` first and refreshing
    // detached: "the header's mark is fresh by the time the sweep says it ended" in sourceCheck.int.test.ts.
    await refreshHealthSummaryNow();
    running = false;
    progress = { ...progress, running: false, current: null, finishedAt: new Date().toISOString() };
  }
}

/**
 * Start a sweep and return without waiting for it: the "Check all now" button. False when one is already
 * running. `onDone` runs after it finishes (the route's audit line); a failed sweep is left in checkProgress().
 */
export function startSourceCheck(opts: { autoFix?: boolean; by?: 'schedule' | 'admin' } = {}, onDone?: (r: WatchdogResult) => unknown): boolean {
  if (running) return false;
  void runSourceCheck(opts).then((r) => onDone?.(r)).catch(() => {});
  return true;
}

async function sweep(opts: { autoFix?: boolean }): Promise<WatchdogResult> {
  const autoFix = opts.autoFix !== false;
  const verdicts: SourceVerdict[] = [];
  const prevOf = new Map<string, { state: string; stage: string | null; code: string | null } | null>();

  const disabled = new Set(
    (await q<{ source_id: string }>('SELECT source_id FROM source_health WHERE disabled = true').catch(() => [] as { source_id: string }[]))
      .map((r) => r.source_id),
  );
  // switched off deliberately; not a fault to report
  const sources = listSources().filter((s) => !disabled.has(s.id));
  progress = { ...progress, total: sources.length };

  for (const src of sources) {
    progress = { ...progress, current: { id: src.id, name: src.name } };
    try {
      // The Test button runs the same function, so the schedule and the button cannot disagree about a source.
      const r = await checkSourceLive(src, { by: 'sweep' });
      if (r.disabled) continue;
      prevOf.set(src.id, r.prev);
      let d = r.diagnosis;
      let state = r.state;

      let action: SourceVerdict['action'] | undefined;
      if (autoFix && d.code === 'moved' && r.probe?.finalUrl && await followMove(src.id, r.probe.finalUrl)) {
        action = 'followed-move';
        d = { ...d, code: 'ok', reason: '', fix: '', silent: false, needsProbe: false, actor: 'none' };
        // followMove proved the new address with a passing smoke test before keeping it.
        state = 'pass';
      }

      // Evidence first (live_* and the stages), then the stamp the schedule reads. ⚠️ check_code is the live-aware
      // code now: diagnose() never answers 'ok' under a failed smoke test, which is what the old code wrote.
      await recordLiveResult(src.id, { smoke: r.smoke, state, stage: r.stage, diagnosis: d }, 'sweep');
      await q(
        `INSERT INTO source_health (source_id, checked_at, check_code, updated_at)
         VALUES ($1, now(), $2, now())
         ON CONFLICT (source_id) DO UPDATE SET checked_at = now(), check_code = $2, updated_at = now()`,
        [src.id, d.code],
      ).catch(() => {});

      verdicts.push({
        id: src.id, name: src.name, code: d.code, reason: d.reason, fix: d.fix, ok: state === 'pass', state,
        stage: state === 'pass' ? null : r.stage, kind: state === 'pass' ? null : r.smoke.failure?.kind ?? null,
        actor: d.actor, action,
      });
    } finally {
      progress = { ...progress, done: progress.done + 1 };
    }
  }

  // Every confirmed live failure, not a list of codes someone thought actionable: the old ACTIONABLE set left
  // out 'unknown', so a source failing its test with an error nobody had seen before was "All sources healthy".
  // A rate limit ('wait') is the one thing that clears itself; a moved site is always worth saying.
  const needsAttention = verdicts.filter((v) => (v.state === 'fail' && v.actor !== 'wait') || v.code === 'moved');
  const inconclusive = verdicts.filter((v) => v.state === 'inconclusive');

  // ONE push per new failure, not one a day. Health and the header keep saying it until someone acts; a push
  // repeating the same news every morning is noise that teaches an admin to dismiss them.
  const toNotify = needsAttention.filter((v) => {
    const p = prevOf.get(v.id);
    return !p || p.state !== 'fail' || p.stage !== v.stage || p.code !== v.code;
  });
  if (toNotify.length) {
    const lead = toNotify[0];
    const stageName = (v: SourceVerdict) => (v.stage ? STAGE_WORD[v.stage] : v.code === 'moved' ? 'moved' : 'the test');
    await notifyAdmins(
      toNotify.length === 1 ? `${lead.name} needs attention` : `${toNotify.length} sources need attention`,
      toNotify.length === 1
        ? `${lead.stage ? `${cap(STAGE_WORD[lead.stage])} fails: ` : ''}${lead.reason}`
        : toNotify.map((v) => `${v.name} (${stageName(v)})`).join(', '),
      '/admin/?tab=Health',
    ).catch(() => {});
  }

  return {
    checkedAt: new Date().toISOString(),
    sources: verdicts,
    needsAttention,
    inconclusive,
    notified: toNotify.map((v) => v.id),
  };
}

const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
