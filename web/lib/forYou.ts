// Discover's one "Recommended for you" row (v0.98.0): what the trackers a person connected suggest (Recommended for you,
// #248) and what AniList's readers recommend after the series they read here lately (Because you read, v0.61.0), in one
// row. They were two rails, each half empty -- the owner's own Because you read held four cards on a screen that holds
// fourteen -- and between them they named some titles twice. Pure (test/forYou.test.ts).
import { badgeOf, becauseOf, provenance, type Recommendation } from './recommendations';
import { normTitle } from './normTitle';

/** A Because you read pick (GET /api/discover/because): an AniList entry, and the read series it came from. */
export interface ReadPick {
  id?: number | null;
  title: string;
  cover: string | null;
  score: number | null;
  /** Absent from a server before v0.98.0, which named one read for the whole rail: the answer's `seed`. */
  because?: { id: string; title: string };
}

/** One card of the row: the title, and where it came from. */
export interface Pick {
  id: number | null;
  title: string;
  cover: string | null;
  score: number | null;
  from:
    | { kind: 'tracker'; badge: string; because: string | null; tip: string }
    | { kind: 'read'; seriesId: string; because: string };
}

/** The most cards the row holds. */
export const PICKS_MAX = 40;

/** The AniList entry behind a tracker's suggestion, when AniList made it: its page address carries the id. */
export function anilistIdOf(r: Recommendation): number | null {
  for (const s of r.sources) {
    const m = /anilist\.co\/manga\/(\d+)/.exec(s.url ?? '');
    if (m) return Number(m[1]);
  }
  return null;
}

/**
 * The row: one suggestion from the trackers, then one from the reads, in turn -- each list keeps its own order, best first
 * -- and one card per title, by any name the card goes by or by its AniList entry, the first to name it keeping it. A read
 * pick from an older server names the answer's one `seed`.
 */
export function mergePicks(recs: Recommendation[], reads: ReadPick[], seed: { id: string; title: string } | null = null, max = PICKS_MAX): Pick[] {
  const out: Pick[] = [];
  const names = new Set<string>();
  const ids = new Set<number>();
  const take = (p: Pick, alt: readonly string[]) => {
    // A title of no Latin letters normalises to nothing, and nothing is not a name two cards share.
    const keys = [p.title, ...alt].map(normTitle).filter(Boolean);
    if (keys.some((k) => names.has(k)) || (p.id != null && ids.has(p.id))) return;
    for (const k of keys) names.add(k);
    if (p.id != null) ids.add(p.id);
    out.push(p);
  };
  for (let i = 0; out.length < max && (i < recs.length || i < reads.length); i++) {
    const r = recs[i];
    if (r) {
      take({
        id: anilistIdOf(r), title: r.title, cover: r.cover, score: r.score,
        from: { kind: 'tracker', badge: badgeOf(r), because: becauseOf(r), tip: provenance(r) },
      }, r.altTitles ?? []);
    }
    const b = reads[i];
    const from = b?.because ?? seed;
    if (b && from && out.length < max) {
      take({ id: b.id ?? null, title: b.title, cover: b.cover, score: b.score, from: { kind: 'read', seriesId: from.id, because: from.title } }, []);
    }
  }
  return out;
}

/** The most read series the For you band shows beside "Because you read…". */
export const SEEDS_SHOWN = 5;

/**
 * The read series the picks came from (v0.99.0, components/ForYouBand.tsx): each once, in the order the picks name them,
 * at most `max` -- so every cover beside "Because you read…" belongs to a card in the band. A tracker's suggestion names
 * a title but no series here, and adds none.
 */
export function seedsOf(picks: readonly Pick[], max = SEEDS_SHOWN): Array<{ seriesId: string; title: string }> {
  const out: Array<{ seriesId: string; title: string }> = [];
  const seen = new Set<string>();
  for (const p of picks) {
    if (out.length >= max) break;
    if (p.from.kind !== 'read' || seen.has(p.from.seriesId)) continue;
    seen.add(p.from.seriesId);
    out.push({ seriesId: p.from.seriesId, title: p.from.because });
  }
  return out;
}
