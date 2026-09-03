// In what order to ask sources whether they carry a title.
//
// The fill scan used to ask every registered source at once. With 35 sources and a four-slot Cloudflare
// solver, the tail of that queue spent its whole timeout waiting for a slot and was then reported as
// unreachable: in one live scan, 16 of 21 candidates were sources that never got a turn. Asking in a
// sensible order lets the scan stop once it has enough, and makes "enough" arrive from the sources most
// likely to carry the title: the series' own source, then sources in its language, then sources that do
// not pin a language at all (they may well carry it), and only then sources pinned to another language.
//
// Pure, so it can be tested without a registry or a database.
export interface Orderable {
  id: string;
  lang?: string | null;
  preferredOrder?: number | null;
}

/** 'pt-BR' and 'pt' are the same language for this purpose; case is noise. */
const base = (l: string | null | undefined) => (l || '').toLowerCase().split(/[-_]/)[0];

export function scanOrder(all: Orderable[], own: { id: string; lang?: string | null } | null): string[] {
  const ownLang = base(own?.lang);
  const rank = (s: Orderable): number => {
    if (own && s.id === own.id) return 0;
    if (ownLang && base(s.lang) === ownLang) return 1;
    if (!s.lang) return 2;
    return 3;
  };
  return all
    .map((s, i) => ({ s, i, r: rank(s), p: s.preferredOrder ?? 999 }))
    .sort((a, b) => a.r - b.r || a.p - b.p || a.i - b.i)
    .map((x) => x.s.id);
}
