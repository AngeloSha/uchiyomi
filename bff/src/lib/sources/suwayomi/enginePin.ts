// Which extension engine this Uchiyomi was built and tested against, and how a running one stands next to it.
//
// The engine is Suwayomi-Server, a project of its own with its own releases. Every install mode pins one version of it
// (bff/test/enginePins.test.ts holds them equal), but an engine is also run by people who chose their own: an
// external Suwayomi, a CasaOS add-on edited by hand, a compose file with `:stable`. Until this file, nothing compared
// the version an engine reports with anything, and an engine that refused Uchiyomi's queries was reported as "not
// answering" -- the fix for which (restart the container) does nothing.
//
// Pure on purpose: no env, no db, no fetch, so lib/sourceDiagnosis.ts (and through it web/test/said.test.ts) can read
// the refusal words below.
import { isBehind, parseVersion } from '../../githubRelease';

/** The engine this Uchiyomi was tested with. bff/test/enginePins.test.ts holds it equal to the pin. */
export const TESTED_ENGINE = 'v2.3.2243';
/**
 * The oldest engine this Uchiyomi still works with. Every GraphQL document it sends (operations.ts) is validated
 * against the schema of every engine from this one up (test/suwayomiOperations.test.ts), and an older one is told to
 * update. v2.3.2243 is the first with extension stores and `fetchMangaAndChapters`.
 */
export const OLDEST_ENGINE = 'v2.3.2243';

/**
 * - `same`: the tested engine;
 * - `older`: older than the tested one, still supported;
 * - `tooOld`: older than the oldest supported one;
 * - `newer`: newer than the tested one -- likely fine, and not yet tested;
 * - `unknown`: no version, or one that is not `vX.Y.Z`.
 */
export type EngineStanding = 'same' | 'older' | 'tooOld' | 'newer' | 'unknown';

export function engineStanding(
  version: string | null | undefined, tested: string = TESTED_ENGINE, oldest: string = OLDEST_ENGINE,
): EngineStanding {
  if (!parseVersion(version)) return 'unknown';
  if (isBehind(version, oldest)) return 'tooOld';
  if (isBehind(version, tested)) return 'older';
  if (isBehind(tested, version)) return 'newer';
  return 'same';
}

/**
 * The engine REFUSING a query, as graphql-java words it, at the start of the message and nowhere else: a validation
 * error, a document it cannot parse, or variables it cannot coerce. Measured on v2.3.2243 and v2.4.2366
 * (fakeSuwayomiEngine.mjs, conformFakeSuwayomi.mjs): status 200, no `data` key, and one of these openings.
 *
 * ⚠️ Anchored. An extension's own failure is "Exception while fetching data (/fetchSourceManga) : …", and its message
 * can quote anything a site sent -- including these words. Unanchored, a site printing "Validation error (" would read
 * as an incompatible engine.
 */
export const REFUSAL_HEAD = /^(?:Validation error \(|Invalid syntax|Variable '[^']*' has an invalid value|The variables input contains a field name)/;

/** Is this message (with or without client.ts's `suwayomi: ` prefix) the engine refusing a query? */
export function isRefusalMessage(message: string | null | undefined): boolean {
  return REFUSAL_HEAD.test(String(message ?? '').replace(/^suwayomi: /, ''));
}
