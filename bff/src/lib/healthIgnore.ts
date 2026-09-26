// Health findings an admin has chosen to ignore (v0.48.3).
//
// The owner: "there is no button to ignore this warning so it never repeats again". Every check recomputes its
// findings from live data on every run, so a gap nobody will ever fill, a source that is simply slow, a folder
// of someone's own -- each came back on every run, turned the page amber and brought the header's warning back.
//
// An ignored finding is not deleted and not hidden: it stays on its card, greyed, with "Stop ignoring". It stays
// quiet while everything it is about NOW was already part of what was ignored -- a gap that shrinks stays quiet,
// a newly missing chapter makes it a new finding -- and an ignore whose finding has been gone for a week is
// dropped, so a problem that went away and came back is news again. Ignoring means "don't tell me"; it never
// stops the repair from fixing the thing.
//
// Short chapters are not here: their "It's fine" already records exactly this judgement, and the repair reads it.
import { q } from './db';
import type { HealthItem } from './health';

/** The checks an admin can ignore findings of, and nothing else (the route's allow-list). */
export const IGNORABLE_CHECKS = ['chapter-gaps', 'chapter-failures', 'sources', 'frozen-series', 'duplicates', 'outliers', 'downloads-missing'] as const;
export type IgnorableCheck = (typeof IGNORABLE_CHECKS)[number];

/** A finding as a check reports it for ignoring: a stable key, and what it is about. */
export interface Finding { title: string; members: string[] }

interface IgnoreRow { members: Set<string>; at: string; by: string | null }

/**
 * What one run of the checks carries: the ignores as they stood when it began, and every finding it met (for
 * the route, which needs a finding's full member list, and for keeping ignores of findings still there alive).
 */
export interface IgnoreCtx {
  ign: Map<string, IgnoreRow>;
  found: Map<string, Finding>;
  /**
   * The checks that produced their whole list this run. Only their ignores are kept alive or forgotten: a check
   * that could not read its data reports nothing, and that must not read as "every finding went away".
   */
  ran: Set<string>;
}
export const noIgnores = (): IgnoreCtx => ({ ign: new Map(), found: new Map(), ran: new Set() });

/**
 * A gap is recorded as its runs, "13-40", not one entry per missing chapter: a single chapter numbered 9001 by
 * mistake makes a gap of nine thousand, on every run. What is ignored is covered while every missing run now lies
 * inside a run that was ignored -- a gap that shrinks, or splits because a chapter landed in the middle.
 */
const RANGE = /^(-?\d+(?:\.\d+)?)-(-?\d+(?:\.\d+)?)$/;
function parseRange(m: string): [number, number] | null {
  const r = RANGE.exec(m);
  return r ? [Number(r[1]), Number(r[2])] : null;
}
function covered(members: string[], row: Set<string>, ranges: boolean): boolean {
  if (!ranges) return members.every((m) => row.has(m));
  const held = [...row].map(parseRange).filter((x): x is [number, number] => !!x);
  return members.every((m) => {
    const r = parseRange(m);
    return !!r && held.some(([lo, hi]) => r[0] >= lo && r[1] <= hi);
  });
}
/** The checks whose members are runs of chapter numbers rather than names. */
const RANGED: ReadonlySet<string> = new Set(['chapter-gaps']);

const k = (check: string, key: string) => `${check}\u0000${key}`;

/** The ignores, once per run. A failed read is "nothing ignored": the page can never break on it. */
export async function loadIgnores(): Promise<IgnoreCtx> {
  const rows = await q<{ check_id: string; item_key: string; members: string[]; at: string; by: string | null }>(
    `SELECT i.check_id, i.item_key, i.members, i.at, u.username AS by
       FROM health_ignored i LEFT JOIN users u ON u.id = i.by_user`,
  ).catch(() => [] as Array<{ check_id: string; item_key: string; members: string[]; at: string; by: string | null }>);
  return {
    ign: new Map(rows.map((r) => [k(r.check_id, r.item_key), { members: new Set(r.members ?? []), at: new Date(r.at).toISOString(), by: r.by }])),
    found: new Map(),
    ran: new Set(),
  };
}

/**
 * Mark what was ignored and offer Ignore on the rest, on a check's FULL list, before it is cut to the page size:
 * a finding past the cut must still be ignorable, and its status must not count it.
 *
 * An ignored item becomes `info` (a statement, not a finding: the check's verdict leaves it out), carries when and
 * by whom, and offers only "Stop ignoring". Everything else with a key gets an Ignore chip, greyed rows included:
 * a gap the repair has already looked into turns amber again a week later, and that is exactly the one to silence.
 * Returns how many are ignored, for the summary.
 */
export function applyIgnores(
  check: IgnorableCheck, items: Array<HealthItem & { members?: string[] }>, ctx: IgnoreCtx,
  /** False when the check could not read everything it looks at: its ignores are then neither refreshed nor forgotten. */
  complete = true,
): number {
  if (complete) ctx.ran.add(check);
  let ignored = 0;
  for (const it of items) {
    if (!it.key) continue;
    const members = it.members ?? [];
    ctx.found.set(k(check, it.key), { title: it.title, members });
    delete it.members;
    const row = ctx.ign.get(k(check, it.key));
    if (row && covered(members, row.members, RANGED.has(check))) {
      ignored++;
      it.info = true;
      it.ignored = { at: row.at, by: row.by };
      it.actions = ['unignore'];
      it.detail = `${it.detail} · ignored ${row.at.slice(0, 10)}${row.by ? ` by ${row.by}` : ''}`;
    } else {
      it.actions = [...(it.actions ?? []), 'ignore'];
    }
  }
  return ignored;
}

/** The summary's tail for ignored findings: "; 2 ignored". */
export const ignoredTail = (n: number): string => (n ? `; ${n} ignored` : '');

/**
 * How long an ignore outlives its finding. A week, not a day: a source that is slow every few days is exactly what
 * someone ignores, and it must not come back each time it has one good day. A problem gone for a week and back
 * is news again.
 */
const FORGET_AFTER = '7 days';

/**
 * After a run: the ignores whose findings are still there are marked seen; one not seen for a day is dropped.
 * Best effort -- this is bookkeeping, and the report is already built.
 */
export async function keepIgnoresAlive(ctx: IgnoreCtx): Promise<void> {
  const still = [...ctx.ign.keys()].filter((key) => ctx.found.has(key)).map((key) => key.split('\u0000'));
  if (still.length) {
    await q(
      `UPDATE health_ignored i SET seen_at = now()
         FROM unnest($1::text[], $2::text[]) AS f(check_id, item_key)
        WHERE i.check_id = f.check_id AND i.item_key = f.item_key`,
      [still.map((x) => x[0]), still.map((x) => x[1])],
    ).catch(() => {});
  }
  // Only for checks that ran whole this time (IgnoreCtx.ran).
  if (ctx.ran.size) {
    await q(`DELETE FROM health_ignored WHERE check_id = ANY($1) AND seen_at < now() - interval '${FORGET_AFTER}'`, [[...ctx.ran]]).catch(() => {});
  }
}

/** Record an ignore: the finding's members as they are right now, which the route has just recomputed. */
export async function ignoreFinding(check: IgnorableCheck, key: string, f: Finding, userId: string | null): Promise<void> {
  await q(
    `INSERT INTO health_ignored (check_id, item_key, members, title, by_user, at, seen_at)
     VALUES ($1, $2, $3, $4, $5, now(), now())
     ON CONFLICT (check_id, item_key) DO UPDATE SET members = EXCLUDED.members, title = EXCLUDED.title,
       by_user = EXCLUDED.by_user, at = now(), seen_at = now()`,
    [check, key, f.members, f.title.slice(0, 300), userId],
  );
}

export async function unignoreFinding(check: IgnorableCheck, key: string): Promise<boolean> {
  const r = await q<{ check_id: string }>('DELETE FROM health_ignored WHERE check_id = $1 AND item_key = $2 RETURNING check_id', [check, key]);
  return r.length > 0;
}
