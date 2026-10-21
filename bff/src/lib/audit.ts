// Append-only activity/audit log: logins, admin actions, downloads, blocks. Best-effort (never throws).
import type { FastifyRequest } from 'fastify';
import { q } from './db';
// The one reading of the client's address (lib/clientAddr.ts): this file kept a copy of it, and two copies of the rule
// that decides who a visitor is can drift apart. clientIpHygiene.test.ts holds every other reader to it.
import { clientIp } from './clientAddr';

export async function logAudit(
  event: string,
  opts: { userId?: string | null; username?: string | null; detail?: unknown; req?: FastifyRequest } = {},
): Promise<void> {
  const ua = opts.req ? ((opts.req.headers['user-agent'] as string) || '').slice(0, 200) : null;
  await q(
    'INSERT INTO audit_log (user_id, username, event, detail, ip, user_agent) VALUES ($1,$2,$3,$4,$5,$6)',
    [opts.userId ?? null, opts.username ?? null, event, JSON.stringify(opts.detail ?? {}), opts.req ? clientIp(opts.req) : null, ua],
  ).catch(() => {});
}

const spacing = new Map<string, { at: number; swallowed: number }>();

/**
 * At most one audit row per `everyMs` for this key, counting what the row stands for -- the rule
 * lib/desktop.ts desktopFailAudit applies to the desktop handshake, here for refusals of callers with no signed-in
 * principal (the OIDC callback, v0.69.1). Returns the number of attempts to record, or null to write nothing. Key it
 * on a fixed kind, never on caller text or an address: a rotating X-Forwarded-For would otherwise mint a key per
 * request. `now` is a monotonic clock; one that went backwards counts as due.
 */
export function auditEvery(key: string, everyMs = 60_000, now: number = performance.now()): number | null {
  const t = spacing.get(key) ?? { at: Number.NEGATIVE_INFINITY, swallowed: 0 };
  const since = now - t.at;
  if (since >= 0 && since < everyMs) { t.swallowed++; spacing.set(key, t); return null; }
  spacing.set(key, { at: now, swallowed: 0 });
  return t.swallowed + 1;
}

/**
 * The refusal rows a caller with no account can cause. Only these are ever pruned: the rest of audit_log is read back
 * as evidence -- migrate.ts keeps a deliberately deleted chapter's tombstone held only while a series.chapters_delete
 * or series.delete_files row proves it, and lib/numbering.ts replays series.chapters_refetch picks -- so an age or
 * count prune over every row would let the next boot fetch deleted chapters again, and a flood push that proof out.
 */
const REFUSALS = ['login.fail', 'login.blocked', 'login.totp_fail', 'login.oidc_fail', 'login.desktop_fail'];

/** Keep the refusal history bounded: rows older than `days`, then any beyond the newest `keep`. Runs once a day. */
export async function pruneAudit(days = 180, keep = 50_000): Promise<void> {
  await q(`DELETE FROM audit_log WHERE event = ANY($1) AND at < now() - make_interval(days => $2)`, [REFUSALS, days]);
  await q(
    `DELETE FROM audit_log WHERE event = ANY($1)
        AND id <= (SELECT id FROM audit_log WHERE event = ANY($1) ORDER BY id DESC OFFSET $2 LIMIT 1)`,
    [REFUSALS, keep],
  );
}

export const recentAudit = (limit = 100) =>
  q('SELECT id, at, user_id, username, event, detail, ip, user_agent FROM audit_log ORDER BY at DESC LIMIT $1', [Math.min(Math.max(limit, 1), 500)]);
