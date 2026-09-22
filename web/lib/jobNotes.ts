/**
 * What a download job card says beyond its counter (v0.40.0).
 *
 * `GET /api/sources/jobs` cards gained two facts the counter cannot carry: which chapters were taken from
 * a source other than the one asked (`switched`), and how many were saved with pages missing (`partial`).
 * Three surfaces read the card -- the downloads pill, Find missing chapters, the add dialog's done step --
 * and each used to word its own lines, which is how "Fetch stopped." came to mean four different things.
 * One function, so the three agree and the locale test sees every sentence once.
 *
 * `nameOf` turns a source id into its display name where the caller has one (the add dialog's providers,
 * the fill's candidates, the pill's source list). The id itself is the fallback, never nothing: an
 * extension's id is nineteen digits, but a line with it still says what happened.
 */
import { t as tr } from './i18n';

export interface JobSwitch {
  number: number;
  from: string;
  to: string;
  /**
   * Why the chapter left its source, when the card says. `rate_limited` is the one case a person should
   * read differently -- the first source did not fail, it asked us to slow down, and the sweep will keep
   * using it -- so it gets its own sentence. Anything else, or nothing, is "took it from the other one".
   */
  why?: string;
}

export interface JobCardNotes {
  switched?: JobSwitch[];
  /** Chapters saved short: the count, not the pages. Each row on the series page says how many pages. */
  partial?: number;
}

/**
 * The lines for one card, in card order: every switch, then the partial count. Empty when the card has
 * nothing to add, so a caller can render nothing rather than an empty box.
 *
 * ⚠️ `partial` counts CHAPTERS. The first draft printed it as "saved with {n} pages missing", which for two
 * short chapters read as two pages. The pages are the series page's to count, per row.
 * Reintroduce by wording the partial line with "pages": the test's two-chapter card says "2 pages".
 */
export function jobNoteLines(job: JobCardNotes | null | undefined, nameOf: (id: string) => string = (id) => id): string[] {
  const out: string[] = [];
  for (const s of job?.switched ?? []) {
    const from = nameOf(s.from);
    const to = nameOf(s.to);
    out.push(s.why === 'rate_limited'
      ? tr('{from} asked us to slow down — continued from {to}', { from, to })
      : tr('took chapter {n} from {to}', { n: s.number, to }));
  }
  const partial = job?.partial ?? 0;
  if (partial > 0) out.push(partial === 1 ? tr('1 chapter saved with pages missing') : tr('{n} chapters saved with pages missing', { n: partial }));
  return out;
}
