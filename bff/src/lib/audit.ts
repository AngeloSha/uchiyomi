// Append-only activity/audit log: logins, admin actions, downloads, blocks. Best-effort (never throws).
import type { FastifyRequest } from 'fastify';
import { q } from './db';

function clientIp(req?: FastifyRequest): string | null {
  if (!req) return null;
  const xff = (req.headers['x-forwarded-for'] as string) || '';
  return (xff.split(',')[0].trim() || req.ip || '').slice(0, 64) || null;
}

export async function logAudit(
  event: string,
  opts: { userId?: string | null; username?: string | null; detail?: unknown; req?: FastifyRequest } = {},
): Promise<void> {
  const ua = opts.req ? ((opts.req.headers['user-agent'] as string) || '').slice(0, 200) : null;
  await q(
    'INSERT INTO audit_log (user_id, username, event, detail, ip, user_agent) VALUES ($1,$2,$3,$4,$5,$6)',
    [opts.userId ?? null, opts.username ?? null, event, JSON.stringify(opts.detail ?? {}), clientIp(opts.req), ua],
  ).catch(() => {});
}

export const recentAudit = (limit = 100) =>
  q('SELECT id, at, user_id, username, event, detail, ip, user_agent FROM audit_log ORDER BY at DESC LIMIT $1', [Math.min(Math.max(limit, 1), 500)]);
