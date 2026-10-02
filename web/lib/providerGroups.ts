// How the Providers panel folds one extension's language variants into one card, the part with no React in it.
//
// A multi-language extension is ONE package that exposes one source per language: 3Hentai alone is
// twenty-nine rows, enabled or not, and with a few of those installed the panel is a wall of near-identical
// cards that differ only in a two-letter tag. The server says which package each `sw:` source came out of
// (`extension.pkgName`); this groups by it, and by the extension's name when the engine never said.
//
// MangaDex is the same shape since v0.52.0 (#123): one built-in source per language, `mangadex` for English and
// `mangadex-es-419` and so on for the others, and the server names the family `mangadex`. It is one card however
// many languages are on -- with English alone too, because that card is where the other languages are offered.

import type { Src } from './sourceGroups';

export type SrcStatus = NonNullable<Src['status']>;

/**
 * What a source card can say: the public status, plus `failing` (#115, v0.49.0) -- a source whose Test or daily
 * check failed, or that failed at the same step three times running in normal use, while no cooldown holds it.
 * Admin-only: Discover's Src type is untouched, because GET /api/sources is one cache key for every account.
 */
export type ProviderStatus = SrcStatus | 'failing';

/** The admin row's part providerStatus reads: GET /api/admin/sources `failing`, the open confirmed failures. */
export interface AdminSourceRow {
  failing?: Array<{ stage: string }> | null;
}

/**
 * The status a Providers card wears. The public status knows only cooldowns, and any download or the nightly
 * lapsed-block reset puts it back to 'ok', which is how "Manga Ball (EN)" failed its Test under a card that said
 * "ok". A confirmed failure outranks 'ok' and 'quiet'; a cooldown and a switched-off source keep their own
 * words, which already say more than "failing" would.
 */
export function providerStatus(pub: SrcStatus | null | undefined, row?: AdminSourceRow | null): ProviderStatus {
  const st = pub ?? 'ok';
  if ((st === 'ok' || st === 'quiet') && row?.failing?.length) return 'failing';
  return st;
}

/** One row of GET /api/sources as the panel sees it: the registry entry plus the v0.33.0 provenance. */
export interface ProviderSrc extends Omit<Src, 'status'> {
  /** The public status, or `failing` once the admin rows are overlaid (providerStatus). */
  status?: ProviderStatus;
  /**
   * The extension package an `sw:` source came from. `pkgName` null means the engine did not say and
   * `name` is the display name with its language tag stripped by the server -- a guess, but the same
   * guess for every variant of the package, which is all grouping needs. `{pkgName: 'mangadex'}` on every
   * MangaDex language (v0.52.0). Null for every other source.
   */
  extension?: { pkgName: string | null; name: string } | null;
}

/** The MangaDex family's group key (v0.52.0, #123): the Providers panel gives it a card of its own. */
export const MANGADEX_GROUP = 'builtin:mangadex';

/** MangaDex's source id in one language, as the server names it: `mangadex` for English, `mangadex-es-419`, … */
export function mangadexSourceId(code: string): string {
  return code === 'en' ? 'mangadex' : `mangadex-${code.toLowerCase()}`;
}

export interface ProviderGroup {
  /** Stable across renders and refetches; `sw-pkg:` / `sw-name:` for extensions, MANGADEX_GROUP, the source id otherwise. */
  key: string;
  /** What the card header says: the extension's name, or the lone source's own name. */
  name: string;
  /** The variants, in the order the server listed them. Length 1 for anything that is not a multi-variant extension. */
  sources: ProviderSrc[];
  /** Distinct declared languages, in first-seen order; a variant with no language does not add one. */
  languages: string[];
  /** How many of the variants are switched on (any status but `disabled`). */
  on: number;
  /** The status the header wears: the unhappiest variant's, so a blocked language colours the whole card. */
  worst: ProviderStatus;
}

/**
 * The order the header chooses a status by. Lower loses to higher, so one blocked variant among
 * twenty-eight healthy ones is what the card shows -- "everything fine" on a card hiding a blocked source is
 * the state this exists to prevent. `disabled` ranks below `ok` on purpose: an extension with most
 * languages switched off and one healthy one is healthy, not off.
 */
const SEVERITY: Record<ProviderStatus, number> = { disabled: 0, ok: 1, quiet: 1, failing: 2, rate_limited: 2, down: 2, blocked: 2 };

const statusOf = (s: ProviderSrc): ProviderStatus => s.status ?? 'ok';

/** The unhappiest of the statuses given, by SEVERITY; ties keep the first seen. */
export function worstStatus(statuses: ProviderStatus[]): ProviderStatus {
  let worst: ProviderStatus = 'ok';
  let rank = -1;
  for (const st of statuses) {
    const r = SEVERITY[st] ?? 1;
    if (r > rank) { worst = st; rank = r; }
  }
  return worst;
}

/** The grouping key of an extension source or of MangaDex's languages, or null for a source that is never folded. */
function groupKeyOf(s: ProviderSrc): string | null {
  if (!s.extension) return null;
  // A built-in that is several sources: the server names the family (MangaDex's languages, v0.52.0). Its own key
  // space, so a family never folds with an extension package of the same name.
  if (!s.id.startsWith('sw:')) return s.extension.pkgName ? `builtin:${s.extension.pkgName}` : null;
  if (s.extension.pkgName) return `sw-pkg:${s.extension.pkgName}`;
  // No package name: fold on the server's stripped name, folded for case so "3hentai" and "3Hentai" (two
  // engine versions, one package) still land together. Anything else on the row is per-variant.
  const n = s.extension.name.trim().toLowerCase();
  return n ? `sw-name:${n}` : null;
}

/**
 * The provider list as cards: one per extension package (however many language variants it exposes), one for
 * MangaDex (however many languages are on), and one per every other source. Order is the server's, by each group's first appearance, so the built-ins
 * and packs keep their registry position and a package sits where its first variant did.
 */
export function groupProviders(list: ProviderSrc[]): ProviderGroup[] {
  const out: ProviderGroup[] = [];
  const byKey = new Map<string, ProviderGroup>();
  for (const s of list) {
    const key = groupKeyOf(s);
    if (key === null) {
      out.push({ key: s.id, name: s.name, sources: [s], languages: s.lang ? [s.lang] : [], on: statusOf(s) === 'disabled' ? 0 : 1, worst: statusOf(s) });
      continue;
    }
    let g = byKey.get(key);
    if (!g) {
      g = { key, name: s.extension!.name || s.name, sources: [], languages: [], on: 0, worst: 'ok' };
      byKey.set(key, g);
      out.push(g);
    }
    g.sources.push(s);
    if (s.lang && !g.languages.includes(s.lang)) g.languages.push(s.lang);
    if (statusOf(s) !== 'disabled') g.on++;
  }
  for (const g of out) g.worst = worstStatus(g.sources.map(statusOf));
  return out;
}
