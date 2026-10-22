/**
 * The warnings around chapters no other source has (bff lib/sourceLeftovers.ts).
 *
 * Removing a source deletes the downloaded chapters only it lists, with everyone's progress on them, so the Sources
 * sheet asks first with the count. Deleting a chapter no followed source lists cannot be undone by Fetch again, so the
 * Delete from server confirmation says so.
 */
import { t as tr } from './i18n';

/** What GET /api/admin/series/:id/sources/:sourceId/leftovers answers. */
export interface SourceLeftovers {
  chapters: number;
  numbers: number[];
  readers: number;
  lastSource: boolean;
}

/** The line in the remove-source question: what goes with it. Null when nothing does. */
export function leftoversText(chapters: number): string | null {
  if (chapters <= 0) return null;
  return chapters === 1
    ? tr("1 downloaded chapter no other source lists will be deleted from the server, together with everyone's reading progress.")
    : tr("{n} downloaded chapters no other source lists will be deleted from the server, together with everyone's reading progress.", { n: chapters });
}

/** The Delete from server warning, for `unlisted` of the `total` chosen chapters. Null when every one is listed. */
export function unlistedWarning(total: number, unlisted: number): string | null {
  if (unlisted <= 0) return null;
  if (total === 1) return tr('No source this series follows lists this chapter. Once it is deleted, it cannot be fetched again.');
  if (unlisted >= total) return tr('No source this series follows lists these chapters. Once they are deleted, they cannot be fetched again.');
  if (unlisted === 1) return tr('No source this series follows lists one of these chapters. Once it is deleted, it cannot be fetched again.');
  return tr('No source this series follows lists {n} of these chapters. Once they are deleted, they cannot be fetched again.', { n: unlisted });
}
