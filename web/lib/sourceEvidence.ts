/**
 * What a source was seen doing, as the admin screens say it (#115, v0.49.0): the part of
 * components/SourceEvidence.tsx with no React in it, so a test can hold the words and the rules.
 *
 * "Manga Ball (EN)" failed its Test while its Providers card said "ok" and Health said "All good", and the one
 * line the Test did show read "Working normally." under a ✗. The server now keeps evidence per STAGE (search,
 * chapter list, page list, images: bff/src/lib/sourceEvidence.ts) and this turns either kind of answer into the
 * same lines:
 * - a live Test answer (POST /api/admin/sources/:id/test): its checks, its diagnosis, whether it ran out of time;
 * - persisted evidence (Health's source rows, GET /api/admin/sources): one StageLine per stage, and the last
 *   live verdict (`live` / `tested`).
 * Both render through ONE component, so Providers and Health can never describe the same source two ways.
 */
import { t as tr, keys } from './i18n';
import { formatClock, relativeTime } from './format';
import type { Tone } from './status';

export type Stage = 'search' | 'chapters' | 'pages' | 'images';
export const STAGES: readonly Stage[] = ['search', 'chapters', 'pages', 'images'];
/** Who saw it: an admin's Test, the daily check (or "Check all now"), or ordinary use. */
export type EvidenceBy = 'test' | 'sweep' | 'traffic';

/** One stage as the server reports it (bff lib/sourceEvidence.ts StageLine). */
export interface StageLine {
  stage: Stage;
  state: 'ok' | 'fail' | 'unknown';
  at: string | null;
  by: EvidenceBy | null;
  kind: 'error' | 'empty' | 'unnumbered' | null;
  error: string | null;
}

/** The last deliberate live check (`live` on GET /api/admin/sources, `tested` on a Health item). */
export interface LiveVerdict {
  at: string;
  by: 'test' | 'sweep' | null;
  state: 'pass' | 'fail' | 'inconclusive' | null;
  stage: Stage | null;
}

/** One check of a live Test (bff lib/sourceProbe.ts Check). */
export interface TestCheck {
  name: string;
  ok: boolean;
  detail: string;
  stage?: Stage;
  kind?: 'error' | 'empty' | 'timeout' | 'unnumbered';
  error?: string;
}

/** POST /api/admin/sources/:id/test, as far as these screens read it. */
export interface TestAnswer {
  ok: boolean;
  timedOut?: boolean;
  checks: TestCheck[];
  diagnosis?: { code: string; reason?: string; fix?: string };
  state?: 'pass' | 'fail' | 'inconclusive';
  stage?: Stage | null;
  ms?: number;
}

// Declared through `keys()` because they reach tr() through the maps below (lib/i18n.ts).
export const STAGE_LABELS = keys('Search', 'Chapter list', 'Page list', 'Images');
const STAGE_LABEL: Record<Stage, (typeof STAGE_LABELS)[number]> = {
  search: STAGE_LABELS[0], chapters: STAGE_LABELS[1], pages: STAGE_LABELS[2], images: STAGE_LABELS[3],
};
export const stageLabel = (s: Stage): string => tr(STAGE_LABEL[s] ?? STAGE_LABELS[0]);

/**
 * Who saw it. ⚠️ Not "by you": the server records that a Test ran, not which admin pressed it, and in a household
 * with two admins "by you" would put one person's click in the other's mouth.
 */
export const BY_LABELS = keys('with the Test button', 'by the daily check', 'in normal use');
const BY_LABEL: Record<EvidenceBy, (typeof BY_LABELS)[number]> = { test: BY_LABELS[0], sweep: BY_LABELS[1], traffic: BY_LABELS[2] };

/** A line's glyph: passed, failed, ran out of OUR time (not the source's fault), or nothing to say. */
export type Glyph = 'ok' | 'fail' | 'timeout' | 'none';
export const GLYPH_TONE: Record<Glyph, Tone> = { ok: 'ok', fail: 'problem', timeout: 'warn', none: 'off' };
/** What a screen reader hears for the glyph, which is aria-hidden. */
export const GLYPH_WORDS = keys('passed', 'failed', 'ran out of time', 'not checked');
const GLYPH_WORD: Record<Glyph, (typeof GLYPH_WORDS)[number]> = { ok: GLYPH_WORDS[0], fail: GLYPH_WORDS[1], timeout: GLYPH_WORDS[2], none: GLYPH_WORDS[3] };
export const glyphWord = (g: Glyph): string => tr(GLYPH_WORD[g]);

export interface EvidenceRow {
  key: string;
  glyph: Glyph;
  label: string;
  /** Short and already said: "12 result(s)", "not reached". */
  detail: string | null;
  /** The source's or the engine's own words, in full (the row clamps them to two lines). */
  error: string | null;
  /** "5m ago · by the daily check". */
  when: string | null;
}

export interface EvidenceView {
  head: { tone: Tone; text: string } | null;
  rows: EvidenceRow[];
  fix: string | null;
}

/** The check names the smoke test uses, as words a translator has seen; anything newer is shown as sent. */
const CHECK_NAMES = keys('Series page', 'Chapters', 'Pages', 'Covers');
const checkName = (n: string): string => ((CHECK_NAMES as readonly string[]).includes(n) || n === 'Search' ? tr(n) : n);

/**
 * A live Test answer as lines, one per stage the Test covers, plus Covers when it was looked at.
 *
 * ⚠️ "Working normally." is said ONLY when the Test passed and no line on screen is a ✗. It used to be the
 * fallback for any diagnosis without a reason, which is how it sat under a failed Search (#115).
 */
export function answerView(t: TestAnswer): EvidenceView {
  const rows: EvidenceRow[] = [];
  for (const stage of ['search', 'chapters', 'pages'] as const) {
    const cs = (t.checks || []).filter((c) => c.stage === stage);
    if (!cs.length) {
      // Nothing ran at this stage: the Test stopped earlier (or ran out of time before it).
      rows.push({ key: stage, glyph: 'none', label: stageLabel(stage), detail: tr('not reached'), error: null, when: null });
      continue;
    }
    const late = cs.find((c) => c.kind === 'timeout');
    const bad = cs.find((c) => !c.ok && c.kind !== 'timeout');
    if (bad) {
      rows.push({
        key: stage, glyph: 'fail', label: stageLabel(stage),
        // The failing check's own name when the stage has two (Series page / Chapters), then its words.
        detail: cs.length > 1 ? checkName(bad.name) : null,
        error: bad.error || bad.detail || null, when: null,
      });
    } else if (late) {
      rows.push({ key: stage, glyph: 'timeout', label: stageLabel(stage), detail: tr('did not finish in time'), error: null, when: null });
    } else {
      rows.push({ key: stage, glyph: 'ok', label: stageLabel(stage), detail: cs.map((c) => c.detail).filter(Boolean).join(' · ') || null, error: null, when: null });
    }
  }
  for (const c of t.checks || []) {
    if (c.stage) continue;
    rows.push({ key: `check:${c.name}`, glyph: c.ok ? 'ok' : 'fail', label: checkName(c.name), detail: c.ok ? c.detail || null : null, error: c.ok ? null : c.detail || null, when: null });
  }
  // The smoke test never fetches an image byte, so it cannot speak for downloads: say so, rather than leave an
  // admin wondering why a passing Test did not clear a download failure.
  rows.push({ key: 'images', glyph: 'none', label: stageLabel('images'), detail: tr('a Test does not download images'), error: null, when: null });

  const failedLine = rows.some((r) => r.glyph === 'fail');
  const d = t.diagnosis;
  let head: EvidenceView['head'];
  if (t.ok && !failedLine) head = { tone: 'ok', text: tr('Working normally.') };
  else if (t.ok) head = { tone: 'warn', text: tr('Works, but not everything checked out') };
  else if (t.state === 'inconclusive' || (t.timedOut && !failedLine)) {
    head = { tone: 'warn', text: d?.reason || tr('The test ran out of time. That alone is not proof it is broken.') };
  } else head = { tone: 'problem', text: d?.reason || tr('That source is still failing') };
  return { head, rows, fix: t.ok ? null : d?.fix || null };
}

/** "5m ago · by the daily check". */
function whenBy(at: string | null, by: EvidenceBy | null): string | null {
  if (!at) return null;
  const ago = relativeTime(at);
  return by && BY_LABEL[by] ? `${ago} · ${tr(BY_LABEL[by])}` : ago;
}

/** The last live verdict as one sentence: "Last tested 2h ago by the daily check". */
export function testedLine(v: LiveVerdict | null | undefined): { tone: Tone; text: string } | null {
  if (!v?.at) return null;
  const when = relativeTime(v.at);
  const text = v.by === 'test' ? tr('Last tested {when} with the Test button', { when })
    : v.by === 'sweep' ? tr('Last tested {when} by the daily check', { when })
    : tr('Last tested {when}', { when });
  const tone: Tone = v.state === 'pass' ? 'ok' : v.state === 'fail' ? 'problem' : v.state === 'inconclusive' ? 'warn' : 'info';
  return { tone, text };
}

/** Persisted evidence as lines: every stage, what was last seen there, when, and by what. */
export function evidenceView(lines: StageLine[] | null | undefined, tested?: LiveVerdict | null, fix?: string | null): EvidenceView {
  const rows: EvidenceRow[] = [];
  for (const l of lines || []) {
    if (!STAGES.includes(l.stage)) continue;
    if (l.state === 'fail') {
      rows.push({
        key: l.stage, glyph: 'fail', label: stageLabel(l.stage),
        detail: l.kind === 'empty' ? tr('answered with nothing') : l.kind === 'unnumbered' ? tr('chapters without numbers') : null,
        error: l.error, when: whenBy(l.at, l.by),
      });
    } else if (l.state === 'ok') {
      rows.push({ key: l.stage, glyph: 'ok', label: stageLabel(l.stage), detail: null, error: null, when: whenBy(l.at, l.by) });
    } else {
      rows.push({ key: l.stage, glyph: 'none', label: stageLabel(l.stage), detail: tr('nothing recorded yet'), error: null, when: null });
    }
  }
  return { head: testedLine(tested), rows, fix: fix || null };
}

/** The Test button while it runs: "Testing… 0:12 of up to 0:53". The server's own wall is `testMs`. */
export function testClock(elapsedMs: number, testMs?: number | null): string {
  const elapsed = formatClock(elapsedMs);
  return testMs && testMs > 0
    ? tr('Testing… {elapsed} of up to {max}', { elapsed, max: formatClock(testMs) })
    : tr('Testing… {elapsed}', { elapsed });
}

/** GET /api/admin/sources/check while it runs, as the Check all button's words: "Checking 7 of 40 · Manga Ball (EN)". */
export function checkAllLabel(p: { total: number; done: number; current: { name: string } | null } | null | undefined): string {
  if (!p || !p.total) return tr('Checking…');
  const head = tr('Checking {done} of {total}', { done: Math.min(p.done + (p.current ? 1 : 0), p.total), total: p.total });
  return p.current?.name ? `${head} · ${p.current.name}` : head;
}

/** The sweep's result as its toast: who needs attention, and who could not be tested to the end. */
export function sweepToast(r: { needsAttention?: unknown[]; inconclusive?: unknown[] } | null | undefined): { text: string; type: 'success' | 'error' | 'info' } {
  const n = r?.needsAttention?.length ?? 0;
  const late = r?.inconclusive?.length ?? 0;
  const parts: string[] = [];
  if (n) parts.push(n === 1 ? tr('1 source needs attention') : tr('{n} sources need attention', { n }));
  if (late) parts.push(late === 1 ? tr('1 could not finish in time') : tr('{n} could not finish in time', { n: late }));
  if (!parts.length) return { text: tr('All sources healthy'), type: 'success' };
  return { text: parts.join(' · '), type: n ? 'error' : 'info' };
}
