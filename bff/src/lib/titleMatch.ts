// Which search result IS the title we asked for -- the one rule every cross-source lookup applies.
//
// This lived inside routes/sources.ts for as long as the fill scan, the import review and the "find on
// another source" button were the only callers, and a lib that needed it (lib/autoFollow.ts) had to carry
// a copy of the normalisation instead, because a lib cannot import a route without pulling the whole
// Fastify plugin -- and its module-level caches -- into the updater's module graph. The source hunt
// (lib/sourceHunt.ts) is a lib that searches, so the rule now lives where every caller can reach it, and
// routes/sources.ts imports it like everyone else.
//
// The one rule that matters here is the last line of `pickBestScored`: NEVER fall back to list[0]. A
// provider's first result for a title it does not carry is an unrelated manga -- the "wrong manga" bug
// that once filed another series' chapters under a title's folder -- and a caller that wants "something"
// rather than "this" is asking the wrong question.

/**
 * The comparison key for a title: lower case, letters and digits only.
 *
 * ⚠️ The same rule as `norm` in routes/sources.ts and `normTitle` in web/lib/normTitle.ts, spelt the
 * same way on purpose. The route's copy is held by wall.test.ts against the web's as text, so it cannot be
 * replaced by an import of this one; autoFollow.int.test.ts holds this one against the route's by value.
 */
export const normTitle = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** Words that carry no identity: a token-overlap match must not be earned by "the" and "of". */
const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'to', 'in', 'is', 'no', 'my', 'i', 'on', 'with', 'for']);

/** Title-match confidence tiers, best first. Exposed to callers that show the pick to a person (import review). */
export type MatchConfidence = 'same_source' | 'exact' | 'contains' | 'fuzzy';

/**
 * Best title-match for a provider, or null if it doesn't really carry the title. NEVER fall back to list[0]
 * -- a provider's first result for a title it lacks is an unrelated manga (the "wrong manga" bug).
 *
 * Scored version used where the caller (or a human) needs to know HOW GOOD the match is, not just what it
 * is. Kept separate from `pickBest` below rather than changing its signature: fifteen existing call sites
 * only ever wanted the item.
 */
export function pickBestScored<T extends { title: string }>(list: T[], term: string): { item: T; confidence: MatchConfidence } | null {
  if (!list.length) return null;
  const n = normTitle(term);
  const exact = list.find((r) => normTitle(r.title) === n);
  if (exact) return { item: exact, confidence: 'exact' };
  const sub = list.find((r) => { const t = normTitle(r.title); return t.length > 2 && (t.includes(n) || n.includes(t)); });
  if (sub) return { item: sub, confidence: 'contains' };
  // token overlap: most meaningful query words must appear in the title
  const qw = term.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w));
  if (qw.length) {
    let best: T | null = null;
    let score = 0;
    for (const r of list) {
      const tw = new Set(r.title.toLowerCase().split(/[^a-z0-9]+/));
      const hit = qw.filter((w) => tw.has(w)).length / qw.length;
      if (hit > score) { score = hit; best = r; }
    }
    if (score >= 0.7 && best) return { item: best, confidence: 'fuzzy' };
  }
  return null;
}

/** `pickBestScored` for the callers that only want the item. */
export function pickBest<T extends { title: string }>(list: T[], term: string): T | null {
  return pickBestScored(list, term)?.item ?? null;
}
