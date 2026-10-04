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
// fetch, no imports beyond a type and lib/desktop.ts (which imports nothing of ours). That is what lets its
// test run without a database and assert against the verbatim strings production actually holds.
//
// The fixes that send an admin to a container, a compose file or an env var go through `forDesktop`: the
// desktop app has none of those, and its answer is Uchiyomi's own built-in helper and a restart.
//
// v0.49.1: the web says both halves in the reader's language. A reason is its code's (REASONS); a fix carries a
// code of its own (FixCode, with the stage or host that fills it) beside its English, which web/lib/said.ts
// words -- and web/test/said.test.ts runs diagnose() over every rule and holds the two to each other.
import type { SourceStatus } from './sourceHealth';
import type { Stage } from './sourceEvidence';
import type { Said } from './said';
import { forDesktop } from './desktop';

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
  | 'upstream_down'   // the extension server did not answer (unreachable, refused, its own HTTP error)
  | 'extension_error' // the extension server DID answer, with the extension's own error (#115)
  | 'unnumbered'      // chapters are listed, but none with a number Uchiyomi can use (#115)
  | 'site_offline'    // the site answers with its own offline or maintenance notice (v0.49.1, lib/sources/offline.ts)
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
  /**
   * What the site's homepage answered to a bare request. 0 when a request was made and no HTTP answer ever
   * came back (the transport failed; see `transport`). ABSENT when no request was made at all: an adapter
   * with no `base` to probe, which is every Suwayomi/extension source, because the engine talks to the
   * site and this server never does. The two must stay distinct. PR #56 first encoded "not asked" as 0,
   * and while no rule happened to fire on it, a status of 0 reads as "the site is unreachable" to the next
   * person who adds a rule keyed on it -- and every extension source would then diagnose as down.
   */
  httpStatus?: number;
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
  /**
   * Where the live test just failed, and how (#115). Live evidence of the most specific kind: the stage, and the
   * error as it was thrown a moment ago. `timeout` is our own deadline and proves nothing by itself.
   */
  failure?: { stage: Stage; kind: 'error' | 'empty' | 'timeout' | 'unnumbered' | 'site_offline' | 'rate_limited'; error?: string | null };
}

/** The stage as a phrase for the admin's fix sentence ("while listing pages"); never in a public `reason`. */
export const STAGE_WORD: Record<Stage, string> = {
  search: 'searching',
  chapters: 'listing chapters',
  pages: 'listing pages',
  images: 'downloading images',
};

/**
 * The stored `last_error`, or null when it is history: a success newer than the last failure (and the last
 * slow answer) means the words describe an afternoon that is over. `reportOk` never clears the string, so every
 * reader of it needs this, and three had their own copy or none (#115: the Test button diagnosed a new failure
 * from a months-old #54 string).
 */
export function currentError(row: {
  last_error?: string | null; last_ok_at?: string | Date | null; last_fail_at?: string | Date | null; last_slow_at?: string | Date | null;
} | null | undefined): string | null {
  if (!row?.last_error) return null;
  const at = (t: string | Date | null | undefined) => (t ? new Date(t).getTime() : 0);
  const history = at(row.last_ok_at) > Math.max(at(row.last_fail_at), at(row.last_slow_at));
  return history ? null : row.last_error;
}

export interface Diagnosis {
  code: DiagnosisCode;
  /**
   * One sentence, safe for any signed-in reader. Never contains a hostname, a component name, an HTTP
   * status or any part of `last_error`. This is a closed set of hand-written sentences rather than a
   * sanitised version of the stored string, because a scrubber eventually leaks and a fixed list cannot.
   * It is always its code's (REASONS), so the web words it by `code`.
   */
  reason: string;
  /** ADMIN ONLY. May name FlareSolverr, compose files, config paths, and the host a site moved to. */
  fix: string;
  /** v0.49.1: `fix` as its code and what fills it, for the web to word (absent for no fix, or one written without). */
  fixSaid?: Said;
  actor: Actor;
  /** True when the failure never threw. The class of bug this whole module exists to make visible. */
  silent: boolean;
  /** True when the stored evidence cannot identify a cause and only a live probe will. */
  needsProbe: boolean;
}

/** Enough empties in a row to mean something. Each one is a separate ten-minute cache window. */
export const EMPTY_SUSPECT = 3;

/**
 * Every fix, by code. A fix that names the stage it failed at (`stage`), the host a site moved to (`host`), the
 * transport's error (`transport`) or the latest-page budget (`seconds`) carries it as a parameter; one with a
 * desktop wording keeps one code, and the web picks the words the way the server picked them (isDesktop).
 */
export type FixCode =
  | 'fix.solverCrash' | 'fix.solverDown' | 'fix.solverTimeout' | 'fix.bypassOff' | 'fix.engineLogin' | 'fix.engineDown'
  | 'fix.engineTimeout' | 'fix.challenge' | 'fix.cdnRefuses' | 'fix.rateLimited' | 'fix.unreachable' | 'fix.siteTimeout'
  | 'fix.extensionFailed' | 'fix.timeout' | 'fix.disabled' | 'fix.moved' | 'fix.unreachableAt' | 'fix.cdnAnswered403'
  | 'fix.nothingToDo' | 'fix.solverBroken' | 'fix.markupChanged' | 'fix.unknownLive' | 'fix.unnumbered'
  | 'fix.emptySearch' | 'fix.emptyChapters' | 'fix.emptyPages' | 'fix.testTimeout' | 'fix.tooSlow' | 'fix.unknown'
  | 'fix.unexplained' | 'fix.siteOffline' | 'fix.solverBusy' | 'fix.ipBlocked';

/** A fix: its English, and its code with what fills it. */
interface Fix { text: string; said: Said }
const fixed = (code: FixCode, text: string, params?: Record<string, string | number | null>): Fix =>
  ({ text, said: { code, ...(params ? { params } : {}) } });

/** A fix written as a bare string carries no code, and the web shows it as it is. */
const D = (
  code: DiagnosisCode, reason: string, fix: string | Fix, actor: Actor,
  opts: { silent?: boolean; needsProbe?: boolean } = {},
): Diagnosis => {
  const f = typeof fix === 'string' ? { text: fix } : fix;
  return {
    code, reason, fix: f.text, ...('said' in f && f.text ? { fixSaid: f.said } : {}), actor,
    silent: !!opts.silent, needsProbe: !!opts.needsProbe,
  };
};

const NEEDS_ADMIN = 'This source needs a check from an admin.';

/** What a rule may know besides the error: the stage it was thrown at, when a live test says. */
interface RuleCtx { err?: string; stage?: Stage }
const whileStage = (c: RuleCtx) => (c.stage ? ` while ${STAGE_WORD[c.stage]}` : '');

/**
 * The site's own offline notice (v0.49.1, lib/sources/offline.ts): the one case where the site says in words what is
 * wrong. Waiting is the fix for the site; for its series, Health offers Find other sources (the row's action).
 */
const SITE_OFFLINE = () => D('site_offline', 'The site says it is offline (its own page)',
  fixed('fix.siteOffline', 'Wait for the site to come back, or find other sources for its series.'), 'admin');

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
const RULES: Array<[RegExp, (c: RuleCtx) => Diagnosis]> = [
  // First: the message is our own classified error (`site_offline: …`), quoting the site's notice, and a notice's
  // words ("maintenance", a Cloudflare page title) must not be read by a rule below as something else.
  [/^site_offline:/i, SITE_OFFLINE],

  [/chromedriver.*exited|devtoolsactiveport|session not created/i, () =>
    D('solver_crash', NEEDS_ADMIN,
      fixed('fix.solverCrash', forDesktop(
        "The Cloudflare solver's browser crashed. Chrome in Docker needs far more than the default 64 MB of shared memory: set shm_size: 1gb on the flaresolverr service and recreate it.",
        "The browser inside Uchiyomi's built-in Cloudflare helper crashed. Quit and reopen Uchiyomi to restart it.",
      )),
      'admin')],

  // trawl (v0.55.3) still starting its browsers answers "Browser pool initializing, retry in a few seconds", and an address
  // that answers with something that is not a solver's JSON is ours (sources/flaresolverr.ts): no solver is there.
  [/httpconnectionpool|max retries exceeded|newconnectionerror|failed to establish a new connection|browser pool initializing|did not answer with its json/i, () =>
    D('solver_down', NEEDS_ADMIN,
      fixed('fix.solverDown', forDesktop(
        'The Cloudflare solver is not answering. Check the container is up and FLARESOLVERR_URL is right. It also leaks memory, so it wants a periodic restart.',
        "Uchiyomi's built-in Cloudflare helper is not answering. Quit and reopen Uchiyomi to restart it.",
      )),
      'admin')],

  // trawl's own (v0.55.3): "Tier 3 failed (cloudflare-challenge-timeout)", its browser's wait on the wall running out.
  [/timeout after [\d.]+ seconds|error solving the challenge|-challenge-timeout\b/i, () =>
    D('solver_timeout', NEEDS_ADMIN,
      fixed('fix.solverTimeout', 'The site presented a Cloudflare challenge the solver could not finish in time. Often transient, so re-test first. If it persists, the site has raised its protection.'),
      'admin')],

  // A solver that stayed BUSY through its tries and the backup (v0.55.3, sources/flaresolverr.ts SOLVER_BUSY: trawl's
  // own 429 when no browser of its pool frees up). The solver ran out of room, not the site of patience: a solver code,
  // with the solver's own capacity as the fix. The words are ours, so no rule below can read them as the site's.
  [/\bsolver busy\b/i, () =>
    D('solver_timeout', NEEDS_ADMIN,
      fixed('fix.solverBusy', forDesktop(
        'The Cloudflare solver stayed busy: every browser it has was in use, however long Uchiyomi waited. It catches up by itself; if it keeps happening, give it more browsers (trawl: BROWSER_POOL_SIZE), or let Uchiyomi ask fewer pages of it at once (SOLVER_CONCURRENCY).',
        "Uchiyomi's built-in Cloudflare helper stayed busy with other pages. It catches up by itself. Quit and reopen Uchiyomi if it keeps happening.",
      )),
      'admin')],

  // Suwayomi's own CloudflareInterceptor throws exactly these words when the ENGINE's FlareSolverr
  // integration is off, which is its default (issue #54: Mangaball via keiyoushi, `java.io.IOException:
  // Cloudflare bypass currently disabled` on every search). The generic rule below would send the admin to
  // check Uchiyomi's solver, which is not involved: extension sources never go through it. The engine talks
  // to the site itself and has to be pointed at the solver by its own env. Must sit ABOVE the generic
  // cf_challenge rule, which matches the same string on the word "cloudflare".
  // ⚠️ The sentence must stay name-agnostic. Its first version named the development stack's containers
  // (yomi-suwayomi / yomi-flaresolverr), which exist on exactly one install; every shipped compose file says
  // uchiyomi-*, the Unraid template runs no engine at all, and the admins who will actually read this are
  // the ones whose engine was NOT recreated from the v0.37.0 files -- so a hard-coded name is wrong for
  // precisely the people it is for. Name the shipped names as examples and point at the value they have.
  [/cloudflare bypass currently disabled/i, () =>
    D('cf_challenge', 'This source is protected by a check we could not get past.',
      fixed('fix.bypassOff', forDesktop(
        "The extension engine's own Cloudflare bypass is switched off. On the Suwayomi engine's container (uchiyomi-suwayomi in the shipped compose files) set FLARESOLVERR_ENABLED=true and FLARESOLVERR_URL to the same solver address Uchiyomi uses (http://uchiyomi-flaresolverr:8191 in the shipped files), then recreate it. The v0.37.0 compose files already set both, so an upgrade that recreates the engine is the fix there.",
        "The extension engine isn't using Uchiyomi's built-in Cloudflare helper. Quit and reopen Uchiyomi to restart it.",
      )),
      'admin')],

  // The engine itself did not answer, or its own HTTP layer refused us. ABOVE every site rule: "suwayomi 403" is
  // the engine refusing Uchiyomi's Basic auth, and below the edge_403 rule it read as the site's CDN blocking
  // this server. The four transport shapes are made in suwayomi/client.ts (transportError).
  [/^suwayomi (?:unreachable|is not configured|returned no data)\b|^suwayomi \d{3}\b/i, (c) => {
    const auth = /^suwayomi 40[13]\b/.test(c.err ?? '');
    return D('upstream_down', 'The extension server did not answer.',
      auth
        ? fixed('fix.engineLogin', forDesktop(
          "The extension engine refused Uchiyomi's login. Set SUWAYOMI_USERNAME and SUWAYOMI_PASSWORD to the engine's own basic-auth user and password (or turn its auth off), then restart Uchiyomi.",
          "Uchiyomi's extension engine refused Uchiyomi's own login. Quit and reopen Uchiyomi to restart both.",
        ))
        : fixed('fix.engineDown', forDesktop(
          'This is the Suwayomi extension server, not the site. Check that container.',
          "This is Uchiyomi's extension engine, not the site. Quit and reopen Uchiyomi to restart it.",
        )), 'admin');
  }],

  // The engine did not answer in time: our wait, on the engine, says nothing about the site behind it.
  [/^suwayomi timeout after \d+ms/i, (c) =>
    D('timeout', 'This source did not answer in time.',
      fixed('fix.engineTimeout',
        `The extension engine did not answer in time${whileStage(c)}. It may be busy with a slow site or a long chapter list; re-test, and if it keeps happening, check the engine's own log.`,
        { stage: c.stage ?? null }),
      'admin', { needsProbe: true })],

  // trawl's "datacenter-ip-blocked (cf_clearance obtained but redirect never completed — needs residential proxy)"
  // (v0.55.3): it got past the challenge and the site still refused this server's address. ABOVE the Cloudflare rule,
  // which would read its "cf_clearance" as a challenge left unsolved and send the admin to check a solver that worked.
  [/datacenter-ip-blocked/i, () =>
    D('edge_403', 'This source is blocking this server right now.',
      fixed('fix.ipBlocked', "The solver got past the site's check, but the site still refuses this server's address: usually a block on datacentre IPs, which no challenge solver gets past. Only another network does (trawl: RESIDENTIAL_PROXY_URL). Change egress or drop the source."),
      'admin')],

  [/just a moment|cf-chl|cf_clearance|cloudflare|challenge/i, () =>
    D('cf_challenge', 'This source is protected by a check we could not get past.',
      fixed('fix.challenge', 'A Cloudflare interstitial was served and not solved. Confirm the solver is healthy, then re-test.'),
      'admin')],

  [/\b403\b|forbidden|access denied/i, () =>
    D('edge_403', 'This source is blocking this server right now.',
      fixed('fix.cdnRefuses', "The site's CDN is refusing this server outright with a 403. A challenge solver cannot fix that; it is usually a datacentre-IP block. Change egress or drop the source."),
      'admin')],

  // Since v0.40.0 a 429 is not only waited out: the downloader remembers it per source (lib/pace.ts) and
  // the next chapters from it go one page at a time with a longer pause, and a chapter it still refuses is
  // taken from another followed source (lib/chapterFallback.ts). The sentence says so, or an admin reading
  // "nothing to do" beside a series that keeps landing chapters "via" another source has no way to connect
  // the two.
  [/\b429\b|rate.?limit|too many requests|slow down/i, () =>
    D('rate_limited', 'This source asked us to slow down.',
      fixed('fix.rateLimited', 'The downloader slows itself down on this source (one page at a time, a longer pause) for the next chapters and takes a chapter from another followed source when this one still refuses. The cooldown widens automatically and clears itself.'),
      'wait')],

  // trawl's Firefox (v0.55.3) says it in its own words: NS_ERROR_UNKNOWN_HOST, NS_ERROR_CONNECTION_REFUSED, about:neterror.
  [/enotfound|eai_again|econnrefused|unknownhostexception|connectexception|ns_error_unknown_host|ns_error_connection_refused|about:neterror/i, () =>
    D('unreachable', 'This source is not answering right now.',
      fixed('fix.unreachable', 'The address could not be reached at all. Check the URL. The site may be gone.'), 'admin')],

  // From here on the engine DID answer (`suwayomi: ` is a GraphQL error, suwayomi/client.ts): what failed is the
  // extension, talking to its site. BELOW the Cloudflare, 403, rate-limit and unreachable rules, which read the
  // same engine-relayed message for what the site said. Until v0.49.0 a catch-all /^suwayomi\b/ sat here and
  // blamed the engine container for the extension's own exception (#115).
  [/^suwayomi: .*(?:sockettimeoutexception|\btimed? ?out\b)/i, (c) =>
    D('timeout', 'This source did not answer in time.',
      fixed('fix.siteTimeout',
        `The extension engine answered, but the site behind the extension did not answer it in time${whileStage(c)}. Often transient: re-test. If it persists, the site may be down or slow for the engine.`,
        { stage: c.stage ?? null }),
      'admin', { needsProbe: true })],

  [/^suwayomi: /i, (c) =>
    D('extension_error', "This source's extension reported an error.",
      fixed('fix.extensionFailed',
        `The extension engine answered, but the extension itself failed${whileStage(c)}. Usually the site changed or refused the extension: update the extension (Admin → Sources), check its settings, or open the site in a browser. The engine's own message is shown with the test.`,
        { stage: c.stage ?? null }),
      'admin')],

  // Deliberately last, and deliberately NOT confident. `withTimeout` throws this after discarding whatever
  // the adapter knew, so on a real install it covers a moved domain, a 403 and a dead solver at the same
  // time. Guessing here is how you tell someone to go and fix the wrong thing.
  [/^timeout\b/i, () =>
    D('timeout', 'This source did not answer in time.',
      fixed('fix.timeout', 'A timeout alone does not say why. Re-test it: that distinguishes a moved domain, a challenge that never completed, and a genuinely slow site.'),
      'admin', { needsProbe: true })],
];

const hostOf = (u?: string): string | null => {
  if (!u) return null;
  try { return new URL(u).host.replace(/^www\./, ''); } catch { return null; }
};

const MARKUP_DRIFT = 'This source stopped listing new titles. An admin needs to check it.';
/** The fix for a search that answers with nothing, from a live test or from three empty answers in a row. */
const EMPTY_SEARCH = 'It answers without an error but returns nothing, which usually means the site changed its markup or is serving a challenge page. Re-test it to find out which.';

/**
 * Each code's public sentence. A reason belongs to its code, whichever rule found it -- which is what lets the web
 * word it by `code` alone (and lib/said.ts's `sources.reason` put it in a Health row). sourceDiagnosis.test.ts
 * holds every rule's reason to this.
 */
export const REASONS: Readonly<Record<DiagnosisCode, string>> = {
  ok: '',
  disabled: 'This source is switched off.',
  moved: "This source's website moved. An admin needs to point it at the new address.",
  edge_403: 'This source is blocking this server right now.',
  cf_challenge: 'This source is protected by a check we could not get past.',
  solver_crash: NEEDS_ADMIN,
  solver_down: NEEDS_ADMIN,
  solver_timeout: NEEDS_ADMIN,
  timeout: 'This source did not answer in time.',
  too_slow: 'This source answers, but takes longer than the time it is given.',
  markup_drift: MARKUP_DRIFT,
  unreachable: 'This source is not answering right now.',
  rate_limited: 'This source asked us to slow down.',
  upstream_down: 'The extension server did not answer.',
  extension_error: "This source's extension reported an error.",
  unnumbered: 'This source lists chapters without numbers Uchiyomi can use.',
  site_offline: 'The site says it is offline (its own page)',
  unknown: NEEDS_ADMIN,
};

/**
 * What is wrong with this source, and what to do.
 *
 * Live evidence beats stored evidence, always. A stored error can be months old: on the install this was
 * built against, one source's `last_error` predated the running container by 62 days. If someone has just
 * probed the site, what the site said a second ago wins.
 */
export function diagnose(f: HealthFacts, probe?: Probe, baseUrl?: string): Diagnosis {
  if (f.disabled) {
    return D('disabled', 'This source is switched off.', fixed('fix.disabled', 'Turn it back on in Admin → Sources.'), 'admin');
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
        fixed('fix.moved', `The site now redirects to ${now}. Update its address in Admin → Sources.`, { host: now }), 'admin');
    }
    if (probe.transport && /enotfound|eai_again|econnrefused/i.test(probe.transport)) {
      return D('unreachable', 'This source is not answering right now.',
        fixed('fix.unreachableAt', `The address could not be reached (${probe.transport}). Check the URL. The site may be gone.`, { transport: probe.transport }), 'admin');
    }
    // The site said it is offline, in its own words, a moment ago (v0.49.1). Above the homepage rules: that notice
    // is a 200 HTML page, and an empty streak from before it was recognised would read it as markup drift -- the
    // misleading "markup may not match this engine" Health gave for aqua. Reintroduce by moving it below them:
    // "an offline notice is not markup drift" in sourceDiagnosis.test.ts reads markup_drift.
    if (probe.failure?.kind === 'site_offline') return SITE_OFFLINE();
    // Everything below reads the homepage's status, so it only applies when a homepage was actually asked.
    // For an extension source nothing was (the engine talks to the site, not this server), and a rule that
    // read an absent status as anything at all would be inventing evidence: the live facts such a source
    // brings are `adapterOk` above and nothing else, and its verdict comes from the stored rules below.
    if (probe.httpStatus != null) {
      // Only meaningful for a source that does NOT go through the solver. For one that does, this is just
      // the challenge page and says nothing about whether the source works.
      if (probe.httpStatus === 403 && !probe.needsSolver) {
        return D('edge_403', 'This source is blocking this server right now.',
          fixed('fix.cdnAnswered403', "The site's CDN answered 403 to a direct request. A challenge solver cannot fix that; it is usually a datacentre-IP block."),
          'admin');
      }
      if (probe.httpStatus === 429) {
        return D('rate_limited', 'This source asked us to slow down.',
          fixed('fix.nothingToDo', 'Nothing to do. The cooldown widens automatically and clears itself.'), 'wait');
      }
      // The inference that matters most: the site answered us fine from this very container, so whatever
      // the stored error blames, the broken component is the solver and not the site.
      if (probe.httpStatus === 200 && /flaresolverr/i.test(err)) {
        const hit = RULES.find(([re]) => re.test(err))?.[1]({ err });
        if (hit && hit.code.startsWith('solver_')) return hit;
        return D('solver_down', NEEDS_ADMIN,
          fixed('fix.solverBroken', forDesktop(
            'The site answers fine from this server, so the Cloudflare solver is the broken part. Check that container.',
            "The site answers fine from this computer, so Uchiyomi's built-in Cloudflare helper is the broken part. Quit and reopen Uchiyomi to restart it.",
          )),
          'admin');
      }
      if (probe.httpStatus === 200 && probe.looksHtml && suspect) {
        return D('markup_drift', MARKUP_DRIFT,
          fixed('fix.markupChanged', 'The site answers, but its listing no longer matches the parser, so the site changed its markup. Re-add it with auto-detect to re-pick the engine.'),
          'admin', { silent: true });
      }
    }

    // Where the live test failed, and with what (#115). Below the homepage rules, which still name a moved or
    // refusing site more precisely; above everything stored, because this was thrown a moment ago.
    const fl = probe.failure;
    if (fl) {
      const word = STAGE_WORD[fl.stage];
      // A rate limit (v0.55.1, lib/sourceEvidence.ts) is an error in the site's own words: the rules name it.
      if (fl.kind === 'error' || fl.kind === 'rate_limited') {
        const e = fl.error || '';
        for (const [re, make] of RULES) if (re.test(e)) return make({ err: e, stage: fl.stage });
        return D('unknown', NEEDS_ADMIN,
          fixed('fix.unknownLive', `The live test failed while ${word}, and the error matches nothing known. It is shown with the test.`, { stage: fl.stage }), 'admin');
      }
      if (fl.kind === 'unnumbered') {
        return D('unnumbered', 'This source lists chapters without numbers Uchiyomi can use.',
          fixed('fix.unnumbered', "The extension lists this source's chapters, but none of them with a chapter number, so there is nothing to order, name or download. Look for a numbering option in the extension's own settings (Admin → Sources), or Ignore it here."),
          'admin');
      }
      if (fl.kind === 'empty') {
        // "The titles it tried", not "three of them": up to three are tried, and a one-chapter series or a site with
        // one search hit gives fewer. The check's own detail carries the count.
        //
        // A current stored Cloudflare or solver error explains an empty answer better than "the markup changed":
        // a challenge page parses to nothing too. Only a current one (the caller passes nothing stale).
        const why = err ? RULES.find(([re]) => re.test(err))?.[1]({ err }) : undefined;
        if (why && (why.code === 'cf_challenge' || why.code.startsWith('solver_'))) return why;
        return D('markup_drift', MARKUP_DRIFT,
          fl.stage === 'search'
            ? fixed('fix.emptySearch', EMPTY_SEARCH)
            : fl.stage === 'chapters'
              ? fixed('fix.emptyChapters', 'It finds titles, but lists no chapters for the titles it tried, which usually means the chapter list moved or changed its markup. Re-add it with auto-detect, or update the extension.')
              : fixed('fix.emptyPages', 'It lists chapters, but no pages for the chapters it tried, which usually means the reader page changed its markup or hides pages behind a script. Re-add it with auto-detect, or update the extension.'),
          'admin', { silent: true, needsProbe: fl.stage === 'search' });
      }
      // Our own deadline. With a current stored error, the stored rules below speak -- they name a cause (a
      // Cloudflare challenge, the engine's own bypass switched off), and running out of time does not contradict
      // it. With nothing stored to go on, the engine client's own deadline first, which the smoke test carries in
      // its words (sourceProbe.ts outOfTime): its rule names the engine, where the sentence below would send an
      // admin to SOURCE_TEST_TIMEOUT_MS -- a wall the engine's fixed 30 s never reaches. Reintroduce by skipping it:
      // "an engine timeout names the engine" in sourceDiagnosis.test.ts reads the SOURCE_TEST_TIMEOUT_MS advice.
      // ⚠️ Inside `!err`: run before it, an engine timeout overrode a current stored cause, and a Test that ran
      // out of the engine's 30 s behind a Cloudflare wall read "the engine did not answer" (integration-1 review).
      // Reintroduce it above this test: the same test's stored-cause line reads timeout, not cf_challenge.
      if (!err) {
        if (fl.error) {
          const e = fl.error;
          for (const [re, make] of RULES) if (re.test(e)) return make({ err: e, stage: fl.stage });
        }
        return D('timeout', 'This source did not answer in time.',
          fixed('fix.testTimeout', `The live test ran out of time while ${word}. That alone is not proof it is broken: re-test, and if it keeps happening, raise SOURCE_TEST_TIMEOUT_MS or look at the site itself.`, { stage: fl.stage }),
          'admin', { needsProbe: true });
      }
    }
  }

  // Before the stored-error rules, because a slow source's `last_error` is literally "timeout after Nms" and
  // the generic timeout rule would shrug at it. Repeatedly outrunning the budget is not an unknown cause; it
  // is a known one with a specific fix, and it is the fault that made a working source disappear.
  if ((f.slowStreak ?? 0) >= EMPTY_SUSPECT) {
    const seconds = f.budgetMs ? Math.round(f.budgetMs / 1000) : null;
    const budget = seconds !== null ? `${seconds}s` : 'the time allowed';
    return D('too_slow',
      'This source answers, but takes longer than the time it is given.',
      fixed('fix.tooSlow', `It keeps taking longer than ${budget} to return its newest page. Raise SOURCE_LATEST_TIMEOUT_MS if the wait is acceptable; otherwise the site itself, or the Cloudflare solver in front of it, is the slow part.`, { seconds }),
      'admin');
  }

  for (const [re, make] of RULES) if (re.test(err)) return make({ err });

  if (suspect) {
    return D('markup_drift', MARKUP_DRIFT, fixed('fix.emptySearch', EMPTY_SEARCH), 'admin', { silent: true, needsProbe: true });
  }

  if (err) {
    return D('unknown', NEEDS_ADMIN,
      fixed('fix.unknown', 'The recorded error does not match anything known. Re-test it for a live verdict.'), 'admin', { needsProbe: true });
  }

  // A live test that just FAILED is never "working normally", whatever the stored record says (#115: the Test
  // result printed "Working normally." under a ✗).
  if (probe && probe.adapterOk === false) {
    return D('unknown', NEEDS_ADMIN,
      fixed('fix.unexplained', 'The live test failed, and nothing recorded explains it. Re-test it and read the failing step.'), 'admin', { needsProbe: true });
  }

  return D('ok', '', '', 'none');
}
