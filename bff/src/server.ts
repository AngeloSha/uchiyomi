import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import compress from '@fastify/compress';
import { env } from './env';
import { pool, q, one } from './lib/db';
import { runtime } from './lib/runtime';
import { reapStaleTemp } from './lib/fsAtomic';
import { DL_ROOT } from './lib/library';
import { migrate } from './lib/migrate';
import { loadSources, loadCustomSites, loadBuiltins, listSources, loadSuwayomiSources, scheduleSuwayomiRetry, suwayomiConfigured } from './lib/sources';
import { scheduleFingerprintBackfill } from './lib/fingerprintJob';
import { schedulePageHashBackfill } from './lib/pageHashJob';
import { solverHealth } from './lib/health';
import { notifyAdmins } from './lib/push';
import { runSourceCheck } from './lib/sourceWatchdog';
import { runSweep } from './lib/updater';
import { runExtensionMonitor } from './lib/extensionMonitor';
import { startSweeper } from './lib/imageCache';
import { runBackup, msUntilHour } from './lib/backup';
import { KomgaError } from './lib/komga';
import { ZodError } from 'zod';
import { registerWebRoot, webRootConfigured } from './lib/webRoot';
import { registerApiDocs } from './lib/apiDocs';
import { appVersion } from './lib/appVersion';
import { buildPayload, installFacts, sendPing } from './lib/installPing';
import authRoutes from './routes/auth';
import adminRoutes from './routes/admin';
import catalogRoutes from './routes/catalog';
import imageRoutes, { authorizeImageRequest } from './routes/images';
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

  // Byte-serving auth for the WHOLE /img/ prefix, at the root, so it cannot be opted out of.
  //
  // This guard used to be a preHandler inside imageRoutes. Fastify encapsulates hooks, so it covered only
  // the routes that plugin happened to register -- meaning the way to serve unauthenticated image bytes was
  // simply to add a new plugin. Registered here it applies to every /img/ route regardless of which plugin
  // owns it, and a plugin that forgets auth inherits it instead of escaping it.
  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/img/')) return;
    await authorizeImageRequest(app, req, reply);
  });

  await app.register(authRoutes);
  await app.register(adminRoutes);
  await app.register(catalogRoutes);
  await app.register(imageRoutes);
  await app.register(personalRoutes);
  await app.register(downloadRoutes);
  await app.register(sourceRoutes);
  await app.register(opdsRoutes);
  // The interactive API reference, BEFORE the web root: registerWebRoot installs the not-found handler that
  // serves the app shell for any unknown path, and a route added after it would still work, but its
  // static assets under /api/docs/ would not be found by the UI in the same way. Unauthenticated on
  // purpose -- every route name is already public in docs/api.md and the spec holds no secrets.
  await registerApiDocs(app);

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
        // The running flag, the stored result and the summary line all live in runSweep now, so the panel's
        // "Run now" button gets the same treatment as this tick -- and this tick can see the button's sweep.
        const run = runSweep({ maxNew: 5 }, app.log);
        if (run) await run;
        else app.log.info('updater: the previous sweep is still running, skipping this tick');
      } catch (e) {
        app.log.error(e as any);
      }
      setTimeout(tick, hours * 60 * 60 * 1000).unref();
    };
    // The first run used to wait a full interval after boot, so every deploy pushed the next sweep out by
    // six hours: three deploys in one day meant no scheduled sweep at all, measured. Now the first run is
    // scheduled for whatever remains of the interval since the last COMPLETED sweep (persisted, so it
    // survives the restart), with a ten-minute floor so a restart loop cannot turn into a flood and a booting
    // server answers readers before it starts fetching.
    void (async () => {
      let hours = 6;
      let last = 0;
      try {
        const s = await pool.query('SELECT updater_hours, updater_last_run FROM server_settings WHERE id = 1');
        hours = Math.min(168, Math.max(1, s.rows[0]?.updater_hours || 6));
        last = s.rows[0]?.updater_last_run ? new Date(s.rows[0].updater_last_run).getTime() : 0;
      } catch { /* settings row not readable yet — keep the defaults */ }
      const due = last + hours * 60 * 60 * 1000 - Date.now();
      const delay = Math.max(10 * 60 * 1000, due);
      app.log.info(`updater: first sweep in ${Math.round(delay / 60000)} min` + (last ? ` (last completed ${new Date(last).toISOString()})` : ' (no completed sweep on record)'));
      setTimeout(tick, delay).unref();
    })();
  }

  /**
   * The Cloudflare solver, watched rather than waited on.
   *
   * ⚠️ `solverHealth` is good and it was invisible. It ran ONLY when an admin opened the Health tab, so a
   * solver that died at two in the morning stayed dead until somebody happened to look — while every
   * Cloudflare-protected source failed and recorded the failure against itself, which is the exact confusion
   * that check was written to clear up.
   *
   * Hourly: it is one HTTP call to a container on the same network, and the thing it watches is a Chrome
   * process known to leak memory and crash mid-challenge.
   *
   * EDGE-TRIGGERED. A solver that is down stays down, and a notification every hour about it is not
   * information — the same reasoning as the extension monitor's refresh-failure push. Only a CHANGE is
   * announced, in both directions, so recovery is told too.
   * Reintroduce by pushing whenever the status is bad rather than when it changes: a solver that dies on
   * Friday sends 48 notifications by Sunday and the operator turns them off.
   */
  {
    const HOUR = 60 * 60 * 1000;
    let lastBad: boolean | null = null;
    const tick = async () => {
      try {
        const h = await solverHealth();
        const bad = h.status === 'problem' || h.status === 'warn';
        if (lastBad !== null && bad !== lastBad) {
          await notifyAdmins(
            bad ? 'Cloudflare solver needs attention' : 'Cloudflare solver recovered',
            h.summary,
            '/admin/',
            'solver',
          );
        }
        if (bad !== lastBad) app.log.info(`solver health: ${h.status} — ${h.summary}`);
        lastBad = bad;
      } catch (e) {
        // A failed check must not end the schedule; that would be the very outage it is here to notice.
        app.log.error(e as any);
      }
      setTimeout(tick, HOUR).unref();
    };
    setTimeout(tick, 10 * 60 * 1000).unref();
  }

  /**
   * The opt-in install count.
   *
   * ⚠️ THE FIRST THING THIS DOES IS CHECK CONSENT, EVERY TICK, FROM THE DATABASE. Not a value captured at
   * boot: an admin who turns it off must stop being counted without restarting the server, and reading the
   * flag at the top of each run is what makes the switch mean that. With it off, nothing here touches the
   * network at all -- there is no request to fail closed.
   *
   * Daily, and the first run waits an hour: nothing about this is urgent, and an install that is restarted
   * repeatedly (a crash loop, someone tuning their compose file) must not turn a headcount into a flood.
   * Sending at most one ping a day per install is also what makes the number mean "installs", not "boots".
   */
  {
    const DAY = 24 * 60 * 60 * 1000;
    const tick = async () => {
      try {
        const row = await one<{ on: boolean; secret: string | null; last: Date | null }>(
          'SELECT install_ping AS on, install_ping_secret AS secret, install_ping_last AS last FROM server_settings WHERE id = 1',
        ).catch(() => null);
        // No consent, or no secret because consent was never given: send nothing, say nothing.
        if (row?.on && row.secret) {
          const since = row.last ? Date.now() - new Date(row.last).getTime() : Infinity;
          if (since >= DAY - 60_000) {
            const ok = await sendPing(buildPayload(row.secret, installFacts(appVersion())));
            // Only a delivered ping moves the clock, so a collector that is down is retried tomorrow
            // rather than silently counted as done.
            if (ok) await q('UPDATE server_settings SET install_ping_last = now() WHERE id = 1');
          }
        }
      } catch (e) {
        app.log.error(e as any);
      }
      setTimeout(tick, DAY).unref();
    };
    setTimeout(tick, 60 * 60 * 1000).unref();
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
        app.log.info(`source check: ${r.sources.length} checked, ${r.needsAttention.length} need attention`);
      } catch (e) {
        app.log.error(e as any);
      }
      setTimeout(tick, DAY).unref();
    };
    setTimeout(tick, 10 * 60 * 1000).unref();
  }

  // Keep the installed extensions current with the repositories they came from.
  //
  // Its own schedule rather than a step in the watchdog above: that one is a daily, deliberately serial
  // scrape of every source at up to 45 seconds each, and this is one index download plus one list query.
  // Sharing a schedule would mean either running the expensive thing four times a day or catching an
  // upstream push a day late -- and upstream pushes roughly every fifteen hours.
  if (suwayomiConfigured()) {
    const tick = async () => {
      let hours = 6;
      try {
        const s = await pool.query('SELECT extension_hours FROM server_settings WHERE id = 1');
        hours = Math.min(168, Math.max(1, s.rows[0]?.extension_hours || 6));
        const run = runExtensionMonitor(app.log);
        if (run) await run;
        else app.log.info('extensions: the previous check is still running, skipping this tick');
      } catch (e) {
        app.log.error(e as any);
      }
      setTimeout(tick, hours * 60 * 60 * 1000).unref();
    };
    // Same reasoning as the sweep: schedule the REMAINDER of the interval since the last completed check, so
    // a deploy does not push the next one out by a full interval. The ten-minute floor also means a fresh
    // install sees its first check while someone is still watching, rather than six hours later.
    void (async () => {
      let hours = 6;
      let last = 0;
      try {
        const s = await pool.query('SELECT extension_hours, extension_last_run FROM server_settings WHERE id = 1');
        hours = Math.min(168, Math.max(1, s.rows[0]?.extension_hours || 6));
        last = s.rows[0]?.extension_last_run ? new Date(s.rows[0].extension_last_run).getTime() : 0;
      } catch { /* settings row not readable yet -- keep the defaults */ }
      const delay = Math.max(10 * 60 * 1000, last + hours * 60 * 60 * 1000 - Date.now());
      app.log.info(`extensions: first check in ${Math.round(delay / 60000)} min`);
      setTimeout(tick, delay).unref();
    })();
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

  // Abandoned half-writes from a previous life: a chapter or cache file whose rename never happened.
  void reapStaleTemp(DL_ROOT).then((n) => { if (n) app.log.info(`reaped ${n} half-written file(s) under ${DL_ROOT}`); });

  // Stop at a boundary, and say so. Before this there was no handler at all: `docker compose up -d` in the
  // middle of a sweep killed it mid-chapter, the job card polled a dead id, and nothing recorded that a run
  // had been interrupted rather than finished.
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.once(sig, () => {
      runtime.stopping = true;
      app.log.info(`${sig}: finishing the current chapter, then stopping`);
      void app.close().finally(() => process.exit(0));
      setTimeout(() => process.exit(0), 20_000).unref(); // never hang a shutdown on a slow site
    });
  }

  await app.listen({ host: '0.0.0.0', port: env.PORT });

  // Says which topology is running, so "why is / a 404" is answerable from `docker compose logs`.
  console.log(webRootConfigured()
    ? `[web] serving the app from ${process.env.WEB_ROOT} (single container)`
    : '[web] API only; the web app is served separately');

  // Content fingerprints for the library, filled in behind the server rather than during boot: it reads
  // every archive on disk, so putting it on the boot path would make start-up time grow with the size of
  // someone's library. Nothing reads the column yet, so not finishing is harmless.
  if (process.env.LIBRARY_BACKEND !== 'komga') scheduleFingerprintBackfill();

  // Page hashes, for skipping the pages that are not the story. Started later than the fingerprint job and
  // deliberately last: it decodes every page in the library, which is the heaviest thing this process ever
  // does. Nothing breaks while it is unfinished -- an un-hashed page is simply never skipped.
  if (process.env.LIBRARY_BACKEND !== 'komga') schedulePageHashBackfill();
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('Fatal:', e);
  process.exit(1);
});
