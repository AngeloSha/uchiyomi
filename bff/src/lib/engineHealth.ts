// Health's "Extension engine" check (#72, with #115's Cloudflare evidence): the ONE row about the engine itself.
//
// Before it, nothing on the Health page looked at the engine. extensionCap stayed green through an outage,
// the solver check pinged only Uchiyomi's own FlareSolverr, and an engine whose own Cloudflare helper was off
// (#54) made every protected extension fail while Health said "All good". The per-series rows (frozenSeries)
// say which series wait; this row says why, and what to do about it.
//
// `extensionEngine` decides from facts it is handed and is unit-tested that way; `extensionEngineCheck` gathers
// them, through the memoised probe in extensionEngine.ts so the page never waits more than a few seconds.
import type { HealthCheck, HealthItem } from './health';
import { isDesktop } from './desktop';
import { cloudflareEvidence, engineProbe, linkedSeriesCount, type CloudflareEvidence } from './extensionEngine';
import { suwayomiConfigured } from './sources/suwayomi/client';
import { engineOffReason, type EngineState } from './sources/suwayomi/engineState';
import { ourSolverUrl, solverWiring, type EngineSolver } from './sources/suwayomi/engineSolver';
import { lastSuwayomiLoad, suwayomiRetryState } from './sources/suwayomi/register';

export interface EngineCheckDeps {
  state: EngineState;
  /** Series added through an extension. */
  linked: number;
  desktop: boolean;
  /** Uchiyomi's own solver (FLARESOLVERR_URL), '' when it has none: what Connect would point the engine at. */
  ourSolver: string;
  version?: string | null;
  error?: string | null;
  /** The engine's helper setting; null when it could not be read. Only looked at while `up`. */
  solver: EngineSolver | null;
  retry?: { attempts: number } | null;
  /** Extension sources seen behind Cloudflare lately (extensionEngine.ts cloudflareEvidence). */
  cloudflare: CloudflareEvidence[];
  /** It answers, but the last registration missed it (the retry or the status route registers it shortly). */
  registering?: boolean;
}

const TITLE = 'Extension engine';
const ID = 'extension-engine';
const s = (n: number, one: string, many: string) => (n === 1 ? one : many);
const names = (ev: CloudflareEvidence[]) =>
  ev.slice(0, 5).map((e) => e.name).join(', ') + (ev.length > 5 ? ` and ${ev.length - 5} more` : '');

/**
 * The check, or null when there is nothing to say: no engine and nothing that depends on one (the Docker install
 * someone switched off before adding a single extension series), or a desktop app whose engine was never
 * downloaded -- its SUWAYOMI_URL is always set (desktop/src/env.js), so without this every fresh desktop would
 * open Health on a warning about a download it never asked for.
 */
export function extensionEngine(d: EngineCheckDeps): HealthCheck | null {
  const base = { id: ID, title: TITLE };
  const waiting = `${d.linked} series that came from extensions ${s(d.linked, 'keeps its', 'keep their')} chapters and ${s(d.linked, 'gets', 'get')} no new ones until it is back`;

  if (d.state === 'off' || d.state === 'switched_off') {
    if (!d.linked) return null;
    // Off on purpose is not a fault: the per-series rows already warn (and can be ignored one by one), and a
    // second amber row for the same decision would be the page crying wolf.
    return {
      ...base, status: 'ok',
      summary: d.state === 'switched_off' ? 'Turned off' : 'Not set up',
      note: 'Admin → Extensions shows how to bring it back. Its data is kept while it is off.',
      items: [{ title: 'Series from extensions', detail: waiting, info: true }],
    };
  }
  if (d.desktop && d.state !== 'up' && !d.linked) return null;

  if (d.state === 'unreachable') {
    const tries = d.retry?.attempts ?? 0;
    return {
      ...base, status: 'warn',
      summary: `Not answering${d.error ? ` (${d.error})` : ''}`,
      // The desktop's Admin → Extensions is the engine's installer, with no setup steps and no Check again: the
      // app starts its engine itself. Reintroduce the one note for both: "not answering is a warning…" in
      // engineHealth.test.ts finds a desktop sent to a button it does not have.
      note: 'Uchiyomi asks again every 5 minutes by itself, and its extensions come back without a restart. ' +
        (d.desktop
          ? 'If it stays this way, quit and reopen Uchiyomi, which starts its extension engine again.'
          : 'Admin → Extensions shows what to check for your setup, and Check again there asks at once.'),
      // ⚠️ Always one finding: a warning with nothing under it reads as a broken page (health.ts `verdict`).
      items: [{
        title: 'Not answering',
        detail: (tries ? `asked ${tries} ${s(tries, 'time', 'times')} since it stopped answering` : 'no answer at the last try') +
          (d.linked ? `; ${waiting}` : ''),
      }],
    };
  }

  // Up.
  const version = d.version ? ` (v${d.version.replace(/^v/i, '')})` : '';
  const registering = d.registering ? ' It answers again; its extensions are being registered.' : '';
  // The engine's own words, on a source that is failing now (#115's evidence): "Cloudflare bypass currently
  // disabled". When its setting cannot be read -- just now, or ever, on an engine too old to report it -- this is
  // still proof it cannot use its helper, and the row says so rather than "Answering". Reintroduce by answering
  // these two branches as before: "the engine's own words are proof when its setting cannot be read" in
  // engineHealth.test.ts reads an ok row over a failing source.
  const refusing = d.cloudflare.filter((e) => e.bypass);
  const noSolver = ' Uchiyomi has no Cloudflare helper of its own to share yet: set FLARESOLVERR_URL on Uchiyomi, then connect it here.';
  const cannotUse = (why: string, connect: boolean): HealthCheck => ({
    ...base, status: 'warn',
    summary: 'It cannot use its Cloudflare helper',
    note: `${why}${registering}`,
    items: [{
      title: 'Cloudflare helper',
      detail: `The engine says its own Cloudflare helper is switched off: ${names(refusing)} ${s(refusing.length, 'fails', 'fail')} because of it.` +
        (connect && !d.ourSolver ? noSolver : ''),
      ...(connect && d.ourSolver ? { actions: ['engine_solver' as const] } : {}),
    }],
  });
  if (!d.solver) {
    if (refusing.length) {
      return cannotUse(d.ourSolver
        ? 'Its Cloudflare helper setting could not be read just now. Connect points it at the helper Uchiyomi uses and switches it on; nothing restarts.'
        : 'Its Cloudflare helper setting could not be read just now.', true);
    }
    return { ...base, status: 'ok', summary: `Answering${version}`, note: `Its Cloudflare helper setting could not be read just now.${registering}`, items: [] };
  }
  const wiring = solverWiring(d.solver, d.ourSolver, d.desktop);
  if (wiring === 'unsupported') {
    // No setting to change from here, so no Connect: it is the engine's own configuration (or a newer engine).
    if (refusing.length) {
      return cannotUse(d.desktop
        ? 'This engine version does not report its Cloudflare setting, so Uchiyomi cannot switch it on from here.'
        : "This engine version does not report its Cloudflare setting, so Uchiyomi cannot switch it on: set FLARESOLVERR_ENABLED=true and FLARESOLVERR_URL on the engine's own container, or update the engine.", false);
    }
    return { ...base, status: 'ok', summary: `Answering${version}`, note: `This engine version does not report its Cloudflare setting.${registering}`, items: [] };
  }
  if (wiring === 'ok') {
    return { ...base, status: 'ok', summary: `Ready, and it can get past Cloudflare${version}`, note: registering.trim() || undefined, items: [] };
  }
  if (wiring === 'other') {
    return {
      ...base, status: 'ok', summary: `Ready${version}`, note: registering.trim() || undefined,
      items: [{
        title: 'Cloudflare helper',
        // The address only on a server: on desktop it carries the in-app helper's token.
        detail: d.desktop || !d.solver.supported ? 'on, through a helper other than Uchiyomi’s own'
          : `on, through ${d.solver.url} rather than Uchiyomi’s own helper`,
        info: true,
      }],
    };
  }

  // Off, or pointed at localhost on a server -- where nothing answers, since the engine's own container runs no
  // solver. Only a finding when extension sources are seen behind Cloudflare: an engine whose extensions never
  // meet a challenge loses nothing, and says so as a greyed line with the same one-click fix.
  const failing = d.cloudflare.filter((e) => e.bypass);
  const fronted = d.cloudflare.filter((e) => !e.bypass);
  const why = wiring === 'localhost'
    ? 'it points at localhost, where no helper runs'
    : 'it is switched off';
  const seen = failing.length
    ? ` ${names(failing)} ${s(failing.length, 'fails', 'fail')} because of it.`
    : fronted.length ? ` ${names(fronted)} ${s(fronted.length, 'is', 'are')} behind Cloudflare.` : '';
  // Never on desktop: the shell always gives Uchiyomi its helper.
  const how = d.ourSolver ? '' : noSolver;
  const finding = d.cloudflare.length > 0;
  const item: HealthItem = {
    title: 'Cloudflare helper',
    detail: `The engine’s own Cloudflare helper is not in use: ${why}. Extension sources on Cloudflare-protected sites fail until it is.${seen}${how}`,
    ...(d.ourSolver ? { actions: ['engine_solver'] } : {}),
    ...(finding ? {} : { info: true }),
  };
  return {
    ...base,
    status: finding ? 'warn' : 'ok',
    summary: finding ? 'Its Cloudflare helper is not in use' : `Ready${version}; its Cloudflare helper is not in use`,
    note: `Connect points it at the helper Uchiyomi uses and switches it on; nothing restarts, and it stays that way unless the engine’s own container names another helper.${registering}`,
    items: [item],
  };
}

/** The check as runHealthChecks calls it: the facts, gathered without ever waiting long on the engine. */
export async function extensionEngineCheck(): Promise<HealthCheck | null> {
  const desktop = isDesktop();
  const linked = await linkedSeriesCount();
  if (!suwayomiConfigured()) {
    return extensionEngine({
      state: engineOffReason() === 'switch' ? 'switched_off' : 'off',
      linked, desktop, ourSolver: ourSolverUrl(), solver: null, cloudflare: [],
    });
  }
  const [probe, cloudflare] = await Promise.all([engineProbe(), cloudflareEvidence()]);
  return extensionEngine({
    state: probe.reachable ? 'up' : 'unreachable',
    linked, desktop,
    ourSolver: ourSolverUrl(),
    version: probe.version,
    error: probe.error,
    solver: probe.solver,
    retry: suwayomiRetryState(),
    cloudflare,
    registering: probe.reachable && !lastSuwayomiLoad()?.reachable,
  });
}
