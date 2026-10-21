/**
 * The Library's select mode, the React-free half (v0.96.0, #333, @TIGamingTV): Shift with a click picks every series
 * between the last one picked and this one, as a file manager or a mail app does, so a run of twenty is two clicks.
 *
 * The range takes the state the click gives the series clicked: Shift-clicking an unpicked one picks the whole run, and
 * Shift-clicking a picked one unpicks it. The anchor is the series last clicked; with no anchor, or one no longer on the
 * shelf (the filters changed and the shelf with them), the click is an ordinary one.
 */
export function pickWith(
  picked: ReadonlySet<string>, ids: readonly string[], id: string, anchor: string | null, shift: boolean,
): Set<string> {
  const next = new Set(picked);
  const on = !picked.has(id);
  const from = shift && anchor ? ids.indexOf(anchor) : -1;
  const to = ids.indexOf(id);
  if (from < 0 || to < 0) {
    if (on) next.add(id); else next.delete(id);
    return next;
  }
  for (let i = Math.min(from, to); i <= Math.max(from, to); i++) {
    if (on) next.add(ids[i]); else next.delete(ids[i]);
  }
  return next;
}
