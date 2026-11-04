// Posting-order numbering on the web side (#116): the shapes the server answers, and the pure decisions the add
// dialog, the series page's notice and its plan sheet make from them.
//
// The server decides (bff lib/postingOrder.ts detects, lib/numbering.ts applies); nothing here re-derives a
// number. A source that gives many different posts one chapter number -- Webtoons: Istrevelia's 226 posts on 13
// numbers -- is numbered 1..K in the order the posts came out. New adds are numbered so at once; a series already
// in a library is renamed only when an admin has seen the plan and confirmed it. A source that counts its specials
// as chapters (#379, Tapas: "24. The Other Side" is its 27) is numbered by its chapter titles, through the same doors.
import { t as tr } from './i18n';
import { saidText, type Said } from './said';

export type NumberingMode = 'source' | 'posting_order' | 'titles';
export type RenumberMode = 'posting_order' | 'titles' | 'source' | 'remap';
/**
 * Which plan the sheet shows: one numbering, or `next` -- the change waiting for review, else the other numbering,
 * which is GET /api/admin/series/:id/numbering's own pick when it is asked for no mode. Health's rows open `next`:
 * a row knows its series needs a look, and the server knows which change it is.
 */
export type PlanMode = RenumberMode | 'next';

/** GET /api/sources/detail `numbering`: the detector's word on the listing the add dialog is about to add. */
export interface DetailNumbering {
  verdict: 'strong' | 'hint' | 'none';
  reason?: 'no_order';
  /**
   * How the add will number it with nothing changed: posting_order when the detector fired strongly, titles when the
   * source counts its specials as chapters (#379).
   */
  applied: NumberingMode;
  ordered: boolean;
  posts: number;
  numbers: number;
  biggest: { number: number; posts: number } | null;
  examples: string[];
  /** The other reading's count and range, for the dialog's switch; null when there is nothing to switch to. */
  alt: { count: number; first: number; last: number } | null;
  /** #379, when `applied` is titles: how many posts are specials, and the newest chapter the source numbers ahead of its title. */
  titles?: TitlesNote;
  /** The extension source id, for the settings deep link (extension sources only). */
  extSourceId?: string;
}

/** A source that counts its specials as chapters (#379): the server's own figures, and one chapter it numbers ahead of its title. */
export interface TitlesNote {
  specials: number;
  moved: number;
  example: { title: string; from: number; to: number } | null;
}

/** The detector's last word on a series' numbering source (lib_series.numbering_note). */
export interface NumberingNote {
  verdict: 'strong' | 'hint' | 'none';
  reason?: 'no_order';
  ordered: boolean;
  posts: number;
  numbers: number;
  extras: number;
  biggest: { number: number; posts: number } | null;
  examples: string[];
  /** #379: present when the source counts its specials as chapters. */
  titles?: TitlesNote & { posts: number };
  source: string;
  at?: string;
}

/** GET /api/series/:id/listing `numbering`: how the series is numbered, and what is waiting. */
export interface NumberingSummary {
  /** null: automatic (the detector has not numbered it), `source`, `posting_order`, or `titles`. */
  mode: NumberingMode | null;
  by: 'auto' | 'manual' | null;
  pending: RenumberMode | null;
  note: NumberingNote | null;
  changedAt: string | null;
  sourceName: string | null;
  extSourceId?: string;
}

export interface PlanMove {
  bookId: string;
  root: string;
  from: number;
  to: number;
  fromFile: string;
  file: string;
  /** rename: on disk and in the library. row: a deleted chapter's row only. override: an unwritable folder keeps the file. none: nothing changes. */
  via: 'rename' | 'row' | 'override' | 'none';
  how?: 'id' | 'pick' | 'stored' | 'name' | 'date' | 'listing';
  title?: string | null;
}

export interface RenumberPlan {
  mode: RenumberMode;
  moves: PlanMove[];
  parked: PlanMove[];
  collisions: Array<{ root: string; number: number; bookIds: string[] }>;
  clean: boolean;
  reasons: Array<'unmatched' | 'listing_only' | 'collision' | 'tracker' | 'busy'>;
  newFloor: number | null;
}

/** GET /api/admin/series/:id/numbering. */
export interface PlanAnswer { mode: RenumberMode; plan: RenumberPlan; tracker: boolean; numbering: NumberingSummary | null }
/** POST /api/admin/series/:id/numbering. */
export interface NumberingAnswer {
  state: 'applied' | 'pending' | 'needs_confirm' | 'unchanged';
  plan?: RenumberPlan;
  tracker?: boolean;
  running?: boolean;
  /**
   * Why a confirmed apply was refused, in the server's words: a file already at a target name, a path that would
   * leave its library root (bff lib/numbering.ts RenumberRefused). Absent from a server that does not carry it yet.
   */
  error?: string;
  /** v0.49.1: `error` as a code lib/said.ts words, with the file it names. */
  errorSaid?: Said;
  numbering: NumberingSummary | null;
}

// ---- the add dialog -----------------------------------------------------------------------------------------

/**
 * What the add dialog shows and sends, from the detail and its one switch. The switch always means "the other
 * reading": when the add renumbers (a STRONG verdict, or a source that counts its specials, #379) it is "Keep the
 * source's numbers", under a HINT "Number by posting order". `send` is what POST /api/sources/add gets: `auto`
 * whenever the switch is untouched, so the server's own decision stands (a revived folder, a manual choice kept on
 * its row). `titles`: the add numbers each chapter by its title.
 */
export function addNumberingView(
  d: { count: number; first: number | null; last: number | null; numbering?: DetailNumbering },
  flipped: boolean,
): { count: number; first: number | null; last: number | null; posting: boolean; titles: boolean; send: 'auto' | 'source' | 'posting_order'; offer: 'keep' | 'number' | null } {
  const n = d.numbering;
  // Reintroduce by offering the switch on the shared-numbers verdict alone: "the add dialog numbers a source that counts
  // its specials by the titles" in numbering.test.ts finds no switch (that verdict is `none` there).
  const offer = !n || !n.alt ? null : n.applied !== 'source' ? 'keep' : n.verdict === 'none' ? null : 'number';
  if (!n || !offer || !flipped) {
    return { count: d.count, first: d.first, last: d.last, posting: n?.applied === 'posting_order', titles: n?.applied === 'titles', send: 'auto', offer };
  }
  const alt = n.alt!;
  const posting = offer === 'number';
  return { count: alt.count, first: alt.first, last: alt.last, posting, titles: false, send: posting ? 'posting_order' : 'source', offer };
}

/**
 * The add dialog's notice heading: the reading the add WILL use, from the same view as its counts. It said
 * "Numbered by posting order" above a switched-on "Keep the source's numbers" (the e2e walk's shot), a heading that
 * contradicted the choice right under it. Under a hint the untouched notice names what it found; switched on, the
 * reading it chose.
 */
export function addNoticeHeading(view: { posting: boolean; titles?: boolean; offer: 'keep' | 'number' | null }): string {
  if (view.posting) return tr('Numbered by posting order');
  if (view.titles) return tr('Numbered by the chapter titles');
  return view.offer === 'keep' ? tr('Keeping the source’s own numbers') : tr('Some posts share a chapter number');
}

/**
 * Why a source's numbers are not its chapters' (#379), with the newest chapter it numbers ahead of its title when the
 * server names one: "Tapas counts its specials as chapters, so its chapter numbers run ahead of their titles (it
 * numbers “24. The Other Side” 27)." The add dialog, the series page's notice and the plan say it the same way.
 */
export function titlesLine(source: string, t: Pick<TitlesNote, 'example'> | null | undefined): string {
  const ex = t?.example;
  return ex
    ? tr('{source} counts its specials as chapters, so its chapter numbers run ahead of their titles (it numbers “{title}” {number}).', { source, title: ex.title, number: numLabel(ex.from) })
    : tr('{source} counts its specials as chapters, so its chapter numbers run ahead of their titles.', { source });
}

// ---- the series page ----------------------------------------------------------------------------------------

/**
 * Which notice the series page shows, if any:
 *   review   -- a change waits for an admin (the detector's proposal, or the undo): nothing downloads meanwhile;
 *   remap    -- an extension setting moved the source's numbers under the files: same, with its own reason;
 *   applied  -- numbered by posting order, or by the chapter titles (#379): say why the numbers are not the source's;
 *   hint     -- some posts share a number, not strongly enough to act on: offer posting order;
 *   null     -- nothing to say, including a series an admin chose to keep on the source's numbers.
 */
export type NoticeKind = 'review' | 'remap' | 'applied' | 'hint' | null;
export function noticeKind(n: NumberingSummary | null | undefined): NoticeKind {
  if (!n) return null;
  if (n.pending === 'remap') return 'remap';
  if (n.pending) return 'review';
  if (n.mode === 'posting_order' || n.mode === 'titles') return 'applied';
  if (n.by === 'manual') return null;
  if (n.note?.verdict === 'hint' || n.note?.verdict === 'strong') return 'hint';
  return null;
}

/** The plan sheet's first line: how many files move, how many stay, and what could not be matched. */
export function planCounts(p: RenumberPlan): { renamed: number; unchanged: number; parked: number; collisions: number } {
  const moved = (m: PlanMove) => m.via !== 'none' && (m.to !== m.from || m.file !== m.fromFile);
  return {
    renamed: p.moves.filter(moved).length,
    unchanged: p.moves.filter((m) => !moved(m)).length,
    parked: p.parked.length,
    collisions: p.collisions.length,
  };
}

/** A number as a chapter label shows it: at most three decimals, no float noise (a parked book sits at 7.5). */
export const numLabel = (n: number): string => String(Math.round(n * 1000) / 1000);

/** A rename under a download writing into the folder would race the file it writes: the route says 409 `busy`. */
const busyLine = (): string => tr('Chapters are being fetched for this series. Try again when that ends.');

/**
 * The server's own words when a renumber waits for another run inside the series -- the sweep or a check reading
 * its listing (bff lib/numbering.ts CHECKING_NOW; numbering.test.ts holds the two equal). The route's 409 is `busy`
 * for this AND for a download writing into the folder, so only the message tells them apart; both were said as
 * "chapters are being fetched", which sent an admin looking for a download that was not there. A confirmed POST
 * carries the same sentence as `error` when the check that would apply it met another run.
 */
export const CHECKING_NOW = 'This series is being checked right now. Try again when that ends.';
const checkingLine = (): string => tr('This series is being checked right now. Try again when that ends.');

/**
 * Why a confirmed renumbering is not applied yet (POST answered `pending`), in words. It used to be one sentence
 * for every cause -- "the source may not have answered" -- so an admin with a stray file at a target name was
 * told to retry, and retried, for a reason that was never the source: the rename still running past the request,
 * the server's own refusal, chapters being fetched into the folder, and only then the source.
 */
export function pendingLine(r: Pick<NumberingAnswer, 'running' | 'error' | 'errorSaid' | 'plan'>): string {
  if (r.running) return tr('Still renaming. The series page shows the new numbers when it is done.');
  // A refusal names a file ("Chapter 21.cbz is already on disk"): in the reader's language by its code (v0.49.1),
  // the file's name as it is; from an older server, the check by its sentence and the rest as sent.
  if (r.error) return saidText(r.errorSaid, r.error === CHECKING_NOW ? checkingLine() : r.error);
  if (r.plan?.reasons.includes('busy')) return busyLine();
  return tr('It could not be applied yet. The source may not have answered; try again in a moment.');
}

/** The body of a refused API call, or nothing when it is not JSON. */
function bodyOf(e: unknown): { error?: string; message?: string; messageSaid?: Said } {
  try { return JSON.parse((e as { body?: string } | null)?.body || '{}'); } catch { return {}; }
}

/**
 * A refused numbering request, in words: in the reader's language by its code (`messageSaid`, v0.49.1). From an
 * older server, its two `busy`s are told apart by their sentence -- a download in the folder, or a check inside
 * the series -- and the rest is as sent.
 */
export function refusalText(e: unknown, fallback: string): string {
  const j = bodyOf(e);
  const old = j.error === 'busy' ? (j.message === CHECKING_NOW ? checkingLine() : busyLine()) : j.message || fallback;
  return saidText(j.messageSaid, old);
}

/**
 * A plan that could not be shown, in words: in the reader's language by its code; from an older server, its 502
 * `unreachable` -- the source did not answer the fresh listing -- by the error, and anything else as sent.
 */
export function planErrorText(e: unknown, fallback: string): string {
  const j = bodyOf(e);
  const old = j.error === 'unreachable' ? tr('The source did not answer, so there is no plan to show. Try again in a moment.') : j.message || fallback;
  return saidText(j.messageSaid, old);
}

/**
 * What a confirmed renumbering came to, for a Health row's status line: done, still renaming past the request (it
 * carries on; partial, not failed), or not applied and why.
 */
export function numberingOutcome(r: NumberingAnswer): { text: string; ok?: false; partial?: true } {
  if (r.state === 'applied' || r.state === 'unchanged') return { text: tr('Renumbered') };
  if (r.running) return { text: pendingLine(r), partial: true };
  return { text: pendingLine(r), ok: false };
}
