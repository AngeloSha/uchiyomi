import { hash } from '@node-rs/argon2';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { q, one } from '../lib/db';
import { content as komga } from '../lib/backend';
import { cacheBytes } from '../lib/imageCache';
import { runtime } from '../lib/runtime';
import { persistScan } from '../lib/library';
import { runBackup } from '../lib/backup';
import { runUpdateAll, updateSeries } from '../lib/updater';
import { authenticate, requireAdmin, userIdOf, revokeAllSessions, revokeRefreshTokenById, passwordError } from '../lib/auth';
import { logAudit, recentAudit } from '../lib/audit';
import { healthAll, setDisabled, clearBlock } from '../lib/sourceHealth';
import { reloadAll, listSources, getSource, detectEngine } from '../lib/sources';
import { readFile, writeFile, mkdir, rm } from 'fs/promises';
import { dirname } from 'path';
import sharp from 'sharp';
import { ART_DIR, artFile } from '../lib/seriesArt';
import { addSeriesFromSource, findBestMatch, norm } from './sources';
import { titlesFromBackup } from '../lib/tachibk';
import { titlesFromMangadexList } from '../lib/mangadexList';
import { fetchAniListArt, fetchAniListCandidates, fetchAnimeBanner } from '../lib/anilist';
import { fetchKitsuBanner } from '../lib/kitsu';

type ImportJob = { running: boolean; total: number; done: number; added: number; already: number; notFound: number; failed: number; startedAt: number; details: Array<{ title: string; status: string; source?: string }> };
let importJob: ImportJob | null = null;

type ArtJob = { running: boolean; total: number; done: number; banners: number; covers: number; misses: number; startedAt: number };
let artJob: ArtJob | null = null;

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
        (SELECT max(created_at) FROM reading_events e WHERE e.user_id = u.id) AS last_active
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
    ] };
  });
  app.post('/api/admin/tasks/:id/run', async (req) => {
    const { id } = req.params as { id: string };
    await logAudit('task.run', { userId: userIdOf(req), detail: { task: id }, req });
    if (id === 'scan') return { ok: true, ...(await persistScan()) };
    if (id === 'update') { runUpdateAll({ maxNew: 10 }).then((r) => { runtime.lastUpdate = Date.now(); runtime.lastUpdateResult = { series: r.series, added: r.added }; }).catch(() => {}); return { ok: true, started: true }; }
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
    const r = reloadAll(); // rescan pack + re-add built-ins + config sites
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
    reloadAll();
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
    reloadAll();
    await logAudit('source.custom_remove', { userId: userIdOf(req), detail: { id }, req });
    return { ok: true, available: listSources().length };
  });

  // ---- admin-editable series metadata + art overrides (Jellyfin-style) ----
  // Edit title/summary; an empty value clears the override (back to the source's own metadata).
  app.put('/api/admin/series/:id/meta', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = z.object({ title: z.string().max(300).nullish(), summary: z.string().max(8000).nullish() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    const norm = (v: string | null | undefined) => { const s = (v ?? '').trim(); return s ? s : null; };
    await q(
      `INSERT INTO series_overrides (series_id, title, summary, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (series_id) DO UPDATE SET title = $2, summary = $3, updated_at = now()`,
      [id, norm(b.data.title), norm(b.data.summary)],
    );
    await logAudit('series.meta_override', { userId: userIdOf(req), detail: { id }, req });
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
  app.get('/api/admin/art/overview', async () => {
    const rows = await q<any>(
      `SELECT s.id, s.title, s.books_count,
              (a.banner IS NOT NULL AND a.banner <> '') AS has_banner,
              (a.cover  IS NOT NULL AND a.cover  <> '') AS has_cover,
              (o.banner IS NOT NULL) AS override_banner,
              (o.cover  IS NOT NULL) AS override_cover,
              EXTRACT(EPOCH FROM o.updated_at) * 1000 AS override_v
       FROM lib_series s
       LEFT JOIN series_art a ON a.series_id = s.id
       LEFT JOIN series_overrides o ON o.series_id = s.id
       ORDER BY (o.banner IS NOT NULL OR o.cover IS NOT NULL), (a.banner IS NOT NULL AND a.banner <> ''),
                (a.cover IS NOT NULL AND a.cover <> ''), s.title`,
    );
    return { content: rows };
  });

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
       WHERE (a.banner IS NULL OR a.banner = '') AND o.banner IS NULL
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
      komga.libraries().catch(() => [] as any[]),
      komga.searchSeries({}, 0, 1).catch(() => ({ totalElements: 0 } as any)),
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

  const permsShape = z.object({ canDownload: z.boolean().optional(), canManage: z.boolean().optional() });

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
