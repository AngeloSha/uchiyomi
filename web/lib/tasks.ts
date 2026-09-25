import { bytes } from './format';

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
    if (r.skipped === 'disabled') return ' \u00b7 switched off';
    const only: string[] | null = Array.isArray(r.only) && r.only.length ? r.only : null;
    const ran = (step: string) => !only || only.includes(step);
    const bits: string[] = [];
    if (r.stopped === 'shutdown') bits.push('stopped for a restart');
    if (r.stopped === 'disk') bits.push('stopped: the download disk is at its floor');
    // Cancel on the download pill (#82): the counts after it are as far as it got.
    if (r.stopped === 'cancelled') bits.push('cancelled');
    if (ran('count')) {
      // `uncounted` is the backlog: 30,000 chapter files have never been opened, so the first weeks of
      // nightly runs are a drain and "2000 stamped" alone looks like the job has finished.
      bits.push(`${r.counted} page count${r.counted === 1 ? '' : 's'} stamped${r.uncounted ? `, ${r.uncounted} still to count` : ''}`);
    }
    if (ran('short')) {
      const s = r.short || {};
      // `confirmed` is not a failure: it is the answer "every source really does serve two pages here",
      // and it is why the finding stops coming back. `left` is the honest remainder -- a copy that threw,
      // a source in a cooldown -- and without it a run that proved nothing reads as a run that fixed it.
      bits.push(`short: ${s.replaced ?? 0} replaced, ${s.confirmed ?? 0} confirmed${s.left ? `, ${s.left} left` : ''}`);
    }
    if (ran('gaps')) {
      const g = r.gaps || {};
      bits.push(`gaps: ${g.series ?? 0} series, ${g.followed ?? 0} followed, ${g.fetched ?? 0} chapter${g.fetched === 1 ? '' : 's'} fetched`);
    }
    // Group upgrades (#81) are off unless switched on, and a line that said "groups: off" every night would be
    // noise about a feature nobody chose; with the switch on, it says what the step did.
    if (ran('groups') && r.groups && !r.groups.off) {
      const g = r.groups;
      bits.push(`groups: ${g.replaced ?? 0} replaced${g.left ? `, ${g.left} left` : ''}`);
    }
    if (ran('failures')) {
      const n = r.failures?.reset ?? 0;
      bits.push(`${n} failure${n === 1 ? '' : 's'} reset`);
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
        const re = `${t.series} series re-checked, ${t.added} chapter${t.added === 1 ? '' : 's'} added`;
        bits.push(t.failed ? `${re}, ${t.failed} still could not be saved` : re);
      }
    }
    if (ran('solver')) {
      const s = r.solver || {};
      // ⚠️ Said even when nothing was reset. The solver step only resets when the solver answers AND a
      // source is blaming it, so "nothing" is the normal, healthy outcome -- omitting the clause entirely
      // made a solver-only run render as an empty line, which is a button that did nothing.
      const bit = [s.reset ? 'solver reset' : 'solver: nothing to reset'];
      if (s.unblocked) bit.push(`${s.unblocked} unblocked`);
      if (s.expired) bit.push(`${s.expired} old block${s.expired === 1 ? '' : 's'} cleared`);
      bits.push(bit.join(', '));
    }
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
    if (r.unmounted?.length) bits.push(`${r.unmounted.length === 1 ? 'one folder' : `${r.unmounted.length} folders`} looked unmounted and ${r.unmounted.length === 1 ? 'was' : 'were'} left alone: ${r.unmounted.join(', ')}`);
    bits.push(`${r.checked} checked`, r.missing ? `${r.missing} missing, marked for the next sweep` : 'none missing');
    // The read library is not Uchiyomi's to re-fetch (a re-fetch lands under the download folder, on a new
    // row), so those are counted for the admin and left alone -- and said, or the count above would be
    // read as "the read library is fine".
    if (r.readLibraryMissing) bits.push(`${r.readLibraryMissing} missing in the read library, not marked`);
    if (r.stopped === 'shutdown') bits.push('stopped for a restart');
    return ` \u00b7 ${bits.join(', ')}`;
  }
  // ⚠️ BEFORE the backup branch. The read-chapter cleanup also reports `bytes`, so keying on that first
  // would render "freed 4 GB" as a backup archive size and lose the chapter count entirely.
  if (typeof r.deleted === 'number') {
    // A run that did not look is not a run that found nothing. The read-only case in particular is a
    // permissions problem on somebody's download volume, and reporting it as "0 chapters" is how it stays
    // unnoticed for a month.
    if (r.skipped === 'read_only') return ' \u00b7 the download folder is not writable';
    if (r.skipped === 'shutdown') return ' \u00b7 stopped for a restart';
    if (r.skipped) return ' \u00b7 switched off';
    const bits = [`${r.deleted} chapters deleted`, bytes(r.bytes || 0) + ' freed'];
    if (r.failed) bits.push(`${r.failed} could not be deleted`);
    // A run that stopped because EVERY due chapter's folder was missing along with its file is the download
    // volume not being mounted; the chapters it left are the ones still due. Without this line the result
    // reads as a quiet "0 chapters deleted" when the only fix is to mount the share, after which the next
    // run takes them.
    if (r.stopped === 'unmounted') bits.push('stopped: every due chapter\'s folder is missing, is the download volume mounted?');
    return ` \u00b7 ${bits.join(', ')}`;
  }
  if (typeof r.added === 'number') {
    // A sweep an admin cancelled from the download pill (#82) is not a quiet night either.
    const base = ` \u00b7 +${r.added} chapters${r.stopped === 'cancelled' ? ' \u00b7 cancelled' : ''}`;
    if (r.healthy === false) {
      const bits: string[] = [];
      if (r.failed) bits.push(`${r.failed} series did not answer`);
      if (r.chapterFailures) bits.push(`${r.chapterFailures} chapters could not be saved`);
      return `${base} \u00b7 ${bits.join(', ') || 'some sources failed'}`;
    }
    return base;
  }
  if (typeof r.bytes === 'number') {
    // Both of these used to be invisible: the archive could be missing every config file, or its size could
    // have failed to measure, and the panel showed a contented size either way.
    const warn = [r.configEmpty && 'config not captured', r.sizeUnknown && 'size not measured'].filter(Boolean);
    return ` \u00b7 ${r.sizeUnknown ? 'size unknown' : bytes(r.bytes)}${warn.length ? ` \u00b7 ${warn.join(', ')}` : ''}`;
  }
  if (typeof r.refreshed === 'boolean') {
    // A check that could not read the repositories is NOT a quiet check. Saying "0 updated" for it is the
    // shape of the original bug, one layer up.
    if (!r.refreshed) return ` \u00b7 could not read the repositories${r.refreshError ? `: ${r.refreshError}` : ''}`;
    const bits: string[] = [`${r.updated?.length ?? 0} updated`];
    if (r.failed?.length) bits.push(`${r.failed.length} failed`);
    if (!r.autoUpdate && r.updatesAvailable?.length) bits.push(`${r.updatesAvailable.length} waiting (auto-update off)`);
    if (r.obsolete?.length) bits.push(`${r.obsolete.length} obsolete`);
    if (r.reinstalled?.length) bits.push(`${r.reinstalled.length} reinstalled`);
    if (r.deferred) bits.push('waiting for the library sweep');
    return ` \u00b7 ${bits.join(', ')}`;
  }
  return '';
}
