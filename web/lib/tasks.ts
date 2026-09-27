import { bytes, durationText } from './format';
import { keys, t as tr } from './i18n';

/**
 * The tasks' names, by id, in the words GET /api/admin/tasks sends in English (v0.49.0). Declared through
 * `keys()` so the extractor and the locale tests see them: the page renders `tr(name)`, which a scan for
 * inline tr() calls cannot read.
 */
export const TASK_NAMES = keys(
  'Library scan', 'Check for new chapters', 'Backup database & config', 'Fingerprint library files',
  'Find repeated pages', 'Verify chapter files', 'Repair library', 'Delete read chapters', 'Extension updates',
);

/**
 * Every schedule sentence the tasks route sends as `scheduleKey` (bff routes/admin.ts `sched()`), with its
 * values in `scheduleVars`. ⚠️ A new sentence there is a new key here and in the eight locale files; the
 * taskResult test reads the route and fails on one this list does not carry.
 */
export const SCHEDULE_KEYS = keys(
  'on demand', 'every {h}h', 'daily at {hh}:00', 'in the background, rechecked every 6h',
  'on demand · after a database-only restore', 'switched off · on demand', 'every {h}h · never during a chapter sweep',
  'hourly · as soon as everyone has finished', 'hourly · 1 day after everyone has finished',
  'hourly · {n} days after everyone has finished', 'every {h}h · check only',
);

/** A task's schedule in the reader's language; the English `schedule` for a server older than v0.49.0. */
export function scheduleText(t: { schedule?: string; scheduleKey?: string; scheduleVars?: Record<string, string | number> }): string {
  return t.scheduleKey ? tr(t.scheduleKey, t.scheduleVars) : (t.schedule ?? '');
}


/**
 * The one-line outcome shown beside a background task in Admin.
 *
 * Lives here rather than in the admin page because it is the only part of that page with real branching, and
 * every branch exists because of a run that reported nothing useful. A sweep in which every source was down
 * and one in which nothing was new both rendered "+0 chapters", so a library that had quietly stopped
 * updating looked exactly like a quiet week.
 *
 * Duck-typed on the shape of the result, because the tasks endpoint returns whatever the job stored: `added`
 * is the chapter sweep, `bytes` the backup, `refreshed` the extension check, `counted` the nightly repair.
 */
export function taskResult(r: any): string {
  if (!r) return '';
  // "Repair library" (v0.41.0), FIRST because it is the only result with five sections and the only one
  // that can report a step it deliberately did not run. `counted` is the key: no other job counts pages.
  //
  // ⚠️ Only the steps that RAN get a clause. A run started from a Health chip carries `only: ['short']`,
  // and rendering the full line for it would say "0 page counts stamped · gaps: 0 series" about work that
  // was never asked for -- which reads as a repair that found nothing to do, the exact failure every
  // branch in this file exists to prevent.
  //
  // ⚠️ A `stopped` run leads the line, for the reason the verify branch below does: the numbers after it
  // are partial, and a clause at the end of a long line is the clause that is off the edge of a phone.
  // Reintroduce by pushing it last: "a repair that stopped early says so before its counts" fails.
  if (typeof r.counted === 'number') {
    if (r.skipped === 'disabled') return ` \u00b7 ${tr('switched off')}`;
    const only: string[] | null = Array.isArray(r.only) && r.only.length ? r.only : null;
    const ran = (step: string) => !only || only.includes(step);
    const bits: string[] = [];
    if (r.stopped === 'shutdown') bits.push(tr('stopped for a restart'));
    if (r.stopped === 'disk') bits.push(tr('stopped: the download disk is at its floor'));
    // Cancel on the download pill (#82): the counts after it are as far as it got.
    if (r.stopped === 'cancelled') bits.push(tr('cancelled'));
    if (ran('count')) {
      // `uncounted` is the backlog: 30,000 chapter files have never been opened, so the first weeks of
      // nightly runs are a drain and "2000 stamped" alone looks like the job has finished.
      const stamped = r.counted === 1 ? tr('1 page count stamped') : tr('{n} page counts stamped', { n: r.counted });
      bits.push(r.uncounted ? `${stamped}, ${tr('{n} still to count', { n: r.uncounted })}` : stamped);
    }
    if (ran('short')) {
      const s = r.short || {};
      // `confirmed` is not a failure: it is the answer "every source really does serve two pages here",
      // and it is why the finding stops coming back. `left` is the honest remainder -- a copy that threw,
      // a source in a cooldown -- and without it a run that proved nothing reads as a run that fixed it.
      const line = tr('short: {r} replaced, {c} confirmed', { r: s.replaced ?? 0, c: s.confirmed ?? 0 });
      bits.push(s.left ? `${line}, ${tr('{n} left', { n: s.left })}` : line);
    }
    if (ran('gaps')) {
      const g = r.gaps || {};
      const series = g.series ?? 0;
      const fetched = g.fetched ?? 0;
      bits.push([
        series === 1 ? tr('gaps: 1 series') : tr('gaps: {n} series', { n: series }),
        tr('{n} followed', { n: g.followed ?? 0 }),
        fetched === 1 ? tr('1 chapter fetched') : tr('{n} chapters fetched', { n: fetched }),
      ].join(', '));
    }
    // Group upgrades (#81) are off unless switched on, and a line that said "groups: off" every night would be
    // noise about a feature nobody chose; with the switch on, it says what the step did.
    if (ran('groups') && r.groups && !r.groups.off) {
      const g = r.groups;
      const line = tr('groups: {n} replaced', { n: g.replaced ?? 0 });
      bits.push(g.left ? `${line}, ${tr('{n} left', { n: g.left })}` : line);
    }
    // Reading directions (#102) are learned quietly most nights once a library has been through it once, so the
    // clause appears when one was learned -- and always on a run that asked for nothing else, where an empty
    // line would read as a button that did nothing.
    if (ran('directions') && r.directions && (r.directions.learned || (only?.length === 1))) {
      const n = r.directions.learned ?? 0;
      bits.push(n === 1 ? tr('1 reading direction learned') : tr('{n} reading directions learned', { n }));
    }
    if (ran('failures')) {
      const n = r.failures?.reset ?? 0;
      bits.push(n === 1 ? tr('1 failure reset') : tr('{n} failures reset', { n }));
      // ⚠️ The second half of a "Retry now", and the more interesting one. `retried` is written only by an
      // on-demand run against one source (the Health chip), where the whole point is what the re-check
      // then did -- and with only the reset count, a run that re-checked three series and landed two
      // chapters read "4 failures reset", the same line as a nightly that reset four rows and touched
      // nothing. `failed` is said whenever it is not zero for the reason every branch in this file exists:
      // a retry in which every chapter failed again must not render as a retry that worked.
      // Reintroduce by dropping this block: "a Retry now says what the re-check did, not just what it
      // reset" in taskResult.test.ts finds the line ends at "reset".
      const t = r.failures?.retried;
      if (t) {
        const checked = t.series === 1 ? tr('1 series re-checked') : tr('{n} series re-checked', { n: t.series });
        const added = t.added === 1 ? tr('1 chapter added') : tr('{n} chapters added', { n: t.added });
        const re = `${checked}, ${added}`;
        bits.push(t.failed ? `${re}, ${tr('{n} still could not be saved', { n: t.failed })}` : re);
      }
    }
    if (ran('solver')) {
      const s = r.solver || {};
      // ⚠️ Said even when nothing was reset. The solver step only resets when the solver answers AND a
      // source is blaming it, so "nothing" is the normal, healthy outcome -- omitting the clause entirely
      // made a solver-only run render as an empty line, which is a button that did nothing.
      const bit = [s.reset ? tr('solver reset') : tr('solver: nothing to reset')];
      if (s.unblocked) bit.push(tr('{n} unblocked', { n: s.unblocked }));
      if (s.expired) bit.push(s.expired === 1 ? tr('1 old block cleared') : tr('{n} old blocks cleared', { n: s.expired }));
      bits.push(bit.join(', '));
    }
    // How long it took (v0.49.0), last: the Tasks line said what a run did and never how long, so nobody could
    // tell a nightly that takes two minutes from one that takes two hours.
    if (typeof r.ms === 'number' && r.ms > 0) bits.push(tr('took {d}', { d: durationText(r.ms) }));
    return bits.length ? ` \u00b7 ${bits.join(' \u00b7 ')}` : '';
  }
  // "Verify chapter files". A root it skipped as unmounted is the one thing that must not read as a quiet
  // run: every chapter under it is still claiming bytes, and "0 missing" is exactly what the admin would
  // conclude the task had found. `checked` is the key: no other job reports one.
  // ⚠️ The unmounted clause comes FIRST. The task runs detached, so this line is the only place its result
  // is ever shown, and a clause at the end of a long line is the clause that is off the edge of a phone.
  // Reintroduce by pushing it after the counts: "a verify run that skipped an unmounted folder says so"
  // finds the counts before the warning.
  if (typeof r.checked === 'number') {
    const bits: string[] = [];
    if (r.unmounted?.length) {
      const list = r.unmounted.join(', ');
      bits.push(r.unmounted.length === 1 ? tr('one folder looked unmounted and was left alone: {list}', { list })
        : tr('{count} folders looked unmounted and were left alone: {list}', { count: r.unmounted.length, list }));
    }
    bits.push(tr('{n} checked', { n: r.checked }), r.missing ? tr('{n} missing, marked for the next sweep', { n: r.missing }) : tr('none missing'));
    // The read library is not Uchiyomi's to re-fetch (a re-fetch lands under the download folder, on a new
    // row), so those are counted for the admin and left alone -- and said, or the count above would be
    // read as "the read library is fine".
    if (r.readLibraryMissing) bits.push(tr('{n} missing in the read library, not marked', { n: r.readLibraryMissing }));
    if (r.stopped === 'shutdown') bits.push(tr('stopped for a restart'));
    return ` \u00b7 ${bits.join(', ')}`;
  }
  // ⚠️ BEFORE the backup branch. The read-chapter cleanup also reports `bytes`, so keying on that first
  // would render "freed 4 GB" as a backup archive size and lose the chapter count entirely.
  if (typeof r.deleted === 'number') {
    // A run that did not look is not a run that found nothing. The read-only case in particular is a
    // permissions problem on somebody's download volume, and reporting it as "0 chapters" is how it stays
    // unnoticed for a month.
    if (r.skipped === 'read_only') return ` \u00b7 ${tr('the download folder is not writable')}`;
    if (r.skipped === 'shutdown') return ` \u00b7 ${tr('stopped for a restart')}`;
    if (r.skipped) return ` \u00b7 ${tr('switched off')}`;
    const bits = [(r.deleted === 1 ? tr('1 chapter deleted') : tr('{n} chapters deleted', { n: r.deleted })), tr('{size} freed', { size: bytes(r.bytes || 0) })];
    if (r.failed) bits.push(tr('{n} could not be deleted', { n: r.failed }));
    // A run that stopped because EVERY due chapter's folder was missing along with its file is the download
    // volume not being mounted; the chapters it left are the ones still due. Without this line the result
    // reads as a quiet "0 chapters deleted" when the only fix is to mount the share, after which the next
    // run takes them.
    if (r.stopped === 'unmounted') bits.push(tr("stopped: every due chapter's folder is missing, is the download volume mounted?"));
    return ` \u00b7 ${bits.join(', ')}`;
  }
  if (typeof r.added === 'number') {
    // A sweep an admin cancelled from the download pill (#82) is not a quiet night either.
    const base = ` \u00b7 ${tr('+{count} chapters', { count: r.added })}${r.stopped === 'cancelled' ? ` \u00b7 ${tr('cancelled')}` : ''}`;
    if (r.healthy === false) {
      const bits: string[] = [];
      if (r.failed) bits.push(r.failed === 1 ? tr('1 series did not answer') : tr('{n} series did not answer', { n: r.failed }));
      if (r.chapterFailures) bits.push(r.chapterFailures === 1 ? tr('1 chapter could not be saved') : tr('{n} chapters could not be saved', { n: r.chapterFailures }));
      return `${base} \u00b7 ${bits.join(', ') || tr('some sources failed')}`;
    }
    return base;
  }
  if (typeof r.bytes === 'number') {
    // Both of these used to be invisible: the archive could be missing every config file, or its size could
    // have failed to measure, and the panel showed a contented size either way.
    const warn = [r.configEmpty && tr('config not captured'), r.sizeUnknown && tr('size not measured')].filter(Boolean);
    return ` \u00b7 ${r.sizeUnknown ? tr('size unknown') : bytes(r.bytes)}${warn.length ? ` \u00b7 ${warn.join(', ')}` : ''}`;
  }
  if (typeof r.refreshed === 'boolean') {
    // A check that could not read the repositories is NOT a quiet check. Saying "0 updated" for it is the
    // shape of the original bug, one layer up.
    if (!r.refreshed) return ` \u00b7 ${tr('could not read the repositories')}${r.refreshError ? `: ${r.refreshError}` : ''}`;
    const bits: string[] = [tr('{n} updated', { n: r.updated?.length ?? 0 })];
    if (r.failed?.length) bits.push(tr('{n} failed', { n: r.failed.length }));
    if (!r.autoUpdate && r.updatesAvailable?.length) bits.push(tr('{n} waiting (auto-update off)', { n: r.updatesAvailable.length }));
    if (r.obsolete?.length) bits.push(tr('{n} obsolete', { n: r.obsolete.length }));
    if (r.reinstalled?.length) bits.push(tr('{n} reinstalled', { n: r.reinstalled.length }));
    if (r.deferred) bits.push(tr('waiting for the library sweep'));
    return ` \u00b7 ${bits.join(', ')}`;
  }
  return '';
}
