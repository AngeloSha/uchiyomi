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
 * is the chapter sweep, `bytes` the backup, `refreshed` the extension check.
 */
export function taskResult(r: any): string {
  if (!r) return '';
  if (typeof r.added === 'number') {
    const base = ` \u00b7 +${r.added} chapters`;
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
