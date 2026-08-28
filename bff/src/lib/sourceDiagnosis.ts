// Why a source is failing, in words, and what to do about it.
//
// `source_health` has always stored the reason -- `last_error` is populated and has been for as long as the
// table has existed -- but it stores whatever string happened to reach the catch block. On a real install
// that means five of six broken sources say the literal word "timeout" while being broken in three
// completely different ways: a domain that moved, a CDN returning 403, and a Cloudflare solver whose own
// browser had crashed. "down" is a confident wrong answer for four of those five.
//
// This module turns the stored evidence (plus a live probe, when someone has just gone and looked) into a
// code, a sentence anyone may read, and a fix only an admin should see. It is deliberately pure: no db, no
// fetch, no imports beyond a type. That is what lets its test run without a database and assert against the
// verbatim strings production actually holds.
import type { SourceStatus } from './sourceHealth';

export type DiagnosisCode =
  | 'ok'
  | 'disabled'
  | 'moved'           // the site now redirects to a different host
  | 'edge_403'        // the CDN refuses this server outright; not solvable by a challenge solver
  | 'cf_challenge'    // a Cloudflare interstitial we did not get past
  | 'solver_crash'    // FlareSolverr's own browser died
  | 'solver_down'     // FlareSolverr is not answering at all
  | 'solver_timeout'  // the challenge did not finish inside the solver's budget
  | 'timeout'         // WE gave up. Says nothing about why, and must not pretend otherwise.
  | 'too_slow'        // WE gave up, repeatedly, and the site is answering -- just not fast enough.
  | 'markup_drift'    // answers fine, parses to nothing
  | 'unreachable'     // DNS failure, refused connection, gone
  | 'rate_limited'
  | 'upstream_down'   // the extension server, not the site
  | 'unknown';

/** Who can act on this, which is what decides whether the UI offers a button or asks for patience. */
export type Actor = 'admin' | 'wait' | 'none';

export interface HealthFacts {
  status: SourceStatus;
  lastError: string | null;
  consecutive: number;
  lastOkAt: string | null;
  emptyStreak: number;
  blockedUntil: string | null;
  disabled: boolean;
  /** Times our own budget ran out. Distinct from a failure: see `reportSlow`. */
  slowStreak?: number;
  /** The budget those timeouts ran out of, so the advice can name a number. */
  budgetMs?: number;
}

/** Live evidence. Optional by design: most callers have only what is in the table. */
export interface Probe {
  /** 0 when no HTTP answer was ever received. */
  httpStatus: number;
  /** After redirects, so a moved domain shows up as a different host. */
  finalUrl?: string;
  /** 'ENOTFOUND' | 'ECONNREFUSED' | 'timeout' | ... when the transport failed before HTTP. */
  transport?: string;
  looksHtml?: boolean;
  /**
   * Did the ADAPTER work, just now? This outranks everything: a source that can search, list chapters and
   * serve pages is working, whatever a bare HTTP request to its homepage made of it.
   */
  adapterOk?: boolean;
  /**
   * Does this source normally reach its site through the Cloudflare solver?
   *
   * If so, a 403 or 503 from `probeBase` is the EXPECTED answer and carries no information: the probe
   * deliberately does not use the solver, so it is seeing the challenge everybody sees. Reading it as "the
   * CDN is blocking this server" reported the healthiest source on one install -- 190 series, working --
   * as blocked.
   */
  needsSolver?: boolean;
}

export interface Diagnosis {
  code: DiagnosisCode;
  /**
   * One sentence, safe for any signed-in reader. Never contains a hostname, a component name, an HTTP
   * status or any part of `last_error`. This is a closed set of hand-written sentences rather than a
   * sanitised version of the stored string, because a scrubber eventually leaks and a fixed list cannot.
   */
  reason: string;
  /** ADMIN ONLY. May name FlareSolverr, compose files, config paths, and the host a site moved to. */
  fix: string;
  actor: Actor;
  /** True when the failure never threw. The class of bug this whole module exists to make visible. */
  silent: boolean;
  /** True when the stored evidence cannot identify a cause and only a live probe will. */
  needsProbe: boolean;
}

/** Enough empties in a row to mean something. Each one is a separate ten-minute cache window. */
export const EMPTY_SUSPECT = 3;

const D = (
  code: DiagnosisCode, reason: string, fix: string, actor: Actor,
  opts: { silent?: boolean; needsProbe?: boolean } = {},
): Diagnosis => ({ code, reason, fix, actor, silent: !!opts.silent, needsProbe: !!opts.needsProbe });

const NEEDS_ADMIN = 'This source needs a check from an admin.';

/**
 * Stored-error rules, most specific first. **The ordering is the whole game.**
 *
 * Both of FlareSolverr's real failure strings contain the word "challenge":
 *   "Error solving the challenge. Message: Service /app/chromedriver unexpectedly exited."
 *   "Error solving the challenge. HTTPConnectionPool(...): Max retries exceeded with url: /session"
 * so a cascade that tests /cloudflare|challenge/ first swallows every solver fault and reports that the
 * site is blocking you, when the site is fine and the fix is to restart a container. The solver rules MUST
 * come before `cf_challenge`, and there is a test that reintroduces exactly that mistake.
 */
const RULES: Array<[RegExp, () => Diagnosis]> = [
  [/chromedriver.*exited|devtoolsactiveport|session not created/i, () =>
    D('solver_crash', NEEDS_ADMIN,
      "The Cloudflare solver's browser crashed. Chrome in Docker needs far more than the default 64 MB of shared memory: set shm_size: 1gb on the flaresolverr service and recreate it.",
      'admin')],

  [/httpconnectionpool|max retries exceeded|newconnectionerror|failed to establish a new connection/i, () =>
    D('solver_down', NEEDS_ADMIN,
      'The Cloudflare solver is not answering. Check the container is up and FLARESOLVERR_URL is right. It also leaks memory, so it wants a periodic restart.',
      'admin')],

  [/timeout after [\d.]+ seconds|error solving the challenge/i, () =>
    D('solver_timeout', NEEDS_ADMIN,
      'The site presented a Cloudflare challenge the solver could not finish in time. Often transient, so re-test first. If it persists, the site has raised its protection.',
      'admin')],

  [/just a moment|cf-chl|cf_clearance|cloudflare|challenge/i, () =>
    D('cf_challenge', 'This source is protected by a check we could not get past.',
      'A Cloudflare interstitial was served and not solved. Confirm the solver is healthy, then re-test.',
      'admin')],

  [/\b403\b|forbidden|access denied/i, () =>
    D('edge_403', 'This source is blocking this server right now.',
      "The site's CDN is refusing this server outright with a 403. A challenge solver cannot fix that; it is usually a datacentre-IP block. Change egress or drop the source.",
      'admin')],

  [/\b429\b|rate.?limit|too many requests|slow down/i, () =>
    D('rate_limited', 'This source asked us to slow down.',
      'Nothing to do. The cooldown widens automatically and clears itself.', 'wait')],

  [/^suwayomi\b|suwayomi \d{3}|suwayomi returned no data/i, () =>
    D('upstream_down', 'The extension server did not answer.',
      'This is the Suwayomi extension server, not the site. Check that container.', 'admin')],

  [/enotfound|eai_again|econnrefused/i, () =>
    D('unreachable', 'This source is not answering right now.',
      'The address could not be reached at all. Check the URL. The site may be gone.', 'admin')],

  // Deliberately last, and deliberately NOT confident. `withTimeout` throws this after discarding whatever
  // the adapter knew, so on a real install it covers a moved domain, a 403 and a dead solver at the same
  // time. Guessing here is how you tell someone to go and fix the wrong thing.
  [/^timeout\b/i, () =>
    D('timeout', 'This source did not answer in time.',
      'A timeout alone does not say why. Re-test it: that distinguishes a moved domain, a challenge that never completed, and a genuinely slow site.',
      'admin', { needsProbe: true })],
];

const hostOf = (u?: string): string | null => {
  if (!u) return null;
  try { return new URL(u).host.replace(/^www\./, ''); } catch { return null; }
};

const MARKUP_DRIFT = 'This source stopped listing new titles. An admin needs to check it.';

/**
 * What is wrong with this source, and what to do.
 *
 * Live evidence beats stored evidence, always. A stored error can be months old: on the install this was
 * built against, one source's `last_error` predated the running container by 62 days. If someone has just
 * probed the site, what the site said a second ago wins.
 */
export function diagnose(f: HealthFacts, probe?: Probe, baseUrl?: string): Diagnosis {
  if (f.disabled) {
    return D('disabled', 'This source is switched off.', 'Turn it back on in Admin, Sources, Providers.', 'admin');
  }

  const err = f.lastError || '';
  const suspect = f.emptyStreak >= EMPTY_SUSPECT;

  if (probe) {
    // The adapter did the whole job a moment ago. Nothing a homepage request says can outrank that, and
    // pretending otherwise is how a working source gets reported as broken.
    if (probe.adapterOk) return D('ok', '', '', 'none');

    const base = hostOf(baseUrl);
    const now = hostOf(probe.finalUrl);
    if (base && now && base !== now) {
      return D('moved', "This source's website moved. An admin needs to point it at the new address.",
        `The site now redirects to ${now}. Update its address in Admin, Sources, Providers.`, 'admin');
    }
    if (probe.transport && /enotfound|eai_again|econnrefused/i.test(probe.transport)) {
      return D('unreachable', 'This source is not answering right now.',
        `The address could not be reached (${probe.transport}). Check the URL. The site may be gone.`, 'admin');
    }
    // Only meaningful for a source that does NOT go through the solver. For one that does, this is just the
    // challenge page and says nothing about whether the source works.
    if (probe.httpStatus === 403 && !probe.needsSolver) {
      return D('edge_403', 'This source is blocking this server right now.',
        "The site's CDN answered 403 to a direct request. A challenge solver cannot fix that; it is usually a datacentre-IP block.",
        'admin');
    }
    if (probe.httpStatus === 429) {
      return D('rate_limited', 'This source asked us to slow down.',
        'Nothing to do. The cooldown widens automatically and clears itself.', 'wait');
    }
    // The inference that matters most: the site answered us fine from this very container, so whatever the
    // stored error blames, the broken component is the solver and not the site.
    if (probe.httpStatus === 200 && /flaresolverr/i.test(err)) {
      const hit = RULES.find(([re]) => re.test(err))?.[1]();
      if (hit && hit.code.startsWith('solver_')) return hit;
      return D('solver_down', NEEDS_ADMIN,
        'The site answers fine from this server, so the Cloudflare solver is the broken part. Check that container.',
        'admin');
    }
    if (probe.httpStatus === 200 && probe.looksHtml && suspect) {
      return D('markup_drift', MARKUP_DRIFT,
        'The site answers, but its listing no longer matches the parser, so the site changed its markup. Re-add it with auto-detect to re-pick the engine.',
        'admin', { silent: true });
    }
  }

  // Before the stored-error rules, because a slow source's `last_error` is literally "timeout after Nms" and
  // the generic timeout rule would shrug at it. Repeatedly outrunning the budget is not an unknown cause; it
  // is a known one with a specific fix, and it is the fault that made a working source disappear.
  if ((f.slowStreak ?? 0) >= EMPTY_SUSPECT) {
    const budget = f.budgetMs ? `${Math.round(f.budgetMs / 1000)}s` : 'the time allowed';
    return D('too_slow',
      'This source answers, but more slowly than it is given.',
      `It keeps taking longer than ${budget} to return its newest page. Raise SOURCE_LATEST_TIMEOUT_MS if the wait is acceptable; otherwise the site itself, or the Cloudflare solver in front of it, is the slow part.`,
      'admin');
  }

  for (const [re, make] of RULES) if (re.test(err)) return make();

  if (suspect) {
    return D('markup_drift', MARKUP_DRIFT,
      'It answers without an error but returns nothing, which usually means the site changed its markup or is serving a challenge page. Re-test it to find out which.',
      'admin', { silent: true, needsProbe: true });
  }

  if (err) {
    return D('unknown', NEEDS_ADMIN,
      'The recorded error does not match anything known. Re-test it for a live verdict.', 'admin', { needsProbe: true });
  }

  return D('ok', '', '', 'none');
}
