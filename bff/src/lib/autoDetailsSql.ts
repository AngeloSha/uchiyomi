// The details a series shows, layer by layer (v0.73.0): what an admin wrote in Edit details (series_overrides), else what
// the series' own files or source said (lib_series, the scan), else what the server filled in because both were empty
// (series_auto_details, lib/autoDetails.ts). Every read of a description, genres or an author goes through here, so the
// series page, the Library, search, OPDS, the Komga-compatible API and the 18+ filter all agree on what a series is.
//
// Two rules hold every expression below:
//   - the filled-in value is BELOW the scan. It is read only where the series' own value is empty, so a scan that brings
//     a real description later wins at once, without anybody removing anything;
//   - an admin's edit is ABOVE both, and its own two states stay apart: NULL is "inherit", and genres `{}` is "cleared on
//     purpose" (routes/admin.ts normGenres), which the filled-in genres never refill.
// Plain strings with no imports: ownedCatalog, visibility, OPDS and the hero query all read these, and none of them may
// pull the filling machinery (sources, AniList) in behind it.

/** The table, for a join: `LEFT JOIN ${AUTO_DETAILS} m ON m.series_id = s.id`. */
export const AUTO_DETAILS = 'series_auto_details';

/** SQL: the description series `s` shows, `o` its series_overrides row and `m` its series_auto_details row (both joined). */
export const summaryOf = (o: string, s: string, m: string): string =>
  `COALESCE(${o}.summary, CASE WHEN btrim(COALESCE(${s}.summary, '')) = '' AND ${m}.summary IS NOT NULL THEN ${m}.summary ELSE ${s}.summary END)`;

/** SQL: the author series `s` shows; as summaryOf. */
export const authorOf = (o: string, s: string, m: string): string =>
  `COALESCE(${o}.author, CASE WHEN btrim(COALESCE(${s}.author, '')) = '' AND ${m}.author IS NOT NULL THEN ${m}.author ELSE ${s}.author END)`;

/** SQL: the genres series `s` shows; as summaryOf. An admin's `{}` is a value, so COALESCE keeps it. */
export const genresOf = (o: string, s: string, m: string): string =>
  `COALESCE(${o}.genres, CASE WHEN COALESCE(cardinality(${s}.genres), 0) = 0 AND ${m}.genres IS NOT NULL THEN ${m}.genres ELSE ${s}.genres END)`;

/**
 * SQL: genresOf for a query that cannot join, by correlated subqueries on `alias`.id: the 18+ filter (visibility.ts
 * browsable) is a predicate dropped into other queries. Both lookups are by primary key, and the filled-in one is only
 * read when the series' own genres are empty.
 */
export const genresByIdOf = (alias: string): string =>
  `COALESCE((SELECT o_g.genres FROM series_overrides o_g WHERE o_g.series_id = ${alias}.id),
            CASE WHEN COALESCE(cardinality(${alias}.genres), 0) = 0
                 THEN (SELECT m_g.genres FROM ${AUTO_DETAILS} m_g WHERE m_g.series_id = ${alias}.id) END,
            ${alias}.genres)`;
