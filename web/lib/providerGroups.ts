// How the Providers panel folds one extension's language variants into one card, the part with no React in it.
//
// A multi-language extension is ONE package that exposes one source per language: 3Hentai alone is
// twenty-nine rows, enabled or not, and with a few of those installed the panel is a wall of near-identical
// cards that differ only in a two-letter tag. The server says which package each `sw:` source came out of
// (`extension.pkgName`); this groups by it, and by the extension's name when the engine never said.

import type { Src } from './sourceGroups';

export type SrcStatus = NonNullable<Src['status']>;

/** One row of GET /api/sources as the panel sees it: the registry entry plus the v0.33.0 provenance. */
export interface ProviderSrc extends Src {
  /**
   * The extension package an `sw:` source came from. `pkgName` null means the engine did not say and
   * `name` is the display name with its language tag stripped by the server -- a guess, but the same
   * guess for every variant of the package, which is all grouping needs. Null for every other source.
   */
  extension?: { pkgName: string | null; name: string } | null;
}

export interface ProviderGroup {
  /** Stable across renders and refetches; `sw-pkg:` / `sw-name:` for extensions, the source id otherwise. */
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
  worst: SrcStatus;
}

/**
 * The order the header chooses a status by. Lower loses to higher, so one blocked variant among
 * twenty-eight healthy ones is what the card shows -- "everything fine" on a card hiding a blocked source is
 * the state this exists to prevent. `disabled` ranks below `ok` on purpose: an extension with most
 * languages switched off and one healthy one is healthy, not off.
 */
const SEVERITY: Record<SrcStatus, number> = { disabled: 0, ok: 1, quiet: 1, rate_limited: 2, down: 2, blocked: 2 };

const statusOf = (s: ProviderSrc): SrcStatus => s.status ?? 'ok';

/** The unhappiest of the statuses given, by SEVERITY; ties keep the first seen. */
export function worstStatus(statuses: SrcStatus[]): SrcStatus {
  let worst: SrcStatus = 'ok';
  let rank = -1;
  for (const st of statuses) {
    const r = SEVERITY[st] ?? 1;
    if (r > rank) { worst = st; rank = r; }
  }
  return worst;
}

/** The grouping key of an extension source, or null for a source that is never folded. */
function groupKeyOf(s: ProviderSrc): string | null {
  if (!s.id.startsWith('sw:') || !s.extension) return null;
  if (s.extension.pkgName) return `sw-pkg:${s.extension.pkgName}`;
  // No package name: fold on the server's stripped name, folded for case so "3hentai" and "3Hentai" (two
  // engine versions, one package) still land together. Anything else on the row is per-variant.
  const n = s.extension.name.trim().toLowerCase();
  return n ? `sw-name:${n}` : null;
}

/**
 * The provider list as cards: one per extension package (however many language variants it exposes), and
 * one per every other source. Order is the server's, by each group's first appearance, so the built-ins
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
