// Register the Suwayomi sources the operator has switched on.
//
// Registration is opt-in per source, and that is not a preference — it is what keeps the feature usable.
// GET /api/sources/search-all fans out to EVERY registered source with a 20s timeout each, so registering
// the several hundred sources a full extension set exposes would make cross-source search unusable and
// would hit every one of those sites at once.
//
// Everything here fails soft. Suwayomi being unset, down, or unauthorised must leave Uchiyomi booting and
// working exactly as it does without it.
import { q } from '../../db';
import { env } from '../../../env';
import { registerAdapter } from '../loader';
import { listRemoteSources, makeSuwayomiAdapter, type RemoteSource } from './sources';
import { suwayomiConfigured } from './client';

export interface EnabledRow {
  source_id: string;
  name: string;
  lang: string | null;
  enabled: boolean;
  /** The extension package this source belongs to, and the extension's own name. Null when the engine did not say. */
  pkg_name: string | null;
  ext_name: string | null;
}

export async function enabledSourceIds(): Promise<Set<string>> {
  const rows = await q<{ source_id: string }>('SELECT source_id FROM suwayomi_sources WHERE enabled = true');
  return new Set(rows.map((r) => r.source_id));
}

/** Remember what Suwayomi offered, so the admin list still renders when Suwayomi is briefly unreachable. */
async function remember(sources: RemoteSource[]): Promise<void> {
  for (const s of sources) {
    await q(
      // `nsfw` is refreshed on every re-register alongside the name and language: an extension that turns
      // adult in a later version must not keep an old `false` and stay reachable by a capped account.
      // `pkg_name`/`ext_name` are refreshed the same way so the Providers page can fold one extension's
      // language variants into one card; both are null rather than '' when the engine did not say, because
      // '' is a real (if silly) package name and would fold every unknown source into one group.
      `INSERT INTO suwayomi_sources (source_id, name, lang, nsfw, enabled, pkg_name, ext_name) VALUES ($1,$2,$3,$4,false,$5,$6)
       ON CONFLICT (source_id) DO UPDATE SET name = EXCLUDED.name, lang = EXCLUDED.lang, nsfw = EXCLUDED.nsfw,
         pkg_name = EXCLUDED.pkg_name, ext_name = EXCLUDED.ext_name`,
      [
        String(s.id), s.displayName?.trim() || s.name, s.lang ?? null, !!s.isNsfw,
        s.extension?.pkgName?.trim() || null, s.extension?.name?.trim() || null,
      ],
    ).catch(() => {});
  }
}

/**
 * Rows for the engine's sources among `ids` that Uchiyomi has not recorded yet, switched off, as a registration
 * records them (v0.53.0). An extension installed in the engine's own page has no rows until the next registration,
 * so a switch by id -- Admin → Extensions' language switches, through the bulk route -- updated nothing and said
 * nothing. The engine is asked only when one of the ids is missing; a source it no longer lists gets no row.
 */
export async function rememberMissing(ids: string[], list: () => Promise<RemoteSource[]> = listRemoteSources): Promise<number> {
  if (!ids.length) return 0;
  const known = new Set(
    (await q<{ source_id: string }>('SELECT source_id FROM suwayomi_sources WHERE source_id = ANY($1::text[])', [ids])).map((r) => r.source_id),
  );
  const missing = new Set(ids.filter((id) => !known.has(id)));
  if (!missing.size) return 0;
  const found = (await list().catch((): RemoteSource[] => [])).filter((s) => missing.has(String(s.id)));
  await remember(found);
  return found.length;
}

export interface LoadResult {
  configured: boolean;
  reachable: boolean;
  available: number;
  registered: number;
  skipped: number;
  error?: string;
}

// The most recent load, kept so the cap overflow is readable after the fact. Until this existed the only
// record of "skipped 30 over the limit" was one console.warn at boot, which is exactly where nobody looks
// when search quietly stops covering half their sources; the status route and the health page read it now.
let last: LoadResult | null = null;
export const lastSuwayomiLoad = (): LoadResult | null => last;

/**
 * The most recent attempt to reach the engine, whoever made it, and whether it answered: a load (the boot, a
 * reload, the retry, the status route's self-heal), the status route's own look (every Check again, every poll of
 * the setup card) and Health's probe. Admin → Extensions' "Last tried".
 *
 * ⚠️ It used to be the last LOAD. An engine that stopped answering after a good one starts no retry, so right after
 * Check again the card named that load, hours back, as its last try -- a success, beside "not answering" (v0.49.1).
 * `at` is when the attempt began; an older one that ends later does not replace a newer one.
 */
let lastTry: { at: number; ok: boolean } | null = null;
export function noteSuwayomiTry(ok: boolean, at: number = Date.now()): void {
  if (!lastTry || at >= lastTry.at) lastTry = { at, ok };
}
export const lastSuwayomiTry = (): { at: number; ok: boolean } | null => lastTry;

/**
 * Called at boot, from reloadAll() and by the retry below. Returns a summary rather than throwing, so a dead
 * extension server degrades to "no extension sources" instead of taking the server down with it.
 *
 * `quiet` leaves out the "could not list sources" warning: the retry passes it once it has said, in one line,
 * that it goes on trying every few minutes -- a log that gains a line every five minutes for a week of an engine
 * someone switched off by hand is a log nobody reads.
 */
export async function loadSuwayomiSources(
  list: () => Promise<RemoteSource[]> = listRemoteSources,
  opts: { quiet?: boolean } = {},
): Promise<LoadResult> {
  const at = Date.now();
  last = await load(list, !!opts.quiet);
  // Not configured is no attempt: nothing was asked.
  if (last.configured) noteSuwayomiTry(last.reachable, at);
  // Registered, however it came about (a retry, a reload, Check again): any retry still waiting is done.
  if (last.reachable) connected(last);
  return last;
}

async function load(list: () => Promise<RemoteSource[]>, quiet: boolean): Promise<LoadResult> {
  if (!suwayomiConfigured()) return { configured: false, reachable: false, available: 0, registered: 0, skipped: 0 };

  let remote: RemoteSource[];
  try {
    remote = await list();
  } catch (e) {
    const msg = (e as Error)?.message || 'unreachable';
    if (!quiet) console.warn(`[sources] suwayomi: could not list sources (${msg})`);
    return { configured: true, reachable: false, available: 0, registered: 0, skipped: 0, error: msg };
  }

  await remember(remote);
  const enabled = await enabledSourceIds().catch(() => new Set<string>());
  const wanted = remote.filter((s) => enabled.has(String(s.id)));

  let registered = 0;
  let skipped = 0;
  for (const s of wanted) {
    // Cap registrations rather than silently letting search fan out forever. Say what was dropped.
    if (registered >= env.SUWAYOMI_MAX_SOURCES) {
      skipped++;
      continue;
    }
    if (registerAdapter(makeSuwayomiAdapter(s))) registered++;
  }
  if (skipped) {
    console.warn(
      `[sources] suwayomi: registered ${registered} source(s); skipped ${skipped} over the SUWAYOMI_MAX_SOURCES limit of ${env.SUWAYOMI_MAX_SOURCES}`,
    );
  }
  return { configured: true, reachable: true, available: remote.length, registered, skipped };
}

// ---- keep trying until the engine answers ---------------------------------------------------------------------

/** The fast phase after a failed load: the engine is a JVM, and on a cold start it is usually just still booting. */
export const RETRY_FAST_MS: readonly number[] = [5_000, 15_000, 30_000, 60_000, 120_000];
/** After the fast phase, one quiet try this often, for as long as it takes. */
export const RETRY_EVERY_MS = 5 * 60_000;

/** One registration attempt, as the retry makes it. Injectable so a test can drive the loop without an engine. */
export type RetryLoad = (opts: { quiet: boolean }) => Promise<LoadResult>;
const defaultLoad: RetryLoad = (o) => loadSuwayomiSources(listRemoteSources, o);

interface RetryLoop {
  /** Asked and not answered in this outage, counting the failed load that started the loop. */
  attempts: number;
  /** When the loop started: right after the load that found the engine gone. */
  since: number;
  nextAt: number;
  /** Retries made, which is also where in the fast phase the loop is. */
  tries: number;
  timer: ReturnType<typeof setTimeout> | null;
  fast: readonly number[];
  everyMs: number;
  load: RetryLoad;
}

let loop: RetryLoop | null = null;
let inFlight: Promise<LoadResult> | null = null;
const reconnectHooks = new Set<() => void>();

/**
 * Keep trying after a failed load, for as long as it takes (#72).
 *
 * The engine is a JVM and takes longer to accept connections than Uchiyomi does to boot, so on a cold
 * `docker compose up` the first attempt reliably fails; the fast phase (5 s, 15 s, 30 s, 1 min, 2 min) is for
 * that. ⚠️ It used to stop there, about four minutes in, and nothing ever asked again: an engine that came up
 * later -- a slow NAS, an Unraid template installed after Uchiyomi, a container restarted by hand, a reload
 * that ran during an outage -- stayed unregistered until someone found the reload button. So after the fast
 * phase it tries every `everyMs` (5 minutes), quietly, until the engine answers or stops being configured.
 *
 * ONE loop per process: a second call while one runs changes nothing, so the boot, every reloadAll during an
 * outage and anything else may call it without doubling the traffic. Timers never hold the process open.
 */
export function scheduleSuwayomiRetry(
  delaysMs: readonly number[] = RETRY_FAST_MS,
  everyMs: number = RETRY_EVERY_MS,
  load: RetryLoad = defaultLoad,
): void {
  if (!suwayomiConfigured() || loop) return;
  const now = Date.now();
  loop = { attempts: 1, since: now, nextAt: now, tries: 0, timer: null, fast: delaysMs, everyMs, load };
  arm(loop);
}

function arm(l: RetryLoop): void {
  const wait = l.fast[l.tries] ?? l.everyMs;
  l.nextAt = Date.now() + wait;
  l.timer = setTimeout(() => { void tick(l); }, wait);
  l.timer.unref?.();
}

async function tick(l: RetryLoop): Promise<void> {
  if (loop !== l) return;
  l.timer = null;
  // EXTENSION_ENGINE and SUWAYOMI_URL are read once at boot, so this only ends a loop in a test today; it is
  // here so the loop can never outlive the thing it is waiting for.
  if (!suwayomiConfigured()) { loop = null; return; }
  // The fast phase warns on each failure as it always did; from the first slow try on, one line says so and
  // the tries themselves stay out of the log.
  const quiet = l.tries >= l.fast.length;
  l.tries++;
  const r = await once(l.load, quiet).catch(() => null);
  if (loop !== l) return; // answered (here or elsewhere), or stopped
  if (r?.reachable) { connected(r); return; }
  l.attempts++;
  if (l.tries === l.fast.length) {
    console.warn(`[sources] suwayomi: still not answering; trying again every ${Math.round(l.everyMs / 60_000)} min without logging each attempt`);
  }
  arm(l);
}

/** One attempt at a time, whoever asks: the loop, Check again and the status route's self-heal share it. */
function once(load: RetryLoad, quiet: boolean): Promise<LoadResult> {
  if (!inFlight) inFlight = load({ quiet }).finally(() => { inFlight = null; });
  return inFlight;
}

/** The engine answered and its sources are registered: the loop is over, and whoever asked to know is told. */
function connected(r: LoadResult): void {
  const l = loop;
  if (!l) return;
  if (l.timer) clearTimeout(l.timer);
  loop = null;
  console.log(`[sources] suwayomi: connected on retry (${r.registered} extension source(s))`);
  for (const hook of reconnectHooks) {
    try { hook(); } catch { /* a listener's failure is its own */ }
  }
}

/**
 * Try right now, once: Admin → Extensions' Check again and its self-heal (routes/admin.ts, the status route).
 * Single-flight with the loop; a success ends it. A failure while the loop runs counts as one more attempt.
 */
export async function retrySuwayomiNow(load: RetryLoad = defaultLoad): Promise<LoadResult> {
  const r = await once(load, !!loop);
  if (r.reachable) connected(r);
  else if (loop) loop.attempts++;
  return r;
}

/** The loop as Admin → Extensions shows it, or null when none is running. Times are ISO strings. */
export function suwayomiRetryState(): { attempts: number; since: string; nextAt: string } | null {
  if (!loop) return null;
  return { attempts: loop.attempts, since: new Date(loop.since).toISOString(), nextAt: new Date(loop.nextAt).toISOString() };
}

/** Run `fn` whenever a retry brings the engine back (the Health engine check forgets its cached probe). */
export function onSuwayomiReconnect(fn: () => void): () => void {
  reconnectHooks.add(fn);
  return () => { reconnectHooks.delete(fn); };
}

/** For tests: end the loop without an answer. */
export function stopSuwayomiRetry(): void {
  if (loop?.timer) clearTimeout(loop.timer);
  loop = null;
}
