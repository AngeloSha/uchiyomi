// Chapter parts that sources number or split differently (v0.50.0).
//
// A long chapter is often posted in parts, and the sites do not agree on how to number them. On Tales of Demons
// and Gods mangapill writes part 1 as N and part 2 as N.5, mangaread writes N.1 and N.6; natomanga splits The
// Great Mage Returns After 4000 Years' chapter 78 into 78, 78.1 ... 78.9 where the disk holds 78 as one file.
// Every number comparison in the sweep is exact, so once aqua (the main source) went offline and series followed
// sites like these, the sweep took their numbers for new chapters: on 1 October it downloaded about a hundred
// chapters this server already had, under other numbers.
//
// Two rules, per series and per whole number N, over every followed source's list -- the primary's included --
// in the updater's listing layer, BEFORE the chooser, so the chooser, the floor, the have-set, `source_missing`
// and the stored listing all see the same numbers:
//
//   R1  The same parts under different numbers. A source listing as many parts at N as the reference (two or
//       more), in other numbers, is renumbered onto the reference, part for part in ascending order: its N.1 and
//       N.6 become N and N.5 when that is how the disk has them. The copy keeps the source's own number in
//       `sourceNumber`, as a posting-order renumber does (#116). A different count is a different split, and
//       one part has no order to go by: neither is touched.
//   R2  Another split of a chapter you have. A listed number that is not on disk, at a whole number the disk
//       holds a file at, from a source none of those files came from, is `covered`: not fetched by the sweep,
//       not counted as missing, kept in the listing so the series page can show it and a person can still
//       fetch it. The SAME source listing N.5 beside the N it gave us is a part of its own numbering -- that is
//       a genuine extra, and it is fetched. A file with no recorded origin counts as another source's.
//
// The reference parts at N: the files on disk at N; else the primary's list at N; else the series' own
// convention for that many parts -- the pattern most of its chapters with that many parts on disk follow, so
// two followers that disagree land on the series' numbering and not on whichever happened to rank first; else
// the first source in rank order that lists N.
//
// Pure: no database, no clock (partAlias.test.ts walks the imports). The updater reads the disk and hands it in.
import type { SourceChapter } from './sources/types';
import { numKey } from './postingOrder';
import { chapterName } from './naming';

/** A chapter file the series holds: its number (the admin's override when there is one) and where it came from. */
export interface HeldPart {
  number: number;
  /** lib_books.source_id: the adapter the file was downloaded from; null for a file that came from elsewhere. */
  sourceId: string | null;
}

export interface PartAliasInput<T extends SourceChapter> {
  /** Every followed source's copies, each tagged with its `source`, in the order the updater gathered them. */
  tagged: readonly T[];
  /** What the series holds: live chapters and deliberate tombstones (lib/chapterCleanup heldBooks), override-aware. */
  held: readonly HeldPart[];
  /** The series' own source, whose list at N is the reference when nothing is on disk there. */
  primary: string | null;
  /** The chooser's source rank, lower first (lib/sourcePrefs rankSources). Absent: the order of `tagged`. */
  sourceRank?: (source?: string) => number;
}

export interface PartAliasResult<T extends SourceChapter> {
  /** `tagged` after R1: a renumbered copy is a new object, every other copy the very one handed in. */
  tagged: T[];
  /** R2: the numbers, exactly as they appear in `tagged`, that are another split of a chapter on disk. */
  covered: Set<number>;
}

/**
 * Do the rules apply to this series now? Not under posting order (#116): its numbers are Uchiyomi's, one per
 * post, and parts are posts there. Not while a numbering change is pending or a renumber's journal is open: the
 * listing is then in numbers the files may not be in, and a reference read from the disk would be the old one.
 */
export function partRulesApply(s: { numbering?: string | null; numbering_pending?: unknown; renumber_plan?: unknown }): boolean {
  return s.numbering !== 'posting_order' && s.numbering_pending == null && s.renumber_plan == null;
}

/** The distinct parts (numKey) at each whole number, ascending. */
function partsByWhole(numbers: Iterable<number>): Map<number, number[]> {
  const sets = new Map<number, Set<number>>();
  for (const n of numbers) {
    if (!Number.isFinite(n)) continue;
    const k = numKey(n);
    const w = Math.floor(k);
    let parts = sets.get(w);
    if (!parts) sets.set(w, (parts = new Set()));
    parts.add(k);
  }
  return new Map([...sets].map(([w, parts]) => [w, [...parts].sort((a, b) => a - b)]));
}

/**
 * The series' convention for a chapter in k parts, as offsets from its whole number ([0, 0.5] for N and N.5): the
 * pattern most of its k-part chapters on disk follow, a tie going to the newest chapter's.
 */
function conventions(disk: Map<number, number[]>): Map<number, number[]> {
  const tally = new Map<string, { offsets: number[]; count: number; newest: number }>();
  for (const [w, parts] of disk) {
    const offsets = parts.map((p) => numKey(p - w));
    const key = offsets.join(',');
    const t = tally.get(key);
    if (t) { t.count++; t.newest = Math.max(t.newest, w); } else tally.set(key, { offsets, count: 1, newest: w });
  }
  const best = new Map<number, { offsets: number[]; count: number; newest: number }>();
  for (const t of tally.values()) {
    const b = best.get(t.offsets.length);
    if (!b || t.count > b.count || (t.count === b.count && t.newest > b.newest)) best.set(t.offsets.length, t);
  }
  return new Map([...best].map(([k, t]) => [k, t.offsets]));
}

const sameParts = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** R1 then R2 over one series' listing. See the top of this file. */
export function aliasParts<T extends SourceChapter>(input: PartAliasInput<T>): PartAliasResult<T> {
  const { tagged, held, primary } = input;
  const disk = partsByWhole(held.map((h) => h.number));
  const lists = new Map<string, T[]>();
  for (const c of tagged) {
    const key = c.source ?? '';
    const list = lists.get(key);
    if (list) list.push(c);
    else lists.set(key, [c]);
  }
  const bySource = new Map([...lists].map(([src, list]) => [src, partsByWhole(list.map((c) => c.number))]));
  // Stable: two sources the rank cannot tell apart keep the order the updater gathered them in, primary first.
  const ranked = [...bySource.keys()];
  if (input.sourceRank) ranked.sort((a, b) => input.sourceRank!(a) - input.sourceRank!(b));
  const convention = conventions(disk);

  const refs = new Map<number, number[]>();
  const referenceAt = (w: number): number[] => {
    let ref = refs.get(w);
    if (ref) return ref;
    ref = disk.get(w) ?? (primary != null ? bySource.get(primary)?.get(w) : undefined);
    if (!ref) {
      const first = ranked.find((src) => bySource.get(src)!.has(w))!;
      const own = bySource.get(first)!.get(w)!;
      const offsets = convention.get(own.length);
      ref = offsets ? offsets.map((o) => numKey(w + o)) : own;
    }
    refs.set(w, ref);
    return ref;
  };

  // R1: per source and whole number, the same count of parts as the reference in other numbers, matched in order.
  const moves = new Map<string, number>();
  for (const [src, wholes] of bySource) {
    for (const [w, parts] of wholes) {
      const ref = referenceAt(w);
      if (ref.length < 2 || parts.length !== ref.length || sameParts(parts, ref)) continue;
      parts.forEach((p, i) => { if (p !== ref[i]) moves.set(`${src}\u0000${p}`, ref[i]); });
    }
  }
  const out = moves.size
    ? tagged.map((c) => {
      if (!Number.isFinite(c.number)) return c;
      const to = moves.get(`${c.source ?? ''}\u0000${numKey(c.number)}`);
      if (to === undefined) return c;
      // The source's own number stays with the copy -- unless posting order already put one there (#116). The title
      // loses that number: "Chapter 12.6" on the copy that is now 12.5 would be stamped on the file as its name
      // (library.ts setBookMeta names a chapter by what its title says beyond its number). What is left is the
      // chapter's own name, or nothing when the title only said the number.
      return { ...c, number: to, sourceNumber: c.sourceNumber ?? c.number, title: chapterName(c.title, c.number) ?? undefined };
    })
    : [...tagged];

  // R2: who lists each number now, and where the files at each whole number came from.
  const listers = new Map<number, Set<string>>();
  for (const c of out) {
    if (!Number.isFinite(c.number)) continue;
    const k = numKey(c.number);
    let who = listers.get(k);
    if (!who) listers.set(k, (who = new Set()));
    who.add(c.source ?? '');
  }
  const onDisk = new Set(held.filter((h) => Number.isFinite(h.number)).map((h) => numKey(h.number)));
  const origins = new Map<number, Set<string | null>>();
  for (const h of held) {
    if (!Number.isFinite(h.number)) continue;
    const w = Math.floor(numKey(h.number));
    let from = origins.get(w);
    if (!from) origins.set(w, (from = new Set()));
    from.add(h.sourceId ?? null);
  }
  const coveredKeys = new Set<number>();
  for (const [k, who] of listers) {
    if (onDisk.has(k)) continue;
    const from = origins.get(Math.floor(k));
    if (!from?.size || [...who].some((src) => from.has(src))) continue;
    coveredKeys.add(k);
  }
  const covered = new Set(out.filter((c) => Number.isFinite(c.number) && coveredKeys.has(numKey(c.number))).map((c) => c.number));
  return { tagged: out, covered };
}
