// Which MangaDex title the product smoke adds (product-smoke.mjs): one whose NEWEST English chapter -- the one an add
// with `chapterFrom: 'newest'` takes -- MangaDex hosts itself. On its own, with no import that touches the disk, the
// network or the app, so desktop/test/smoke.mangadex.test.mjs holds it against answers shaped like MangaDex's.
//
// ⚠️ Desktop run 39342059609 (main, 2026-10-19, mac-arm64, attempt 1) went red with nothing broken. MangaDex was slow
// for that runner: the app's Newest gave up at its 8-second listing budget (SOURCE_LATEST_TIMEOUT_MS) and answered an
// empty page, so the only candidates were the smoke's two fallback searches, "Solo Leveling" and "Dandadan" -- licensed
// titles whose English chapters on MangaDex are only links to the publisher (`externalUrl`, 0 pages; Dandadan's 242 and
// 243 even say 1 page). All three adds ended "No downloadable chapters here", which is the app's right answer.
//
// So every title is first held to MangaDex's own feed (newestHosted), the searches are gone, and when the app's Newest
// has nothing to offer, MangaDex's newest hosted chapters are asked for directly with a patient timeout (newestFeedUrl:
// the adapter's own Newest query). The check keeps its meaning: it passes only when the app adds a series and its
// chapter lands. A runner MangaDex answers nothing still fails it, now with what MangaDex itself answered beside what the
// app did (10-21, run 39612192984: `{"latest":200,"candidates":0}` on all three runners, every answer empty and fast).

/** The content ratings the app's MangaDex adapter asks for (bff/src/lib/sources/mangadex.ts RATINGS). */
const RATINGS = ['safe', 'suggestive', 'erotica'].map((r) => `contentRating[]=${r}`).join('&');

/**
 * MangaDex's newest English chapters that it hosts, newest first: the adapter's own Newest query (latest()), with each
 * chapter's title included rather than asked for in a second request.
 * @param {string} api MangaDex's API origin
 */
export const newestFeedUrl = (api) => `${api}/chapter?translatedLanguage[]=en&order[readableAt]=desc&limit=100&includeExternalUrl=0&includeFuturePublishAt=0&includeEmptyPages=0&${RATINGS}&includes[]=manga`;

/**
 * One title's English chapters, highest number first: the rows the adapter's chapter list reads (feedFor asks for the
 * same language and ratings, every page of them, lowest first).
 * @param {string} api MangaDex's API origin @param {string} id the title's MangaDex id
 */
export const titleFeedUrl = (api, id) => `${api}/manga/${encodeURIComponent(id)}/feed?translatedLanguage[]=en&order[chapter]=desc&limit=100&${RATINGS}`;

/** A title's name as the adapter reads one (toSeries): English, else romanised Japanese, else the first given. */
const nameOf = (t) => (t && typeof t === 'object' && (t.en || t['ja-ro'] || Object.values(t)[0])) || '';

/**
 * The titles a newest-chapters answer (newestFeedUrl) names, each once, in its order.
 * @returns {{ sourceId: string, title: string }[]}
 */
export function titlesOf(feed) {
  const out = [];
  const seen = new Set();
  for (const c of feed?.data || []) {
    const m = (c?.relationships || []).find((r) => r?.type === 'manga');
    if (typeof m?.id !== 'string' || seen.has(m.id)) continue;
    seen.add(m.id);
    out.push({ sourceId: m.id, title: nameOf(m.attributes?.title) || m.id });
  }
  return out;
}

/**
 * Can an add of this title's newest chapter download it, from one feed answer's rows (titleFeedUrl)? The newest chapter is
 * the highest number, read as the adapter reads one (parseFloat; a row without a number is no chapter there, and a
 * title with none is the add's `no_chapters`). One of its copies must be HOSTED -- MangaDex serves its pages: no
 * `externalUrl`, more than 0 pages, not marked unavailable, readable now -- and none may merely look hosted: the app's
 * chooser (bff/src/lib/releases.ts) passes over a copy only for `pages === 0`, so a link that says 1 page, or a chapter
 * not out yet, could be the very copy it takes.
 * @returns {{ ok: boolean, chapter?: number, why?: string }}
 */
export function newestHosted(rows, now = Date.now()) {
  const numbered = (rows || [])
    .map((c) => ({ a: c?.attributes || {}, n: parseFloat(c?.attributes?.chapter) }))
    .filter((x) => Number.isFinite(x.n));
  if (!numbered.length) return { ok: false, why: 'no numbered English chapter' };
  const chapter = Math.max(...numbered.map((x) => x.n));
  const copies = numbered.filter((x) => x.n === chapter).map((x) => x.a);
  const hosted = (a) => !a.externalUrl && a.pages > 0 && a.isUnavailable !== true && !(Date.parse(a.readableAt || a.publishAt) > now);
  if (!copies.some(hosted)) {
    return { ok: false, chapter, why: `its newest chapter (${chapter}) is ${copies.some((a) => a.externalUrl) ? 'only a link to another site' : 'not readable on MangaDex'}` };
  }
  if (copies.some((a) => !hosted(a) && a.pages !== 0)) return { ok: false, chapter, why: `its newest chapter (${chapter}) also has a copy that only looks hosted` };
  return { ok: true, chapter };
}

/**
 * Adds titles until one's chapter lands, and what every step met. `lists` are asked in order, each only once the titles
 * before it ran out: `() => Promise<{ note, titles }>`, where `note` (what that list answered) goes into `tried` and
 * `titles` are `{ sourceId, title }`. Each title is tried once, whichever lists name it, and first held to `hosted`
 * (newestHosted's answer, or `{ ok: null, why }` when MangaDex could not say): a `false` is skipped with its reason, and
 * an unknown one is still added -- the app's add judges it, as it judged every title before this check. `add(title)`
 * adds it and follows its job, answering `{ step, added }`: the step for `tried`, `added` when the chapter landed. At
 * most `maxAdds` adds, within `budgetMs`.
 */
export async function addFirstHosted({ lists, hosted, add, maxAdds = 6, budgetMs = 8 * 60_000, clock = Date.now }) {
  const tried = [];
  const seen = new Set();
  const until = clock() + budgetMs;
  let adds = 0;
  const more = () => adds < maxAdds && clock() <= until;
  for (const list of lists) {
    if (!more()) break;
    const { note, titles } = await list();
    tried.push(note);
    for (const t of Array.isArray(titles) ? titles : []) {
      if (!more()) break;
      if (typeof t?.sourceId !== 'string' || seen.has(t.sourceId)) continue;
      seen.add(t.sourceId);
      const v = await hosted(t);
      if (v.ok === false) {
        tried.push({ title: t.title, skipped: v.why });
        continue;
      }
      adds++;
      const r = await add(t);
      tried.push({ title: t.title, newest: v.ok ? v.chapter : `unknown: ${v.why}`, ...r.step });
      if (r.added) return { added: r.added, step: r.step, tried };
    }
  }
  return { added: null, step: null, tried };
}
