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
import { classify } from './sourceHealth';
import { env } from '../env';
import type { SourceAdapter } from './sources/types';

export interface Check { name: string; ok: boolean; detail: string }
export interface SmokeResult { ok: boolean; timedOut?: boolean; checks: Check[] }

const clip = (s: unknown) => String(s || '').slice(0, 80);

/** A wall-clock deadline, checked between stages. `Promise.race` returns but does not cancel. */
const past = (deadline: number) => Date.now() >= deadline;

/**
 * Exercise an adapter end to end: search -> series page -> chapters -> pages.
 *
 * Bounded by a real deadline rather than by a race the work outlives. The original raced a 30-second timer
 * against a call chain whose worst case was four search terms at up to 95 seconds each, and then kept
 * scraping after answering. Behind a button an admin can press repeatedly, that matters.
 *
 * The search loop tries several terms because a site with few titles can legitimately miss one. It now stops
 * early when the failure is *classifiable*: a 403, a rate limit or a dead solver will answer identically for
 * all four terms, so trying the rest costs four times as long to learn nothing. Only a parse-shaped failure
 * (returned nothing, threw nothing) justifies another term, and that is exactly the case this is for.
 */
export async function smokeTest(src: SourceAdapter, opts: { timeoutMs?: number } = {}): Promise<SmokeResult> {
  const deadline = Date.now() + (opts.timeoutMs ?? env.SOURCE_TEST_TIMEOUT_MS);
  const checks: Check[] = [];
  const bail = (): SmokeResult => ({ ok: false, timedOut: true, checks });

  let results: any[] = [];
  let searchOk = false;
  let searchDetail = 'no results — markup may not match this engine';
  for (const term of ['the', 'one', 'love', 'a']) {
    if (past(deadline)) return bail();
    try {
      const r = await src.search(term);
      if (Array.isArray(r) && r.length) { results = r; searchOk = true; searchDetail = `${r.length} result(s)`; break; }
    } catch (e: any) {
      searchDetail = clip(e?.message || 'error');
      // Transport-level: the next three terms give the same answer at full price.
      if (classify(e)) break;
    }
  }
  checks.push({ name: 'Search', ok: searchOk, detail: searchDetail });
  if (!searchOk) return { ok: false, checks };
  if (past(deadline)) return bail();

  let chapters: any[] = [];
  try {
    const series = await src.getSeries(results[0].sourceId);
    checks.push({ name: 'Series page', ok: !!series?.title, detail: series?.title ? clip(series.title) : 'no data' });
    if (past(deadline)) return bail();
    chapters = await src.listChapters(results[0].sourceId);
    checks.push({ name: 'Chapters', ok: chapters.length > 0, detail: chapters.length ? `${chapters.length} chapter(s)` : 'none found' });
  } catch (e: any) {
    checks.push({ name: 'Series / chapters', ok: false, detail: clip(e?.message || 'error') });
  }

  if (chapters.length) {
    if (past(deadline)) return bail();
    try {
      const pages = await src.getPageUrls(chapters[0].sourceId);
      checks.push({ name: 'Pages', ok: pages.length > 0, detail: pages.length ? `${pages.length} page(s)` : 'none found' });
    } catch (e: any) {
      checks.push({ name: 'Pages', ok: false, detail: clip(e?.message || 'error') });
    }
  }
  return { ok: checks.every((c) => c.ok), checks };
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
