// Age ratings, as a minimum age.
//
// The README and the site say "built for a household" eleven times, and a household often includes children.
// Komga and Kavita both let you cap an account; this could not, and `ageRating` was hardcoded `null` in the
// catalog. Per-library access was the only workaround, which means remembering to file every new adult title
// into the right library forever.
//
// Stored as an INTEGER MINIMUM AGE rather than a label, for the same reason Komga does it: labels are not
// orderable. "Teen" and "MA15+" and "R18+" come from three different rating systems, and a cap has to be a
// comparison. 13 < 15 < 18 is a comparison; "Teen" < "MA15+" is a string sort that happens to be wrong.

/**
 * ComicInfo.xml's AgeRating is a fixed string enum, and the values come from several rating boards at once.
 * Anything unrecognised maps to null, which means "unrated" -- never to 18, because guessing high hides
 * someone's library and guessing low is the failure this file exists to prevent. Unrated is a third state.
 */
const COMIC_INFO: Record<string, number> = {
  'early childhood': 3,
  'everyone': 6,
  'g': 6,
  'kids to adults': 6,
  'everyone 10+': 10,
  'pg': 10,
  'teen': 13,
  'ma15+': 15,
  'm': 17,
  'mature 17+': 17,
  'adults only 18+': 18,
  'r18+': 18,
  'x18+': 18,
  // 'unknown' and 'rating pending' deliberately absent: both mean "nobody has said", which is null.
};

/** The caps an admin can choose, and what each is called in the UI. */
export const AGE_CAPS: Array<{ value: number; label: string }> = [
  { value: 6, label: '6+' },
  { value: 10, label: '10+' },
  { value: 13, label: '13+' },
  { value: 15, label: '15+' },
  { value: 17, label: '17+' },
  { value: 18, label: '18+' },
];

export const MAX_AGE = 18;

/** Parse ComicInfo's AgeRating into a minimum age, or null when it says nothing useful. */
export function parseComicInfoAgeRating(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  if (!v || v === 'unknown' || v === 'rating pending') return null;
  if (v in COMIC_INFO) return COMIC_INFO[v];
  // Some writers emit a bare number ("16") or an unlisted "NN+" form. Accept those rather than discarding
  // information, but only within a sane range: a stray year like 2019 must not become a rating.
  const m = /^(\d{1,2})\s*\+?$/.exec(v);
  if (m) {
    const n = Number(m[1]);
    if (n >= 0 && n <= MAX_AGE) return n;
  }
  return null;
}

/** Clamp an admin-entered rating to something storable, or null to clear it. */
export function normalizeAgeRating(n: unknown): number | null {
  if (n === null || n === undefined || n === '') return null;
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return null;
  return Math.min(MAX_AGE, Math.max(0, v));
}
