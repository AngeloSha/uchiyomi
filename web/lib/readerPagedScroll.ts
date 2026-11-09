import type { ReaderAction } from './readerKeys';

/** Read the rest of a width-fitted page before the next/previous reading-order action turns its slide. */
export function pagedScrollStep(action: ReaderAction, pane: { scrollTop: number; scrollHeight: number; clientHeight: number }): number {
  if (action !== 'next' && action !== 'prev') return 0;
  const max = Math.max(0, pane.scrollHeight - pane.clientHeight);
  const top = Math.max(0, Math.min(max, pane.scrollTop));
  const direction = action === 'next' ? 1 : -1;
  const room = direction > 0 ? max - top : top;
  return room > 1 ? direction * Math.min(room, pane.clientHeight * 0.88) : 0;
}

/**
 * Where a width-fitted page opens: at its top, or at its foot when reading went back to it (#401, @Forgitusername), so
 * the page read last is where it was left rather than at its top again.
 */
export function pagedOpenOffset(pane: { scrollHeight: number; clientHeight: number }, atFoot: boolean): number {
  return atFoot ? Math.max(0, pane.scrollHeight - pane.clientHeight) : 0;
}

/** Keep the same image point under the viewport's centre when its actual scrollable dimensions are zoomed. */
export function zoomedScrollOffset(offset: number, viewport: number, before: number, after: number): number {
  return Math.max(0, (offset + viewport / 2) * after / before - viewport / 2);
}
