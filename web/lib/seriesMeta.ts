/**
 * Edit details' metadata (v0.53.0): what the dialog seeds its fields from, what one save sends, and the one queue
 * every save goes through. Apart from React so web/test/seriesEditor.test.ts holds these rules on plain values;
 * components/SeriesEditor.tsx draws the fields.
 *
 * ⚠️ THE ROUTE WRITES EVERY FIELD ON EVERY CALL. `PUT /api/admin/series/:id/meta` sets title, summary, author,
 * status, genres and the age rating unconditionally (bff routes/admin.ts), so a body that left one out would clear
 * that override. Until v0.53.0 one "Save details" key sent them all; now each field saves as it is changed or left,
 * so each of those saves is the WHOLE object as it stands -- `metaBody` -- never the one field that changed.
 */
import type { Series } from './types';

export interface SeriesMeta {
  title: string;
  summary: string;
  author: string;
  status: string;
  /** A minimum age as a string, or '' for "whatever the files said". */
  ageRating: string;
  genres: string[];
  /** "Always show": kept on the shelf while "Show 18+" is off. */
  adultExempt: boolean;
  /** One of Komga's four, or '' for automatic. */
  readingDirection: string;
}

/**
 * The fields as the dialog opens them. ⚠️ Exactly the rules the dialog has always seeded by (v0.48.0, v0.42.0):
 *
 * - author, status, the age rating and the genres: the OVERRIDE where one exists, else the scanned value. Seeding
 *   from the scan alone showed the scanned author while an override was active, and a save then wrote the very
 *   value the override was made to replace back over it.
 * - "Always show" and the reading direction: the override ONLY. The direction's effective value is whatever was
 *   detected (the chapter files, the source, AniList: bff lib/readingDirection.ts), and seeding from it turned that
 *   into a hand-set override on the first unrelated save -- a retitle -- after which a better signal could never
 *   reach the series again. An exemption seeded `false` without reading it would clear every one on a retitle.
 * - title and description: what the series shows, the override applied (the payload's `metadata`).
 */
export function seedMeta(series: Series): SeriesMeta {
  const o = series.overrides;
  const m = series.metadata;
  return {
    title: m?.title || series.name || '',
    summary: m?.summary || series.booksMetadata?.summary || '',
    author: o?.author ?? m?.author ?? '',
    status: o?.status ?? m?.status ?? '',
    // A minimum age. Age caps on member accounts compare against it, and an unrated series stays visible to
    // everyone -- so setting one opts a title IN to being filtered, never the rest of the library out.
    ageRating: o?.ageRating != null ? String(o.ageRating) : m?.ageRating != null ? String(m.ageRating) : '',
    genres: o?.genres ?? m?.genres ?? [],
    adultExempt: o?.adultExempt === true,
    readingDirection: o?.readingDirection ?? '',
  };
}

/** What one save sends: every field, '' as null where the route reads null as "back to what the files say". */
export function metaBody(m: SeriesMeta) {
  return {
    title: m.title,
    summary: m.summary,
    author: m.author,
    status: m.status,
    genres: m.genres,
    ageRating: m.ageRating === '' ? null : Number(m.ageRating),
    adultExempt: m.adultExempt,
    // '' is automatic and goes up as null, which the route reads as "clear the override".
    readingDirection: m.readingDirection || null,
  };
}

export type MetaBody = ReturnType<typeof metaBody>;

export interface MetaSaver {
  /** The fields as they stand: the dialog's own, saved or on their way. */
  current(): SeriesMeta;
  /** Change some fields and save the whole object; rejects (and puts those fields back) when the save fails. */
  save(patch: Partial<SeriesMeta>): Promise<void>;
}

/**
 * The one way a field is saved.
 *
 * ⚠️ ONE PUT AT A TIME, built when it is SENT. Two saves in flight together -- a title left by tapping a status --
 * could land in either order, and the route keeps the last: the first save's body, read before the status
 * changed, would put the old status back. So each save waits for the one before it and then sends the object as it
 * stands at that moment, which holds every change made meanwhile.
 *
 * A save that fails puts back the fields it changed (unless a later change has already replaced them), so the
 * fields never show a value the server refused while the header says "Could not save"; the next save that
 * succeeds carries everything else.
 */
export function metaSaver(initial: SeriesMeta, put: (body: MetaBody) => Promise<unknown>, onChange: (m: SeriesMeta) => void): MetaSaver {
  let now = initial;
  let queue: Promise<unknown> = Promise.resolve();
  const set = (m: SeriesMeta) => { now = m; onChange(m); };
  return {
    current: () => now,
    save(patch) {
      const before = now;
      const after = { ...now, ...patch };
      set(after);
      const sent = queue.catch(() => {}).then(() => put(metaBody(now)));
      queue = sent;
      return sent.then(() => undefined, (e) => {
        const back = { ...now };
        for (const k of Object.keys(patch) as (keyof SeriesMeta)[]) {
          if (now[k] === after[k]) (back as Record<string, unknown>)[k] = before[k];
        }
        set(back);
        throw e;
      });
    },
  };
}
