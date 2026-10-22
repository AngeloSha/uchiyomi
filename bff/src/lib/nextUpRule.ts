// "Is this the chapter the reader would read next?" -- the series page's own rule (web/lib/continueLabel.ts
// continueChoice), on plain rows so the web's test can hold the two to each other. No imports: the web test loads this file.

/** A chapter as the rule reads it. `pruned`: the server no longer holds its file, so it cannot be opened, but if it was read it still says how far the reader is. */
export interface NextUpRow { number: number; done: boolean; page: number; pruned?: boolean }

/**
 * The chapter number the series page's reading button would open for this reader, or null when it opens none that is
 * new to them (nothing to read, or everything read). Mirrors continueChoice:
 *  - a chapter that is part-read (page 1 or later, not finished) is the one to continue;
 *  - else, with nothing finished, the first chapter that can be opened;
 *  - else the first chapter that is neither finished nor pruned AFTER the highest finished one (pruned ones count for
 *    where "highest" is), or the lowest such chapter when none comes after it.
 */
export function nextUpNumber(rows: ReadonlyArray<NextUpRow>): { kind: 'continue' | 'next' | 'start'; number: number } | null {
  const open = rows.filter((r) => !r.pruned).sort((a, b) => a.number - b.number);
  if (!open.length) return null;
  const reading = open.filter((r) => !r.done && r.page >= 1);
  if (reading.length) return { kind: 'continue', number: reading[0].number };
  let highest = -Infinity;
  for (const r of rows) if (r.done && r.number > highest) highest = r.number;
  if (highest === -Infinity) return { kind: 'start', number: open[0].number };
  const unread = open.filter((r) => !r.done);
  const next = unread.find((r) => r.number > highest) ?? unread[0];
  return next ? { kind: 'next', number: next.number } : null;
}

/** Whether a chapter that just landed is the one the reader would read next, i.e. one of `numbers` is it. Only a `next` or `start` counts: a half-read chapter is the one to continue, so nothing new is next. */
export function nextUpIn(rows: ReadonlyArray<NextUpRow>, numbers: readonly number[]): boolean {
  const n = nextUpNumber(rows);
  if (!n || n.kind === 'continue') return false;
  return numbers.some((x) => Math.abs(x - n.number) < 0.001);
}
