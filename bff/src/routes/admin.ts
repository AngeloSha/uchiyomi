import { hash } from '@node-rs/argon2';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { q, one, tx } from '../lib/db';
import { content as komga } from '../lib/backend';
import { cacheBytes } from '../lib/imageCache';
import { runtime } from '../lib/runtime';
import { persistScan } from '../lib/library';
import { deleteSeries, restoreSeries, mergeSeries, getSeriesRow, deleteSeriesFiles, renameSeriesFolder } from '../lib/libraryAdmin';
import { runFingerprintBackfill, fingerprintRemaining, fpState } from '../lib/fingerprintJob';
import { runBackup } from '../lib/backup';
import { runUpdateAll, updateSeries } from '../lib/updater';
import { authenticate, requireAdmin, userIdOf, revokeAllSessions, revokeRefreshTokenById, passwordError } from '../lib/auth';
import { logAudit, recentAudit } from '../lib/audit';
import { healthAll, setDisabled, clearBlock } from '../lib/sourceHealth';
import { reloadAll, listSources, getSource, detectEngine, listRemoteSources, suwayomiConfigured, suwayomiAbout, swAdapterId } from '../lib/sources';
import { listExtensions, refreshExtensions, setExtensionState, sourcesOfExtension, getRepos, setRepos, normalizeRepoUrl, altRepoUrl } from '../lib/sources/suwayomi/extensions';
import { readFile, writeFile, mkdir, rm } from 'fs/promises';
import { dirname } from 'path';
import sharp from 'sharp';
import { ART_DIR, artFile, artOverview } from '../lib/seriesArt';
import { writePreflight } from '../lib/fsGuard';
// Admin stats report on the whole library by definition; this route is already behind requireAdmin.
import { SYSTEM_CTX, visibleToAll } from '../lib/visibility';
import { addSeriesFromSource, findBestMatch, norm } from './sources';
import { titlesFromBackup } from '../lib/tachibk';
import { linkSeries } from '../lib/trackers';
import { runHealthChecks } from '../lib/health';
import { titlesFromMangadexList } from '../lib/mangadexList';
import { fetchAniListArt, fetchAniListCandidates, fetchAnimeBanner } from '../lib/anilist';
import { fetchKitsuBanner } from '../lib/kitsu';
import { randomBytes } from 'crypto';

type ImportJob = { running: boolean; total: number; done: number; added: number; already: number; notFound: number; failed: number; startedAt: number; details: Array<{ title: string; status: string; source?: string }> };
let importJob: ImportJob | null = null;

type ArtJob = { running: boolean; total: number; done: number; banners: number; covers: number; misses: number; startedAt: number };
let artJob: ArtJob | null = null;
// per-series "check for new chapters" runs, so the UI can poll instead of blocking on a long download
const seriesChecks = new Map<string, { running: boolean; added?: number; error?: string; startedAt?: number; finishedAt?: number }>();

export default async function adminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);
  app.addHook('preHandler', requireAdmin);

  // Owned-library scan (Phase 1): walk the CBZ folder and upsert lib_series/lib_books.
  app.post('/api/admin/library/scan', async () => persistScan());

  // Owned downloader/updater (Phase 2): pull new chapters from the source for one series or the whole library.
  app.post('/api/admin/update/:id', async (req) => updateSeries((req.params as { id: string }).id, Number((req.body as any)?.maxNew) || 10));
  app.post('/api/admin/update', async (req) => runUpdateAll({ onlyFavorites: !!(req.body as any)?.favorites, maxNew: Number((req.body as any)?.maxNew) || 10 }));

  app.get('/api/admin/users', async () => ({
    content: await q(`SELECT u.id, u.username, u.display_name, u.role, u.avatar, u.created_at, u.disabled, u.perms, u.totp_enabled,
        u.max_age_rating,
        (SELECT max(created_at) FROM reading_events e WHERE e.user_id = u.id) AS last_active,
        -- NULL, not an empty array, when unrestricted: the UI must tell "every library, including ones
        -- added later" apart from "exactly these", and an empty array is a real setting meaning nothing.
        (SELECT array_agg(ul.library_id) FROM user_libraries ul WHERE ul.user_id = u.id) AS libraries
      FROM users u ORDER BY u.created_at`),
  }));

  // ---- server settings ----
  app.get('/api/admin/settings', async () => one('SELECT server_name, allow_registration, updater_hours FROM server_settings WHERE id = 1'));
  app.patch('/api/admin/settings', async (req) => {
    const b = z.object({ serverName: z.string().min(1).max(64).optional(), allowRegistration: z.boolean().optional(), updaterHours: z.number().int().min(1).max(168).optional() }).parse(req.body);
    if (b.serverName !== undefined) await q('UPDATE server_settings SET server_name = $1, updated_at = now() WHERE id = 1', [b.serverName]);
    if (b.allowRegistration !== undefined) await q('UPDATE server_settings SET allow_registration = $1, updated_at = now() WHERE id = 1', [b.allowRegistration]);
    if (b.updaterHours !== undefined) await q('UPDATE server_settings SET updater_hours = $1, updated_at = now() WHERE id = 1', [b.updaterHours]);
    await logAudit('settings.update', { userId: userIdOf(req), detail: b, req });
    return one('SELECT server_name, allow_registration, updater_hours FROM server_settings WHERE id = 1');
  });

  // ---- scheduled tasks ----
  app.get('/api/admin/tasks', async () => {
    const s = await one<{ updater_hours: number; backup_hour: number; backup_last_run: string | null; backup_last_result: any }>(
      'SELECT updater_hours, backup_hour, backup_last_run, backup_last_result FROM server_settings WHERE id = 1',
    );
    // the backup's last run is persisted, so prefer the DB value over the in-memory one (which resets on restart)
    const backupLast = runtime.lastBackup || (s?.backup_last_run ? new Date(s.backup_last_run).getTime() : null);
    return { content: [
      { id: 'scan', name: 'Library scan', schedule: 'on demand', lastRun: runtime.lastScan || null, running: false },
      { id: 'update', name: 'Check for new chapters', schedule: `every ${s?.updater_hours ?? 6}h`, lastRun: runtime.lastUpdate || null, lastResult: runtime.lastUpdateResult, running: runtime.updating },
      { id: 'backup', name: 'Backup database & config', schedule: `daily at ${String(s?.backup_hour ?? 3).padStart(2, '0')}:00`, lastRun: backupLast, lastResult: runtime.lastBackupResult ?? s?.backup_last_result ?? null, running: runtime.backingUp },
      {
        id: 'fingerprint',
        name: 'Fingerprint library files',
        schedule: 'once, in the background',
        lastRun: fpState.finishedAt,
        lastResult: fpState.finishedAt ? { done: fpState.done, failed: fpState.failed, ms: fpState.ms } : null,
        running: fpState.running,
        remaining: await fingerprintRemaining().catch(() => null),
      },
    ] };
  });
  app.post('/api/admin/tasks/:id/run', async (req) => {
    const { id } = req.params as { id: string };
    await logAudit('task.run', { userId: userIdOf(req), detail: { task: id }, req });
    if (id === 'scan') return { ok: true, ...(await persistScan()) };
    if (id === 'update') { runUpdateAll({ maxNew: 10 }).then((r) => { runtime.lastUpdate = Date.now(); runtime.lastUpdateResult = { series: r.series, added: r.added }; }).catch(() => {}); return { ok: true, started: true }; }
    if (id === 'fingerprint') {
      if (fpState.running) return { ok: false, error: 'busy' };
      // never awaited: on a large library this is minutes, and the caller is an admin clicking a button
      runFingerprintBackfill().catch(() => {});
      return { ok: true, started: true };
    }
    if (id === 'backup') {
      if (runtime.backingUp) return { ok: false, error: 'busy' };
      runtime.backingUp = true;
      runBackup()
        .then((r) => { runtime.lastBackup = Date.now(); runtime.lastBackupResult = { bytes: r.bytes, ms: r.ms }; })
        .catch(() => {})
        .finally(() => { runtime.backingUp = false; });
      return { ok: true, started: true };
    }
    return { ok: false };
  });

  // ---- audit / activity feed ----
  app.get('/api/admin/audit', async (req) => ({ content: await recentAudit(Number((req.query as any)?.limit) || 150) }));

  // reload source plugins from SOURCES_DIR (after dropping in / updating a source pack) — no restart needed
  app.post('/api/admin/sources/reload', async (req) => {
    const r = await reloadAll(); // rescan pack + re-add built-ins, config sites and extension sources
    await logAudit('source.reload', { userId: userIdOf(req), detail: r, req });
    return { ok: true, ...r, available: listSources().length };
  });

  // ---- custom "template" sites (Madara/Manganato added by name+URL, no code). The core only reads/writes
  // a JSON file; the source pack's custom plugin instantiates the adapters from it on reload. ----
  const SITES_FILE = process.env.CUSTOM_SITES_FILE || '/config/sites.json';
  type Site = { engine: string; id: string; name: string; base: string; order?: number };
  const readSites = async (): Promise<Site[]> => { try { const j = JSON.parse(await readFile(SITES_FILE, 'utf8')); return Array.isArray(j) ? j : []; } catch { return []; } };
  const writeSites = async (list: Site[]) => { await mkdir(dirname(SITES_FILE), { recursive: true }).catch(() => {}); await writeFile(SITES_FILE, JSON.stringify(list, null, 2)); };
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 40);

  // After adding a site, actually exercise it (search → series → chapters → pages) so the admin gets immediate
  // ✓/✗ feedback instead of discovering a parse failure later. Best-effort; bounded by a caller-side timeout.
  const smokeTest = async (src: any): Promise<{ ok: boolean; checks: Array<{ name: string; ok: boolean; detail: string }> }> => {
    const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
    const clip = (s: any) => String(s || '').slice(0, 80);
    let results: any[] = [];
    let searchOk = false;
    let searchDetail = 'no results — markup may not match this engine';
    for (const qq of ['the', 'one', 'love', 'a']) {
      try { const r = await src.search(qq); if (Array.isArray(r) && r.length) { results = r; searchOk = true; searchDetail = `${r.length} result(s)`; break; } }
      catch (e: any) { searchDetail = clip(e?.message || 'error'); }
    }
    checks.push({ name: 'Search', ok: searchOk, detail: searchDetail });
    if (!searchOk) return { ok: false, checks };
    let chapters: any[] = [];
    try {
      const series = await src.getSeries(results[0].sourceId);
      checks.push({ name: 'Series page', ok: !!series?.title, detail: series?.title ? clip(series.title) : 'no data' });
      chapters = await src.listChapters(results[0].sourceId);
      checks.push({ name: 'Chapters', ok: chapters.length > 0, detail: chapters.length ? `${chapters.length} chapter(s)` : 'none found' });
    } catch (e: any) {
      checks.push({ name: 'Series / chapters', ok: false, detail: clip(e?.message || 'error') });
    }
    if (chapters.length) {
      try { const pages = await src.getPageUrls(chapters[0].sourceId); checks.push({ name: 'Pages', ok: pages.length > 0, detail: pages.length ? `${pages.length} page(s)` : 'none found' }); }
      catch (e: any) { checks.push({ name: 'Pages', ok: false, detail: clip(e?.message || 'error') }); }
    }
    return { ok: checks.every((c) => c.ok), checks };
  };

  app.get('/api/admin/sources/custom', async () => ({ content: await readSites() }));
  app.post('/api/admin/sources/custom', async (req, reply) => {
    const b = z.object({ engine: z.enum(['auto', 'madara', 'manganato', 'mangathemesia']), name: z.string().min(1).max(60), base: z.string().url() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request', message: 'Pick an engine, a name, and a valid https URL.' });
    // auto-detect the engine from the site's homepage so the user can just paste a URL
    let engine = b.data.engine as string;
    if (engine === 'auto') {
      const detected = await detectEngine(b.data.base);
      if (!detected) return reply.code(422).send({ error: 'undetected', message: "Couldn't detect the site's engine — pick Madara, MangaThemesia, or Manganato manually." });
      engine = detected;
    }
    const id = slug(b.data.name) || slug(new URL(b.data.base).hostname.replace(/^www\./, ''));
    if (!id) return reply.code(400).send({ error: 'bad_name' });
    const list = await readSites();
    if (getSource(id) || list.some((s) => s.id === id)) return reply.code(409).send({ error: 'exists', message: `A source named "${b.data.name}" already exists — pick another name.` });
    list.push({ engine, id, name: b.data.name, base: b.data.base.replace(/\/+$/, ''), order: 100 });
    await writeSites(list);
    await reloadAll();
    await logAudit('source.custom_add', { userId: userIdOf(req), detail: { id, engine, base: b.data.base }, req });
    // Verify the freshly-added site actually works, bounded so a slow/Cloudflare-heavy site can't hang the request.
    const added = getSource(id);
    const smoke = added
      ? await Promise.race([
          smokeTest(added),
          new Promise<{ ok: boolean; timedOut: boolean; checks: Array<{ name: string; ok: boolean; detail: string }> }>((res) =>
            setTimeout(() => res({ ok: false, timedOut: true, checks: [{ name: 'Verify', ok: false, detail: 'timed out — site is slow or heavily protected; added anyway' }] }), 30000)),
        ])
      : { ok: false, checks: [{ name: 'Verify', ok: false, detail: 'source failed to load' }] };
    return reply.send({ ok: true, id, engine, available: listSources().length, smoke });
  });
  app.delete('/api/admin/sources/custom/:id', async (req) => {
    const { id } = req.params as { id: string };
    await writeSites((await readSites()).filter((s) => s.id !== id));
    await reloadAll();
    await logAudit('source.custom_remove', { userId: userIdOf(req), detail: { id }, req });
    return { ok: true, available: listSources().length };
  });

  // ---- admin-editable series metadata + art overrides (Jellyfin-style) ----
  // Edit title/summary; an empty value clears the override (back to the source's own metadata).
  // Per-series settings. auto_update could only ever be chosen at add time, and the UI never read it back,
  // so there was no way to stop the updater chasing a series you had finished with.
  app.patch('/api/admin/series/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = z.object({ autoUpdate: z.boolean() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    const r = await q<{ id: string }>('UPDATE lib_series SET auto_update = $2 WHERE id = $1 RETURNING id', [id, b.data.autoUpdate]);
    if (!r.length) return reply.code(404).send({ error: 'not_found' });
    await logAudit('series.settings', { userId: userIdOf(req), detail: { id, autoUpdate: b.data.autoUpdate }, req });
    return { ok: true, autoUpdate: b.data.autoUpdate };
  });

  // "Check for new chapters" for one series. updateSeries downloads synchronously and can run for minutes,
  // so this starts it and returns; the UI polls the status below rather than holding a request open.
  app.post('/api/admin/series/:id/check', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (seriesChecks.get(id)?.running) return reply.code(409).send({ error: 'busy', message: 'Already checking that series.' });
    const row = await getSeriesRow(id);
    if (!row) return reply.code(404).send({ error: 'not_found' });
    seriesChecks.set(id, { running: true, startedAt: Date.now() });
    void updateSeries(id, Number((req.body as any)?.maxNew) || 10)
      .then((r) => seriesChecks.set(id, { running: false, added: r.added, finishedAt: Date.now() }))
      .catch((e) => seriesChecks.set(id, { running: false, error: (e as Error)?.message || 'failed', finishedAt: Date.now() }));
    await logAudit('series.check', { userId: userIdOf(req), detail: { id, title: row.title }, req });
    return { ok: true, started: true };
  });

  app.get('/api/admin/series/:id/check', async (req) => {
    const { id } = req.params as { id: string };
    return seriesChecks.get(id) ?? { running: false };
  });

  // ---- library management: hide, restore, merge ----
  // Delete HIDES the series rather than erasing it: the id survives, so favourites, ratings, notes and
  // reading history stay attached to something real, and the action is undoable. Files are never touched.
  app.delete('/api/admin/series/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await getSeriesRow(id);
    if (!row) return reply.code(404).send({ error: 'not_found' });
    if (row.deleted_at) return reply.code(400).send({ error: 'already_deleted', message: 'That series is already hidden.' });
    if (row.merged_into) return reply.code(400).send({ error: 'merged', message: 'That series was merged into another one.' });
    const r = await deleteSeries(id);
    await logAudit('series.delete', { userId: userIdOf(req), detail: { id, title: row.title, books: r.books }, req });
    return r;
  });

  app.post('/api/admin/series/:id/restore', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await getSeriesRow(id);
    if (!row) return reply.code(404).send({ error: 'not_found' });
    if (!row.deleted_at) return reply.code(400).send({ error: 'not_deleted', message: 'That series is not hidden.' });
    await restoreSeries(id);
    await logAudit('series.restore', { userId: userIdOf(req), detail: { id, title: row.title }, req });
    return { ok: true };
  });

  /** Hidden series, so the admin can see and undo what was deleted. */
  app.get('/api/admin/series/deleted', async () => ({
    content: await q(
      `SELECT id, title, folder, books_count, deleted_at FROM lib_series
        WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC`,
    ),
  }));

  // Merge :id INTO the series named in the body. Chapters and everything a user owns move across; nothing
  // is de-duplicated and no chapter row is deleted, so no reading progress can be lost.
  app.post('/api/admin/series/:id/merge', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = z.object({ into: z.string().min(1).max(64) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request', message: 'Which series should it merge into?' });
    if (b.data.into === id) return reply.code(400).send({ error: 'same_series', message: 'A series cannot merge into itself.' });

    const from = await getSeriesRow(id);
    const into = await getSeriesRow(b.data.into);
    if (!from || !into) return reply.code(404).send({ error: 'not_found' });
    for (const [row, which] of [[from, 'source'], [into, 'target']] as const) {
      if (row.deleted_at) return reply.code(400).send({ error: 'deleted', message: `The ${which} series is hidden. Restore it first.` });
      if (row.merged_into) return reply.code(400).send({ error: 'merged', message: `The ${which} series was already merged into another one.` });
    }

    const r = await mergeSeries(id, into.id);
    await logAudit('series.merge', {
      userId: userIdOf(req),
      detail: { from: id, fromTitle: from.title, into: into.id, intoTitle: into.title, ...r },
      req,
    });
    return r;
  });

  app.put('/api/admin/series/:id/meta', async (req, reply) => {
    const { id } = req.params as { id: string };
    // Status is free text with a generous cap rather than an enum: the scanner writes whatever ComicInfo's
    // PublishingStatus said, so validating against a fixed list here would reject values Uchiyomi itself
    // produced. The UI offers the four common ones plus an escape hatch.
    const b = z.object({
      title: z.string().max(300).nullish(),
      summary: z.string().max(8000).nullish(),
      author: z.string().max(300).nullish(),
      status: z.string().max(60).nullish(),
      genres: z.array(z.string().min(1).max(60)).max(50).nullish(),
      // A minimum age, or null to fall back to whatever ComicInfo said. See lib/ageRating.ts.
      ageRating: z.number().int().min(0).max(18).nullish(),
    }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    const norm = (v: string | null | undefined) => { const s = (v ?? '').trim(); return s ? s : null; };
    // Genres are a set, not a string: trim, drop blanks, de-duplicate case-insensitively keeping the first
    // spelling, preserve order. null means "inherit what was scanned"; [] means "cleared on purpose", and
    // COALESCE in SERIES_SRC treats those two differently, which is the whole point of the distinction.
    const normGenres = (v: string[] | null | undefined): string[] | null => {
      if (v == null) return null;
      const seen = new Set<string>();
      const out: string[] = [];
      for (const g of v) {
        const t = g.trim();
        if (!t || seen.has(t.toLowerCase())) continue;
        seen.add(t.toLowerCase());
        out.push(t);
      }
      return out;
    };
    // Every column is written on every call, so the client must send the whole object. The edit modal
    // already holds all five fields; a partial PUT would silently clear the ones it omitted.
    await q(
      `INSERT INTO series_overrides (series_id, title, summary, author, status, genres, age_rating, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT (series_id) DO UPDATE SET title = $2, summary = $3, author = $4, status = $5,
         genres = $6, age_rating = $7, updated_at = now()`,
      [id, norm(b.data.title), norm(b.data.summary), norm(b.data.author), norm(b.data.status), normGenres(b.data.genres)],
    );
    await logAudit('series.meta_override', { userId: userIdOf(req), detail: { id }, req });
    return { ok: true };
  });

  /**
   * Correct one chapter's number or title.
   *
   * Chapter numbers are parsed out of filenames by numFromName(), which takes the first number it finds, so
   * "Vol 2 Ch 5.cbz" is chapter 2. That misorders the reader and is what gets reported to a tracker.
   *
   * Deliberately one chapter at a time. A bulk re-parse with a smarter rule would renumber hundreds at once,
   * and every renumbered chapter that is already COMPLETED changes what AniList is told. The response
   * reports how many people have finished this chapter so the UI can say so before the change is made
   * rather than after.
   */
  app.put('/api/admin/books/:id/meta', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = z.object({
      number: z.number().min(0).max(100000).nullish(),
      title: z.string().max(300).nullish(),
    }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });

    const book = await one<{ number: number }>('SELECT number FROM lib_books WHERE id = $1', [id]);
    if (!book) return reply.code(404).send({ error: 'not_found' });

    const title = (b.data.title ?? '').trim() || null;
    const number = b.data.number ?? null;
    if (number == null && title == null) {
      await q('DELETE FROM book_overrides WHERE book_id = $1', [id]);
    } else {
      await q(
        `INSERT INTO book_overrides (book_id, number, title, updated_at) VALUES ($1, $2, $3, now())
         ON CONFLICT (book_id) DO UPDATE SET number = $2, title = $3, updated_at = now()`,
        [id, number, title],
      );
    }
    const affected = await one<{ n: number }>(
      'SELECT count(*)::int n FROM read_progress WHERE book_id = $1 AND completed', [id],
    );
    await logAudit('book.meta_override', {
      userId: userIdOf(req),
      detail: { id, from: book.number, to: number, title },
      req,
    });
    return { ok: true, affectedUsers: affected?.n ?? 0 };
  });

  // ---- file operations on the user's own library ----
  //
  // The only routes in the app that write to a collection the user owns. Both take one series, both are
  // explicitly confirmed by the client, and both refuse rather than half-apply.

  /** Is the library writable at all, so the UI can say so before anyone clicks. */
  app.get('/api/admin/library/writable', async () => {
    const roots = (await q<{ root: string }>('SELECT DISTINCT root FROM lib_books WHERE root IS NOT NULL')).map((r) => r.root);
    const checks = await Promise.all(roots.map(async (root) => ({ root, ...(await writePreflight(root)) })));
    return { content: checks, ok: checks.every((c) => c.ok) };
  });

  app.post('/api/admin/series/:id/delete-files', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = z.object({ confirm: z.string() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    const row = await getSeriesRow(id);
    if (!row) return reply.code(404).send({ error: 'not_found' });
    if (b.data.confirm.trim() !== row.title.trim()) {
      return reply.code(400).send({ error: 'confirm_mismatch', message: 'Type the series title exactly to confirm.' });
    }
    const r = await deleteSeriesFiles(id);
    if (!r.ok) return reply.code(409).send({ error: 'refused', message: r.reason, fix: r.fix });
    await logAudit('series.delete_files', { userId: userIdOf(req), detail: { id, files: r.files, bytes: r.bytes }, req });
    return r;
  });

  app.post('/api/admin/series/:id/rename-folder', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = z.object({ folder: z.string().min(1).max(400) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    const r = await renameSeriesFolder(id, b.data.folder);
    if (!r.ok) return reply.code(409).send({ error: 'refused', message: r.reason, fix: r.fix });
    await logAudit('series.rename_folder', { userId: userIdOf(req), detail: { id, folder: b.data.folder }, req });
    return r;
  });

  // ---- libraries ----
  //
  // Declared, never inferred from disk. The obvious rule (each top-level folder is a library) is wrong on a
  // real install: that level holds source names written by the downloader, so inferring would rename one
  // library into several named after scrapers. Library zero covers the whole root and always exists.

  app.get('/api/admin/libraries', async () => {
    const rows = await q<{ id: string; name: string; path: string; n: number }>(
      `SELECT l.id, l.name, l.path,
              (SELECT count(*)::int FROM lib_series s WHERE s.library_id = l.id AND ${visibleToAll('s')}) AS n
         FROM libraries l ORDER BY l.sort_order, l.name`,
    );
    // Candidate subdirectories: folders that hold series but are not yet a library. Annotated where the name
    // matches a known source, because that is the case an admin should NOT usually promote.
    const sources = new Set((await q<{ source: string }>('SELECT DISTINCT source FROM lib_series')).map((r) => r.source));
    const taken = new Set(rows.map((r) => r.path).filter(Boolean));
    const seen = new Map<string, number>();
    for (const r of await q<{ folder: string }>(`SELECT folder FROM lib_series s WHERE ${visibleToAll('s')}`)) {
      const top = r.folder.split('/')[0];
      if (!top || taken.has(top)) continue;
      seen.set(top, (seen.get(top) ?? 0) + 1);
    }
    const candidates = [...seen.entries()].map(([path, n]) => ({
      path, series: n,
      looksLikeSource: sources.has(path),
    })).sort((a, b) => b.series - a.series);
    return { content: rows, candidates };
  });

  /** What promoting a path WOULD do, without doing it. Same habit as the chapter-override route. */
  app.get('/api/admin/libraries/preview', async (req, reply) => {
    const path = String((req.query as { path?: string }).path ?? '').trim();
    if (!path) return reply.code(400).send({ error: 'bad_request' });
    const rows = await q<{ id: string; title: string }>(
      `SELECT id, title FROM lib_series s
        WHERE s.library_id = 'lib' AND (folder = $1 OR folder LIKE $1 || '/%') AND ${visibleToAll('s')}
        ORDER BY title LIMIT 20`,
      [path],
    );
    const total = await one<{ n: number }>(
      `SELECT count(*)::int n FROM lib_series s
        WHERE s.library_id = 'lib' AND (folder = $1 OR folder LIKE $1 || '/%')`, [path],
    );
    return { path, series: total?.n ?? 0, sample: rows.map((r) => r.title) };
  });

  app.post('/api/admin/libraries', async (req, reply) => {
    const b = z.object({
      name: z.string().min(1).max(80),
      // relative, posix, no escaping the root. Containment is checked again at the filesystem layer.
      path: z.string().min(1).max(300),
    }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    const path = b.data.path.replace(/^\/+|\/+$/g, '').trim();
    if (!path || path.includes('..') || path.startsWith('/')) {
      return reply.code(400).send({ error: 'bad_path', message: 'Use a folder path relative to your library root.' });
    }
    // Nesting makes "longest prefix wins" surprising and makes access rules ambiguous, so refuse both
    // directions rather than pick a winner.
    const clash = await one<{ path: string }>(
      `SELECT path FROM libraries WHERE path <> '' AND ($1 = path OR $1 LIKE path || '/%' OR path LIKE $1 || '/%')`,
      [path],
    );
    if (clash) {
      return reply.code(409).send({ error: 'nested', message: `That overlaps the existing library at "${clash.path}".` });
    }
    const id = `lib_${randomBytes(8).toString('hex')}`;
    await tx(async (qq) => {
      await qq(`INSERT INTO libraries (id, name, path) VALUES ($1,$2,$3)`, [id, b.data.name.trim(), path]);
      // Reassignment is deliberate and happens here, not in a scan: the scanner keeps an existing folder in
      // the library it is already in, precisely so it can never re-mint an id by recomputing.
      await qq(
        `UPDATE lib_series SET library_id = $1
          WHERE library_id = 'lib' AND (folder = $2 OR folder LIKE $2 || '/%')`,
        [id, path],
      );
    });
    await logAudit('library.create', { userId: userIdOf(req), detail: { id, path }, req });
    return { ok: true, id };
  });

  app.patch('/api/admin/libraries/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = z.object({ name: z.string().min(1).max(80) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    // Rename only. Changing the path is a reassignment of every series in it, so it is delete-and-recreate,
    // which forces the preview and the audit entry rather than doing it silently under an edit.
    await q('UPDATE libraries SET name = $2 WHERE id = $1', [id, b.data.name.trim()]);
    await logAudit('library.rename', { userId: userIdOf(req), detail: { id, name: b.data.name }, req });
    return { ok: true };
  });

  app.delete('/api/admin/libraries/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (id === 'lib') {
      return reply.code(400).send({ error: 'cannot_delete', message: 'The default library cannot be removed.' });
    }
    await tx(async (qq) => {
      // Back to library zero first. The FK is RESTRICT on purpose: read_progress cascades from lib_series,
      // so a cascading library delete would destroy reading history two hops away.
      await qq(`UPDATE lib_series SET library_id = 'lib' WHERE library_id = $1`, [id]);
      await qq('DELETE FROM user_libraries WHERE library_id = $1', [id]);
      await qq('DELETE FROM libraries WHERE id = $1', [id]);
    });
    await logAudit('library.delete', { userId: userIdOf(req), detail: { id }, req });
    return { ok: true };
  });

  // Set/replace a cover or background: paste a URL, upload an image (base64 data URL), or reset to automatic.
  app.put('/api/admin/series/:id/art', { bodyLimit: 12 * 1024 * 1024 }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = z.object({
      kind: z.enum(['cover', 'banner']),
      mode: z.enum(['url', 'upload', 'reset']),
      url: z.string().url().optional(),
      dataUrl: z.string().optional(),
    }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    const { kind, mode } = b.data;
    let value: string | null = null;
    if (mode === 'url') {
      if (!b.data.url) return reply.code(400).send({ error: 'no_url', message: 'Paste an image URL.' });
      value = b.data.url;
      await rm(artFile(id, kind), { force: true }).catch(() => {});
    } else if (mode === 'upload') {
      const m = /^data:image\/[a-z0-9.+-]+;base64,(.+)$/i.exec(b.data.dataUrl || '');
      if (!m) return reply.code(400).send({ error: 'bad_image', message: 'Upload a valid image.' });
      let buf: Buffer;
      try {
        const maxW = kind === 'banner' ? 1600 : 1000;
        buf = await sharp(Buffer.from(m[1], 'base64')).rotate().resize({ width: maxW, withoutEnlargement: true }).webp({ quality: 86 }).toBuffer();
      } catch { return reply.code(400).send({ error: 'bad_image', message: "That file isn't a readable image." }); }
      await mkdir(ART_DIR, { recursive: true }).catch(() => {});
      await writeFile(artFile(id, kind), buf);
      value = 'upload';
    } else {
      await rm(artFile(id, kind), { force: true }).catch(() => {});
      value = null;
    }
    const col = kind === 'cover' ? 'cover' : 'banner';
    await q(
      `INSERT INTO series_overrides (series_id, ${col}, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (series_id) DO UPDATE SET ${col} = $2, updated_at = now()`,
      [id, value],
    );
    await logAudit('series.art_override', { userId: userIdOf(req), detail: { id, kind, mode }, req });
    return { ok: true };
  });

  // ---- art review: per-series art status + candidates + bulk backfill ----

  // Every series with its art status, worst-first — feeds the admin Art Review gallery.
  // The query lives in lib/seriesArt so a test can execute it; see the note there.
  app.get('/api/admin/art/overview', async () => ({ content: await artOverview() }));

  // Art options for one series: AniList matches (banner + cover) and MangaDex covers — the admin picks one.
  app.get('/api/admin/art/candidates/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const s = await one<{ title: string }>('SELECT title FROM lib_series WHERE id = $1', [id]);
    if (!s) return reply.code(404).send({ error: 'not_found' });
    const cleaned = s.title.replace(/\([^)]*\)/g, '').replace(/\s*[-–—:].*$/, '').trim() || s.title;
    const [anilist, anilistLoose, kitsu, md] = await Promise.all([
      fetchAniListCandidates(s.title).catch(() => []),
      cleaned !== s.title ? fetchAniListCandidates(cleaned).catch(() => []) : Promise.resolve([]),
      fetchKitsuBanner(s.title).then((b) => (b ? [{ title: s.title, banner: b, cover: null as string | null }] : [])).catch(() => []),
      (async () => {
        try {
          const mdSrc = getSource('mangadex');
          if (!mdSrc) return [];
          const res = await mdSrc.search(s.title);
          return (res || []).slice(0, 5).map((r) => ({ title: r.title, banner: null as string | null, cover: r.coverUrl || null }));
        } catch { return []; }
      })(),
    ]);
    // merge, dedupe by image URL, label the origin
    const seen = new Set<string>();
    const out: Array<{ origin: string; title: string; banner: string | null; cover: string | null }> = [];
    for (const [origin, list] of [['anilist', anilist], ['anilist', anilistLoose], ['kitsu', kitsu], ['mangadex', md]] as const) {
      for (const c of list) {
        const key = c.banner || c.cover || '';
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push({ origin, ...c });
      }
    }
    return { title: s.title, content: out };
  });

  // Bulk backfill: re-hunt art for series missing a banner (or any art). AniList first (cleaned-title retry),
  // MangaDex cover as a second source. Runs in the background; poll /api/admin/art/backfill/status.
  app.post('/api/admin/art/backfill', async (req, reply) => {
    if (artJob?.running) return reply.code(409).send({ error: 'busy', message: 'A backfill is already running.' });
    const targets = await q<{ id: string; title: string }>(
      `SELECT s.id, s.title FROM lib_series s
       LEFT JOIN series_art a ON a.series_id = s.id
       LEFT JOIN series_overrides o ON o.series_id = s.id
       WHERE ${visibleToAll('s')} AND (a.banner IS NULL OR a.banner = '') AND o.banner IS NULL
       ORDER BY s.title`,
    );
    const job: ArtJob = { running: true, total: targets.length, done: 0, banners: 0, covers: 0, misses: 0, startedAt: Date.now() };
    artJob = job;
    await logAudit('art.backfill_start', { userId: userIdOf(req), detail: { count: targets.length }, req });
    void (async () => {
      for (const t of targets) {
        try {
          // banner hunt, widest net first-hit-wins: AniList manga (banner or its anime adaptation's, same
          // query) → harsher-cleaned retry → direct AniList ANIME search → Kitsu wide cover.
          let art = await fetchAniListArt(t.title).catch(() => ({ banner: null as string | null, cover: null as string | null }));
          const harsh = t.title.replace(/\([^)]*\)/g, '').replace(/\s*[-–—:].*$/, '').trim();
          if (!art.banner && harsh && harsh !== t.title) {
            const retry = await fetchAniListArt(harsh).catch(() => ({ banner: null, cover: null }));
            art = { banner: retry.banner ?? art.banner, cover: art.cover ?? retry.cover };
          }
          if (!art.banner) art.banner = await fetchAnimeBanner(t.title).catch(() => null);
          if (!art.banner) art.banner = await fetchKitsuBanner(t.title);
          if (!art.banner && harsh && harsh !== t.title) art.banner = await fetchKitsuBanner(harsh);
          if (!art.cover) {
            try {
              const mdSrc = getSource('mangadex');
              const res = mdSrc ? await mdSrc.search(t.title) : [];
              art.cover = res?.[0]?.coverUrl || null;
            } catch { /* mangadex miss is fine */ }
          }
          if (art.banner || art.cover) {
            await q(
              `INSERT INTO series_art (series_id, banner, cover) VALUES ($1, $2, $3)
               ON CONFLICT (series_id) DO UPDATE SET
                 banner = COALESCE(EXCLUDED.banner, series_art.banner),
                 cover  = COALESCE(EXCLUDED.cover,  series_art.cover), fetched_at = now()`,
              [t.id, art.banner, art.cover],
            );
            if ((art as any).mediaId) await linkSeries(t.id, (art as any).mediaId, (art as any).mediaTitle ?? null);
            if (art.banner) job.banners++;
            else job.covers++;
          } else job.misses++;
        } catch { job.misses++; }
        job.done++;
        await new Promise((r) => setTimeout(r, 2200)); // stay under AniList's ~30 req/min
      }
      job.running = false;
    })();
    return { ok: true, total: targets.length };
  });
  app.get('/api/admin/art/backfill/status', async () => ({ job: artJob }));

  // ---- extensions (Mihon/Tachiyomi sources, via an optional Suwayomi server) ----
  // Uchiyomi never fetches or installs extension APKs itself: installing is a link out to Suwayomi's own UI.
  // All this does is let the operator choose WHICH of the extension's sources become Uchiyomi sources.
  app.get('/api/admin/extensions/status', async () => {
    if (!suwayomiConfigured()) return { configured: false, reachable: false };
    let version: string | null = null;
    let reachable = false;
    let error: string | undefined;
    try {
      version = (await suwayomiAbout()).version;
      reachable = true;
    } catch (e) {
      error = (e as Error)?.message || 'unreachable';
    }
    const counts = await one<{ enabled: number; known: number }>(
      `SELECT count(*) FILTER (WHERE enabled)::int AS enabled, count(*)::int AS known FROM suwayomi_sources`,
    );
    return { configured: true, reachable, version, error, enabled: counts?.enabled ?? 0, known: counts?.known ?? 0 };
  });

  // The full source list, joined with what we have switched on. Falls back to the remembered rows when the
  // extension server is briefly unreachable, so the page still renders something useful.
  app.get('/api/admin/extensions/sources', async (req) => {
    if (!suwayomiConfigured()) return { content: [], reachable: false };
    const { q: term, lang } = req.query as { q?: string; lang?: string };
    let remote: Array<{ id: string; name: string; displayName?: string | null; lang?: string | null; isNsfw?: boolean | null; supportsLatest?: boolean | null }> = [];
    let reachable = true;
    try {
      remote = await listRemoteSources();
    } catch {
      reachable = false;
      remote = (await q<{ source_id: string; name: string; lang: string | null }>(
        'SELECT source_id, name, lang FROM suwayomi_sources ORDER BY name',
      )).map((r) => ({ id: r.source_id, name: r.name, lang: r.lang }));
    }
    const on = new Set(
      (await q<{ source_id: string }>('SELECT source_id FROM suwayomi_sources WHERE enabled = true')).map((r) => r.source_id),
    );
    const needle = (term || '').trim().toLowerCase();
    const content = remote
      .map((s) => ({
        id: String(s.id),
        name: s.displayName?.trim() || s.name,
        lang: s.lang || null,
        nsfw: !!s.isNsfw,
        supportsLatest: !!s.supportsLatest,
        enabled: on.has(String(s.id)),
      }))
      .filter((s) => (!needle || s.name.toLowerCase().includes(needle)) && (!lang || s.lang === lang))
      .sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name));
    return { content, reachable, total: remote.length };
  });

  app.post('/api/admin/extensions/sources/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = z.object({ enabled: z.boolean() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    if (!suwayomiConfigured()) return reply.code(400).send({ error: 'not_configured', message: 'No extension server is configured.' });

    // Take the name from the live list so the row is meaningful even before the source is ever used.
    const remote = await listRemoteSources().catch(() => []);
    const match = remote.find((s) => String(s.id) === id);
    await q(
      `INSERT INTO suwayomi_sources (source_id, name, lang, enabled) VALUES ($1,$2,$3,$4)
       ON CONFLICT (source_id) DO UPDATE SET enabled = EXCLUDED.enabled,
         name = COALESCE(NULLIF(EXCLUDED.name, ''), suwayomi_sources.name)`,
      [id, match ? (match.displayName?.trim() || match.name) : id, match?.lang ?? null, b.data.enabled],
    );
    await reloadAll();
    await logAudit(b.data.enabled ? 'source.extension_enable' : 'source.extension_disable', {
      userId: userIdOf(req), detail: { id, name: match?.name }, req,
    });

    // Prove it actually works now rather than letting the user discover it later from an empty search.
    let smoke = null;
    if (b.data.enabled) {
      const adapter = getSource(swAdapterId(id));
      if (adapter) smoke = await smokeTest(adapter);
    }
    return { ok: true, smoke };
  });

  // ---- the extension catalogue ----
  // Uchiyomi is a remote control for the operator's own extension server here: the catalogue comes from
  // repositories THEY configured, and that server does the fetching and installing. No repository URL ships
  // in this codebase and nothing is fetched until one is added.
  const needExt = (reply: FastifyReply) =>
    suwayomiConfigured() ? null : reply.code(400).send({ error: 'not_configured', message: 'No extension server is configured.' });

  app.get('/api/admin/extensions/catalog', async (req, reply) => {
    if (needExt(reply)) return;
    const { q: term, lang, installed, nsfw } = req.query as { q?: string; lang?: string; installed?: string; nsfw?: string };
    let all;
    try {
      all = await listExtensions();
    } catch (e) {
      return reply.code(502).send({ error: 'unreachable', message: (e as Error)?.message || 'Could not reach the extension server.' });
    }
    const needle = (term || '').trim().toLowerCase();
    const filtered = all
      .filter((e) => (!needle || e.name.toLowerCase().includes(needle) || e.pkgName.toLowerCase().includes(needle)))
      .filter((e) => (!lang || lang === 'all' ? true : e.lang === lang))
      .filter((e) => (installed === 'true' ? e.installed : true))
      // adult extensions are hidden unless asked for — this is a household server by default, and they
      // otherwise dominate the top of an alphabetical list
      .filter((e) => (nsfw === 'true' ? true : !e.nsfw || e.installed))
      // installed first, then updatable, then alphabetical — the things you can act on float up
      .sort((a, b) => Number(b.installed) - Number(a.installed) || Number(b.hasUpdate) - Number(a.hasUpdate) || a.name.localeCompare(b.name));
    const langs = [...new Set(all.map((e) => e.lang).filter(Boolean))].sort() as string[];
    // Serve icons through our own origin; the extension server is not reachable from a browser.
    const withIcons = filtered.map((e) => ({ ...e, iconUrl: e.iconUrl ? `/img/extensions/icon/${e.pkgName}` : null }));
    return {
      content: withIcons.slice(0, 400),
      total: all.length,
      shown: Math.min(filtered.length, 400),
      matched: filtered.length,
      installed: all.filter((e) => e.installed).length,
      updatable: all.filter((e) => e.hasUpdate).length,
      hiddenAdult: nsfw === 'true' ? 0 : all.filter((e) => e.nsfw && !e.installed).length,
      langs,
    };
  });

  app.post('/api/admin/extensions/refresh', async (req, reply) => {
    if (needExt(reply)) return;
    try {
      const n = await refreshExtensions();
      await logAudit('extension.refresh', { userId: userIdOf(req), detail: { count: n }, req });
      return { ok: true, count: n };
    } catch (e) {
      return reply.code(502).send({ error: 'unreachable', message: (e as Error)?.message || 'Could not refresh.' });
    }
  });

  app.post('/api/admin/extensions/catalog/:pkgName', async (req, reply) => {
    if (needExt(reply)) return;
    const { pkgName } = req.params as { pkgName: string };
    const b = z.object({ action: z.enum(['install', 'uninstall', 'update']) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });

    // Ask which sources this extension provides BEFORE acting: once it is uninstalled it provides none, and
    // we would leave the rows behind claiming sources that no longer exist.
    const enable = b.data.action !== 'uninstall';
    const priorSources = enable ? [] : await sourcesOfExtension(pkgName).catch(() => []);

    try {
      await setExtensionState(pkgName, b.data.action);
    } catch (e) {
      return reply.code(502).send({ error: 'failed', message: (e as Error)?.message || 'The extension server refused that.' });
    }
    await logAudit(`extension.${b.data.action}`, { userId: userIdOf(req), detail: { pkgName }, req });

    // Installing an extension and then having to hunt for its sources in a second list is exactly the
    // friction this feature exists to remove, so switch them on (or off) as part of the same action.
    const provided = enable ? await sourcesOfExtension(pkgName).catch(() => []) : priorSources;
    for (const s of provided) {
      await q(
        `INSERT INTO suwayomi_sources (source_id, name, lang, enabled) VALUES ($1,$2,$3,$4)
         ON CONFLICT (source_id) DO UPDATE SET enabled = EXCLUDED.enabled, name = EXCLUDED.name, lang = EXCLUDED.lang`,
        [s.id, s.name, s.lang, enable],
      ).catch(() => {});
    }
    if (b.data.action === 'uninstall') {
      // the sources are gone from the server too; don't leave rows implying otherwise
      await q('DELETE FROM suwayomi_sources WHERE source_id = ANY($1)', [provided.map((s) => s.id)]).catch(() => {});
    }
    const r = await reloadAll();
    return { ok: true, sources: provided.length, registered: r.suwayomi };
  });

  // ---- extension repositories ----
  app.get('/api/admin/extensions/repos', async (req, reply) => {
    if (needExt(reply)) return;
    try {
      return { content: await getRepos() };
    } catch (e) {
      return reply.code(502).send({ error: 'unreachable', message: (e as Error)?.message || 'Could not reach the extension server.' });
    }
  });

  app.post('/api/admin/extensions/repos', async (req, reply) => {
    if (needExt(reply)) return;
    const b = z.object({ url: z.string().url().max(500) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request', message: 'That does not look like a repository URL.' });

    const wanted = normalizeRepoUrl(b.data.url);
    const current = await getRepos().catch((): string[] => []);
    if (current.includes(wanted)) return reply.code(409).send({ error: 'exists', message: 'That repository is already added.' });

    const before = (await listExtensions().catch(() => [])).length;
    let error: string | undefined;

    // Suwayomi applies a settings change asynchronously, so the FIRST read after adding a repository still
    // sees the old list and comes back empty. Retry until the catalogue actually grows.
    const attempt = async (url: string): Promise<number> => {
      await setRepos([...current, url]);
      let n = before;
      for (let i = 0; i < 4; i++) {
        try {
          await refreshExtensions();
          error = undefined;
        } catch (e) {
          error = (e as Error)?.message || 'could not read that repository';
        }
        n = (await listExtensions().catch(() => [])).length;
        if (n > before) break;
        await new Promise((r) => setTimeout(r, 700));
      }
      return n;
    };

    let used = wanted;
    let total = await attempt(wanted);

    // Still nothing after retrying? Repository layouts vary, and a bare directory URL is a reasonable thing
    // to paste, so try the full-index form of the same URL as a last resort -- keeping it only if it did
    // better, since for many repositories the original form is the correct one.
    if (total <= before) {
      const alt = altRepoUrl(wanted);
      if (alt && alt !== wanted) {
        const altTotal = await attempt(alt);
        if (altTotal > total) { used = alt; total = altTotal; }
        else await setRepos([...current, wanted]); // no better; keep what they typed
      }
    }

    await logAudit('extension.repo_add', { userId: userIdOf(req), detail: { url: used, extensions: total }, req });
    return { ok: true, url: used, corrected: used !== wanted, total, error };
  });

  app.delete('/api/admin/extensions/repos', async (req, reply) => {
    if (needExt(reply)) return;
    const b = z.object({ url: z.string().max(500) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    const current = await getRepos().catch((): string[] => []);
    await setRepos(current.filter((u) => u !== b.data.url));
    await refreshExtensions().catch(() => 0);
    await logAudit('extension.repo_remove', { userId: userIdOf(req), detail: { url: b.data.url }, req });
    return { ok: true };
  });

  // ---- library health ----
  // Read-only aggregate over the library. Every check is a plain query, so this is safe to hit whenever
  // the tab is opened rather than needing a background job.
  app.get('/api/admin/health', async () => runHealthChecks());

  // ---- link existing series to AniList entries so tracker sync has an anchor ----
  // Art was matched long before trackers existed, so those series have cached art but no link. This
  // re-resolves only what's missing, paced for AniList's ~30 req/min limit.
  let relinkJob: { running: boolean; total: number; done: number; linked: number; misses: number } | null = null;
  app.post('/api/admin/trackers/relink', async (req, reply) => {
    if (relinkJob?.running) return reply.code(409).send({ error: 'busy' });
    const targets = await q<{ id: string; title: string }>(
      `SELECT s.id, s.title FROM lib_series s
         LEFT JOIN series_trackers t ON t.series_id = s.id AND t.provider = 'anilist'
        WHERE ${visibleToAll('s')} AND t.series_id IS NULL ORDER BY s.books_count DESC`,
    );
    const job = { running: true, total: targets.length, done: 0, linked: 0, misses: 0 };
    relinkJob = job;
    await logAudit('tracker.relink_start', { userId: userIdOf(req), detail: { count: targets.length }, req });
    void (async () => {
      for (const t of targets) {
        try {
          const m = await fetchAniListArt(t.title);
          if (m.mediaId) { await linkSeries(t.id, m.mediaId, m.mediaTitle ?? null); job.linked++; }
          else job.misses++;
        } catch { job.misses++; }
        job.done++;
        await new Promise((r) => setTimeout(r, 2200)); // stay under AniList's rate limit
      }
      job.running = false;
    })();
    return { ok: true, total: targets.length };
  });
  app.get('/api/admin/trackers/relink/status', async () => ({ job: relinkJob }));

  // ---- import intake: turn a Mihon/Tachiyomi backup or a MangaDex list into a reviewable title list ----
  // Parsing is separate from importing on purpose: adding hundreds of series is slow and hits other people's
  // servers, so the admin gets to see and trim the list first.
  app.post('/api/admin/import/parse', { bodyLimit: 12 * 1024 * 1024 }, async (req, reply) => {
    const b = z
      .object({
        // a .tachibk / .proto.gz as a data URL (there's no multipart plugin; this mirrors the art upload)
        dataUrl: z.string().optional(),
        // a public MangaDex list URL or id
        mangadexList: z.string().optional(),
      })
      .safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });

    let titles: string[] = [];
    let origin = '';
    try {
      if (b.data.dataUrl) {
        const m = /^data:[^;]*;base64,(.+)$/s.exec(b.data.dataUrl);
        if (!m) return reply.code(400).send({ error: 'bad_request', message: 'Could not read that file.' });
        titles = titlesFromBackup(Buffer.from(m[1], 'base64'));
        origin = 'backup';
      } else if (b.data.mangadexList) {
        titles = await titlesFromMangadexList(b.data.mangadexList);
        origin = 'mangadex';
      } else {
        return reply.code(400).send({ error: 'bad_request', message: 'Provide a backup file or a MangaDex list.' });
      }
    } catch (e) {
      return reply.code(422).send({ error: 'parse_failed', message: (e as Error)?.message || 'Could not read that.' });
    }

    // flag what's already here so the admin isn't re-importing their own library
    const have = new Set((await q<{ title: string }>('SELECT title FROM lib_series')).map((r) => norm(r.title)));
    const items = titles.slice(0, 500).map((title) => ({ title, inLibrary: have.has(norm(title)) }));
    return { origin, total: titles.length, truncated: titles.length > 500, items };
  });

  // ---- bulk import: paste a list of titles, match each to a source, add it ----
  app.post('/api/admin/import', async (req, reply) => {
    if (importJob?.running) return reply.code(409).send({ error: 'busy', message: 'An import is already running.' });
    const b = z.object({ titles: z.array(z.string()).min(1).max(500), autoUpdate: z.boolean().optional(), chapterCount: z.number().int().positive().optional() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request', message: 'Paste at least one title.' });
    const titles = [...new Set(b.data.titles.map((t) => t.replace(/^[-*•\d.\s]+/, '').trim()).filter(Boolean))].slice(0, 500);
    if (!titles.length) return reply.code(400).send({ error: 'bad_request', message: 'No titles found.' });
    const job: ImportJob = { running: true, total: titles.length, done: 0, added: 0, already: 0, notFound: 0, failed: 0, startedAt: Date.now(), details: [] };
    importJob = job;
    await logAudit('import.start', { userId: userIdOf(req), detail: { count: titles.length }, req });
    void (async () => {
      for (const title of titles) {
        try {
          const m = await findBestMatch(title);
          if (!m) { job.notFound++; job.details.push({ title, status: 'not_found' }); }
          else {
            const r = await addSeriesFromSource({ source: m.source, sourceId: m.sourceId, autoUpdate: b.data.autoUpdate, chapterCount: b.data.chapterCount });
            if (r.ok && (r.chapters ?? 0) > 0) { job.added++; job.details.push({ title, status: 'added', source: m.source }); }
            else if (r.ok) { job.already++; job.details.push({ title, status: 'already', source: m.source }); }
            else { job.failed++; job.details.push({ title, status: r.error || 'failed', source: m.source }); }
          }
        } catch { job.failed++; job.details.push({ title, status: 'error' }); }
        job.done++;
      }
      job.running = false;
    })();
    return { ok: true, total: titles.length };
  });
  app.get('/api/admin/import/status', async () => ({ job: importJob }));

  // ---- provider/source health control ----
  app.get('/api/admin/sources', async () => ({ content: await healthAll() }));
  app.post('/api/admin/sources/:id/:action', async (req, reply) => {
    const { id, action } = req.params as { id: string; action: string };
    if (action === 'disable') await setDisabled(id, true);
    else if (action === 'enable') await setDisabled(id, false);
    else if (action === 'unblock') await clearBlock(id);
    else return reply.code(400).send({ error: 'bad_action' });
    await logAudit(`source.${action}`, { userId: userIdOf(req), detail: { source: id }, req });
    return reply.send({ ok: true });
  });

  // ---- sessions across all users ----
  app.get('/api/admin/sessions', async () => ({
    content: await q(`SELECT r.id, r.user_id, u.username, u.display_name, r.device_name, r.ip, r.user_agent, r.created_at, r.last_seen
      FROM refresh_tokens r JOIN users u ON u.id = r.user_id
      WHERE r.revoked_at IS NULL AND r.expires_at > now() ORDER BY r.last_seen DESC LIMIT 300`),
  }));
  app.delete('/api/admin/sessions/:id', async (req) => {
    await revokeRefreshTokenById((req.params as { id: string }).id);
    await logAudit('admin.session_revoke', { userId: userIdOf(req), req });
    return { ok: true };
  });

  app.get('/api/admin/stats', async () => {
    const [libs, seriesPage, cb, members, activity] = await Promise.all([
      komga.libraries(SYSTEM_CTX).catch(() => [] as any[]),
      komga.searchSeries(SYSTEM_CTX, {}, 0, 1).catch(() => ({ totalElements: 0 } as any)),
      cacheBytes().catch(() => 0),
      one<{ c: number }>('SELECT count(*)::int AS c FROM users'),
      q(
        `SELECT u.id, u.display_name, u.username, u.avatar,
                count(e.*) FILTER (WHERE e.completed)::int AS total,
                count(e.*) FILTER (WHERE e.completed AND e.created_at > now() - interval '7 days')::int AS week,
                max(e.created_at) AS last_active
         FROM users u LEFT JOIN reading_events e ON e.user_id = u.id
         GROUP BY u.id ORDER BY total DESC`,
      ),
    ]);
    return {
      libraries: (libs as any[]).map((l) => ({ name: l.name })),
      seriesTotal: (seriesPage as any).totalElements ?? 0,
      cacheBytes: cb,
      lastScan: runtime.lastScan || null,
      members: members?.c ?? 0,
      activity,
    };
  });

  // canDownload is the only permission that is actually enforced (sources.ts, adding a series). A flag
  // that is toggleable and checked nowhere is worse than no flag, so there is deliberately only one.
  const permsShape = z.object({ canDownload: z.boolean().optional() });

  app.post('/api/admin/users', async (req, reply) => {
    const b = z
      .object({
        username: z.string().min(2).max(64).regex(/^[a-zA-Z0-9._-]+$/, 'letters, numbers, . _ - only'),
        password: z.string().min(1).max(200),
        displayName: z.string().max(64).optional(),
        role: z.enum(['admin', 'user']).default('user'),
        perms: permsShape.optional(),
      })
      .safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request', detail: b.error.flatten().fieldErrors });
    const { username, password, displayName, role, perms } = b.data;
    const pwErr = passwordError(password);
    if (pwErr) return reply.code(400).send({ error: 'weak_password', message: pwErr });

    const exists = await one('SELECT id FROM users WHERE username = $1', [username]);
    if (exists) return reply.code(409).send({ error: 'username_taken' });

    const ph = await hash(password);
    const row = await one<{ id: string }>(
      `INSERT INTO users (display_name, username, role, password_hash, auth_kind, perms)
       VALUES ($1, $2, $3, $4, 'password', $5)
       RETURNING id, username, display_name, role, created_at`,
      [displayName || username, username, role, ph, JSON.stringify(perms || {})],
    );
    if (row) await q(`INSERT INTO app_settings (user_id, data) VALUES ($1, '{}'::jsonb) ON CONFLICT (user_id) DO NOTHING`, [row.id]);
    await logAudit('user.create', { userId: userIdOf(req), detail: { username, role }, req });
    return reply.send(row);
  });

  app.patch('/api/admin/users/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = z
      .object({
        password: z.string().min(1).max(200).optional(),
        displayName: z.string().max(64).optional(),
        role: z.enum(['admin', 'user']).optional(),
        disabled: z.boolean().optional(),
        perms: permsShape.optional(),
        // null means every library, including ones created later. A list means exactly these.
        // Absent means leave the current setting alone.
        libraries: z.array(z.string()).nullable().optional(),
        // The highest age rating this member may see. null means no cap, matching `libraries`.
        maxAgeRating: z.number().int().min(0).max(18).nullable().optional(),
      })
      .parse(req.body);
    // safety: never lock yourself out, never remove the last active admin
    if (id === userIdOf(req) && (b.disabled || b.role === 'user')) return reply.code(400).send({ error: 'cannot_demote_self' });
    if (b.disabled || b.role === 'user') {
      const t = await one<{ role: string }>('SELECT role FROM users WHERE id = $1', [id]);
      if (t?.role === 'admin') {
        const admins = await one<{ c: number }>(`SELECT count(*)::int AS c FROM users WHERE role = 'admin' AND NOT disabled`);
        if ((admins?.c ?? 0) <= 1) return reply.code(400).send({ error: 'last_admin' });
      }
    }
    if (b.password) {
      const pwErr = passwordError(b.password);
      if (pwErr) return reply.code(400).send({ error: 'weak_password', message: pwErr });
      await q('UPDATE users SET password_hash = $2, password_changed_at = now(), failed_logins = 0, locked_until = NULL WHERE id = $1', [id, await hash(b.password)]);
      await revokeAllSessions(id); // force re-login after an admin password reset
    }
    if (b.displayName) await q('UPDATE users SET display_name = $2 WHERE id = $1', [id, b.displayName]);
    if (b.maxAgeRating !== undefined) {
      await q('UPDATE users SET max_age_rating = $2 WHERE id = $1', [id, b.maxAgeRating]);
      await logAudit('user.age_cap', { userId: userIdOf(req), detail: { id, maxAgeRating: b.maxAgeRating }, req });
    }
    if (b.libraries !== undefined) {
      // No rows means every library. Writing rows means exactly those, so clearing first is how you say
      // "back to unrestricted". An empty array is a deliberate "nothing", which is why it is never
      // conflated with null.
      await tx(async (qq) => {
        await qq('DELETE FROM user_libraries WHERE user_id = $1', [id]);
        for (const lid of b.libraries ?? []) {
          await qq(
            `INSERT INTO user_libraries (user_id, library_id) SELECT $1, id FROM libraries WHERE id = $2
             ON CONFLICT DO NOTHING`,
            [id, lid],
          );
        }
      });
      await logAudit('user.libraries', { userId: userIdOf(req), detail: { id, libraries: b.libraries }, req });
    }
    if (b.role) await q('UPDATE users SET role = $2 WHERE id = $1', [id, b.role]);
    if (b.perms) await q('UPDATE users SET perms = $2 WHERE id = $1', [id, JSON.stringify(b.perms)]);
    if (b.disabled !== undefined) {
      await q('UPDATE users SET disabled = $2 WHERE id = $1', [id, b.disabled]);
      if (b.disabled) await revokeAllSessions(id); // kick out a suspended account
    }
    await logAudit('user.update', { userId: userIdOf(req), detail: { target: id, role: b.role, disabled: b.disabled, perms: b.perms, password: b.password ? '***' : undefined }, req });
    return one('SELECT id, username, display_name, role, disabled, perms, totp_enabled FROM users WHERE id = $1', [id]);
  });

  app.delete('/api/admin/users/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (id === userIdOf(req)) return reply.code(400).send({ error: 'cannot_delete_self' });
    const target = await one<{ role: string }>('SELECT role FROM users WHERE id = $1', [id]);
    if (!target) return reply.code(404).send({ error: 'not_found' });
    if (target.role === 'admin') {
      const admins = await one<{ c: number }>(`SELECT count(*)::int AS c FROM users WHERE role = 'admin'`);
      if ((admins?.c ?? 0) <= 1) return reply.code(400).send({ error: 'last_admin' });
    }
    await q('DELETE FROM users WHERE id = $1', [id]);
    return reply.send({ ok: true });
  });
}
