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
import { solverPingShared } from './sources/flaresolverr';
import { detailOf, joined, noteOf, say, saidOf, summaryOf, type Part } from './said';

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
  /**
   * Whether Uchiyomi's own solver answers, as Health's Cloudflare solver row read it (flaresolverr.ts
   * solverPingShared). Asked only while the engine's helper points at it; null or absent when not asked.
   */
  solverAnswering?: boolean | null;
}

const TITLE = 'Extension engine';
const ID = 'extension-engine';
/** The sources a sentence names: the first five, and how many more (lib/said.ts). */
const named = (ev: CloudflareEvidence[]) => ({ names: ev.slice(0, 5).map((e) => e.name), more: Math.max(0, ev.length - 5), n: ev.length });
/** A row's title the server words ("Cloudflare helper"), with its code. */
const titled = (p: Part) => ({ title: p.text, titleSaid: saidOf(p) });

/**
 * The check, or null when there is nothing to say: no engine and nothing that depends on one (the Docker install
 * someone switched off before adding a single extension series), or a desktop app whose engine was never
 * downloaded -- its SUWAYOMI_URL is always set (desktop/src/env.js), so without this every fresh desktop would
 * open Health on a warning about a download it never asked for.
 */
export function extensionEngine(d: EngineCheckDeps): HealthCheck | null {
  const base = { id: ID, title: TITLE };
  const waiting = say('engine.waiting', { n: d.linked });

  if (d.state === 'off' || d.state === 'switched_off') {
    if (!d.linked) return null;
    // Off on purpose is not a fault: the per-series rows already warn (and can be ignored one by one), and a
    // second amber row for the same decision would be the page crying wolf.
    return {
      ...base, status: 'ok',
      ...summaryOf([say(d.state === 'switched_off' ? 'engine.switchedOff' : 'engine.notSetUp')]),
      ...noteOf([say('engine.offNote')]),
      items: [{ ...titled(say('engine.fromExtensions')), ...detailOf([waiting]), info: true }],
    };
  }
  if (d.desktop && d.state !== 'up' && !d.linked) return null;

  if (d.state === 'unreachable') {
    const tries = d.retry?.attempts ?? 0;
    return {
      ...base, status: 'warn',
      ...summaryOf([say('engine.notAnswering', { error: d.error || null })]),
      // The desktop's Admin → Extensions is the engine's installer, with no setup steps and no Check again: the
      // app starts its engine itself. Reintroduce the one note for both: "not answering is a warning…" in
      // engineHealth.test.ts finds a desktop sent to a button it does not have.
      ...noteOf([say('engine.retries'), joined('sentence', say(d.desktop ? 'engine.reopen' : 'engine.checkAgain'))]),
      // ⚠️ Always one finding: a warning with nothing under it reads as a broken page (health.ts `verdict`).
      items: [{
        ...titled(say('engine.notAnsweringTitle')),
        ...detailOf([tries ? say('engine.asked', { n: tries }) : say('engine.noAnswer'), d.linked > 0 && waiting]),
      }],
    };
  }

  // Up.
  const version = d.version || null;
  const registering = d.registering ? joined('sentence', say('engine.registering')) : null;
  // The engine's own words, on a source that is failing now (#115's evidence): "Cloudflare bypass currently
  // disabled". When its setting cannot be read -- just now, or ever, on an engine too old to report it -- this is
  // still proof it cannot use its helper, and the row says so rather than "Answering". Reintroduce by answering
  // these two branches as before: "the engine's own words are proof when its setting cannot be read" in
  // engineHealth.test.ts reads an ok row over a failing source.
  const refusing = d.cloudflare.filter((e) => e.bypass);
  const noSolver = joined('sentence', say('engine.noSolver'));
  const cannotUse = (why: Part, connect: boolean): HealthCheck => ({
    ...base, status: 'warn',
    ...summaryOf([say('engine.cannotUse')]),
    ...noteOf([why, registering]),
    items: [{
      ...titled(say('engine.helper')),
      ...detailOf([say('engine.helperOff', named(refusing)), connect && !d.ourSolver && noSolver]),
      ...(connect && d.ourSolver ? { actions: ['engine_solver' as const] } : {}),
    }],
  });
  if (!d.solver) {
    if (refusing.length) return cannotUse(say(d.ourSolver ? 'engine.unreadConnect' : 'engine.unread'), true);
    return { ...base, status: 'ok', ...summaryOf([say('engine.answering', { version })]), ...noteOf([say('engine.unread'), registering]), items: [] };
  }
  const wiring = solverWiring(d.solver, d.ourSolver, d.desktop);
  if (wiring === 'unsupported') {
    // No setting to change from here, so no Connect: it is the engine's own configuration (or a newer engine).
    if (refusing.length) return cannotUse(say(d.desktop ? 'engine.unsupportedDesktop' : 'engine.unsupportedServer'), false);
    return { ...base, status: 'ok', ...summaryOf([say('engine.answering', { version })]), ...noteOf([say('engine.unsupported'), registering]), items: [] };
  }
  // Registering, and nothing else to say: the note is that sentence alone.
  const alone = registering ? say('engine.registering') : null;
  if (wiring === 'ok') {
    // Pointed at Uchiyomi's own solver, which is a way past Cloudflare only while it answers. After Connect this row
    // said "it can get past Cloudflare" beside the solver's own row saying it was not answering (v0.49.1): it says
    // what that row says now, from the same ping. A finding only while extension sources are seen behind Cloudflare,
    // as for a helper that is off below; otherwise a greyed line. No Connect: it is connected, and the fix is the
    // solver's, which its own row names.
    // Reintroduce by answering "Ready, and it can get past Cloudflare" whatever the solver said: "a solver that is
    // not answering" in engineHealth.test.ts reads it.
    if (d.solverAnswering === false) {
      const finding = d.cloudflare.length > 0;
      const seen = finding ? ` ${say('engine.fronted', named(d.cloudflare)).text}` : '';
      return {
        ...base,
        status: finding ? 'warn' : 'ok',
        summary: finding ? 'Its Cloudflare helper is not answering' : `${say('engine.ready', { version }).text}; its Cloudflare helper is not answering`,
        ...noteOf([alone]),
        items: [{
          title: 'Cloudflare helper',
          detail: 'It is connected to Uchiyomi’s own Cloudflare helper, which is not answering (the Cloudflare solver row says '
            + `what to do). Extension sources on Cloudflare-protected sites fail until it answers again.${seen}`,
          ...(finding ? {} : { info: true }),
        }],
      };
    }
    return { ...base, status: 'ok', ...summaryOf([say('engine.readyCloudflare', { version })]), ...noteOf([alone]), items: [] };
  }
  if (wiring === 'other') {
    return {
      ...base, status: 'ok', ...summaryOf([say('engine.ready', { version })]), ...noteOf([alone]),
      items: [{
        ...titled(say('engine.helper')),
        // The address only on a server: on desktop it carries the in-app helper's token.
        ...detailOf([d.desktop || !d.solver.supported ? say('engine.otherHelper') : say('engine.otherHelperAt', { url: d.solver.url })]),
        info: true,
      }],
    };
  }

  // Off, or pointed at localhost on a server -- where nothing answers, since the engine's own container runs no
  // solver. Only a finding when extension sources are seen behind Cloudflare: an engine whose extensions never
  // meet a challenge loses nothing, and says so as a greyed line with the same one-click fix.
  const failing = d.cloudflare.filter((e) => e.bypass);
  const fronted = d.cloudflare.filter((e) => !e.bypass);
  const seen = failing.length ? say('engine.failing', named(failing))
    : fronted.length ? say('engine.fronted', named(fronted)) : null;
  const finding = d.cloudflare.length > 0;
  const item: HealthItem = {
    ...titled(say('engine.helper')),
    ...detailOf([
      say(wiring === 'localhost' ? 'engine.localhost' : 'engine.helperIsOff'),
      // 'then', never 'sentence': it opens on the sources' names, which are theirs to spell ("mangapill fails
      // because of it.", "comick.io is behind Cloudflare."). A raised first letter renamed them. Reintroduce
      // 'sentence': "a source is named as it names itself" in engineHealth.test.ts fails.
      seen && joined('then', seen),
      // Never on desktop: the shell always gives Uchiyomi its helper.
      !d.ourSolver && noSolver,
    ]),
    ...(d.ourSolver ? { actions: ['engine_solver'] } : {}),
    ...(finding ? {} : { info: true }),
  };
  return {
    ...base,
    status: finding ? 'warn' : 'ok',
    ...summaryOf([finding ? say('engine.notInUse') : say('engine.readyNotInUse', { version })]),
    ...noteOf([say('engine.connectNote'), registering]),
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
  const ours = ourSolverUrl();
  // The solver row's own ping (shared for a few seconds), and only when the engine's helper is Uchiyomi's solver: an
  // engine that is down, or points elsewhere, has nothing to learn from it.
  const viaOurs = probe.reachable && !!probe.solver && solverWiring(probe.solver, ours, desktop) === 'ok';
  const solverAnswering = viaOurs ? (await solverPingShared()).ok : null;
  return extensionEngine({
    state: probe.reachable ? 'up' : 'unreachable',
    linked, desktop,
    ourSolver: ours,
    version: probe.version,
    error: probe.error,
    solver: probe.solver,
    retry: suwayomiRetryState(),
    cloudflare,
    registering: probe.reachable && !lastSuwayomiLoad()?.reachable,
    solverAnswering,
  });
}
