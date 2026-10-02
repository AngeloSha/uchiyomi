'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { AutoFollow, AutoFollowResult, FollowWhy, GroupStat, Page, Series } from '@/lib/types';
import { Modal, msgOf } from '@/components/ConfirmDialog';
import { Img, ProgressBar } from '@/components/ui';
import { sourceCover } from '@/components/cards';
import { Switch } from '@/components/Switch';
import { useToast } from '@/components/Toast';
import { IcCheck } from '@/components/icons';
import { SourceIcon } from '@/components/SourcePicker';
import { GroupAvatar } from '@/components/GroupAvatar';
import { ActivityDots } from '@/components/ActivityDots';
import { activityStatus, weeksOf } from '@/lib/activity';
import { languageName, relativeTime } from '@/lib/format';
import { t as tr } from '@/lib/i18n';
import { fetchingLabel } from '@/lib/jobs';
import { normTitle } from '@/lib/normTitle';
import { cadenceText } from '@/lib/cadence';
import { jobNoteLines, type JobCardNotes } from '@/lib/jobNotes';
import { downloadsHref } from '@/lib/libraryView';
import { PreviewReader } from '@/components/PreviewReader';
import { ARCHIVE_PACE, archiveAddLine, archiveSwitchHelp, type EnqueueOutcome } from '@/lib/archive';
import { useServerDownloads } from '@/lib/useServerDownloads';
import { useAuth } from '@/lib/auth';
import { addNoticeHeading, addNumberingView, numLabel, type DetailNumbering } from '@/lib/numbering';
import { extensionSettingsHref } from '@/lib/sourcePrefs';
import { baseOf, codeLabel, editionLangPreset, languageChoices, openingLanguage } from '@/lib/editions';
import { MANGADEX_LANGUAGES_HREF } from '@/lib/mangadexLangs';

export interface Provider {
  source: string; name: string; sourceId: string; title: string; coverUrl?: string;
  /** The language the source declares (v0.52.0), null when it says nothing; absent from an older server. */
  lang?: string | null;
  /** The library holds the title in this provider's language (v0.52.0): the row reads "in your library". */
  inLibrary?: boolean;
  /** On a trending search's providers (GET /api/sources/find): the entry holding the title, and its languages. */
  librarySeriesId?: string;
  libraryLangs?: string[];
}
/** What the library holds of a title, from the card that opened the dialog (v0.52.0): the edition an add would join. */
export interface HeldTitle { seriesId: string; langs: string[] }
/** GET /api/sources/edition-candidates: the languages a series could be added in (v0.52.0). */
interface EditionCandidates {
  title: string;
  held: Array<{ seriesId: string; lang: string }>;
  languages: Array<{ lang: string; sources: Array<{ id: string; name: string }> }>;
  unstated: Array<{ id: string; name: string }>;
}
/** What an add of a language edition came to: its work, or that it was added on its own (bff routes/sources.ts). */
interface AddedEdition { lang: string; workId?: string; unlinked?: 'taken' | 'gone' }
interface Detail {
  source: string; sourceId: string; title: string; summary: string; coverUrl: string | null;
  genres: string[]; status: string; count: number; first: number | null; last: number | null;
  /** Who releases it, from the live chapter list (so `onDisk` is 0 -- nothing is on disk yet). Absent from an older server. */
  groups?: GroupStat[];
  /** How many numbers have more than one copy. */
  versions?: number;
  /** The detector's word on this listing (v0.49.0, #116); `count`/`first`/`last` follow `numbering.applied`. */
  numbering?: DetailNumbering;
}
interface Job extends JobCardNotes {
  folder: string; title: string; total: number; done: number; status: string;
  /** The add-time auto-follow (v0.36.0), once the server has judged the other sources. See lib/types.ts. */
  autoFollow?: AutoFollow;
  /** An edition's add (v0.52.0): linked once the first chapter is scanned in, or added on its own. */
  edition?: AddedEdition;
  /**
   * The series this job is filling, once the server has scanned its first chapter in (v0.42.0, #67). A
   * fresh download has no library row when the add is answered, so this card is how the id reaches
   * "Open in library" -- and the done step is already polling it.
   */
  seriesId?: string;
}

/** What POST /api/sources/add answers with. */
interface AddAnswer {
  title: string; folder: string; chapters: number; started?: boolean; nothing?: boolean;
  /**
   * The series the add landed on (v0.42.0, #67). Present whenever the server could know it -- already in
   * the library, a nothing-yet add, a revive, an add with nothing left to fetch -- and absent on a fresh
   * download, whose row is created behind the reply; that one arrives on the job card.
   */
  seriesId?: string;
  /** Every chapter asked for was already in the library, so none was fetched (v0.42.0, #65). */
  alreadyHere?: number;
  /**
   * What became of "Archive the rest slowly" (#117): queued, `later` (a download's rest is queued once its own
   * chapters are in), or why not. Absent when it was not asked for.
   */
  archive?: EnqueueOutcome | 'later';
  /** The edition this add made (v0.52.0): its language, its work once linked, or why it stands on its own. */
  edition?: AddedEdition;
}

/**
 * What opened the dialog. `library` (v0.52.0): what the library holds of the card's title, when it holds it in
 * another language than every provider's -- the dialog offers the new language as an edition. `edition`: the series
 * page's "Add a language", which starts from the languages the sources offer rather than from a title; with `lang`
 * and `source`, a follow the language guard refused ("Add it as an edition"), which opens on that source's language.
 */
export type AddSeed =
  | { kind: 'trending'; title: string }
  | { kind: 'result'; provider: Provider; library?: HeldTitle }
  | { kind: 'group'; title: string; providers: Provider[]; library?: HeldTitle }
  | { kind: 'edition'; of: string; title: string; lang?: string; source?: string };

/**
 * Per-device memory of the "Also check the other sources" switch. A device setting, not an account one: it
 * is about how this person adds, and the server has nothing to store for a choice the dialog makes at add
 * time. Off until switched on.
 */
const ALSO_FOLLOW_KEY = 'uchiyomi.alsoFollow';
/** At most this many candidates ride with an add: the server judges each with two outbound calls, under one wall budget. */
const ALSO_FOLLOW_MAX = 6;

/**
 * The server's reason a candidate source was not followed, as a person would say it. Every branch is a
 * literal so the locale-parity test sees each; a code this list does not know is printed as it came, so a
 * new reason is at least visible rather than silently "not followed".
 */
export function autoFollowWhy(why: FollowWhy | string): string {
  switch (why) {
    case 'numbering_differs': return tr('numbering differs');
    case 'title_differs': return tr('different title');
    case 'unreachable': return tr('could not be reached');
    case 'too_few_listed': return tr('lists too few chapters');
    case 'not_tried': return tr('not checked — it took too long');
    case 'cap': return tr('already following two');
    case 'unavailable': return tr('not available');
    // #116: nothing is judged -- no other source's numbers line up with posts numbered 1..K.
    case 'posting_order': return tr('this series is numbered by posting order');
    // v0.52.0 (#123): another language's source is never followed for a series; it would be that title's other edition.
    case 'language_differs': return tr('in another language');
    default: return why;
  }
}

/**
 * One candidate's line on the done step: what was followed, under which title there, or why not. The
 * percent sign is glued to its number after translation: at 390 px "· 95 %" broke with a lone "%" on the
 * next line. Done on the output rather than in the keys so no locale file carries an invisible character;
 * a language that writes "95٪" or "95%" has no space to glue.
 */
function autoFollowLine(r: AutoFollowResult): string {
  const pct = Math.round((r.coverage ?? 0) * 100);
  if (r.followed) {
    const line = r.theirTitle
      ? tr('Followed {name} — listed there as “{theirTitle}” · {pct} %', { name: r.name, theirTitle: r.theirTitle, pct })
      : tr('Followed {name} · {pct} %', { name: r.name, pct });
    return line.replace(/(\d) %/, '$1 %');
  }
  return tr('Not followed: {name} — {why}', { name: r.name, why: autoFollowWhy(r.why) });
}

/**
 * What the chapter <select> holds. Sources list chapters ascending, so "First N" has always meant the OLDEST
 * N -- right for a title you are starting, wrong for one you are catching up on. "Latest N" is the other
 * end, and the server puts a floor under the series so auto-update fetches new releases only.
 *
 * `none` is "Nothing yet -- pick chapters later" (#40): the series is created with a listing and a floor
 * above its newest chapter, nothing is fetched, and auto-update takes releases from here on. It is also the
 * only option that survives a source listing zero chapters -- `All (0)` posts a count the server refuses
 * with `no_chapters` -- so it is the default and the only choice then.
 */
type ChapterPick = 'all' | 'none' | `first:${number}` | `latest:${number}`;
const CHAPTER_PRESETS = [10, 25, 50, 100, 200];

/**
 * How long a looked-up detail stays fresh on this device. The server caches the same lookup for ten minutes
 * too, so a longer time here would only show a listing the server itself has already refreshed.
 */
const DETAIL_STALE_MS = 10 * 60_000;
/** One source's series and chapter list. The signal is the query's, so a pick abandoned mid-flight is cancelled. */
const fetchDetail = (p: Pick<Provider, 'source' | 'sourceId'>, signal?: AbortSignal) =>
  api<Detail>(`/api/sources/detail?source=${encodeURIComponent(p.source)}&sourceId=${encodeURIComponent(p.sourceId)}`, { signal });

/** Never render a swept-up <style>/<script> block as a description. The BFF guards this too. */
const looksCss = (s: string) =>
  s.length > 2500 || /<\/?(?:style|script)\b|\.[a-z][\w-]*\s*[{,]|@import|gtag\(|wp-manga|woocommerce|datalayer/i.test(s);

/**
 * Adding a series, in the app's own dialog.
 *
 * The old one was a hand-rolled div: no `role="dialog"`, no `aria-modal`, no Escape, no focus management,
 * and the page scrolled behind it. `Modal` has all of that, including the fix that stops a dialog closing
 * itself when you type a space into one of its fields.
 *
 * It also did not survive the thing it existed for: after a successful add you got a toast and nothing else.
 * The server returns `folder`, which is the key into `/api/sources/jobs`, so the dialog can stay open and
 * show the real download rather than dismissing itself and hoping.
 */
export function AddSeriesDialog({ seed, sources, mayFollow, onClose, onAdded }: {
  seed: AddSeed;
  /** Which sources to look in. Unscoped, one tap is an outbound request to every source on the server. */
  sources: string[];
  /**
   * Whether this person may have the other sources followed (an admin). The manual follow route and the
   * sheet's × are admin-only, so a member who was shown the switch could follow two sources and never undo
   * it; for them the switch is not rendered and no `alsoFollow` is sent, whatever the device remembers.
   */
  mayFollow: boolean;
  onClose: () => void;
  onAdded: (r: { title: string; folder: string; chapters: number }) => void;
}) {
  const toast = useToast();
  const router = useRouter();
  const qc = useQueryClient();

  const [providers, setProviders] = useState<Provider[] | null>(seed.kind === 'group' ? seed.providers : null);
  const [picked, setPicked] = useState<Provider | null>(
    seed.kind === 'result' ? seed.provider : seed.kind === 'group' && seed.providers.length === 1 ? seed.providers[0] : null,
  );
  // The trending `find` in flight. The detail has its own query below and no longer shares this flag.
  const [loading, setLoading] = useState(false);
  // What the person chose in the chapter <select>, or null for "whatever the detail says is the default".
  // Derived rather than set when the detail lands: a `count === 0` listing used to render one frame with
  // `all` selected and no such option before the effect corrected it, and picking another source now
  // simply clears the choice instead of racing the arrival of the new detail.
  const [pickChoice, setPickChoice] = useState<ChapterPick | null>(null);
  const [autoUpdate, setAutoUpdate] = useState(true);
  // "Archive the rest slowly" (#117). Off until switched on, for every add: the rest of a series is days of
  // fetching, and that is a choice, not a default.
  const [archiveOn, setArchiveOn] = useState(false);
  // The numbering switch (#116): on is "the other reading" -- keep the source's numbers under a strong verdict,
  // number by posting order under a hint. Held for the pick it was flipped on, so picking another source starts
  // from that source's own verdict, derived rather than reset in an effect (the chapter choice's rule).
  const [flippedFor, setFlippedFor] = useState<string | null>(null);
  const pickKey = picked ? `${picked.source}\u0000${picked.sourceId}` : '';
  const flipNumbering = !!pickKey && flippedFor === pickKey;
  const { isAdmin } = useAuth();
  const [adding, setAdding] = useState(false);
  // The duplicate prompt: the server's sentence, and the id of the copy it found -- present only when the
  // server was willing to hand it over, which it is not for a series this account may not open.
  const [dup, setDup] = useState<{ message: string; id?: string } | null>(null);
  // Reading before deciding (#91). Kept in this dialog because everything it needs -- the source, the id on
  // that source, the title -- is resolved here, and the expected end of a preview is this dialog's own Add.
  const [previewing, setPreviewing] = useState(false);
  const [done, setDone] = useState<AddAnswer | null>(null);
  const [opening, setOpening] = useState(false);
  const title = seed.kind === 'result' ? seed.provider.title : seed.title;

  // ---- a language edition (v0.52.0, #72) ----
  // An add can make a language edition of a series already here: a series of its own -- folder, chapters, sources,
  // reading progress -- linked with the one the library has, so the Library keeps one card. The series page starts one
  // from the languages the sources offer (the `edition` seed); Discover's card brings what the library holds
  // (`library`); and the server, answering a duplicate whose source is in a language the library does not hold the
  // title in, brings its offer.
  const edSeed = seed.kind === 'edition' ? seed : null;
  // The languages the sources offer, asked again each time the dialog opens: a MangaDex language switched on in
  // Admin -> Providers a minute ago (its "Turn on more" link below) is a row the next time, not after a reload.
  // Reintroduce by dropping `refetchOnMount`: "the language list is asked again" in addSeriesDialog.test.ts fails.
  const candQ = useQuery({
    queryKey: ['edition-candidates', edSeed?.of],
    queryFn: () => api<EditionCandidates>(`/api/sources/edition-candidates?seriesId=${encodeURIComponent(edSeed!.of)}`),
    enabled: !!edSeed, staleTime: 60_000, refetchOnMount: 'always', retry: false,
  });
  /**
   * The edition seed's language: a code, `unstated` for the sources that do not say theirs, or null for the list.
   * Until the person chooses, the one the dialog was opened on (a follow refused for its language, lib/editions.ts
   * openingLanguage) -- "Other languages" still goes back to the list.
   */
  const [edChoice, setEdPick] = useState<string | null | undefined>(undefined);
  const edPick = edChoice !== undefined ? edChoice : edSeed ? openingLanguage(candQ.data, edSeed) : null;
  // The search in that language: the work's title and other names, on just those sources (the server's budget).
  const edSearch = useQuery({
    queryKey: ['edition-candidates', edSeed?.of, edPick],
    queryFn: () => api<{ providers: Provider[] }>(`/api/sources/edition-candidates?seriesId=${encodeURIComponent(edSeed!.of)}&lang=${encodeURIComponent(edPick!)}`),
    enabled: !!edSeed && !!edPick, staleTime: 5 * 60_000, retry: false,
  });
  /** The server's offer on a duplicate: the same title, in a language the library does not hold it in. */
  const [offer, setOffer] = useState<{ of: string; heldLangs: string[]; lang: string } | null>(null);
  /** The duplicate's "It is in another language": the series the person says this is another edition of. */
  const [anotherOf, setAnotherOf] = useState<string | null>(null);
  // The providers to pick from: the seed's or a trending search's -- or, for an edition, the search in its language.
  const offered = edSeed ? (edSearch.data?.providers ?? null) : providers;
  // What the library holds of the title, and the series an edition joins: the server's offer first (its word), then
  // the person's own "It is in another language", the series page's seed, the card's, a trending search's.
  const findHeld = providers?.find((p) => p.librarySeriesId && p.libraryLangs?.length);
  const held: { of: string; langs: string[] } | null = offer ? { of: offer.of, langs: offer.heldLangs }
    : anotherOf ? { of: anotherOf, langs: [] }
    : edSeed ? { of: edSeed.of, langs: (candQ.data?.held ?? []).map((h) => h.lang) }
    : (seed.kind === 'result' || seed.kind === 'group') && seed.library ? { of: seed.library.seriesId, langs: seed.library.langs }
    : findHeld ? { of: findHeld.librarySeriesId!, langs: findHeld.libraryLangs! }
    : null;
  // Whether this add makes an edition: when the dialog began from one, or the picked provider is in a language the
  // library does not hold the title in. The duplicate prompt's "It is in another language" turns it on for the pick,
  // and "It is a different series" off -- derived per pick, as the numbering switch is.
  const [editionFor, setEditionFor] = useState<{ key: string; on: boolean } | null>(null);
  const asEdition = !!held && (editionFor?.key === pickKey ? editionFor.on : !!edSeed || picked?.inLibrary === false);
  // This copy's language: what its source declares, else the one the dialog began from (for the source a follow was
  // refused for, the language the refusal named), else the server's word in its offer -- and what the person chose for
  // this pick over all of them (lib/editions.ts editionLangPreset). Empty when nobody knows: the add then waits.
  const [edLangFor, setEdLangFor] = useState<{ key: string; lang: string } | null>(null);
  const edLang = edLangFor?.key === pickKey ? edLangFor.lang
    : editionLangPreset({ picked, pick: edPick, seed: edSeed, offer: offer?.lang });
  const needsLang = asEdition && !edLang;
  // The series an edition joins, for its languages when the dialog does not know them yet, and -- for an admin, the
  // only one told whether a language is stated -- "The copy you have is in", asked when it is not.
  const ofQ = useQuery({
    queryKey: ['series', held?.of],
    queryFn: () => api<Series>(`/api/series/${encodeURIComponent(held!.of)}`),
    enabled: asEdition && !!held?.of, staleTime: 60_000, retry: false,
  });
  const heldLangs = held?.langs.length ? held.langs
    : ofQ.data?.edition?.editions?.map((e) => e.lang) ?? (ofQ.data?.lang ? [ofQ.data.lang] : []);
  const askOfLang = isAdmin && ofQ.data?.langStated === false;
  const [ofLangChoice, setOfLangChoice] = useState<string | null>(null);
  const ofLang = ofLangChoice ?? ofQ.data?.lang ?? '';
  /** The server's refusal of the edition: the language is taken, a removed edition holds it, or it must be said. */
  const [edRefusal, setEdRefusal] = useState<{ error: 'edition_exists' | 'edition_hidden' | 'edition_lang'; lang: string; id?: string } | null>(null);

  // ---- also follow the other sources (v0.36.0, #49) ----
  // The candidates are the sources this dialog ALREADY found for the title (a trending search, or the
  // wall's fold): no new search is ever run for them, one per source, the picked one left out, at most six.
  // ⚠️ A `result` seed (a Discover-wall tap on a single-source tile) has no list at all -- `providers` stays
  // null -- so it gets no switch and sends nothing; the series page's Find missing chapters is its way in.
  // Reintroduce by seeding `others` from a search here: every wall tap becomes a fan-out to every source.
  const others = useMemo(() => {
    if (!picked || !offered) return [];
    const seen = new Set<string>([picked.source]);
    const out: Provider[] = [];
    for (const p of offered) {
      if (seen.has(p.source)) continue;
      seen.add(p.source);
      // Another language's provider is that title's other edition, never a backup for this one (v0.52.0): the server's
      // guard refuses to follow it (`language_differs`), so it is not offered as a candidate at all.
      if (p.lang && picked.lang && baseOf(p.lang) !== baseOf(picked.lang)) continue;
      out.push(p);
    }
    return out.slice(0, ALSO_FOLLOW_MAX);
  }, [offered, picked]);
  const [alsoFollow, setAlsoFollowState] = useState<boolean>(() => {
    try { return typeof localStorage !== 'undefined' && localStorage.getItem(ALSO_FOLLOW_KEY) === '1'; } catch { return false; }
  });
  const setAlsoFollow = (v: boolean) => {
    setAlsoFollowState(v);
    try { localStorage.setItem(ALSO_FOLLOW_KEY, v ? '1' : '0'); } catch { /* private mode: the switch still works for this dialog */ }
  };
  // How many candidates rode with the add, so the done step knows whether to look for results on the job
  // card and what "Checking {n} sources" counts. Zero when the switch was off or there was nobody to check.
  const [sentFollow, setSentFollow] = useState(0);

  // Which `find` the state belongs to: a seed that changes under an open dialog must not have the first
  // search's answer land last and win. Only the trending search uses it now; the detail is a keyed query.
  const want = useRef(0);

  useEffect(() => {
    if (seed.kind !== 'trending') return;
    const mine = ++want.current;
    setLoading(true);
    api<{ content: Provider[] }>(`/api/sources/find?q=${encodeURIComponent(seed.title)}&sources=${encodeURIComponent(sources.join(','))}`)
      .then((r) => { if (mine === want.current) { setProviders(r.content); if (r.content.length === 1) setPicked(r.content[0]); } })
      .catch(() => { if (mine === want.current) setProviders([]); })
      .finally(() => { if (mine === want.current) setLoading(false); });
  }, [seed, sources]);

  /**
   * The picked source's series and chapter list, as a query keyed on the source and its id.
   *
   * It was an effect with a request counter, so picking A then B then A again asked the server for A twice
   * and showed "Loading…" both times, and the step after picking a source was the slow one the owner named.
   * Keyed, the second pick is instant, and the pre-warm below can fill the cache before anyone picks at all.
   * The server keeps its own ten-minute cache and joins concurrent requests, so a fresh key costs one round
   * trip and a repeat costs none. `retry: false`: a source that failed is shown as failed, with the way to
   * another source right beside it; retrying would be another twenty-second budget against the same site.
   */
  const detailQ = useQuery({
    // ⚠️ The same shape as the pre-warm's key below, or the pre-warm warms nothing.
    queryKey: ['src-detail', picked?.source, picked?.sourceId],
    queryFn: ({ signal }) => fetchDetail(picked!, signal),
    enabled: !!picked,
    staleTime: DETAIL_STALE_MS,
    retry: false,
  });
  const detail = detailQ.data;
  // The count, range and presets the dialog shows are the numbering the add will use (lib/numbering.ts).
  const view = detail ? addNumberingView(detail, flipNumbering) : null;
  const pick: ChapterPick = pickChoice ?? (detail && detail.count === 0 ? 'none' : 'all');

  // The pre-warm: a group with a choice to make looks up its first two providers as it opens, so by the
  // time a person has read the list and tapped one, the detail is already in the cache (or in flight, and
  // the query above joins it). Two, not all: each is a live request to a site, and the list is ranked, so
  // the first two are where nearly every tap lands. A group of one picks itself and needs no pre-warm.
  useEffect(() => {
    if (seed.kind !== 'group' || seed.providers.length < 2) return;
    for (const p of seed.providers.slice(0, 2)) {
      qc.prefetchQuery({ queryKey: ['src-detail', p.source, p.sourceId], queryFn: ({ signal }) => fetchDetail(p, signal), staleTime: DETAIL_STALE_MS, retry: false });
    }
  }, [seed, qc]);

  // Only while the dialog is showing a live download -- or, since v0.36.0, while an auto-follow it asked
  // for is still being judged: a "nothing yet" add starts no download, but with candidates sent the server
  // leaves a finished job entry on the card carrying `autoFollow`, and this same poll is how the results
  // reach the done step. That poll stops the moment `autoFollow.done` is true; the download case keeps its
  // 2 s rhythm as before.
  const { data: jobs } = useQuery({
    queryKey: ['source-jobs'],
    queryFn: () => api<{ content: Job[] }>('/api/sources/jobs'),
    enabled: !!done && (!done.nothing || sentFollow > 0),
    refetchInterval: (q) => {
      if (!done) return false;
      if (!done.nothing) return 2000;
      const j = (q.state.data?.content ?? []).find((x) => x.folder === done.folder);
      return j?.autoFollow?.done ? false : 2000;
    },
  });
  const job = done ? (jobs?.content ?? []).find((j) => j.folder === done.folder) : undefined;

  // Derived, not stored: the payload, the rate-limit warning and the "latest" hint all read these.
  // `none` sends no count at all -- `chapterFrom: 'none'` is the whole instruction -- and counts as zero
  // for the rate-limit warning, since nothing is grabbed.
  const chapterCount = pick === 'all' || pick === 'none' ? undefined : Number(pick.slice(pick.indexOf(':') + 1));
  const chapterFrom: 'oldest' | 'newest' | 'none' = pick === 'none' ? 'none' : pick.startsWith('latest:') ? 'newest' : 'oldest';
  const count = pick === 'none' ? 0 : chapterCount ?? view?.count ?? 0;
  // What "the rest" is: every listed chapter for Nothing yet, the listing less the pick for First or Latest N,
  // and nothing for All -- the switch is not offered then, nor for a source that lists nothing. Counted in the
  // numbering the add will use (`view`, #116), as the count line and the presets are.
  // Reintroduce by offering it for All: "the archive switch is offered for All" in addSeriesDialog.test.ts.
  const archiveRest = !view || pick === 'all' ? 0 : pick === 'none' ? view.count : Math.max(0, view.count - (chapterCount ?? 0));
  const archiving = archiveOn && archiveRest > 0;
  // The pace comes with the downloads AppShell already polls; the default until it has answered.
  const { data: downloads } = useServerDownloads();
  const perHour = downloads?.archive?.perHour ?? ARCHIVE_PACE.perHour;

  const add = async (force = false) => {
    if (!picked) return;
    setAdding(true); setDup(null); setEdRefusal(null);
    // An edition names the series it joins, its own language when known, and the language of the copy the library
    // has when the dialog asked (bff routes/sources.ts). `force` is "add it on its own", never an edition.
    const editionBody = asEdition && held && !force
      ? { of: held.of, ...(edLang ? { lang: edLang } : {}), ...(askOfLang && ofLang ? { ofLang } : {}) } : undefined;
    // Only the identity of each candidate goes: the server looks each up itself and judges it against the
    // listing it has just written, so a stale title or cover from the search cannot steer the match.
    // Not under posting order: another site's numbers cannot line up with posts numbered 1..K, and the server
    // would refuse every candidate for it anyway.
    const alsoFollowBody = mayFollow && alsoFollow && others.length && !view?.posting ? others.map(({ source, sourceId }) => ({ source, sourceId })) : undefined;
    // `auto` unless the person flipped the switch: the server's own decision stands (lib/numbering.ts addNumbering).
    // Reintroduce by dropping `numbering` here: "Keep the source's numbers" is shown and ignored.
    const numbering = view?.send ?? 'auto';
    try {
      const r = await api<AddAnswer>('/api/sources/add', {
        json: {
          source: picked.source, sourceId: picked.sourceId, chapterCount, chapterFrom, autoUpdate, force, alsoFollow: alsoFollowBody, numbering,
          ...(archiving ? { archive: true } : {}), ...(editionBody ? { edition: editionBody } : {}),
        },
        // The client has never set a timeout anywhere, so the only bound was the proxy's 120s -- which
        // turned a slow-but-working add into "Add failed. Try another source." while the download carried
        // on. The request now answers in seconds, so this is a backstop rather than the usual path. The
        // auto-follow is judged behind the reply too (on the job card), never inside this request.
        signal: AbortSignal.timeout(45_000),
      });
      // The judgement only happens for a series this add acted on: a download, a nothing-yet, or a re-add
      // that found everything on disk (#65) -- that one writes the listing the judgement measures against,
      // so the server mints a carrier card for it exactly as it does for a nothing-yet add. "Already in
      // your library" answers with none of the three and the server does nothing with the candidates.
      setSentFollow(alsoFollowBody && (r.started || r.nothing || r.alreadyHere) ? alsoFollowBody.length : 0);
      setDone(r);
      onAdded(r);
    } catch (e: any) {
      let body: any = {};
      try { body = JSON.parse(e?.body || '{}'); } catch { /* not JSON */ }
      if (body.error === 'duplicate' && body.edition?.of) {
        // The server's offer: this source is in a language the library does not hold the title in. The edition block
        // takes the prompt's place -- "You have it in English. This adds Spanish…" says more than "Add anyway?".
        setOffer(body.edition);
        setEditionFor({ key: pickKey, on: true });
      } else if (body.error === 'duplicate') setDup({ message: body.message || tr('You already have this title.'), id: body.existing?.id });
      else if (body.error === 'edition_exists' || body.error === 'edition_hidden' || body.error === 'edition_lang') {
        setEdRefusal({ error: body.error, lang: body.existing?.lang ?? edLang, ...(body.existing?.id ? { id: body.existing.id } : {}) });
      } else toast(msgOf(e, tr('Add failed. Try another source.')), 'error');
    }
    setAdding(false);
  };

  const openIt = async () => {
    if (!done) return;
    setOpening(true);
    // The id the SERVER gave, always first (#67). The add answers with it whenever it can know it, and on
    // a fresh download it lands on the job card this dialog is already polling, once the first chapter has
    // been scanned in. Either way it names the row this add actually landed on.
    const known = done.seriesId ?? job?.seriesId;
    if (known) {
      qc.invalidateQueries({ queryKey: ['library'] });
      router.push(`/series/?id=${known}`);
      return;
    }
    try {
      // Last resort, and only for a download whose first chapter has not been scanned yet: search by title
      // and accept an EXACT normalised match.
      // ⚠️ Never `?? p.content[0]`. That fallback turned "not found" into a confident wrong navigation --
      // it opened whatever the search happened to return, and two series on the owner's own install
      // normalise to the same title. Library -> Downloads is the honest answer: the add is right there, its
      // cover filling, pointed at by `folder` (v0.49.0). Until then this went to the Offline tab -- this
      // device's copies, where a server download had no business -- and on desktop, which hides that tab,
      // to the library, where nothing showed until the first chapter was in. One view serves both builds now.
      const p = await api<Page<Series>>('/api/series/search', { json: { fullTextSearch: done.title, size: 5 } });
      const hit = p.content.find((s) => normTitle(s.metadata?.title || s.name) === normTitle(done.title));
      qc.invalidateQueries({ queryKey: ['library'] });
      router.push(hit ? `/series/?id=${hit.id}` : downloadsHref(done.folder));
    } catch { router.push(downloadsHref(done.folder)); }
  };

  // ---------------------------------------------------------------- done
  if (done) {
    // What the other sources came to, as the job card reports it. A `result` seed never had a list, so it
    // is pointed at Find missing chapters rather than told "no other source carries it" -- nothing was
    // checked. A list with nobody else on it says exactly that: "none of the sources CHECKED", because a
    // trending search asks the page's budgeted sources and the wall's fold holds whoever listed it lately,
    // never every source. Off switch: nothing to say.
    const af = job?.autoFollow;
    // The three answers this add acted on, and so the three the server may have judged candidates for.
    const fresh = !!done.started || !!done.nothing || !!done.alreadyHere;
    const followBlock = (() => {
      if (seed.kind === 'result') return <p className="text-start text-[11px] text-fog-500">{tr('Other sources: Find missing chapters on the series page.')}</p>;
      if (!offered || !fresh) return null;
      // A member never had the switch, so there are no results to show and nothing was "checked": one dim
      // line naming who can, and where.
      if (!mayFollow) return <p className="text-start text-[11px] text-fog-500">{tr('Other sources: an admin can follow them from Sources & translations.')}</p>;
      if (others.length === 0) return <p className="text-start text-[11px] text-fog-500">{tr('None of the other sources checked lists this title.')}</p>;
      if (!sentFollow) return null;
      if (!af || !af.done) {
        // A download that died before its listing existed has no judgement to wait for.
        if (job?.status === 'error') return null;
        return (
          <p className="text-start text-[11px] text-fog-500" data-auto-follow="checking">
            {sentFollow === 1
              ? tr('Checking this source…')
              : tr('Checking {n} sources — this can take a minute. You can close this; anything followed shows under Sources & translations.', { n: sentFollow })}
          </p>
        );
      }
      if (!af.results.length) return null;
      const followed = af.results.filter((r) => r.followed).length;
      const m = af.results.length;
      return (
        <div className="space-y-1 text-start text-[11px]" data-auto-follow="done">
          {af.results.map((r) => (
            <p key={r.source} className={`break-words ${r.followed ? 'text-emerald-400' : 'text-fog-500'}`}>{autoFollowLine(r)}</p>
          ))}
          <p className="text-fog-300">
            {m === 1
              ? (followed === 1 ? tr('Followed the other source') : tr('Not followed'))
              : tr('Followed {n} of {m}', { n: followed, m })}
          </p>
        </div>
      );
    })();
    // An edition's add (v0.52.0): linked on the answer, or on the job card once its first chapter is scanned in -- or
    // added on its own after all, which is said rather than left for the person to discover in the Library.
    const added = done.edition ?? job?.edition;
    const unlinked = job?.edition?.unlinked ?? done.edition?.unlinked;
    return (
      <Modal title={added ? tr('Edition added') : tr('Added to your library')} onClose={onClose}>
        <div className="space-y-4 text-center">
          <span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-emerald-500/15 text-emerald-400">
            <IcCheck width={26} height={26} />
          </span>
          <div>
            <p dir="auto" className="font-display text-base font-semibold text-fog-50">
              {added ? tr('The {language} edition of {title}', { language: languageName(added.lang), title: done.title }) : done.title}
            </p>
            {unlinked && (
              <p className="mt-1 text-[11px] leading-relaxed text-amber-300" data-edition-unlinked={unlinked}>
                {unlinked === 'taken'
                  ? tr('It was added as a series of its own: another add took the {language} edition a moment earlier.', { language: languageName(added!.lang) })
                  : tr('It was added as a series of its own: the series it was an edition of is no longer in the library.')}
              </p>
            )}
            <p className="mt-0.5 text-sm text-fog-400">
              {/* "Fetching", the server-side word: the chapters land on the server for everyone, which is not
                  what "download" means on this device. `nothing` is a nothing-yet add: no job, no bar.
                  `alreadyHere` is the re-add that found everything on disk (#65) -- before it, that add
                  read "Fetching 1192 chapters" and then downloaded them all over again. */}
              {done.nothing ? tr('Added — new chapters will be fetched as they come out')
                : done.alreadyHere ? tr('All {n} chapters are already in your library', { n: done.alreadyHere })
                : done.chapters > 0 ? fetchingLabel(done.chapters)
                : tr('Already in your library')}
            </p>
          </div>
          {done.chapters > 0 && !done.nothing && (
            <>
              <ProgressBar value={job && job.total ? job.done / job.total : 0.02} />
              <p className="text-xs tabular-nums text-fog-500">{job ? `${job.done}/${job.total}` : '…'}</p>
              {/* v0.40.0: a chapter the picked source could not serve is taken from another followed one,
                  and one that arrived short is saved with placeholders. Both are worth a line under the
                  counter while it runs, in the same words as the downloads pill. */}
              {jobNoteLines(job, (id) => offered?.find((p) => p.source === id)?.name ?? id).map((line, i) => (
                <p key={i} className="text-start text-[11px] leading-relaxed text-fog-400" data-job-note>{line}</p>
              ))}
            </>
          )}
          {/* Where the rest went, when "Archive the rest slowly" was on. */}
          {done.archive && <p className="text-start text-[11px] leading-relaxed text-fog-400" data-archive-outcome={done.archive}>{archiveAddLine(done.archive, !!done.nothing)}</p>}
          {followBlock}
          <div className="flex gap-2">
            <button onClick={onClose} className="btn-ghost flex-1 py-2.5 text-sm">{tr('Done')}</button>
            <button onClick={openIt} disabled={opening} className="btn-accent flex-1 py-2.5 text-sm disabled:opacity-50">
              {tr('Open in library')}
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  // ---------------------------------------------------------------- an edition: which language? (v0.52.0)
  // The series page's "Add a language": one row per language the sources offer, the held ones left out by the
  // server, and the sources that do not say theirs as a row of their own. Nothing is searched until one is chosen.
  if (edSeed && !picked && !edPick) {
    const c = candQ.data;
    return (
      <Modal title={tr('Add a language')} onClose={onClose}>
        <p dir="auto" className="-mt-2 mb-3 truncate text-sm text-fog-400">{edSeed.title}</p>
        {candQ.isLoading ? (
          <div className="skeleton h-28 rounded-xl" />
        ) : candQ.isError ? (
          <p className="py-6 text-center text-sm text-amber-300">{tr('Could not be reached right now.')}</p>
        ) : !c || (!c.languages.length && !c.unstated.length) ? (
          <div className="py-6 text-center text-sm text-fog-500" data-edition-none>
            <p>{tr('None of your sources is in another language yet.')}</p>
            {/* MangaDex in another language is a switch away (Admin → Providers); a member is not sent to a page they cannot open. */}
            {isAdmin && <Link href={MANGADEX_LANGUAGES_HREF} className="mt-2 inline-block text-xs text-accent hover:underline">{tr('Turn on more MangaDex languages in Admin → Providers.')}</Link>}
          </div>
        ) : (
          <>
            <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-fog-500">{tr('Which language?')}</p>
            <div className="divide-y divide-ink-800/70" data-edition-langs>
              {c.languages.map((l) => (
                <button key={l.lang} type="button" onClick={() => setEdPick(l.lang)}
                  className="flex w-full items-center gap-3 px-2.5 py-2.5 text-start hover:bg-ink-800/60">
                  <span className="min-w-0 flex-1 truncate text-sm text-fog-100">{languageName(l.lang)}</span>
                  <span className="shrink-0 text-[11px] text-fog-500">{l.sources.length === 1 ? tr('1 source') : tr('{n} sources', { n: l.sources.length })}</span>
                </button>
              ))}
              {c.unstated.length > 0 && (
                <button type="button" onClick={() => setEdPick('unstated')}
                  className="flex w-full items-center gap-3 px-2.5 py-2.5 text-start hover:bg-ink-800/60">
                  <span className="min-w-0 flex-1 text-sm text-fog-300">{tr('Sources that do not say their language')}</span>
                  <span className="shrink-0 text-[11px] text-fog-500">{c.unstated.length === 1 ? tr('1 source') : tr('{n} sources', { n: c.unstated.length })}</span>
                </button>
              )}
            </div>
            {/* The language wanted may be a MangaDex switch away, with others on already: an admin is told where. */}
            {isAdmin && <Link href={MANGADEX_LANGUAGES_HREF} className="mt-3 inline-block text-[11px] text-fog-500 hover:text-accent">{tr('Turn on more MangaDex languages in Admin → Providers.')}</Link>}
          </>
        )}
      </Modal>
    );
  }

  // ---------------------------------------------------------------- pick a source
  if (!picked) {
    const searching = edSeed ? edSearch.isLoading : loading;
    const inLang = edPick && edPick !== 'unstated' ? languageName(edPick) : null;
    return (
      <Modal title={edSeed ? tr('Add a language') : title} onClose={onClose}>
        {/* The edition's search: what it is a language of, and the way back to the other languages. */}
        {edSeed && (
          <p className="-mt-2 mb-3 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm text-fog-400">
            <span dir="auto" className="min-w-0 truncate">{edSeed.title}</span>
            <button type="button" onClick={() => setEdPick(null)} className="chip py-0.5 text-[11px]">{tr('Other languages')}</button>
          </p>
        )}
        {/* A card for a title the library holds in another language: which, and the way to it. */}
        {!edSeed && held && held.langs.length > 0 && (
          <p className="mb-3 text-xs text-fog-400" data-held-langs>
            {tr('In your library in {languages}.', { languages: held.langs.map(languageName).join(', ') })}{' '}
            <button type="button" onClick={() => { qc.invalidateQueries({ queryKey: ['library'] }); router.push(`/series/?id=${encodeURIComponent(held.of)}`); }}
              className="font-semibold text-accent hover:underline">{tr('Open')}</button>
          </p>
        )}
        {searching ? (
          <p className="py-8 text-center text-sm text-fog-500">{tr('Searching…')}</p>
        ) : edSeed && edSearch.isError ? (
          <p className="py-8 text-center text-sm text-amber-300">{tr('Could not be reached right now.')}</p>
        ) : !offered?.length ? (
          <p className="py-8 text-center text-sm text-fog-500">
            {!edSeed ? tr('Not found on any source yet — try searching manually.')
              : inLang ? tr('Not found in {language}. Try another language.', { language: inLang })
              : tr('Not found there. Try another language.')}
          </p>
        ) : (
          <>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-fog-500">{tr('Available on — pick a source')}</p>
            <div className="space-y-1">
              {offered.map((p, i) => (
                <button key={`${p.source}:${p.sourceId}`} onClick={() => setPicked(p)}
                  className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-start hover:bg-ink-800/60">
                  <Img src={sourceCover(p.source, p.coverUrl)} alt="" fallbackSrc={p.coverUrl}
                    className="h-14 w-10 shrink-0 rounded" />
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-1.5 text-sm text-fog-100">
                      <SourceIcon id={p.source} name={p.name} size={20} />
                      <span className="truncate">{p.name}</span>
                      {/* Its language, as the versions sheet marks a copy's (v0.52.0): which edition picking it adds. */}
                      {p.lang && <span className="shrink-0 rounded border border-ink-700 px-1 text-[10px] leading-4 text-fog-500">{codeLabel(p.lang)}</span>}
                    </span>
                    <span dir="auto" className="block truncate text-[11px] text-fog-500">{p.title}</span>
                  </span>
                  {/* The page's own rank: health first, then what the library actually came from. "Most used"
                      is what that is; "preferred" made it sound like a setting someone had chosen. A provider in a
                      language the library holds says so instead: picking it is the copy you already have. */}
                  {p.inLibrary
                    ? <span className="shrink-0 text-[10px] text-fog-500">{tr('in your library')}</span>
                    : i === 0 && !edSeed && <span className="chip shrink-0 text-[10px]">{tr('most used')}</span>}
                </button>
              ))}
            </div>
          </>
        )}
      </Modal>
    );
  }

  // ---------------------------------------------------------------- options
  const summary = detail?.summary && !looksCss(detail.summary) ? detail.summary : '';
  const presets = CHAPTER_PRESETS.filter((n) => view && n < view.count);
  // The picked provider's own cover until the detail lands, then the detail's: the same picture nearly
  // always, so nothing jumps, and the body paints at once instead of behind a bare "Loading…".
  const coverUrl = detail?.coverUrl ?? picked.coverUrl;

  return (
    // Not dismissable while the request is in flight. Escape or a backdrop click used to unmount the dialog
    // mid-add: the add still completed, but `setDone` and `onAdded` ran against nothing, so there was no
    // confirmation and the tile was never marked as added -- the worst possible version of "did that work?"
    <Modal title={detail?.title || title} onClose={adding ? () => {} : onClose} wide>
      {/* ⚠️ No gate around the body. Everything the pick already knows -- the cover, the source, the way back
          to the other providers, the switches -- renders now; only the count, the groups and the chapter
          <select> wait for the detail, and say so in their own place. A whole-body "Loading…" was the second
          "takes forever" the owner reported, and it hid the Change chip exactly when a slow source made it
          the thing to tap. Reintroduce by wrapping the body in `!detail ? <p>Loading…</p> : …`. */}
      <div className="sm:flex sm:gap-4">
        <div className="mb-3 shrink-0 sm:mb-0 sm:w-40">
          <Img src={sourceCover(picked.source, coverUrl)} alt="" fallbackSrc={coverUrl || undefined}
            className="aspect-[2/3] w-28 rounded-xl border border-ink-700 sm:w-40" />
        </div>
        <div className="min-w-0 flex-1">
          {/* Where it comes from, named with its favicon, before anything else about it -- and the way
              back to the other providers as a small chip, only when there are any. */}
          <p className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fog-500">
            <span className="inline-flex items-center gap-1.5">
              {tr('From')}
              <SourceIcon id={picked.source} name={picked.name} size={16} />
              <span className="text-fog-200">{picked.name}</span>
            </span>
            {((offered && offered.length > 1) || !!edSeed) && (
              <button type="button" onClick={() => { setPicked(null); setPickChoice(null); }} className="chip py-0.5 text-[11px]">
                {tr('Change')}
              </button>
            )}
          </p>
          {detail && view ? (
            <p className="text-xs text-fog-500" data-detail-count>
              {view.count} {view.count === 1 ? tr('chapter') : tr('chapters')}
              {view.first != null && view.last != null && <> · {numLabel(view.first)}–{numLabel(view.last)}</>}
            </p>
          ) : detailQ.isError ? (
            // The picker's own words for a source that did not answer; Change is right above it.
            <p className="text-xs text-amber-300" data-detail="failed">{tr('Could not be reached right now.')}</p>
          ) : (
            <p className="text-xs text-fog-500" aria-live="polite" data-detail="loading">{tr('Loading chapter list…')}</p>
          )}
          {/* A new language for a title the library has (v0.52.0): before the chapters, because it changes what the
              add is. Rendered from the pick, like the switches: nothing in it waits for the chapter list. */}
          {asEdition && held && (
            <EditionNotice title={title} held={heldLangs} lang={edLang} onLang={(l) => setEdLangFor({ key: pickKey, lang: l })}
              askOfLang={askOfLang} ofLang={ofLang} onOfLang={setOfLangChoice} refusal={edRefusal} busy={adding}
              onOpen={(sid) => { qc.invalidateQueries({ queryKey: ['library'] }); router.push(`/series/?id=${encodeURIComponent(sid)}`); }}
              onAlone={() => { setEditionFor({ key: pickKey, on: false }); void add(true); }} />
          )}
          {detail && (<>
            {detail.numbering && view!.offer && (
              <AddNumberingNotice n={detail.numbering} count={detail.count} view={view!} flipped={flipNumbering} sourceName={picked.name || picked.source}
                admin={isAdmin} onFlip={(v) => { setFlippedFor(v ? pickKey : null); setPickChoice(null); }} />
            )}
            {/* The series page's Translated by section, compressed to what fits a dialog: the five busiest
                groups and their rhythm, so "is this being translated" is answered before the add, not after.
                No controls -- there is no series to set preferences on yet. */}
            {!!detail.groups?.length && (
              <div className="mt-1.5">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-fog-500">{tr('Translated by')}</p>
                {[...detail.groups].sort((a, b) => b.releases - a.releases).slice(0, 5).map((g) => {
                  const cadence = cadenceText(g.cadence, g.lastReleaseAt);
                  // The twelve-week strip when there is anything to draw (lib/activity.ts says when there is
                  // not: an older server, or a group silent for twelve weeks -- every group of a finished
                  // series), else words: the quiet sentence, amber only while the series is still running,
                  // or when the last release was.
                  const weeks = weeksOf(g);
                  const status = activityStatus(g, detail.status);
                  return (
                    // ⚠️ No `truncate` here, and the rhythm on its own line. The column is ~290 px even on a
                    // desktop, and one truncated line cut exactly the words this block exists for: "quiet
                    // -- no release in 100 ..." lost the day count, "ships weekly · last release ..." lost
                    // when. The name still gets a `title` in case it is the long part. Reintroduce by
                    // putting the cadence back on the first line with `truncate`: the day count is gone.
                    <div key={g.name} className="mt-0.5 text-[11px] text-fog-500">
                      <p className="flex flex-wrap items-center gap-x-1.5 break-words">
                        <GroupAvatar name={g.name} size={16} />
                        <span className="text-fog-300" title={g.name}>{g.name}</span>
                        <span>· {g.releases === 1 ? tr('1 release') : tr('{n} releases', { n: g.releases })}</span>
                      </p>
                      {weeks ? (
                        <p className="mt-0.5"><ActivityDots weeks={weeks} status={status} label={cadence || g.name} /></p>
                      ) : g.cadence.quiet ? (
                        <p className={`break-words ${status === 'quiet' ? 'text-amber-300' : ''}`}>{cadence}</p>
                      ) : g.lastReleaseAt ? (
                        <p>{tr('last release {ago}', { ago: relativeTime(g.lastReleaseAt) })}</p>
                      ) : null}
                    </div>
                  );
                })}
                {(detail.versions ?? 0) > 0 && (
                  <p className="mt-0.5 text-[11px] text-fog-500">{detail.versions === 1 ? tr('1 chapter has more than one version') : tr('{n} chapters have more than one version', { n: detail.versions ?? 0 })}</p>
                )}
              </div>
            )}
            {detail.genres.length > 0 && (
              <p className="mt-1 line-clamp-1 text-[11px] text-fog-500">{detail.genres.slice(0, 4).join(' · ')}</p>
            )}
            {summary && <p className="mt-2 line-clamp-4 text-xs leading-relaxed text-fog-400">{summary}</p>}

            {/* "Fetch now", not "download": the chapters land on the server, and the server side of the app
                is called fetching everywhere else. With nothing listed, "Nothing yet" is the only option that
                can succeed, so it is the only one offered. */}
            <label className="mb-1 mt-4 block text-xs font-semibold uppercase tracking-wider text-fog-500">{tr('Chapters to fetch now')}</label>
            <select value={pick} onChange={(e) => setPickChoice(e.target.value as ChapterPick)} className="field">
              {view!.count > 0 && <option value="all">{tr('All ({n})', { n: view!.count })}</option>}
              {presets.map((n) => <option key={`first:${n}`} value={`first:${n}`}>{tr('First {n}', { n })}</option>)}
              {presets.map((n) => <option key={`latest:${n}`} value={`latest:${n}`}>{tr('Latest {n}', { n })}</option>)}
              <option value="none">{tr('Nothing yet — pick chapters later')}</option>
            </select>
            {pick === 'none' ? (
              <p className="mt-1.5 text-[11px] text-fog-500">
                {tr('Nothing is fetched now. New chapters arrive with auto-update; older ones can be fetched from the series page.')}
              </p>
            ) : chapterFrom === 'newest' && (
              <p className="mt-1.5 text-[11px] text-fog-500">
                {tr('Older chapters are not fetched by auto-update; fetch them from the series page when you want them.')}
              </p>
            )}
            {/* The rest of the series, a chapter at a time over nights or days (#117). Under the pick it
                completes, with how many, which way and about how long; never for All, which leaves no rest. */}
            {archiveRest > 0 && (
              <div className="mt-3" data-archive-rest>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm text-fog-200">{tr('Archive the rest slowly')}</span>
                  <Switch on={archiveOn} onChange={setArchiveOn} label={tr('Archive the rest slowly')} />
                </div>
                <p className="mt-1 text-[11px] leading-relaxed text-fog-500">
                  {archiveSwitchHelp(pick === 'none' ? 'none' : chapterFrom === 'newest' ? 'latest' : 'first', archiveRest, perHour)}
                </p>
              </div>
            )}
          </>)}

          {/* The switches depend on nothing the detail brings, so they are there from the first paint. */}
          <div className="mt-3 flex items-center justify-between gap-3">
            <span className="text-sm text-fog-200">{tr('Auto-update new chapters')}</span>
            <Switch on={autoUpdate} onChange={setAutoUpdate} label={tr('Auto-update new chapters')} />
          </div>

          {/* Only for an admin, and only when the dialog holds other sources for this title (a trending
              search, a wall fold). The helper leads with why anyone would: the benefit is the reason #49
              was filed. "Up to two per series" is the total, not two of these. */}
          {mayFollow && others.length > 0 && view?.posting && (
            <p className="mt-3 text-[11px] text-fog-500" data-also-follow="posting_order">
              {tr('Other sources are not followed for a series numbered by posting order: their chapter numbers do not line up.')}
            </p>
          )}
          {mayFollow && others.length > 0 && !view?.posting && (
            <div className="mt-3" data-also-follow>
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm text-fog-200">{tr('Also check the other sources that carry this title')}</span>
                <Switch on={alsoFollow} onChange={setAlsoFollow} label={tr('Also check the other sources that carry this title')} />
              </div>
              <p className="mt-1 text-[11px] text-fog-500">
                {tr('Following one means new chapters are taken from whichever source has them first. Each is checked against this title\'s chapter list — only a source listing at least 90 % of the same numbers is followed, up to two per series.')}
              </p>
            </div>
          )}

          {count > 40 && (
            <p className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-300">
              {tr('Grabbing many chapters at once can get you rate-limited. It pauses on its own and you can resume later.')}
              {/* The gentle way to the same chapters, where there is a smaller pick to make. */}
              {presets.length > 0 && <> {tr('Or fetch fewer now and archive the rest slowly.')}</>}
            </p>
          )}
          {/* The duplicate prompt. "Open it" is offered only when the server sent the id -- it withholds
              one for a series this account may not see, and the note still reads the same without it. */}
          {dup && (
            <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-300">
              <p>{dup.message}</p>
              {dup.id && (
                <button
                  onClick={() => { qc.invalidateQueries({ queryKey: ['library'] }); router.push(`/series/?id=${dup.id}`); }}
                  className="mt-1 font-semibold underline underline-offset-2">
                  {tr('Open it')}
                </button>
              )}
              {/* v0.52.0: the way out for a site that does not say its language, or says the wrong one -- this copy
                  becomes another language edition of the series named, and the edition block asks which language. */}
              {dup.id && (
                <button type="button" data-another-language
                  onClick={() => { setAnotherOf(dup.id!); setEditionFor({ key: pickKey, on: true }); setEdLangFor({ key: pickKey, lang: '' }); setDup(null); }}
                  className="ms-3 mt-1 font-semibold underline underline-offset-2">
                  {tr('It is in another language')}
                </button>
              )}
            </div>
          )}

          {/* Disabled until the chapter list is here: the count and the from/none choice go in the request. */}
          <button onClick={() => add(!!dup && !asEdition)} disabled={adding || !detail || needsLang} className="btn-accent mt-4 w-full py-2.5 text-sm disabled:opacity-50">
            {adding ? tr('Working…')
              : asEdition ? (edLang ? tr('Add the {language} edition', { language: languageName(edLang) }) : tr('Choose its language'))
              : dup ? tr('Add anyway') : tr('Add to library')}
          </button>
          {/* Whether a title is worth keeping is usually one chapter's worth of question; this answers it and
              leaves nothing behind. Every source, extensions included: the server fetches the pages itself. */}
          {picked && (
            <button type="button" onClick={() => setPreviewing(true)}
              className="mt-2 w-full rounded-full border border-ink-700 py-2.5 text-sm text-fog-300">
              {tr('Read a chapter first')}
            </button>
          )}
        </div>
      </div>
      {previewing && picked && (
        <PreviewReader
          source={picked.source}
          sourceName={picked.name || picked.source}
          sourceId={picked.sourceId}
          title={picked.title || title}
          onClose={() => setPreviewing(false)}
          canAdd={!adding && !!detail && !needsLang}
          onAdd={() => { if (adding || !detail || needsLang) return; setPreviewing(false); void add(!!dup && !asEdition); }}
        />
      )}
    </Modal>
  );
}

/**
 * The add dialog's edition block (v0.52.0, #72): this copy becomes a language edition of the series the library has --
 * a series of its own, with its own chapters, folder and reading progress, under the Library's one card for the work.
 * A text block with an accent start-edge rule, as the numbering notice is. The language this copy is in is prefilled
 * from what its source declares and required when it declares nothing; the language of the copy the library has is
 * asked only when that one does not state it. "It is a different series" is the way out of all of it.
 */
function EditionNotice({ title, held, lang, onLang, askOfLang, ofLang, onOfLang, refusal, busy, onOpen, onAlone }: {
  title: string;
  /** The languages the library holds the title in, as codes. */
  held: string[];
  /** This copy's language, or '' while nobody has said. */
  lang: string;
  onLang: (l: string) => void;
  askOfLang: boolean;
  ofLang: string;
  onOfLang: (l: string) => void;
  refusal: { error: 'edition_exists' | 'edition_hidden' | 'edition_lang'; lang: string; id?: string } | null;
  busy: boolean;
  onOpen: (seriesId: string) => void;
  onAlone: () => void;
}) {
  const choices = languageChoices([lang, ofLang, ...held], languageName);
  const have = held.map(languageName).join(', ');
  return (
    <div data-add-edition className="mt-2 border-s-2 border-accent/60 bg-accent/5 py-2 pe-2.5 ps-2.5">
      <p dir="auto" className="text-[12px] font-semibold text-fog-100">{tr('A new language for {title}', { title })}</p>
      <p className="mt-0.5 text-[11px] leading-relaxed text-fog-400">
        {have && lang
          ? tr('You have it in {languages}. This adds {language} as a separate edition, with its own chapters, folder and reading progress. The Library keeps one card for both.', { languages: have, language: languageName(lang) })
          : tr('This adds it as a separate edition, with its own chapters, folder and reading progress. The Library keeps one card for both.')}
      </p>
      <label className="mt-2 block text-[11px] text-fog-400">
        <span className="mb-0.5 block">{tr('This one is in')}</span>
        <select value={lang} onChange={(e) => onLang(e.target.value)} className="field" required aria-invalid={!lang || undefined}>
          {!lang && <option value="">{tr('Choose a language')}</option>}
          {choices.map((c) => <option key={c} value={c}>{languageName(c)}</option>)}
        </select>
      </label>
      {askOfLang && (
        <label className="mt-2 block text-[11px] text-fog-400">
          <span className="mb-0.5 block">{tr('The copy you have is in')}</span>
          <select value={ofLang} onChange={(e) => onOfLang(e.target.value)} className="field">
            {choices.map((c) => <option key={c} value={c}>{languageName(c)}</option>)}
          </select>
        </label>
      )}
      {refusal && (
        <p className="mt-2 text-[11px] leading-relaxed text-amber-300" data-edition-refusal={refusal.error}>
          {refusal.error === 'edition_lang' ? tr('Choose the language this one is in.')
            : refusal.error === 'edition_hidden'
              ? tr('A removed edition holds {language}. Put it back under Admin → Library, or forget it.', { language: languageName(refusal.lang) })
              : tr('It is already in your library in {language}.', { language: languageName(refusal.lang) })}
          {refusal.error === 'edition_exists' && refusal.id && (
            <button type="button" onClick={() => onOpen(refusal.id!)} className="ms-2 font-semibold underline underline-offset-2">{tr('Open it')}</button>
          )}
        </p>
      )}
      <button type="button" onClick={onAlone} disabled={busy} className="mt-2 text-start text-[11px] text-fog-400 underline underline-offset-2 hover:text-fog-200 disabled:opacity-50">
        {tr('It is a different series. Add it on its own.')}
      </button>
    </div>
  );
}

/**
 * The add dialog's numbering notice (#116): shown only when the detector has something to say and there is another
 * reading to switch to. Under a STRONG verdict the add numbers the posts by posting order -- "226 chapters instead
 * of 13 numbers with versions" -- and the switch keeps the source's numbers; under a HINT it offers posting order.
 * A text block with an accent start-edge rule, not a badge.
 */
function AddNumberingNotice({ n, count, view, flipped, sourceName, admin, onFlip }: {
  n: DetailNumbering;
  /** The detail's own count: the reading the server applies unless the switch is flipped. */
  count: number;
  view: ReturnType<typeof addNumberingView>;
  flipped: boolean;
  sourceName: string;
  admin: boolean;
  onFlip: (v: boolean) => void;
}) {
  const strong = view.offer === 'keep';
  // The two readings side by side, whichever is shown: posts counted one by one, numbers with their versions.
  const posts = strong ? count : n.alt!.count;
  const numbers = strong ? n.alt!.count : count;
  const big = n.biggest;
  return (
    <div data-add-numbering={strong ? 'strong' : 'hint'} className="mt-2 border-s-2 border-accent/60 bg-accent/5 py-2 pe-2.5 ps-2.5">
      {/* The reading the add will use, as the counts are: switched to the source's numbers, it no longer says
          "Numbered by posting order" above its own switch (the e2e walk's shot). */}
      <p className="text-[12px] font-semibold text-fog-100" data-add-numbering-heading>{addNoticeHeading(view)}</p>
      <p className="mt-0.5 text-[11px] leading-relaxed text-fog-400">
        {strong
          ? (big && big.posts > 1
            ? tr('{source} gives many different posts the same chapter number ({posts} posts are all numbered {number}).', { source: sourceName, posts: big.posts, number: numLabel(big.number) })
            : tr('{source} gives many different posts the same chapter number.', { source: sourceName }))
          : tr('If they are different chapters rather than versions of one, number them by posting order.')}
      </p>
      {/* The two readings side by side, whichever the switch shows: the count the add lands, and the other. */}
      {strong && (
        // Counted in words ("226 chapters by posting order"): a bare "Posting order: 226" read as a position.
        <p className="mt-0.5 text-[11px] tabular-nums text-fog-300" data-add-numbering-counts data-posts={posts} data-numbers={numbers}>
          {posts === 1
            ? tr('1 chapter by posting order · {m} by the source’s own numbers', { m: numbers })
            : tr('{n} chapters by posting order · {m} by the source’s own numbers', { n: posts, m: numbers })}
        </p>
      )}
      <div className="mt-1.5 flex items-center justify-between gap-3">
        <span className="text-[12px] text-fog-200">{strong ? tr('Keep the source’s numbers') : tr('Number by posting order')}</span>
        <Switch on={flipped} onChange={onFlip} label={strong ? tr('Keep the source’s numbers') : tr('Number by posting order')} />
      </div>
      {admin && n.extSourceId && (
        <Link href={extensionSettingsHref(n.extSourceId)} className="mt-1 inline-block text-[11px] font-medium text-accent hover:underline">{tr('Source settings')}</Link>
      )}
    </div>
  );
}
