// Called inside the existing admin plugin; its requireAdmin hook authorizes both handlers.
import type { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { roleOf, userIdOf } from '../lib/auth';
import { seriesVisible, viewCtxFor } from '../lib/visibility';
import { logAudit } from '../lib/audit';
import { ART_MAX_BYTES } from '../lib/seriesArt';
import { changeTitleArt, normalizeTitleLogo, refreshTitleLogo, titleLogoFromUrl, TitleArtError, TITLE_STYLES } from '../lib/titleArt';

export async function changeTitleArtRoute(req: FastifyRequest, reply: FastifyReply) {
  const id = (req.params as { id: string }).id;
  const viewer = await viewCtxFor(userIdOf(req), roleOf(req));
  if (!(await seriesVisible(id, viewer))) return reply.code(404).send({ error: 'not_found' });
  const parsed = z.object({ kind: z.literal('logo'), mode: z.enum(['upload', 'url', 'reset', 'text', 'style']),
    dataUrl: z.string().optional(), url: z.string().optional(), style: z.enum(TITLE_STYLES).optional() }).strict().safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: 'bad_request' });
  const b = parsed.data;
  try {
    let change: Parameters<typeof changeTitleArt>[1];
    if (b.mode === 'upload') {
      const encoded = /^data:image\/[a-z0-9.+-]+;base64,([a-z0-9+/\s]*={0,2})$/i.exec(b.dataUrl ?? '');
      if (!encoded) throw new TitleArtError('bad_image', 400, 'Choose a readable image.');
      const bytes = Buffer.from(encoded[1], 'base64');
      if (bytes.length > ART_MAX_BYTES) return reply.code(413).send({ error: 'too_large' });
      change = { mode: 'upload', bytes: await normalizeTitleLogo(bytes) };
    } else if (b.mode === 'url') {
      if (!b.url) return reply.code(400).send({ error: 'no_url' });
      change = { mode: 'url', bytes: await titleLogoFromUrl(b.url) };
    } else if (b.mode === 'style') {
      if (!b.style) return reply.code(400).send({ error: 'bad_request' });
      change = { mode: 'style', style: b.style };
    } else change = { mode: b.mode };
    const titleArt = await changeTitleArt(id, change, viewer);
    await logAudit('series.title_art', { userId: userIdOf(req), detail: { id, mode: b.mode }, req });
    return { ok: true, titleArt };
  } catch (error) {
    if (error instanceof TitleArtError) {
      if (error.retryAfterMs) reply.header('retry-after', String(Math.ceil(error.retryAfterMs / 1000)));
      return reply.code(error.statusCode).send({ error: error.code, message: error.message });
    }
    throw error;
  }
}
export async function refreshTitleArtRoute(req: FastifyRequest, reply: FastifyReply) {
  const id = (req.params as { id: string }).id;
  try {
    const viewer = await viewCtxFor(userIdOf(req), roleOf(req));
    const titleArt = await refreshTitleLogo(id, viewer);
    await logAudit('series.title_art_refresh', { userId: userIdOf(req), detail: { id }, req });
    return { ok: true, status: titleArt?.status ?? 'disabled', titleArt };
  } catch (error) {
    if (error instanceof TitleArtError) {
      if (error.retryAfterMs) reply.header('retry-after', String(Math.ceil(error.retryAfterMs / 1000)));
      return reply.code(error.statusCode).send({ error: error.code, message: error.message });
    }
    throw error;
  }
}
