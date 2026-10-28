/**
 * What the import review's Change sheet shows about a pick besides its title and chapter count (#353): its status
 * and first genres on one line, and its description. Two titles a few letters apart -- or one series under the
 * name of another -- read the same as a cover and a title, and that is exactly when the wrong match gets imported.
 *
 * From the GET /api/sources/detail the sheet already asks for the chapter count, so it costs no request. The
 * description is cleaned on the server (bff routes/sources.ts cleanDescription). React-free, so a test can hold it.
 */
import { statusText } from './activity';

/** How many genres the line names: the add dialog's four (components/AddSeriesDialog.tsx), one line on a phone. */
const GENRES_SHOWN = 4;

/** The detail fields read here; every one optional, so an older server's answer still reads. */
export interface PreviewDetail {
  status?: string | null;
  genres?: readonly string[] | null;
  summary?: string | null;
}

/** `facts`: "Ongoing · Romance · Comedy", or '' when the source said neither. `summary`: '' when it said nothing. */
export function matchPreview(d: PreviewDetail | undefined): { facts: string; summary: string } {
  const status = d?.status?.trim() ? statusText(d.status) : '';
  const genres = [...new Set((d?.genres ?? []).map((g) => g.trim()).filter(Boolean))].slice(0, GENRES_SHOWN);
  return { facts: [status, ...genres].filter(Boolean).join(' · '), summary: d?.summary?.trim() ?? '' };
}
