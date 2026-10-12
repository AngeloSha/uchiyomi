// Related works (v0.61.0): what AniList relates a series to, as the series page and the reader's end card show it.
//
// GET /api/series/:id/related answers each related work with AniList's relation -- SEQUEL, PREQUEL, PARENT,
// SIDE_STORY, SPIN_OFF, ALTERNATIVE, in that order -- and either the library's series (`series`, held and listable
// for this viewer) or AniList's cover and words (`outside`, not held). An outside work is found on the sources from
// Discover, which opens on a search for it (`?q=`).
import { keys, t as tr } from './i18n';
import { DISCOVER_HREF } from './libraryStart';
import type { Series } from './types';

/** AniList's relations the server keeps, in the order it answers them. */
export const RELATIONS = ['SEQUEL', 'PREQUEL', 'PARENT', 'SIDE_STORY', 'SPIN_OFF', 'ALTERNATIVE'] as const;
export type Relation = (typeof RELATIONS)[number];

/** What each relation is called, in RELATIONS' order: a label held in an array, declared for the translators. */
export const RELATION_LABELS = keys('Sequel', 'Prequel', 'Main story', 'Side story', 'Spin-off', 'Alternative version');

/** A relation in words, in the viewer's language; empty for one this version does not know. */
export function relationLabel(r: string): string {
  const i = (RELATIONS as readonly string[]).indexOf(r);
  return i < 0 ? '' : tr(RELATION_LABELS[i]);
}

/** Discover, opening on a search for this title across the sources (app/discover/page.tsx reads `?q=` once). */
export function findHref(title: string): string {
  return `${DISCOVER_HREF}?q=${encodeURIComponent(title.trim())}`;
}

/** A related work the server does not hold: AniList's entry, its cover and its words. */
export interface RelatedOutside {
  anilistId: number;
  title: string;
  cover: string | null;
  format: string | null;
  status: string | null;
  score: number | null;
}

export interface RelatedRow { relation: Relation; series?: Series; outside?: RelatedOutside }

/** `lookups: false` -- the series' library does not look things up on AniList, or it has no checked link. */
export interface RelatedAnswer { lookups: boolean; content: RelatedRow[] }

/** The rows a viewer is shown: the ones this version can label, and that carry a series or an outside work. */
export function shownRows(a: RelatedAnswer | undefined, only?: Relation): RelatedRow[] {
  if (!a?.lookups) return [];
  return (a.content ?? []).filter((r) => (RELATIONS as readonly string[]).includes(r.relation)
    && (!!r.series || !!r.outside) && (!only || r.relation === only));
}
