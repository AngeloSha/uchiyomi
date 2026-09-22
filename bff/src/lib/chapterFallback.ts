// One chapter, every way it can still land: the chosen copy, then the same number from another followed
// source, then a source found for the purpose, and finally the chapter with holes in it.
//
// Three loops download chapters -- the sweep (lib/updater.ts), the job card (routes/sources.ts
// startDownloadJob: fills, fetches, refetches) and the add path's detached run -- and until v0.40.0 each
// asked ONE copy and gave up. The owner's complaint was exactly that: "a missing page, like 149 of 155,
// causes the chapter not to be downloaded", and the ledger agreed with 153 rows of "N-1 of N pages" that
// the sweep re-tried every night for weeks while `series_listing.copies` (v0.33.0) knew about a second
// copy of every one of them on a followed source. This is the one helper all three loops now call, so
// the order of things to try is written down once.
//
// The order, and why it is this order:
//   1. The chosen copy. Skipped outright when its source has already refused this run (`refusing`): a
//      site that answered 403 or 429 minutes ago is not asked again, and the cooldown is the answer.
//   2. The same number from another followed source, at most MAX_ALTERNATES of them, ranked as the
//      release rules rank copies (lib/releases.ts copiesOf), minus the sources that are refusing, disabled,
//      in a cooldown, or outside the viewer's age cap. Never for a PINNED copy: a person who tapped one
//      specific version asked for that version, and "we fetched a different one" is not what they meant.
//   3. A source found for the purpose (lib/sourceHunt.ts), only when the caller offers one and only when
//      the chosen copy did not fail on a refusal: a 403 or a 429 says the site is saying no to us, and
//      following a third source because the first is rate-limiting would turn a cooldown into a load on
//      someone else. A missing page, an error, a site that is down -- those are worth a search. The one
//      exception is a refusal the caller marks `persistent` (the same site has refused this number across
//      two sweeps already): that is no longer a busy site but a chapter it will not serve, and the hunt
//      is the only way it lands. Even then a refusal never becomes a partial (step 4).
//   4. The best hold. A copy that arrived at or above PARTIAL_CHAPTER_FLOOR is offered by the downloader
//      as a PartialHold (never written by it); the hold with the fewest missing pages across everything
//      tried here is written last, once nothing landed whole. So a chapter is saved with holes only when
//      every source that could have served it whole was asked and could not.
//
// Every step is a real request to a site. The caps here (two alternates, one hunt, one write) are the
// whole of what one failed chapter may cost, and the reviewers count them.
import { downloadChapter, type DownloadInput, type PartialHold } from './downloader';
import { getSource, type SourceChapter } from './sources';
import { isDisabled, blockedNow, classify } from './sourceHealth';

export interface FallbackInput {
  seriesId: string;
  title: string;
  /** The series folder under DL_ROOT, as the updater and the job card hold it. */
  folder: string;
  meta: DownloadInput['meta'];
  /** The chosen copy; `source` is the adapter it is fetched through. `pinned` = a person picked this copy. */
  chapter: SourceChapter & { pinned?: boolean };
  /** The other copies of this number, best first, from the sources the series follows. Asked lazily. */
  alternates: () => Promise<SourceChapter[]>;
  /** Sources that have refused this run. Read here to skip them and WRITTEN here when a copy earns it. */
  refusing: Set<string>;
  /** The viewer's age cap, or the sweep's adult rule: a source this returns false for is never asked. */
  allowed?: (source: string) => boolean;
  /** Find and follow a source for this number. Only the sweep offers one; the job card never hunts. */
  hunt?: (why: string) => Promise<SourceChapter | null>;
  /**
   * The ledger already shows >= 2 refusals of this number from this source (lib/updater.ts reads
   * chapter_failures for it) -- a third "no" is not a cooldown story any more. A refusal normally never
   * starts a hunt, because a 429 minutes ago is a site that is busy, and the cooldown is the answer; but
   * a chapter that the same site has refused across two sweeps, days apart, is a chapter that site is not
   * going to serve (live: 169 chapters parked for weeks on "page 1: 404; page 2: 429"), and the hunt is
   * the only way it ever lands. Lifts ONLY the hunt gate: the refusal still costs its strike, the source
   * still goes into `refusing`, and a partial is still never written on one.
   */
  persistent?: boolean;
  /** Write over a file already on disk (the completion pass, the admin refetch). */
  replace?: boolean;
  /**
   * Optional admission check for the best partial hold, evaluated before it writes anything. The completion
   * pass uses this to require fewer holes than the canonical file, so rejecting a worse copy is crash-safe.
   */
  acceptPartial?: (hold: PartialHold, via: string) => boolean;
}

export type FallbackOutcome =
  | { kind: 'landed'; via: string; pages: number; chapterUsed: SourceChapter; switched?: { from: string; why: string } }
  /**
   * Nothing was written and nothing was wrong: the file was already on disk (`on_disk`), or the chosen
   * copy's source is refusing this run and no other copy could be asked (`refusing`). The second is the
   * old loops' `continue`: the chapter was never asked, so it is not a failure and earns no ledger row.
   */
  | { kind: 'skipped'; why: 'on_disk' | 'refusing' }
  | { kind: 'partial'; via: string; pages: number; missing: number[]; chapterUsed: SourceChapter; switched?: { from: string; why: string } }
  | { kind: 'failed'; via: string; err: any };

/** How many other followed sources one failed chapter may be asked from. */
export const MAX_ALTERNATES = 2;

/**
 * What a failure is called when the job card or the log names it: the source status when the source was
 * blamed (`rate_limited`, `blocked`, `down`), `incomplete` for a page count that came up short with nobody
 * blamed, else whatever the error classifies as.
 */
const whyOf = (e: any): string =>
  e?.blockStatus ?? (typeof e?.pages === 'number' ? 'incomplete' : classify(e) ?? 'error');

/** A refusal: the site said no to us. Neither a partial nor a hunt is ever the answer to one. */
const isRefusal = (e: any): boolean => e?.blockStatus === 'rate_limited' || e?.blockStatus === 'blocked';

export async function downloadWithFallback(f: FallbackInput): Promise<FallbackOutcome> {
  const via = f.chapter.source ?? '';
  const n = f.chapter.number;
  const label = `"${f.title}" ch ${n}`;
  if (!via) return { kind: 'failed', via, err: new Error(`${label}: the copy names no source`) };

  // The error of the CHOSEN copy: what the reason is worded from and what decides whether a hunt is
  // worth it. Null when the copy was never asked because its source is refusing.
  // (`null as …`: these are assigned inside `attempt`, and a bare `= null` would let TypeScript narrow
  // them to null for the rest of the function -- it does not see assignments made in closures.)
  let first = null as { via: string; err: any } | null;
  let last = null as { via: string; err: any } | null;
  // The hold with the fewest missing pages across every copy asked. Kept, not written, until the end.
  let best = null as { hold: PartialHold; via: string; chapter: SourceChapter } | null;

  const attempt = async (ch: SourceChapter, src: string, chosen = false): Promise<{ file: string; pages: number } | null | 'failed'> => {
    try {
      return await downloadChapter({ sourceId: src, seriesFolder: f.folder, chapter: ch, meta: f.meta }, { replace: f.replace });
    } catch (e: any) {
      // The library disk at its floor is nobody's fault here, and no other source can fix it.
      if (e?.diskFull) throw e;
      // ⚠️ Any blame on the SOURCE -- a refusal, or the connection gone under a large shortfall -- takes
      // it out of this run: that is the one-strike rule the loops used to apply themselves.
      if (e?.blockStatus) f.refusing.add(src);
      const hold: PartialHold | undefined = e?.partial;
      if (hold && (!best || hold.missing.length < best.hold.missing.length)) best = { hold, via: src, chapter: ch };
      last = { via: src, err: e };
      if (chosen) first = last;
      return 'failed';
    }
  };
  const switched = () => ({ from: via, why: first ? whyOf(first.err) : 'refusing' });
  const tookFrom = (to: string, missing: number[]) => console.log(
    `[download] ${label}: took from ${to} after ${via} failed (${switched().why})${missing.length ? `, saved with ${missing.length} page${missing.length === 1 ? '' : 's'} missing` : ''}`,
  );

  // ── 1 + 2. the chosen copy ────────────────────────────────────────────────────────────────────────
  let asked = 0;
  if (!f.refusing.has(via)) {
    asked++;
    const r = await attempt(f.chapter, via, true);
    if (r === null) return { kind: 'skipped', why: 'on_disk' };
    if (r !== 'failed') return { kind: 'landed', via, pages: r.pages, chapterUsed: f.chapter };
  }

  // ── 3. the same number from another followed source ───────────────────────────────────────────────
  // A pinned copy gets no alternate and no hunt: the person named the version they wanted. A hold from
  // it is still written below -- "this version, with a page missing" is still the version they asked for.
  if (!f.chapter.pinned) {
    let tried = 0;
    const alternates = await f.alternates().catch((e) => { console.warn(`[download] ${label}: alternates unavailable: ${(e as Error)?.message || e}`); return [] as SourceChapter[]; });
    for (const alt of alternates) {
      if (tried >= MAX_ALTERNATES) break;
      const src = alt.source ?? '';
      if (!src || src === via) continue;
      if (f.refusing.has(src)) continue;
      if (f.allowed && !f.allowed(src)) continue;
      if (!getSource(src)) continue;
      if (await isDisabled(src).catch(() => false)) continue;
      if (await blockedNow(src).catch(() => null)) continue;
      tried++;
      asked++;
      const r = await attempt(alt, src);
      if (r === 'failed') continue;
      if (r === null) return { kind: 'skipped', why: 'on_disk' };
      tookFrom(src, []);
      return { kind: 'landed', via: src, pages: r.pages, chapterUsed: alt, switched: switched() };
    }

    // ── 4. a source found for the purpose ───────────────────────────────────────────────────────────
    // Only after a real failure of the chosen copy, and never after a refusal (the header says why) --
    // unless the caller says the refusal is persistent (`FallbackInput.persistent`: the ledger already
    // shows two of them for this number from this source, so a third is not a cooldown story any more).
    // A chosen copy skipped for refusing counts as a refusal: the site that lists it has said no today.
    // Reintroduce by dropping `|| f.persistent`: "a persistent refusal may hunt, and still never writes a
    // partial" in chapterFallback.int.test.ts counts zero hunts.
    if (f.hunt && first && (!isRefusal(first.err) || f.persistent)) {
      const why = whyOf(first.err);
      const found = await f.hunt(why).catch((e) => { console.warn(`[download] ${label}: the source hunt failed: ${(e as Error)?.message || e}`); return null; });
      const src = found?.source ?? '';
      if (found && src && src !== via && !f.refusing.has(src) && (!f.allowed || f.allowed(src)) && getSource(src)) {
        asked++;
        const r = await attempt(found, src);
        if (r === null) return { kind: 'skipped', why: 'on_disk' };
        if (r !== 'failed') {
          tookFrom(src, []);
          return { kind: 'landed', via: src, pages: r.pages, chapterUsed: found, switched: switched() };
        }
      }
    }
  }

  // ── 5. the best hold ──────────────────────────────────────────────────────────────────────────────
  // Written here and nowhere else: the downloader offers a hold, it never writes one (partialChapter.test.ts
  // pins that), and this is the point at which everything that could have served the chapter whole has
  // been asked. The hold with the fewest holes wins, whichever source it came from.
  if (best && (!f.acceptPartial || f.acceptPartial(best.hold, best.via))) {
    const w = await best.hold.write();
    if (best.via !== via) tookFrom(best.via, w.missing);
    else console.warn(`[download] ${label}: saved with ${w.missing.length} page${w.missing.length === 1 ? '' : 's'} missing from ${via}`);
    return {
      kind: 'partial', via: best.via, pages: w.pages, missing: w.missing, chapterUsed: best.chapter,
      ...(best.via !== via ? { switched: switched() } : {}),
    };
  }

  // ── 6. nothing ────────────────────────────────────────────────────────────────────────────────────
  // Not asked at all -- the source is refusing and there was nothing else to ask -- is not a failure of
  // the chapter, and must not cost it an attempt against the retry cap.
  if (!asked) return { kind: 'skipped', why: 'refusing' };
  const fail = first ?? last!;
  return { kind: 'failed', via: fail.via, err: fail.err };
}
