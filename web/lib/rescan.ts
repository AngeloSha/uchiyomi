/**
 * Admin → Tasks → Rescan everything (v0.55.4, discussion #150), the React-free half: the server's shapes, and every
 * sentence the panel says about a preview, a run and an Apply, so a test can hold each one without a browser.
 *
 * The server (bff lib/rescan.ts) previews first and changes nothing: it scans, looks for every chapter's own file,
 * and keeps a plan. Apply marks the chapters whose files are gone from your own folders as "File no longer on disk"
 * -- the rows and everyone's history stay -- and, for the series the admin ticked, reads the chapter numbers again by
 * the newer file-name rules. Its result is the Tasks line's.
 */
import { t as tr } from './i18n';

// ---- the server's shapes (bff routes/rescan.ts) ------------------------------------------------------------------

export type RescanPhase = 'scan' | 'look' | 'pair' | 'numbers' | 'mark' | 'renumber';

/** A folder that looked unmounted: no file at all behind its rows, or `missing` of `of` gone (the 90 % rule). */
export interface RescanUnmounted { root: string; missing?: number; of?: number }

/** A series whose chapter numbers the newer file-name rules would change (the opt-in), as the preview counted it. */
export interface RescanNumbers {
  seriesId: string;
  title: string;
  /** Chapters whose number (or range) changes. */
  chapters: number;
  /** Readers who finished one of them. */
  readers: number;
  /** Chapters an admin numbered by hand, which keep that number. */
  overrides: number;
  /** Linked to a tracker, and of the changed chapters someone finished, how many go up and how many go down. */
  tracked: boolean;
  up: number;
  down: number;
  /** A few of the changes, as file name and numbers ("2" → "5", "1" → "1–7"). */
  examples: Array<{ file: string; from: string; to: string }>;
}

export interface RescanPlanView {
  id: string;
  at: number;
  scannedAt: number;
  ms: number;
  stale: boolean;
  applied: boolean;
  looked: number;
  unchecked: number;
  unmounted: RescanUnmounted[];
  gone: number;
  moved: number;
  downloads: number;
  emptied: number;
  goneSeries: number;
  emptiedList: Array<{ seriesId: string; chapters: number; title: string }>;
  movedList: Array<{ seriesId: string; title: string; file: string; to: { seriesId: string; title: string; file: string } }>;
  /** The opt-in (absent from a server before it): every series it would change, and how many in all. */
  numbers?: RescanNumbers[];
  numbersTotal?: number;
}

export interface RescanApplied {
  ok: true;
  plan: string;
  marked: number;
  back: number;
  changed: number;
  moved: number;
  /**
   * Series left alone because a download or a check was running in them as Apply reached them (v0.55.4: a Fetch's
   * lanes, the slow archive's chapter): none of their chapters marked or renumbered, for the next Rescan.
   */
  busy?: number;
  downloads: number;
  emptied: number;
  unmounted: RescanUnmounted[];
  ms: number;
  stopped?: 'shutdown';
  /** The opt-in: series and chapters read again by the newer rules. */
  renumbered?: { series: number; chapters: number };
}

export interface RescanStatus {
  running: 'preview' | 'apply' | null;
  phase: RescanPhase | null;
  done: number;
  of: number | null;
  startedAt: number | null;
  error: 'failed' | 'stopped' | null;
  plan: RescanPlanView | null;
  last: RescanApplied | null;
  lastRun: number | null;
}

export type ApplyRefusal =
  | 'busy' | 'no_plan' | 'stale' | 'applied' | 'not_in_plan'
  | 'sweep_running' | 'autofix_running' | 'repair_running' | 'verify_running' | 'cleanup_running' | 'scan_running';

/** A name the reader's language cannot reorder around: a folder path or a file name inside a sentence. */
const iso = (s: string): string => `\u2068${s}\u2069`;
/** The last part of a path: what a row's `file` is called in a sentence. */
export const fileName = (file: string): string => file.split('/').pop() || file;

// ---- what the panel says ----------------------------------------------------------------------------------------

/** What a running preview or Apply is doing, as one line. */
export function progressLine(s: Pick<RescanStatus, 'running' | 'phase' | 'done' | 'of'>): string {
  // Each sentence a literal, so the locale scan sees it (localeCoverage.test.ts reads inline tr() calls only).
  const n = typeof s.of === 'number' && s.of > 0 ? { done: Math.min(s.done, s.of), total: s.of } : null;
  switch (s.phase) {
    case 'scan': return tr('Scanning the library…');
    case 'look': return n ? tr('Looking for every chapter file: {done} of {total}', n) : tr('Looking for every chapter file…');
    case 'pair': return n ? tr('Checking for moved or renamed files: {done} of {total}', n) : tr('Checking for moved or renamed files…');
    case 'numbers': return tr('Reading file names by the new rules…');
    case 'mark': return n ? tr('Applying: {done} of {total}', n) : tr('Applying…');
    case 'renumber': return tr('Renumbering the series you ticked…');
    default: return s.running === 'apply' ? tr('Applying…') : tr('Scanning the library…');
  }
}

/**
 * The preview's headline, the brief's four counts: gone from your folders · moved or renamed (kept) · in the
 * download folder (Verify's) · series with nothing left. The first is always said, the others when there are any.
 */
export function planHeadline(p: Pick<RescanPlanView, 'gone' | 'moved' | 'downloads' | 'emptied'>): string {
  const bits = [
    p.gone === 0 ? tr('No chapter file is gone from your folders')
      : p.gone === 1 ? tr('1 chapter file is gone from your folders') : tr('{n} chapter files are gone from your folders', { n: p.gone }),
  ];
  if (p.moved) bits.push(movedText(p.moved));
  if (p.downloads) {
    bits.push(p.downloads === 1 ? tr('1 in the download folder, left to Verify chapter files')
      : tr('{n} in the download folder, left to Verify chapter files', { n: p.downloads }));
  }
  if (p.emptied) bits.push(p.emptied === 1 ? tr('1 series with nothing left') : tr('{n} series with nothing left', { n: p.emptied }));
  return bits.join(' · ');
}

const movedText = (n: number): string =>
  (n === 1 ? tr('1 was probably moved or renamed (kept)') : tr('{n} were probably moved or renamed (kept)', { n }));

/** A folder the preview (or an Apply) left alone because it looked unmounted, with the share of it when that was why. */
export function unmountedLine(u: RescanUnmounted): string {
  if (u.missing != null && u.of) {
    return tr('{root}: {pct} % of {total} chapter files are gone, which looks like a folder that is not mounted. Nothing under it is touched.',
      { root: iso(u.root), pct: Math.round((100 * u.missing) / u.of), total: u.of });
  }
  return tr('{root} looks unmounted. Nothing under it is touched.', { root: iso(u.root) });
}

/** Files that could not be checked at all (a permission, an I/O error): never called gone. */
export const uncheckedLine = (n: number): string =>
  (n === 1 ? tr('1 file could not be checked and was left alone') : tr('{n} files could not be checked and were left alone', { n }));

/** One series of the opt-in, as a line under its title. */
export function numbersLine(n: Pick<RescanNumbers, 'chapters' | 'readers' | 'overrides' | 'tracked' | 'up' | 'down'>): string {
  const bits = [n.chapters === 1 ? tr('1 chapter is renumbered') : tr('{n} chapters are renumbered', { n: n.chapters })];
  if (n.readers) bits.push(n.readers === 1 ? tr('1 reader finished one of them') : tr('{n} readers finished one of them', { n: n.readers }));
  if (n.overrides) bits.push(n.overrides === 1 ? tr('1 with a number set by hand keeps it') : tr('{n} with a number set by hand keep it', { n: n.overrides }));
  // Only for a series linked to a tracker, where a finished chapter's number is what the tracker is told next.
  if (n.tracked && n.up) bits.push(n.up === 1 ? tr('1 finished chapter gets a higher number on a tracker') : tr('{n} finished chapters get a higher number on a tracker', { n: n.up }));
  if (n.tracked && n.down) {
    bits.push(n.down === 1 ? tr('1 finished chapter gets a lower number; the tracker keeps the higher one')
      : tr('{n} finished chapters get a lower number; the tracker keeps the higher one', { n: n.down }));
  }
  return bits.join(' · ');
}

/**
 * One example change: the file, its number now, its number by the new rules. Each part isolated: in Arabic a range
 * "1–7" left to the paragraph's direction reads "7–1", and a file name breaks the sentence around it.
 */
export const exampleLine = (e: { file: string; from: string; to: string }): string =>
  tr('{file}: {from} → {to}', { file: iso(fileName(e.file)), from: iso(e.from), to: iso(e.to) });

/**
 * What an Apply did, as one line: the Tasks line (lib/tasks.ts). Its clauses are joined by " · ", not commas: two of
 * them carry a comma of their own ("1 back on disk before Apply, left alone").
 * ⚠️ A folder left alone as unmounted comes FIRST, for Verify's reason: the result is the only record of a detached
 * run, and a clause at the end of a long line is the clause that is off the edge of a phone.
 */
export function appliedLine(r: RescanApplied): string {
  const bits: string[] = [];
  for (const u of r.unmounted ?? []) bits.push(tr('{root} no longer held the files the preview saw: nothing under it was marked', { root: iso(u.root) }));
  if (r.stopped === 'shutdown') bits.push(tr('stopped for a restart'));
  bits.push(r.marked === 1 ? tr('1 chapter marked as no longer on disk') : tr('{n} chapters marked as no longer on disk', { n: r.marked }));
  if (r.back) bits.push(r.back === 1 ? tr('1 back on disk before Apply, left alone') : tr('{n} back on disk before Apply, left alone', { n: r.back }));
  if (r.changed) bits.push(r.changed === 1 ? tr('1 changed since the preview, left alone') : tr('{n} changed since the preview, left alone', { n: r.changed }));
  if (r.moved) bits.push(movedText(r.moved));
  // Said, or a series Apply did not touch reads as one it found nothing in: the next Rescan has it.
  if (r.busy) {
    bits.push(r.busy === 1 ? tr('1 series had a download or a check running and was left alone')
      : tr('{n} series had a download or a check running and were left alone', { n: r.busy }));
  }
  const s = r.renumbered?.series ?? 0;
  if (s) bits.push(s === 1 ? tr('1 series renumbered by the new rules') : tr('{n} series renumbered by the new rules', { n: s }));
  return bits.join(' \u00b7 ');
}

/** Why an Apply did not start, as the panel says it. Each job by name, as the repair and the sweep refuse each other. */
export function applyRefusalText(error: string | undefined): string {
  switch (error) {
    case 'stale': case 'no_plan': return tr('This preview is more than 30 minutes old, or a newer one replaced it. Run it again to see the library as it is now.');
    case 'applied': return tr('This preview was already applied.');
    case 'busy': return tr('Already running');
    case 'not_in_plan': return tr('A series you ticked is not in this preview any more. Run it again.');
    case 'sweep_running': return tr('A chapter sweep is running — try again in a few minutes');
    case 'repair_running': return tr('The library repair is running — try again in a few minutes');
    case 'autofix_running': return tr('Fix everything is running — try again when it has finished');
    case 'verify_running': return tr('Verify chapter files is running — try again when it has finished');
    case 'cleanup_running': return tr('Delete read chapters is running — try again in a few minutes');
    case 'scan_running': return tr('A library scan is running — try again in a moment');
    default: return tr('Failed');
  }
}

/**
 * What the panel under the Tasks row shows now. `dismissed` is the plan whose preview or result the admin closed.
 * The result of an Apply is the Tasks line's; the panel stays only for what the line cannot hold -- the series with
 * nothing left, each a link -- and only under the plan that Apply was of.
 */
export type RescanView = 'none' | 'running' | 'preview' | 'result' | 'failed';
export function rescanView(s: RescanStatus | null | undefined, dismissed: string | null): RescanView {
  if (!s) return 'none';
  if (s.running) return 'running';
  const p = s.plan;
  if (p && !p.applied) return p.id === dismissed ? 'none' : 'preview';
  if (p && p.applied && s.last?.plan === p.id && p.emptied > 0) return p.id === dismissed ? 'none' : 'result';
  if (s.error === 'failed' && dismissed !== 'failed') return 'failed';
  return 'none';
}
