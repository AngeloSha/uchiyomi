// Go and look at a source, right now, and report what you find.
//
// Two things live here and they answer different questions:
//   `smokeTest` -- does the ADAPTER work? Search, series, chapters, pages, in order, with details.
//   `probeBase` -- does the SITE answer, without the Cloudflare solver in the way?
//
// The second exists because the first cannot tell you why. On the install this was written against, six
// sources were failing for three unrelated reasons that were indistinguishable in the database: a domain
// that had moved twice, two sites returning 403 to this server's IP, and a solver whose own browser kept
// crashing. One plain HTTP request to each homepage separated all three in under a second.
import { env } from '../env';
import { withTimeout } from './sources';
import { unnumberedOf, type SourceAdapter, type SourceChapter } from './sources/types';
import type { Probe } from './sourceDiagnosis';
import type { Stage } from './sourceEvidence';
import { coverSanity } from './sources/imgAttr';

/** How a stage failed. `timeout` is OUR deadline and makes the run inconclusive, never a failure of the source. */
export type SmokeKind = 'error' | 'empty' | 'timeout' | 'unnumbered';
export interface Check {
  name: string;
  ok: boolean;
  /** Short, for the check list (80 characters). */
  detail: string;
  /** Which stage this check belongs to (lib/sourceEvidence.ts). Absent for Covers, which does not vote. */
  stage?: Stage;
  kind?: SmokeKind;
  /** The error as thrown, up to 300 characters: what Health and the Providers card show as the engine's words. */
  error?: string;
}
export type SmokeState = 'pass' | 'fail' | 'inconclusive';
export interface SmokeFailure { stage: 'search' | 'chapters' | 'pages'; kind: SmokeKind; error?: string }
export interface SmokeResult {
  /** Every voting check passed. */
  ok: boolean;
  /** The run hit its deadline. */
  timedOut?: boolean;
  checks: Check[];
  /** pass, fail, or inconclusive when our deadline ended it before any failure. */
  state: SmokeState;
  /** The first stage that failed, and how. Absent on a pass. */
  failure?: SmokeFailure;
  /** The stages that passed, in order. */
  passed: Stage[];
  ms: number;
}

const clip = (s: unknown) => String(s || '').slice(0, 80);
const full = (s: unknown) => String(s || '').slice(0, 300);
const messageOf = (e: unknown) => (e as Error)?.message || 'error';
/**
 * The Suwayomi client's own per-request deadline (client.ts transportError). 30 s, inside the 45 s wall, so a slow
 * extension call ran out of THAT patience first and read as a confirmed failure -- a warn row on Health and a push
 * from the sweep -- for what is our deadline as much as the wall is.
 *
 * ⚠️ Not the wall, though: the wall usually has time left, so an engine timeout is a MISS of one candidate (a term,
 * a title, a chapter) and the next one is tried, exactly like an empty answer. Only when nothing succeeded and
 * nothing really failed does it end the run, as inconclusive with the engine's own words (engineLate below).
 */
const ENGINE_TIMEOUT = /^suwayomi timeout after \d+ms/;
const engineLate = (e: unknown) => ENGINE_TIMEOUT.test(messageOf(e));
/** The wall ran out (withTimeout's selfTimeout): no time is left for another candidate. */
const ours = (e: unknown) => !!(e as { selfTimeout?: boolean })?.selfTimeout;

/** A wall-clock deadline, checked between stages. */
const past = (deadline: number) => Date.now() >= deadline;

/** The one check that is reported but does not vote on whether the source works. */
const COVER_CHECK = 'Covers';
/** How many search hits the chapter stage may try: one dud title must not fail a working source. */
const CHAPTER_TRIES = 3;

/**
 * Newest, middle and oldest, one copy per number, highest first. The oldest chapter alone was the first
 * thing asked for, and on a long-running series that is exactly the one a site has taken down or licensed.
 */
export function pageCandidates(chapters: SourceChapter[]): SourceChapter[] {
  const byNumber = new Map<number, SourceChapter>();
  for (const c of [...chapters].sort((a, b) => b.number - a.number)) if (!byNumber.has(c.number)) byNumber.set(c.number, c);
  const list = [...byNumber.values()];
  const picks = [list[0], list[Math.floor(list.length / 2)], list[list.length - 1]].filter(Boolean);
  return picks.filter((c, i) => picks.findIndex((x) => x.sourceId === c.sourceId) === i);
}

/**
 * Exercise an adapter end to end: search -> series page -> chapters -> pages.
 *
 * Bounded by a real deadline, and since v0.49.0 EVERY adapter call is bounded by what is left of it
 * (`withTimeout`, tagged selfTimeout). Before, the deadline was checked only between stages, so one 30-second
 * GraphQL call started at second 44 of a 45-second wall ran to second 74. Running out of time is recorded as
 * 'inconclusive' at the stage it happened, never as a failure: our patience is not the source's fault.
 *
 * The rest is about not failing a working source (#115: Health must show which stage failed, so the stage had
 * better be right):
 * - The search loop tries several terms because a site with few titles can legitimately miss one. It stops on
 *   ANY thrown error: a 403, a dead solver or an extension's exception answers the same for all four terms
 *   (Manga Ball paid for four searches of its own exception), and only an empty answer -- or the engine client
 *   giving up on one term (ENGINE_TIMEOUT) -- justifies another term.
 * - Chapters are asked of up to three search hits, not the first: one title with no chapters is a title, not
 *   a broken source.
 * - Pages are asked of the newest chapter first, then the middle and the oldest (pageCandidates).
 * - A chapter list whose every chapter lacks a usable number says so (`unnumbered`), because "none found"
 *   sends an admin to the wrong fix.
 */
export async function smokeTest(src: SourceAdapter, opts: { timeoutMs?: number } = {}): Promise<SmokeResult> {
  const t0 = Date.now();
  const deadline = t0 + (opts.timeoutMs ?? env.SOURCE_TEST_TIMEOUT_MS);
  const checks: Check[] = [];
  const passed: Stage[] = [];
  let failure: SmokeFailure | undefined;
  let timedOut = false;

  /** One adapter call, cut off at the wall. `Promise.race` returns but does not cancel: see risks in #115. */
  const call = <T>(f: () => Promise<T>): Promise<T> => withTimeout(f(), Math.max(1, deadline - Date.now()));
  const fail = (f: SmokeFailure) => { failure ??= f; };
  const done = (): SmokeResult => {
    // ⚠️ Covers are reported, never fatal. A source whose covers are wrong still fetches and reads perfectly,
    // and marking it down would take a cosmetic fault and turn it into "this source is broken" -- which is how
    // a health page starts crying wolf and stops being read. It shows in the check list; it does not vote.
    const ok = !timedOut && !failure && checks.filter((c) => c.name !== COVER_CHECK).every((c) => c.ok);
    const state: SmokeState = failure && failure.kind !== 'timeout' ? 'fail' : timedOut ? 'inconclusive' : ok ? 'pass' : 'fail';
    return { ok, ...(timedOut ? { timedOut } : {}), checks, state, ...(failure ? { failure } : {}), passed, ms: Date.now() - t0 };
  };
  /**
   * Our deadline, at this stage: the run ends here, inconclusive unless something had already failed. `late` is the
   * engine client's own timeout when that is what used the time: its words go on the check and the failure, so the
   * verdict names the engine (diagnose() runs its rules over them) instead of telling an admin to raise a wall
   * the engine's fixed 30 s never reaches.
   */
  const outOfTime = (name: string, stage: SmokeFailure['stage'], late?: string): SmokeResult => {
    timedOut = true;
    checks.push({ name, ok: false, detail: late ? clip(late) : 'did not finish in time', stage, kind: 'timeout', ...(late ? { error: full(late) } : {}) });
    fail({ stage, kind: 'timeout', ...(late ? { error: full(late) } : {}) });
    return done();
  };

  // ── search ────────────────────────────────────────────────────────────────────────────────────────────
  let results: any[] = [];
  let thrown: string | undefined;
  /** The engine's own timeout, on any candidate of the stage at hand: a miss, and the words if nothing else speaks. */
  let late: string | undefined;
  for (const term of ['the', 'one', 'love', 'a']) {
    if (past(deadline)) return outOfTime('Search', 'search', late);
    try {
      const r = await call(() => src.search(term));
      if (Array.isArray(r) && r.length) { results = r; break; }
    } catch (e) {
      if (ours(e)) return outOfTime('Search', 'search', late);
      if (engineLate(e)) { late ??= messageOf(e); continue; }
      thrown = messageOf(e);
      break;
    }
  }
  if (!results.length) {
    // Some term ran out of the engine's patience and none answered with an error: we did not see the search, and
    // an empty answer to the others is not proof enough of drift.
    if (thrown === undefined && late !== undefined) return outOfTime('Search', 'search', late);
    if (thrown !== undefined) {
      checks.push({ name: 'Search', ok: false, detail: clip(thrown), stage: 'search', kind: 'error', error: full(thrown) });
      fail({ stage: 'search', kind: 'error', error: full(thrown) });
    } else {
      const detail = 'no results — markup may not match this engine';
      checks.push({ name: 'Search', ok: false, detail, stage: 'search', kind: 'empty', error: detail });
      fail({ stage: 'search', kind: 'empty', error: detail });
    }
    return done();
  }
  checks.push({ name: 'Search', ok: true, detail: `${results.length} result(s)`, stage: 'search' });
  passed.push('search');

  // ── series page and chapters, over up to three hits ───────────────────────────────────────────────────
  let chapters: SourceChapter[] = [];
  let hitNo = 0;
  let title: string | undefined;
  let answered = false; // at least one getSeries answered (with or without a title)
  let firstErr: string | undefined;
  let unnumbered = 0;
  const hits = results.filter((r, i) => r?.sourceId != null && results.findIndex((x) => x?.sourceId === r.sourceId) === i).slice(0, CHAPTER_TRIES);
  late = undefined;
  for (let i = 0; i < hits.length; i++) {
    if (past(deadline)) return outOfTime(answered ? 'Chapters' : 'Series / chapters', 'chapters', late);
    try {
      const series = await call(() => src.getSeries(hits[i].sourceId));
      answered = true;
      if (series?.title && !title) title = series.title;
      // Free: both halves are already in hand. See coverSanity for what it compares and why it is informational.
      if (i === 0) {
        const cov = coverSanity(results, series);
        checks.push({ name: COVER_CHECK, ok: cov.ok, detail: cov.detail });
      }
      const list = await call(() => src.listChapters(hits[i].sourceId));
      if (Array.isArray(list) && list.length) { chapters = list; hitNo = i + 1; break; }
      unnumbered += unnumberedOf(list);
    } catch (e) {
      if (ours(e)) return outOfTime(answered ? 'Chapters' : 'Series / chapters', 'chapters', late);
      if (engineLate(e)) { late ??= messageOf(e); continue; }
      firstErr ??= messageOf(e);
    }
  }
  // Nothing listed, nothing really failed, and a title ran out of the engine's patience: not seen, not a verdict.
  // Reintroduce by returning outOfTime on the first engine timeout: 'an engine timeout on one title or chapter is
  // a miss, and the next one is tried' in sourceProbe.test.ts reads inconclusive over a working source.
  if (!chapters.length && firstErr === undefined && late !== undefined) {
    return outOfTime(answered ? 'Chapters' : 'Series / chapters', 'chapters', late);
  }
  if (!answered) {
    const err = firstErr ?? 'no search hit to open';
    checks.push({ name: 'Series / chapters', ok: false, detail: clip(err), stage: 'chapters', kind: 'error', error: full(err) });
    fail({ stage: 'chapters', kind: 'error', error: full(err) });
    return done();
  }
  checks.push({ name: 'Series page', ok: !!title, detail: title ? clip(title) : 'no data', stage: 'chapters', ...(title ? {} : { kind: 'empty' as const }) });
  if (chapters.length) {
    // Numbers, not rows: a source that lists a chapter once per group would otherwise report twice the count.
    const numbers = new Set(chapters.map((c) => c.number)).size;
    checks.push({ name: 'Chapters', ok: true, detail: `${numbers} chapter(s)${hitNo > 1 ? ` (search hit ${hitNo})` : ''}`, stage: 'chapters' });
    if (title) passed.push('chapters');
    else fail({ stage: 'chapters', kind: 'empty', error: 'the series page returned no data' });
  } else {
    const kind: SmokeKind = firstErr !== undefined ? 'error' : unnumbered ? 'unnumbered' : 'empty';
    const detail = kind === 'error' ? firstErr! : kind === 'unnumbered'
      ? `none with a usable number (${unnumbered} without)`
      : `none found (${hits.length} title${hits.length === 1 ? '' : 's'} tried)`;
    checks.push({ name: 'Chapters', ok: false, detail: clip(detail), stage: 'chapters', kind, error: full(detail) });
    fail({ stage: 'chapters', kind, error: full(detail) });
    return done();
  }

  // ── pages: newest first ───────────────────────────────────────────────────────────────────────────────
  const candidates = pageCandidates(chapters);
  let pagesErr: string | undefined;
  late = undefined;
  for (const c of candidates) {
    if (past(deadline)) return outOfTime('Pages', 'pages', late);
    try {
      const urls = await call(() => src.getPageUrls(c.sourceId));
      if (Array.isArray(urls) && urls.length) {
        checks.push({ name: 'Pages', ok: true, detail: `${urls.length} page(s) (chapter ${c.number})`, stage: 'pages' });
        passed.push('pages');
        return done();
      }
    } catch (e) {
      if (ours(e)) return outOfTime('Pages', 'pages', late);
      if (engineLate(e)) { late ??= messageOf(e); continue; }
      pagesErr ??= messageOf(e);
    }
  }
  if (pagesErr === undefined && late !== undefined) return outOfTime('Pages', 'pages', late);
  const kind: SmokeKind = pagesErr !== undefined ? 'error' : 'empty';
  const detail = pagesErr ?? `none found (${candidates.length} chapter${candidates.length === 1 ? '' : 's'} tried)`;
  checks.push({ name: 'Pages', ok: false, detail: clip(detail), stage: 'pages', kind, error: full(detail) });
  fail({ stage: 'pages', kind, error: full(detail) });
  return done();
}

export interface ProbeResult { httpStatus: number; finalUrl?: string; transport?: string; looksHtml?: boolean }

/**
 * Ask the site directly, with a plain fetch.
 *
 * Deliberately NOT through `cfGet`. When the Cloudflare solver is the broken component, asking it produces
 * no information at all -- which is precisely the case this was built to diagnose. A bare request answers
 * the only question that separates the failure families: does the site talk to this server or not?
 *
 * Redirects are followed so a moved domain shows up as a different host in `finalUrl`. That single fact is
 * what turns a stored "timeout" into "the site is at coffeemanga.ink now".
 */
export async function probeBase(url: string, timeoutMs = 8000): Promise<ProbeResult> {
  try {
    const r = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      // A default UA gets a bot block from some CDNs, which would look like a site problem and is not.
      headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36' },
    });
    const ct = r.headers.get('content-type') || '';
    return { httpStatus: r.status, finalUrl: r.url || url, looksHtml: /text\/html/i.test(ct) };
  } catch (e: any) {
    // `cause.code` is where undici keeps ENOTFOUND / ECONNREFUSED; the message alone often says only
    // "fetch failed", which is the same shrug the stored errors already give us.
    const code = e?.cause?.code || e?.code || (e?.name === 'TimeoutError' ? 'timeout' : '') || 'fetch failed';
    return { httpStatus: 0, transport: String(code) };
  }
}

/**
 * The live evidence `diagnose` is handed, assembled in ONE place for the scheduled sweep and the admin Test
 * button, so the two can never disagree about what counts.
 *
 * `bare` is undefined whenever there was no homepage to ask: every Suwayomi/extension source, because the
 * engine talks to the site and this server never does. Until PR #56 both callers built the probe as
 * `bare && {...}`, which threw `adapterOk` away for exactly those sources, and `diagnose` then fell through
 * to whatever stale string `last_error` last held. `reportOk` never clears that string, so an extension
 * source that had once seen a Cloudflare error went on reporting "protected by a check we could not get
 * past" on every sweep and every Test click while all four live checks passed (issue #54's second half).
 * The adapter's own result and whether the source is solver-fronted are live facts in their own right and
 * must reach `diagnose` whether or not a bare request happened; `httpStatus` is simply absent when none did.
 */
export function buildProbe(
  bare: ProbeResult | undefined,
  smoke: { ok: boolean; failure?: SmokeFailure },
  src: { requiresCloudflare?: boolean },
): Probe {
  // `failure` only when there is one: where and how the live test failed (#115) is live evidence too.
  return { ...bare, adapterOk: smoke.ok, needsSolver: !!src.requiresCloudflare, ...(smoke.failure ? { failure: smoke.failure } : {}) };
}
