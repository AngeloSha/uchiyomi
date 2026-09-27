/**
 * Every library repair run, kept: the nightly and every Health press alike (v0.49.0).
 *
 * WHY IT EXISTS
 *   Until v0.49.0 a run left one trace besides the audit row: server_settings.repair_last_run and
 *   repair_last_result, written by EVERY run. A one-row "Fix" pressed at 23:00 therefore replaced the
 *   nightly's result on the Tasks line with "0 counted, 1 short looked at" -- and, because server.ts arms the
 *   first nightly after a restart from repair_last_run, it moved the nightly's schedule as well. Now only a
 *   FULL run (no `only`) writes those two columns, and every run, full or scoped, gets a row here, which is
 *   what the Health page reads for "Recent repairs", "last repair on this card" and "usually about 4 min".
 *
 *   The audit rows stay exactly as they were, for Activity. They carry only a summary string -- no timing,
 *   no skip reasons, and the nightly and a test both audit with a null user -- so they are not a history.
 *
 * ⚠️ This module holds the history's only DELETE (the prune), and it touches repair_runs alone.
 *   lib/repair.ts may not contain a DELETE at all: "the nightly cannot delete, merge or renumber anything"
 *   in repair.int.test.ts greps it, and extends the same scan to this file with a narrower rule.
 * ⚠️ Best effort, every call: history must never be the thing that fails a repair. Each writer catches and
 *   logs, exactly as logAudit and the failure ledger do.
 */
import { q } from './db';
import { getSource } from './sources';
import type { RepairStep, RepairResult } from './repair';

export type RunOrigin = 'nightly' | 'manual';
export type RunStatus = 'running' | 'done' | 'stopped' | 'failed' | 'skipped' | 'interrupted';

/** What a run was pointed at. `label` is resolved once, at the start, so the history never re-joins. */
export interface RunTarget {
  seriesId?: string;
  bookId?: string;
  sourceId?: string;
  now?: boolean;
  /** The chapter's number when the run is about one chapter (`label` is then its series title). */
  number?: number;
  /** A series title, or a source's display name. Absent for an untargeted run. */
  label?: string;
}

export interface RepairRunRecord {
  id: string;
  startedAt: number;
  finishedAt: number | null;
  origin: RunOrigin;
  /** Who pressed it, or null for the nightly (and for an account since deleted). */
  username: string | null;
  mine: boolean;
  kind: string;
  only: RepairStep[] | null;
  target: RunTarget;
  status: RunStatus;
  ms: number | null;
  stepMs: Partial<Record<RepairStep, number>> | null;
  result: RepairResult | null;
  notes: { replaced: string[]; confirmed: string[]; followed: string[]; upgraded: string[] } | null;
}

/** The history keeps at least this many rows, however old... */
export const HISTORY_KEEP = 50;
/** ...and everything younger than this. A row is pruned only when it is past BOTH. */
export const HISTORY_DAYS = 90;
/** How many finished runs of a kind make its "usually". */
const TYPICAL_OF = 5;
/** The history digests are re-read at most this often, or when a run finishes (which invalidates them). */
const MEMO_MS = 60_000;

type Opts = { only?: readonly string[] | null; seriesId?: string; bookId?: string; sourceId?: string; now?: boolean };

/**
 * The run's kind, which is what its "usually" is the median of. The three Health chips have names of their
 * own, because they are what an admin presses and compares; everything else is its steps, sorted, so the
 * same plan pressed twice is one kind whatever order the client listed them in.
 */
export function kindOf(opts: Opts): string {
  const only = [...new Set(opts.only ?? [])];
  if (!only.length) return 'full';
  if (only.length === 1) {
    if (only[0] === 'short' && opts.bookId) return 'fix_short';
    if (only[0] === 'gaps' && opts.seriesId) return 'fill';
    if (only[0] === 'failures' && opts.sourceId) return 'retry';
  }
  return `steps:${only.sort().join('+')}${opts.now ? ':now' : ''}`;
}

/**
 * A full run is the nightly's shape -- no `only` -- whoever started it (Tasks -> Run now is one too). Only a
 * full run owns the Tasks line and the nightly's schedule (server_settings.repair_last_*).
 */
export const isFullRun = (opts: Opts): boolean => !opts.only?.length;

/**
 * Whether the run can download a chapter at all. A run that cannot -- the solver reset, the page count, the
 * names, the directions, and the failures step without a source or `now` (it only resets ledger rows) -- is
 * still a Server task, but it must not turn the Library ring: every Health press starts a repair run, and a
 * ring that turns for a solver reset says the server is fetching when it is not.
 */
export function canDownload(opts: Opts): boolean {
  const only = opts.only ?? [];
  if (!only.length) return true;
  if (only.some((s) => s === 'short' || s === 'gaps' || s === 'groups')) return true;
  return only.includes('failures') && (!!opts.sourceId || !!opts.now);
}

/** The target as the run was asked for it, before its label is resolved. */
export const targetOf = (opts: Opts): RunTarget => ({
  ...(opts.seriesId ? { seriesId: opts.seriesId } : {}),
  ...(opts.bookId ? { bookId: opts.bookId } : {}),
  ...(opts.sourceId ? { sourceId: opts.sourceId } : {}),
  ...(opts.now ? { now: true } : {}),
});

const warn = (what: string) => (e: unknown) => console.warn(`[repair] history: ${what}: ${(e as Error)?.message || e}`);

/**
 * The name a person reads for the target: a chapter's series title (and its number), a series' title, a
 * source's display name. One query at most.
 */
async function labelled(target: RunTarget): Promise<RunTarget> {
  if (target.bookId) {
    const row = (await q<{ series_id: string; title: string; number: number }>(
      `SELECT b.series_id, s.title, b.number::float8 AS number
         FROM lib_books b JOIN lib_series s ON s.id = b.series_id WHERE b.id = $1`, [target.bookId],
    ).catch(() => []))[0];
    return row ? { ...target, seriesId: row.series_id, number: Number(row.number), label: row.title } : target;
  }
  if (target.seriesId) {
    const row = (await q<{ title: string }>('SELECT title FROM lib_series WHERE id = $1', [target.seriesId]).catch(() => []))[0];
    return row ? { ...target, label: row.title } : target;
  }
  if (target.sourceId) return { ...target, label: getSource(target.sourceId)?.name ?? target.sourceId };
  return target;
}

/**
 * A run starts: any row still `running` belongs to a process that died mid-run (one repair at a time, so it
 * cannot be a live one), and is closed as `interrupted`; then this run's row. Answers the target with its
 * label, which the caller puts on the live object and the run's card.
 */
export async function startRunRecord(run: {
  id: string; startedAt: number; origin: RunOrigin; kind: string; only: RepairStep[] | null; target: RunTarget; by: string | null;
}): Promise<RunTarget> {
  const target = await labelled(run.target).catch(() => run.target);
  await q(`UPDATE repair_runs SET status = 'interrupted', finished_at = COALESCE(finished_at, now())
            WHERE status = 'running' AND id <> $1`, [run.id]).catch(warn('closing an interrupted run'));
  // by_user through a sub-select: an id that names no account (a deleted one, or a test's) stores NULL
  // rather than failing the foreign key -- and the insert with it.
  await q(`INSERT INTO repair_runs (id, started_at, origin, kind, only_steps, target, by_user, status)
           VALUES ($1, to_timestamp($2 / 1000.0), $3, $4, $5, $6::jsonb,
                   (SELECT u.id FROM users u WHERE u.id::text = $7), 'running')`,
    [run.id, run.startedAt, run.origin, run.kind, run.only, JSON.stringify(target), run.by ?? ''],
  ).catch(warn('recording the start'));
  return target;
}

/** A run ends: its row, then the prune. Invalidates every digest below, so the next status read is fresh. */
export async function finishRunRecord(id: string, end: {
  status: RunStatus; ms: number | null; stepMs?: Partial<Record<RepairStep, number>> | null;
  result?: RepairResult | null; notes?: RepairRunRecord['notes'];
}): Promise<void> {
  await q(`UPDATE repair_runs SET finished_at = now(), status = $2, ms = $3, step_ms = $4::jsonb, result = $5::jsonb, notes = $6::jsonb
            WHERE id = $1`,
    [id, end.status, end.ms, end.stepMs ? JSON.stringify(end.stepMs) : null,
      end.result ? JSON.stringify(end.result) : null, end.notes ? JSON.stringify(end.notes) : null],
  ).catch(warn('recording the end'));
  await pruneRuns().catch(warn('pruning'));
  memo = null;
}

/**
 * At least HISTORY_KEEP rows and everything from the last HISTORY_DAYS days: a row goes only when it is past
 * both. A quiet install keeps its last fifty runs however old they are; a busy one keeps three months.
 */
export async function pruneRuns(): Promise<void> {
  await q(`DELETE FROM repair_runs
            WHERE started_at < now() - ($1 || ' days')::interval
              AND id NOT IN (SELECT id FROM repair_runs ORDER BY started_at DESC LIMIT $2)`,
    [String(HISTORY_DAYS), HISTORY_KEEP]);
}

type Row = {
  id: string; started_at: Date; finished_at: Date | null; origin: RunOrigin; username: string | null; mine: boolean;
  kind: string; only_steps: RepairStep[] | null; target: RunTarget | null; status: RunStatus; ms: number | null;
  step_ms: RepairRunRecord['stepMs']; result: RepairResult | null; notes: RepairRunRecord['notes'];
};
const toRecord = (r: Row): RepairRunRecord => ({
  id: r.id,
  startedAt: new Date(r.started_at).getTime(),
  finishedAt: r.finished_at ? new Date(r.finished_at).getTime() : null,
  origin: r.origin,
  username: r.username,
  mine: !!r.mine,
  kind: r.kind,
  only: r.only_steps,
  target: r.target ?? {},
  status: r.status,
  ms: r.ms,
  stepMs: r.step_ms,
  result: r.result,
  notes: r.notes,
});

/** The newest runs, or one by id. `me` decides `mine`; the account behind a run is never sent, only its name. */
export async function listRunRecords(opts: { limit?: number; id?: string; me?: string | null } = {}): Promise<RepairRunRecord[]> {
  const limit = Math.min(50, Math.max(1, Math.floor(opts.limit ?? 20)));
  const rows = await q<Row>(
    `SELECT r.id, r.started_at, r.finished_at, r.origin, u.username, (r.by_user IS NOT NULL AND r.by_user::text = $3) AS mine,
            r.kind, r.only_steps, r.target, r.status, r.ms, r.step_ms, r.result, r.notes
       FROM repair_runs r LEFT JOIN users u ON u.id = r.by_user
      WHERE ($2::text IS NULL OR r.id::text = $2)
      ORDER BY r.started_at DESC LIMIT $1`,
    [limit, opts.id ?? null, opts.me ?? ''],
  );
  return rows.map(toRecord);
}

export interface RunDigest {
  /** The five newest FINISHED runs: how a client learns that the run it started has ended, even a 5 ms one. */
  recent: Array<Pick<RepairRunRecord, 'id' | 'finishedAt' | 'status' | 'kind' | 'target'>>;
  /** The newest finished full run (the Tasks line's run), with who started it. */
  lastFull: { id: string; at: number; ms: number | null; origin: RunOrigin; result: RepairResult | null } | null;
  /** The newest finished scoped run: the Tasks row's "Latest one-off fix". */
  latestOther: Pick<RepairRunRecord, 'id' | 'kind' | 'target' | 'finishedAt' | 'status' | 'result'> | null;
  /** Per kind: the median of its last five finished `done` runs, and how many that is. */
  typical: Record<string, { typicalMs: number; runs: number }>;
  /** Per step: the median of its time inside the last untargeted runs. */
  stepTypicalMs: Partial<Record<RepairStep, number>>;
}

let memo: { at: number; digest: RunDigest } | null = null;

/** The middle value, or the mean of the two middle ones. */
export function median(ns: number[]): number | null {
  if (!ns.length) return null;
  const s = [...ns].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

/**
 * Everything the status route and the Tasks row read from the history, in three queries, memoised: the
 * status route is polled every two seconds while a run is going, and a history read per poll would be load
 * for nothing -- the history only changes when a run finishes, and finishRunRecord drops the memo then.
 */
export async function runDigest(now = Date.now()): Promise<RunDigest> {
  if (memo && now - memo.at < MEMO_MS) return memo.digest;
  const [recent, lastFull, latestOther, done] = await Promise.all([
    q<Row>(`SELECT id, finished_at, status, kind, target FROM repair_runs
             WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 5`).catch(() => [] as Row[]),
    q<Row>(`SELECT id, finished_at, ms, origin, result FROM repair_runs
             WHERE kind = 'full' AND finished_at IS NOT NULL AND status <> 'skipped' ORDER BY finished_at DESC LIMIT 1`).catch(() => [] as Row[]),
    q<Row>(`SELECT id, kind, target, finished_at, status, result FROM repair_runs
             WHERE kind <> 'full' AND finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1`).catch(() => [] as Row[]),
    q<{ kind: string; ms: number; step_ms: RepairRunRecord['stepMs']; target: RunTarget | null }>(
      `SELECT kind, ms, step_ms, target FROM (
         SELECT kind, ms, step_ms, target, row_number() OVER (PARTITION BY kind ORDER BY finished_at DESC) AS rn
           FROM repair_runs WHERE status = 'done' AND ms IS NOT NULL) x
        WHERE rn <= $1`, [TYPICAL_OF]).catch(() => []),
  ]);
  const byKind = new Map<string, number[]>();
  const bySteps = new Map<string, number[]>();
  for (const r of done) {
    if (!byKind.has(r.kind)) byKind.set(r.kind, []);
    byKind.get(r.kind)!.push(Number(r.ms));
    // A step's time inside a TARGETED run is one series' worth, not a step's: it would make "usually" for
    // the whole-library step read seconds. Only untargeted runs teach what a step costs.
    const t = r.target ?? {};
    if (t.seriesId || t.bookId || t.sourceId) continue;
    for (const [step, ms] of Object.entries(r.step_ms ?? {})) {
      if (typeof ms !== 'number') continue;
      if (!bySteps.has(step)) bySteps.set(step, []);
      if (bySteps.get(step)!.length < TYPICAL_OF) bySteps.get(step)!.push(ms);
    }
  }
  const typical: RunDigest['typical'] = {};
  for (const [kind, ms] of byKind) typical[kind] = { typicalMs: median(ms)!, runs: ms.length };
  const stepTypicalMs: RunDigest['stepTypicalMs'] = {};
  for (const [step, ms] of bySteps) stepTypicalMs[step as RepairStep] = median(ms)!;
  const f = lastFull[0];
  const o = latestOther[0];
  const digest: RunDigest = {
    recent: recent.map((r) => ({
      id: r.id, finishedAt: r.finished_at ? new Date(r.finished_at).getTime() : null, status: r.status, kind: r.kind, target: r.target ?? {},
    })),
    lastFull: f ? { id: f.id, at: new Date(f.finished_at!).getTime(), ms: f.ms, origin: f.origin, result: f.result } : null,
    latestOther: o ? {
      id: o.id, kind: o.kind, target: o.target ?? {}, finishedAt: new Date(o.finished_at!).getTime(), status: o.status, result: o.result,
    } : null,
    typical,
    stepTypicalMs,
  };
  memo = { at: now, digest };
  return digest;
}

/** For tests: forget the memo. */
export function clearRunDigest(): void { memo = null; }
