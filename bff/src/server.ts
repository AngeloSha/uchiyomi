import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import { env } from './env';
import { pool } from './lib/db';
import { runtime } from './lib/runtime';
import { migrate } from './lib/migrate';
import { loadSources, loadCustomSites, loadBuiltins, listSources } from './lib/sources';
import { runUpdateAll } from './lib/updater';
import { startSweeper } from './lib/imageCache';
import { KomgaError } from './lib/komga';
import authRoutes from './routes/auth';
import adminRoutes from './routes/admin';
import catalogRoutes from './routes/catalog';
import imageRoutes from './routes/images';
import personalRoutes from './routes/personal';
import downloadRoutes from './routes/downloads';
import sourceRoutes from './routes/sources';
import opdsRoutes from './routes/opds';

async function main() {
  await migrate();
  const bi = loadBuiltins(); // always-on built-ins bundled in the core (MangaDex)
  const ls = loadSources(); // bespoke source plugins from SOURCES_DIR (the optional pack)
  const cs = loadCustomSites(); // user-added engine sites from /config/sites.json (built via the in-core engines)
  console.log(`[sources] ${listSources().length} source(s) available (${bi} built-in, ${ls.loaded} pack, ${cs} custom)`);

  const app = Fastify({
    logger: { level: env.NODE_ENV === 'production' ? 'info' : 'debug' },
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
  });

  await app.register(helmet, { contentSecurityPolicy: false, crossOriginResourcePolicy: false });
  await app.register(cors, { origin: env.PUBLIC_ORIGIN, credentials: true });
  await app.register(cookie);
  await app.register(jwt, { secret: env.JWT_SECRET });
  await app.register(rateLimit, { global: false });

  app.get('/healthz', async (_req, reply) => {
    try {
      await pool.query('SELECT 1');
    } catch {
      return reply.code(503).send({ ok: false, db: false });
    }
    return { ok: true };
  });

  await app.register(authRoutes);
  await app.register(adminRoutes);
  await app.register(catalogRoutes);
  await app.register(imageRoutes);
  await app.register(personalRoutes);
  await app.register(downloadRoutes);
  await app.register(sourceRoutes);
  await app.register(opdsRoutes);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof KomgaError) {
      const code = err.status >= 400 && err.status < 600 ? err.status : 502;
      return reply.code(code).send({ error: 'komga', status: err.status });
    }
    const status = (err as any).statusCode || 500;
    if (status >= 500) req.log.error(err);
    return reply.code(status).send({ error: status >= 500 ? 'internal' : err.message || 'error' });
  });

  startSweeper();

  // Periodic new-chapter check (owned mode), self-rescheduling so the admin can change the interval live.
  if (process.env.LIBRARY_BACKEND === 'owned') {
    const tick = async () => {
      let hours = 6;
      try {
        const s = await pool.query('SELECT updater_hours FROM server_settings WHERE id = 1');
        hours = Math.min(168, Math.max(1, s.rows[0]?.updater_hours || 6));
        runtime.updating = true;
        const r = await runUpdateAll({ maxNew: 5 });
        runtime.lastUpdate = Date.now();
        runtime.lastUpdateResult = { series: r.series, added: r.added };
        app.log.info(`updater: +${r.added} chapters across ${r.series} series`);
      } catch (e) {
        app.log.error(e as any);
      } finally {
        runtime.updating = false;
      }
      setTimeout(tick, hours * 60 * 60 * 1000).unref();
    };
    // first run honors the configured interval too (a 1h setting shouldn't wait 6h after a reboot)
    void (async () => {
      let hours = 6;
      try {
        const s = await pool.query('SELECT updater_hours FROM server_settings WHERE id = 1');
        hours = Math.min(168, Math.max(1, s.rows[0]?.updater_hours || 6));
      } catch { /* settings row not readable yet — keep the 6h default */ }
      setTimeout(tick, hours * 60 * 60 * 1000).unref();
    })();
  }

  await app.listen({ host: '0.0.0.0', port: env.PORT });
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('Fatal:', e);
  process.exit(1);
});
