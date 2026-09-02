import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import compress from '@fastify/compress';
import { env } from './env';
import { pool } from './lib/db';
import { runtime } from './lib/runtime';
import { migrate } from './lib/migrate';
import { loadSources, loadCustomSites, loadBuiltins, listSources, loadSuwayomiSources, scheduleSuwayomiRetry } from './lib/sources';
import { scheduleFingerprintBackfill } from './lib/fingerprintJob';
import { runSourceCheck } from './lib/sourceWatchdog';
import { runUpdateAll } from './lib/updater';
import { startSweeper } from './lib/imageCache';
import { runBackup, msUntilHour } from './lib/backup';
import { KomgaError } from './lib/komga';
import { ZodError } from 'zod';
import { registerWebRoot, webRootConfigured } from './lib/webRoot';
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
  // Extension sources from an optional Suwayomi server. Fails soft: unset or unreachable just means none.
  const sw = await loadSuwayomiSources();
  const swNote = sw.configured ? `, ${sw.registered} extension${sw.reachable ? '' : ' (engine still starting)'}` : '';
  // The engine is a JVM and is usually still booting when we get here, so keep trying in the background
  // rather than leaving the feature switched off until someone notices and reloads.
  if (sw.configured && !sw.reachable) scheduleSuwayomiRetry();
  console.log(`[sources] ${listSources().length} source(s) available (${bi} built-in, ${ls.loaded} pack, ${cs} custom${swNote})`);

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
  /**
   * The single-container layout has no nginx in front of it, and nginx was the only thing compressing
   * anything: `gzip_types text/css application/javascript application/json image/svg+xml
   * application/manifest+json` with `gzip_min_length 1024` (web/nginx.conf:30-32). Without this, the
   * all-in-one image ships 736 KB of JS and CSS on a cold load where the split layout shipped 261 KB, and
   * every API response goes out uncompressed too -- `application/json` was in that list.
   *
   * No explicit type list: the plugin compresses whatever mime-db marks compressible, which is a superset
   * of nginx's five and includes text/html, which nginx only covered implicitly. Brotli is offered first
   * and is something nginx never had here at all -- `nginx:1.27-alpine` ships no brotli module.
   *
   * `@fastify/compress` also sets `Vary: Accept-Encoding`, which nginx did NOT: it ran `gzip on` with no
   * `gzip_vary`, so a shared cache in front of it could hand a gzipped body to a client that never asked
   * for one. This is parity plus that fix.
   */
  // The threshold only bites on buffered replies, which is nearly all of the API: static files are streamed
  // by @fastify/static with no Content-Length, so those are compressed whatever their size. nginx skipped
  // anything under 1 KB; the difference is a few bytes of gzip framing on the handful of tiny assets.
  await app.register(compress, { threshold: 1024, encodings: ['br', 'gzip', 'deflate'] });

  /**
   * Liveness, deliberately separate from readiness.
   *
   * `/healthz` below runs `SELECT 1`, which is the right answer for "should traffic be sent here" and the
   * wrong one for a container healthcheck: in the split layout nginx answered /healthz itself and stayed
   * healthy through a database outage, still serving the shell so the app could render an error. Pointing
   * the Docker healthcheck at a database probe means one Postgres blip marks the whole app unhealthy.
   */
  app.get('/livez', async () => ({ ok: true }));

  app.get('/healthz', async (_req, reply) => {
    try {
      await pool.query('SELECT 1');
    } catch {
      return reply.code(503).send({ ok: false, db: false });
    }
    return { ok: true };
  });

  // BEFORE the routes, not after. Fastify resolves a route's error handler from the encapsulation context
  // that existed when the route was registered, and every `await app.register(...)` below loads immediately.
  // Set afterwards, this whole function was dead: routes fell through to Fastify's default handler, which
  // replies with the raw `err.message`. So the sanitising branch never sanitised anything, and a failed
  // `schema.parse()` returned 500 with the entire ZodError -- field names, expected types and all -- to any
  // client that sent a malformed body.
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof KomgaError) {
      const code = err.status >= 400 && err.status < 600 ? err.status : 502;
      return reply.code(code).send({ error: 'komga', status: err.status });
    }
    // A schema rejection is the client's mistake, not the server's. Most routes use safeParse and answer
    // 400 themselves; the ones that call .parse() throw, and without this they answered 500.
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: 'bad_request',
        fields: err.issues.map((i) => i.path.join('.')).filter(Boolean),
      });
    }
    const status = (err as any).statusCode || 500;
    if (status >= 500) req.log.error(err);
    // fastify 5 types the handler's error as unknown, so the message needs the same narrowing statusCode gets
    return reply.code(status).send({ error: status >= 500 ? 'internal' : (err as Error).message || 'error' });
  });

  await app.register(authRoutes);
  await app.register(adminRoutes);
  await app.register(catalogRoutes);
  await app.register(imageRoutes);
  await app.register(personalRoutes);
  await app.register(downloadRoutes);
  await app.register(sourceRoutes);
  await app.register(opdsRoutes);

  // The web app, when it is packaged into this image. Registered after every API route so a path collision
  // can only ever go the safe way. Unset WEB_ROOT and this is a no-op: nginx keeps serving it as before.
  await registerWebRoot(app);

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
        runtime.lastUpdateResult = { series: r.series, visited: r.visited, added: r.added, failed: r.failed, chapterFailures: r.chapterFailures, healthy: r.healthy, stopped: r.stopped };
        // A sweep that added nothing because nothing was new, and one that added nothing because every source
        // was down, used to print the identical line. They no longer do. Nor does a sweep that finished look
        // like one the budget or the disk cut short.
        const scope = `visited ${r.visited} of ${r.series} series${r.stopped ? ` (stopped: ${r.stopped})` : ''}`;
        if (r.healthy) app.log.info(`updater: +${r.added} chapters, ${scope}`);
        else app.log.warn(
          `updater: +${r.added} chapters, ${scope}, but ${r.failed} series failed to answer` +
          `${r.chapterFailures ? ` and ${r.chapterFailures} chapters could not be saved` : ''} ` +
          `(${Object.entries(r.outcomes).filter(([, n]) => n).map(([k, n]) => `${k}=${n}`).join(' ')})`,
        );
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

  /**
   * Daily source watchdog.
   *
   * A source that dies quietly stays dead: it answers with an empty list, throws nothing, records nothing,
   * and keeps reporting healthy. One install ran six weeks that way after its main site's domain was
   * repurposed into an unrelated website, and only noticed because the dots on Discover looked wrong.
   *
   * Daily rather than hourly because each sweep genuinely scrapes every source, and they share one
   * Cloudflare solver. The first run waits ten minutes so a restart loop cannot turn this into a flood, and
   * so a server that has just booted is answering readers before it starts checking itself.
   */
  {
    const DAY = 24 * 60 * 60 * 1000;
    const tick = async () => {
      try {
        const r = await runSourceCheck();
        app.log.info(
          `source check: ${r.sources.length} checked, ${r.needsAttention.length} need attention` +
          (r.extensionsUpdated.length ? `, ${r.extensionsUpdated.length} extension(s) updated` : ''),
        );
      } catch (e) {
        app.log.error(e as any);
      }
      setTimeout(tick, DAY).unref();
    };
    setTimeout(tick, 10 * 60 * 1000).unref();
  }

  // Nightly backup, aligned to a wall-clock hour and re-read from settings each run so it stays live-editable.
  {
    const backupTick = async () => {
      try {
        runtime.backingUp = true;
        const r = await runBackup();
        runtime.lastBackup = Date.now();
        runtime.lastBackupResult = { bytes: r.bytes, ms: r.ms, configEmpty: r.configEmpty, sizeUnknown: r.sizeUnknown };
        app.log.info(`backup: ${(r.bytes / 1024 / 1024).toFixed(1)} MB in ${r.ms}ms -> ${r.dir}`);
      } catch (e) {
        app.log.error(e as any);
      } finally {
        runtime.backingUp = false;
      }
      setTimeout(backupTick, await nextBackupDelay()).unref();
    };
    const nextBackupDelay = async (): Promise<number> => {
      let hour = 3;
      try {
        const s = await pool.query('SELECT backup_hour FROM server_settings WHERE id = 1');
        const h = Number(s.rows[0]?.backup_hour);
        if (Number.isInteger(h) && h >= 0 && h <= 23) hour = h;
      } catch { /* settings not readable yet — keep 03:00 */ }
      return msUntilHour(hour);
    };
    void (async () => { setTimeout(backupTick, await nextBackupDelay()).unref(); })();
  }

  await app.listen({ host: '0.0.0.0', port: env.PORT });

  // Says which topology is running, so "why is / a 404" is answerable from `docker compose logs`.
  console.log(webRootConfigured()
    ? `[web] serving the app from ${process.env.WEB_ROOT} (single container)`
    : '[web] API only; the web app is served separately');

  // Content fingerprints for the library, filled in behind the server rather than during boot: it reads
  // every archive on disk, so putting it on the boot path would make start-up time grow with the size of
  // someone's library. Nothing reads the column yet, so not finishing is harmless.
  if (process.env.LIBRARY_BACKEND === 'owned') scheduleFingerprintBackfill();
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('Fatal:', e);
  process.exit(1);
});
