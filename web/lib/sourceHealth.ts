/**
 * Health → Source health, decluttered (v0.53.0): the part of components/SourceHealthBody.tsx with no React in it --
 * which group a row is in, its one key, its one line of words, and Turn off all -- so a test can hold the rules.
 *
 * The owner: "it feels like there is a million extention that i need to fix but it loks complicated". The card was
 * forty-six rows: thirty-one sources he had switched off on purpose first, each with a Test key, then the failing ones
 * nothing uses, and at its very end the handful his library depends on. The server now sends each row's group and
 * state in the card's order (bff lib/health.ts sourceTrouble), and the card shows the series' sources first, the
 * failing ones nothing uses under them, and folds the rest away.
 */
import { t as tr } from './i18n';
import { untilText } from './format';
import { stageLabel } from './sourceEvidence';
import { SOURCE_STATUSES, sourceMark, type ProviderStatus, type Tone } from './status';
import type { HealthAction, HealthItem, SourceGroup } from './types';

import { initialsOf } from './groupAvatar';

/**
 * A row's group: the server's, or -- from a server older than v0.53.0, which sent none -- the same rule from what it
 * did send: a finding is the series' or nobody's, and a row listed for reference is switched off (its detail opens
 * on "turned off by you") or quiet.
 */
export function groupOf(it: HealthItem): SourceGroup {
  if (it.group) return it.group;
  if (it.info) return it.detailSaid?.[0]?.code === 'sources.turnedOff' ? 'off' : 'quiet';
  return (it.series ?? 0) > 0 ? 'affected' : 'unused';
}

/** The groups a row of which is a finding: shown open, each row with its one key. */
export const FINDING_GROUPS: readonly SourceGroup[] = ['affected', 'unused'];

/**
 * The ONE key a row shows (the rest are in its ⋯ menu): Replace for a source that is some series' main source and
 * cannot serve them (v0.54.0) -- in any group, the switched-off fold included, where aqua sat switched off and still
 * the main source of 195 series -- then Clear block for a source in a cooldown that has one to clear, Test for
 * everything else -- the one action that answers "is this still true?". Otherwise none on a folded row: a source
 * switched off, or one listed for reference, has nothing else to press for in the list.
 */
export function primaryOf(it: HealthItem): HealthAction | null {
  const actions = it.actions ?? [];
  if (actions.includes('replace_source')) return 'replace_source';
  if (!FINDING_GROUPS.includes(groupOf(it))) return null;
  if (it.state === 'blocked' && actions.includes('unblock')) return 'unblock';
  return actions.includes('test') ? 'test' : null;
}

/** A status the source card knows, else 'down': a newer server's status reads as not answering, never as Healthy. */
const statusOf = (s: string | null | undefined): ProviderStatus =>
  (SOURCE_STATUSES as readonly string[]).includes(s ?? '') && s !== 'ok' ? (s as ProviderStatus) : 'down';

/**
 * The state as one or two words, the source card's where it has them (lib/status.ts SOURCE_LABELS: "Rate-limited",
 * "Blocked by the site", "Failing", "Answers empty", "Turned off"), so Providers and Health name one source alike.
 * Null for a row without a state (a server older than v0.53.0): the caller shows its detail instead.
 */
export function stateWord(it: HealthItem): string | null {
  switch (it.state) {
    case 'blocked': return sourceMark(statusOf(it.cooldown?.status)).label;
    case 'failing': return sourceMark('failing').label;
    case 'slow': return tr('Slow lately');
    case 'empty': return sourceMark('quiet').label;
    case 'inconclusive': return tr('Test didn’t finish');
    case 'untested': return tr('Not checked since it failed');
    case 'off': return it.offBy === 'language' ? tr('Hidden language') : sourceMark('disabled').label;
    default: return null;
  }
}

/**
 * What follows the state word: when a cooldown ends ("trying again in 20 minutes"), the step a failure or an unfinished
 * test is at (the stage's own name, as the stage lines say it), or what slow and empty answers usually mean. Each is
 * a phrase of its own, never a fragment the word has to agree with.
 */
export function stateReason(it: HealthItem, now = Date.now()): string {
  switch (it.state) {
    case 'blocked': {
      const until = it.cooldown?.until ? Date.parse(it.cooldown.until) : NaN;
      return Number.isFinite(until) && until > now ? tr('trying again {when}', { when: untilText(until - now) }) : tr('trying again on next use');
    }
    case 'failing':
    case 'inconclusive':
    case 'untested':
      return it.stage ? stageLabel(it.stage) : '';
    case 'slow': return tr('answers take longer than the limit');
    case 'empty': return tr('the site may have changed');
    default: return '';
  }
}

/**
 * The letters on a source's tile: the first of its first two words that start with a letter, its language suffix left
 * out -- "Hentai Shelf (AR)" is HS and "Lantern 10 (FR)" is L, never "L1". A name that starts with its number is that
 * number and the letter after it -- "3Hentai (EN)" is 3H and "1Manga.co" 1M, where the avatar's rule drew "3(" from the
 * suffix (v0.54.0, the Sources list) -- and one with no letter at all is the group avatar's initials.
 */
export function tileLetters(name: string): string {
  const bare = name.replace(/\s*\([^)]*\)\s*$/, '').trim();
  const lead = /^(\p{N})\p{N}*(\p{L})/u.exec(bare);
  if (lead) return `${lead[1]}${lead[2].toLocaleUpperCase()}`;
  const words = bare.split(/[\s\-_.·&/,]+/).filter((w) => /^\p{L}/u.test(w));
  return words.length ? words.slice(0, 2).map((w) => w.charAt(0).toLocaleUpperCase()).join('') : initialsOf(bare || name);
}

/** "3 series", or nothing for a source no series uses. */
export function seriesText(n: number | undefined): string {
  return !n ? '' : n === 1 ? tr('1 series') : tr('{n} series', { n });
}

/**
 * The tile's tint: by state among the findings (red for a site refusing or not answering, amber for the rest, as the
 * source card colours them), grey in the folds.
 */
export function tileTone(it: HealthItem): Tone {
  const g = groupOf(it);
  if (g === 'off') return 'off';
  if (g === 'quiet') return 'info';
  return it.state === 'blocked' ? sourceMark(statusOf(it.cooldown?.status)).tone : 'warn';
}

/** The rows Turn off all switches off: the failing ones nothing uses that can still be turned off. */
export function bulkTargets(items: readonly HealthItem[]): HealthItem[] {
  return items.filter((it) => groupOf(it) === 'unused' && !!it.sourceId && (it.actions ?? []).includes('disable'));
}

/** The group key's words: "Turn off all 5", or for one source the row's own verb. */
export const turnOffAllLabel = (n: number): string => (n === 1 ? tr('Turn off') : tr('Turn off all {n}', { n }));

/** What Turn off all asks before it does anything (Health's card, and Admin → Sources' Needs attention since v0.54.0). */
export const turnOffQuestion = (n: number): string => (n === 1
  ? tr('Turn off this source? No series uses it. You can turn it back on any time.')
  : tr('Turn off these {n} sources? No series uses them. You can turn them back on any time.', { n }));

/**
 * Turn off all: the row's own Turn off (`post`, the request HealthActions.tsx's `disableSource` makes), for each source
 * IN TURN. Never all at once: each is a request and an audit line of its own, and one that fails says nothing about
 * the next, so it is counted and the rest go on. `onStep(i, total)` hears that the i-th (0-based) is next, and
 * `(total, total)` at the end.
 */
export async function turnOffEach(
  ids: readonly string[], post: (id: string) => Promise<unknown>, onStep?: (done: number, total: number) => void,
): Promise<{ off: string[]; failed: string[] }> {
  const off: string[] = [];
  const failed: string[] = [];
  for (const [i, id] of ids.entries()) {
    onStep?.(i, ids.length);
    try { await post(id); off.push(id); } catch { failed.push(id); }
  }
  onStep?.(ids.length, ids.length);
  return { off, failed };
}

/** What Turn off all did, as its one notice: how many went off, and how many could not be. */
export function turnOffOutcome(off: number, failed: number): string {
  return [
    off ? (off === 1 ? tr('1 source turned off') : tr('{n} sources turned off', { n: off })) : '',
    failed ? (failed === 1 ? tr('1 source could not be turned off') : tr('{n} sources could not be turned off', { n: failed })) : '',
  ].filter(Boolean).join(' · ');
}
