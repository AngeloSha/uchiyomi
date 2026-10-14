// Health's "Extension engine" check (#72, with #115's Cloudflare evidence): the ONE row about the engine itself.
//
// Before it, nothing on the Health page looked at the engine. extensionCap stayed green through an outage,
// the solver check pinged only Uchiyomi's own FlareSolverr, and an engine whose own Cloudflare helper was off
// (#54) made every protected extension fail while Health said "All good". The per-series rows (frozenSeries)
// say which series wait; this row says why, and what to do about it.
//
// `extensionEngine` decides from facts it is handed and is unit-tested that way; `extensionEngineCheck` gathers
// them, through the memoised probe in extensionEngine.ts so the page never waits more than a few seconds.
//
// Since the engine upgrade it also says how the engine's version stands against the one this Uchiyomi was tested with
// (sources/suwayomi/enginePin.ts), and when the engine refuses Uchiyomi's queries it says "Not compatible" -- quoting
// the engine -- where it used to say "Not answering" and send the admin to restart a container that was fine.
import type { HealthCheck, HealthItem } from './health';
import { isDesktop } from './desktop';
import { installPlatform, type InstallPlatform } from './platform';
import { cloudflareEvidence, engineProbe, linkedSeriesCount, type CloudflareEvidence } from './extensionEngine';
import { suwayomiConfigured, type EngineRefusal } from './sources/suwayomi/client';
import { engineStanding, OLDEST_ENGINE, TESTED_ENGINE, type EngineStanding } from './sources/suwayomi/enginePin';
import { engineOffReason, type EngineState } from './sources/suwayomi/engineState';
import { ourSolverUrl, solverWiring, type EngineSolver } from './sources/suwayomi/engineSolver';
import { lastSuwayomiLoad, suwayomiRetryState } from './sources/suwayomi/register';
import { solverPingShared } from './sources/flaresolverr';
import { detailOf, joined, noteOf, say, saidOf, summaryOf, type Part } from './said';

export interface EngineCheckDeps {
  /** `incompatible`: it answers, and refused something Uchiyomi asked (`refused` says what). */
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
  /** What the engine refused, by operation, in its own words (client.ts engineRefusals). */
  refused?: EngineRefusal[];
  /** Where it runs, for the steps that change its version (platform.ts). Absent: the steps for "somewhere else". */
  platform?: InstallPlatform;
  /** The versions it is compared with; enginePin.ts's unless a test says otherwise. */
  tested?: string;
  oldest?: string;
}

const TITLE = 'Extension engine';
const ID = 'extension-engine';
/** The sources a sentence names: the first five, and how many more (lib/said.ts). */
const named = (ev: CloudflareEvidence[]) => ({ names: ev.slice(0, 5).map((e) => e.name), more: Math.max(0, ev.length - 5), n: ev.length });
/** A row's title the server words ("Cloudflare helper"), with its code. */
const titled = (p: Part) => ({ title: p.text, titleSaid: saidOf(p) });

/** The engine's image at a version: what each platform's step names, never translated (it is a parameter). */
export const engineImage = (version: string) => `ghcr.io/suwayomi/suwayomi-server:${version}`;
/** The engine's service in every shipped compose file, and its container on Unraid and CasaOS. */
const SERVICE = 'uchiyomi-suwayomi';
/** Where the Unraid template and the CasaOS add-on keep the engine's data (templates/, deploy/casaos/). */
const DATA_PATH: Partial<Record<InstallPlatform, string>> = {
  unraid: '/mnt/user/appdata/uchiyomi-suwayomi',
  casaos: '/DATA/AppData/uchiyomi-suwayomi',
};

/**
 * How to run `version` of the engine on this platform, as one sentence. The image, the service, the path and the
 * command are parameters: a translator can reword the sentence and never break what someone copies out of it.
 */
function stepTo(version: string, platform: InstallPlatform | undefined): Part {
  const image = engineImage(version);
  switch (platform) {
    case 'compose': return say('engine.stepCompose', { image, file: 'docker-compose.yml', command: `docker compose up -d ${SERVICE}` });
    case 'unraid': return say('engine.stepUnraid', { image, service: SERVICE, path: DATA_PATH.unraid! });
    case 'casaos': return say('engine.stepCasaos', { image, service: SERVICE, path: DATA_PATH.casaos! });
    case 'desktop': return say('engine.stepDesktop');
    default: return say('engine.stepOther', { image });
  }
}

/**
 * The version row, shown only when the engine's version is not the one this Uchiyomi was tested with: older but
 * supported (a greyed line, with how to update), older than the oldest supported (a finding: update it), or newer (a
 * greyed line). ⚠️ Never a downgrade without a backup: an engine migrates its own database forward when it starts, and an
 * older one cannot read what a newer one wrote -- so for a newer engine the row says that going back needs a backup of
 * its data from before, and nothing more. The step to update an older one starts with that backup too, for the same
 * reason (since the pin moved to v2.4.2366, every install left on v2.3.2243 reads this row) -- except on the desktop
 * app, which keeps a copy of the engine's database itself before a new engine first starts (desktop/src/engine.js).
 */
function versionItem(d: EngineCheckDeps, standing: EngineStanding): HealthItem | null {
  const version = d.version || null;
  const tested = d.tested ?? TESTED_ENGINE;
  const oldest = d.oldest ?? OLDEST_ENGINE;
  if (!version || standing === 'same' || standing === 'unknown') return null;
  const title = titled(say('engine.versionTitle'));
  if (standing === 'newer') {
    return {
      ...title, info: true,
      ...detailOf([say('engine.versionNewer', { version, tested }), joined('sentence', say('engine.goBackWithBackup', { tested }))]),
    };
  }
  const backup = d.platform !== 'desktop' && joined('sentence', say('engine.backupFirst'));
  if (standing === 'older') {
    return {
      ...title, info: true,
      ...detailOf([say('engine.versionOlder', { version, tested }), backup, joined('sentence', stepTo(tested, d.platform))]),
    };
  }
  return { ...title, ...detailOf([say('engine.versionTooOld', { version, oldest }), backup, joined('sentence', stepTo(tested, d.platform))]) };
}

/**
 * The engine answers and refuses what Uchiyomi asks (#72's "unreachable" was this, too, until the engine upgrade). One
 * finding quotes it and says what to do, by how its version stands: older, update the engine; newer, update Uchiyomi
 * (or go back, with a backup); unknown or the same, run the tested version -- with a backup first, since nobody can tell
 * which way that goes.
 */
function incompatible(d: EngineCheckDeps, standing: EngineStanding): HealthCheck {
  const version = d.version || null;
  const tested = d.tested ?? TESTED_ENGINE;
  const words = d.refused?.[0]?.message || (d.error ?? '').replace(/^suwayomi: /, '') || null;
  const older = standing === 'older' || standing === 'tooOld';
  const advice = older ? say('engine.updateEngine', { tested })
    : standing === 'newer' ? say('engine.updateUchiyomi', { tested })
      : say('engine.matchEngine', { tested });
  const extra = versionItem(d, standing);
  return {
    id: ID, title: TITLE, status: 'warn',
    ...summaryOf([say('engine.incompatible', { version })]),
    ...noteOf([say('engine.incompatibleNote')]),
    items: [
      {
        ...titled(say('engine.incompatibleTitle')),
        ...detailOf([
          words ? say('engine.refused', { error: words.slice(0, 300) }) : null,
          joined('sentence', advice),
          !older && d.platform !== 'desktop' && joined('sentence', say('engine.backupFirst')),
          joined('sentence', stepTo(tested, d.platform)),
        ]),
      },
      // The version row says the same versions again; only a newer engine's adds anything (go back only with a backup).
      ...(extra && standing === 'newer' ? [extra] : []),
    ],
  };
}

/** A check as it was, with the version row added; a version row that is a finding makes the check one. */
function withVersion(c: HealthCheck, item: HealthItem | null): HealthCheck {
  if (!item) return c;
  return { ...c, status: item.info || c.status !== 'ok' ? c.status : 'warn', items: [...c.items, item] };
}

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
  // A desktop whose engine was never downloaded; one that answers and refuses is worth its row, linked series or not.
  if (d.desktop && d.state === 'unreachable' && !d.linked) return null;

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

  const standing = engineStanding(d.version, d.tested ?? TESTED_ENGINE, d.oldest ?? OLDEST_ENGINE);
  // Before "Up": an engine that refuses Uchiyomi's queries answers, so it is not "Not answering" -- and not ready.
  // Reintroduce by dropping this branch: "a refusal is Not compatible, never Not answering" in engineHealth.test.ts
  // reads "Ready".
  if (d.state === 'incompatible') return incompatible(d, standing);
  return withVersion(up(d), versionItem(d, standing));
}

/** The engine answers and takes what it is asked: its Cloudflare helper is what is left to say. */
function up(d: EngineCheckDeps): HealthCheck {
  const base = { id: ID, title: TITLE };
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
      return {
        ...base,
        status: finding ? 'warn' : 'ok',
        ...summaryOf([finding ? say('engine.solverQuiet') : say('engine.readySolverQuiet', { version })]),
        ...noteOf([alone]),
        items: [{
          ...titled(say('engine.helper')),
          // 'then', as below: the sentence opens on the sources' names, which are theirs to spell.
          ...detailOf([say('engine.solverQuietDetail'), finding && joined('then', say('engine.fronted', named(d.cloudflare)))]),
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
  // What it refused, as of now: the probe's own aboutServer refusal is recorded too (client.ts).
  const refused = probe.reachable ? probe.refused : [];
  // The solver row's own ping (shared for a few seconds), and only when the engine's helper is Uchiyomi's solver: an
  // engine that is down, or points elsewhere, has nothing to learn from it. The MAIN solver's answer (v0.55.3): Connect
  // points the engine at FLARESOLVERR_URL alone, so a backup solving for Uchiyomi does nothing for the engine.
  // Reintroduce `.ok` (at least one answers): "the engine row reads the main solver" in extensionsEngine.int.test.ts
  // finds it saying the engine can get past Cloudflare while its helper does not answer.
  const viaOurs = probe.reachable && !!probe.solver && solverWiring(probe.solver, ours, desktop) === 'ok';
  const solverAnswering = viaOurs ? (await solverPingShared()).main.ok : null;
  return extensionEngine({
    state: !probe.reachable ? 'unreachable' : refused.length ? 'incompatible' : 'up',
    linked, desktop,
    ourSolver: ours,
    version: probe.version,
    error: probe.error,
    solver: probe.solver,
    retry: suwayomiRetryState(),
    cloudflare,
    registering: probe.reachable && !refused.length && !lastSuwayomiLoad()?.reachable,
    solverAnswering,
    refused,
    platform: installPlatform(),
  });
}
