// Sentences the server writes that the web shows, as codes the web words in the reader's language (v0.49.1).
//
// Health's summaries, explainers and rows, the header's headline, a download's reason, a refused renumbering: the
// server has always written these in English, and the web printed them as sent -- so an admin reading Uchiyomi in
// Arabic or Japanese read every finding, and every reason a download stopped, in English. Each is now built HERE,
// from a code and what fills it, and goes out twice: the English exactly as it always was (API clients and older
// web builds read that), and beside it the code with its parameters (the `…Said` fields), which web/lib/said.ts
// words. Numbers stay numbers and dates stay ISO strings, so the web says them the reader's way -- in their own
// time zone, where the English keeps the UTC it always printed.
//
// A line of several parts (a summary and its "; 2 ignored", a row's detail, a note's sentences) is a list of
// parts, each saying how it joins the one before it; `english()` joins them the way the server always did, and the
// web joins its translations the way the reader's language punctuates.
//
// ⚠️ A new sentence is a new code HERE and its words in web/lib/said.ts in the same commit: web/test/said.test.ts
// imports this registry, fails by the code's name, and holds the web's English to the English below.
// ⚠️ Pure on purpose -- no db, no env -- so that test can import it. It imports only lib/desktop.ts, which imports
// nothing of ours (a platform's own wording goes through `forDesktop` here, where desktopCopy.test.ts reads both
// arms), and lib/sourceDiagnosis.ts, pure for the same reason.
import { forDesktop } from './desktop';
import { REASONS, STAGE_WORD, type DiagnosisCode } from './sourceDiagnosis';

/** How a part joins the one before it. The first part of a line joins nothing. */
export type Join =
  | 'clause'    // "a; b" -- the default: a summary's tails, a row's clauses
  | 'sentence'  // "a B": the next sentence, first letter raised
  | 'then'      // "a b": the next sentence as it is -- one that opens on a name ("mangapill fails because of it.")
  | 'period'    // "a. B": ends the part before it
  | 'dash'      // "a — b"
  | 'dashCap'   // "a — B"
  | 'paren'     // "a (b)"
  | 'colon'     // "a: b"
  | 'dot';      // "a · b" -- v0.53.0, Source health's summary: two counts side by side, neither a clause of the other

export type Param = string | number | boolean | null | string[] | number[];

/** A sentence as it goes on the wire: its code, what fills it, and how it joins the part before it. */
export interface Said {
  code: string;
  params?: Record<string, Param>;
  join?: Join;
}

/** One part of a line, as the server builds it: its Said and its English. `text` never goes on the wire. */
export interface Part extends Said {
  text: string;
}

const s = (n: number, one: string, many: string) => (n === 1 ? one : many);
/** The date part of an ISO timestamp, as the English always printed it (UTC). */
const day = (iso: string) => new Date(iso).toISOString().slice(0, 10);
/** "2026-09-23 14:20", UTC, as the English always printed a moment. */
const minute = (iso: string) => new Date(iso).toISOString().slice(0, 16).replace('T', ' ');

/** A stage of a source (lib/sourceEvidence.ts Stage), as the English names it. */
type StageName = 'search' | 'chapters' | 'pages' | 'images';
const STAGE_LABEL: Record<StageName, string> = { search: 'Search', chapters: 'Chapter list', pages: 'Page list', images: 'Images' };

/**
 * " (v3.4.6)" for FlareSolverr, whose versions are numbers; the desktop helper's is `uchiyomi-desktop-0.44.0`,
 * deliberately not semver-shaped (desktop/src/solver/server.ts), and read "vuchiyomi-desktop-…" with the v.
 */
export function solverVersionLabel(version?: string | null): string {
  if (!version) return '';
  return ` (${/^\d/.test(version) ? 'v' : ''}${version})`;
}
/** The engine's version as its Health row says it: " (v2.3.2243)". */
const engineVersion = (v?: string | null) => (v ? ` (v${v.replace(/^v/i, '')})` : '');
/**
 * A language code as English names it ("es-419" is "Latin American Spanish"), the name the web's languageName gives in
 * English; the code itself where Intl cannot. The web says it in the reader's language.
 */
const langName = (code: string) => {
  try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code; } catch { return code; }
};
/** Up to five names, then how many more: "Manga Ball, MangaDex and 3 more". */
const names = (list: string[], more: number) => list.join(', ') + (more > 0 ? ` and ${more} more` : '');
/** Where a census reason found the walk's trouble: this folder, or one above it ('' is the downloads folder). */
const where = (above: string | null | undefined) => (above == null ? 'the folder' : `"${above || 'the downloads folder'}", above it,`);
/** What a loop in the walk led back to (lib/library.ts findSeriesDirs). */
const loopedTo = (ancestor: string | undefined, detail: string | undefined) =>
  ancestor !== undefined ? `the same folder as ${ancestor ? `"${ancestor}"` : 'the root'}, reached again through a mount` : detail ?? '';
const statusWord = (status: string) => (status === 'rate_limited' ? 'rate-limiting' : status === 'blocked' ? 'blocking' : 'unreachable for');

/**
 * Every sentence, by code. Each takes its parameters as ONE destructured object (the web's test reads their names
 * from here to fill them), or none.
 */
const EN = {
  // ---- as sent: a string the server has no code for (a Diagnosis written without one). The web shows it as is.
  text: ({ text }: { text: string }) => text,

  // ---- shared by the checks
  ignored: ({ n }: { n: number }) => `${n} ignored`,
  hidden: ({ n }: { n: number }) => `${n} more not shown.`,
  folder: ({ root, folder }: { root: string; folder: string }) =>
    `${root === 'downloads' ? 'Downloads' : 'Library'} / ${folder || '(the folder itself)'}`,
  roots: ({ library, downloads }: { library: string | null; downloads: string | null }) =>
    `${[...(library ? [`Library: ${library}`] : []), ...(downloads ? [`Downloads: ${downloads}`] : [])].join(' · ')}.`,

  // ---- Chapter gaps
  'gaps.live': ({ n }: { n: number }) => `${n} series ${s(n, 'has', 'have')} missing chapters`,
  'gaps.none': () => 'No gaps that need attention',
  'gaps.quiet': ({ n }: { n: number }) => `${n} already looked into`,
  'gaps.archiving': ({ n }: { n: number }) => `${n} being archived slowly`,
  'gaps.note': () =>
    'Gaps are normal when a source skipped a number or a series is still being downloaded. "Fill now" runs the ' +
    'repair\'s gap search for one series: it looks for another source that carries our numbering on both sides of ' +
    'the hole, follows it and fetches. A series it has already asked about is greyed with what it found.',
  'gaps.detail': ({ n, ranges }: { n: number; ranges: string }) => `${n} missing — ${ranges}`,
  // v0.55.0: holes below a series' "Latest N" start (lib_series.chapter_floor), which nothing fetches unasked. `start` is
  // the first chapter the series was started from.
  'gaps.belowFloor': ({ n, start, ranges }: { n: number; start: number; ranges: string }) =>
    `${n} missing before where you started (chapter ${start}) — ${ranges}`,
  'gaps.alsoBelowFloor': ({ n, start }: { n: number; start: number }) => `${n} more before where you started (chapter ${start})`,
  'gaps.beforeStart': ({ n }: { n: number }) => `${n} before where you started`,

  // ---- Chapter numbering (#116). `name` null: the source could not be named at all.
  'numbering.live': ({ n }: { n: number }) => `${n} series ${s(n, 'waits', 'wait')} for a numbering review`,
  'numbering.none': () => 'No numbering change waits for a review',
  'numbering.lately': ({ n }: { n: number }) => `${n} numbered by posting order lately`,
  'numbering.note': () =>
    'Some sources give many different posts the same chapter number (Webtoons numbers a post by the episode it belongs ' +
    'to). A new series from such a source is numbered by posting order; one already in your library is renumbered only ' +
    'when you confirm its plan, and downloads nothing until then. Renaming keeps every file, and reading progress stays ' +
    'with its chapter. "Keep the source\'s numbers" records your choice; the source\'s own "Use sequential chapter numbering" ' +
    'setting, under Admin → Sources, is the other way out.',
  'numbering.shared': ({ name, extras, posts }: { name: string | null; extras: number; posts: number }) =>
    `${name ?? 'Its source'} gives ${extras} of ${posts} posts a number another post has`,
  'numbering.sharedMost': ({ name, extras, posts, most, number }: { name: string | null; extras: number; posts: number; most: number; number: number }) =>
    `${name ?? 'Its source'} gives ${extras} of ${posts} posts a number another post has (${most} are all ${number})`,
  'numbering.sharedMany': ({ name }: { name: string | null }) => `${name ?? 'Its source'} gives many different posts the same number`,
  'numbering.interrupted': () => 'A renumber was interrupted before it finished; the next check of this series finishes it.',
  'numbering.applying': () => 'Its confirmed renumber is being applied now.',
  // "its source" mid-sentence; "Its source" only where it opens one (the three above).
  'numbering.remap': ({ name }: { name: string | null }) =>
    `An extension setting changed ${name ?? 'its source'}'s chapter numbers; the chapters on disk wait to be matched to the new ones.`,
  'numbering.reviewWaits': () => 'numbering them by posting order waits for your review.',
  'numbering.askedWaits': () => 'Numbering by posting order, as asked, waits to be applied.',
  'numbering.sourceWaits': ({ name }: { name: string | null }) => `Going back to ${name ?? 'its source'}'s own numbers waits to be applied.`,
  'numbering.since': ({ at }: { at: string }) => `numbered by posting order since ${day(at)}.`,
  'numbering.hint': () => 'they may be different chapters listed as versions of one.',
  'numbering.kept': () => "you chose to keep the source's own numbers.",
  'numbering.held': () => 'Nothing downloads for this series until then.',

  // ---- Suspiciously short chapters
  'short.live': ({ n }: { n: number }) => `${n} chapter${s(n, '', 's')} contain only one or two images`,
  'short.none': () => 'No truncated chapters found',
  'short.quiet': ({ n }: { n: number }) => `${n} confirmed short at the source`,
  'short.note': () =>
    'Counted nightly by the repair task, which opens the chapter files nobody has read yet, so this is no longer ' +
    'limited to chapters someone has opened. Half-chapters are excluded since author notices really are one page. ' +
    '"Fix" replaces the chapter only if another source has a longer copy; "It\'s fine" records that it really is ' +
    'this short, and the nightly stops looking at it.',
  'short.detail': ({ number, pages }: { number: number; pages: number }) => `Chapter ${number} has ${pages} page${s(pages, '', 's')}`,

  // ---- Chapters that would not download
  'failures.live': ({ n, m }: { n: number; m: number }) => `${n} chapter${s(n, '', 's')} across ${m} source${s(m, '', 's')} keep failing`,
  'failures.none': () => 'Every attempted chapter landed',
  'failures.note': ({ cap }: { cap: number }) =>
    'One entry per source, counting chapters still missing after an attempt and how often each has been tried. ' +
    `They clear themselves the moment the chapter lands. After ${cap} failed tries the nightly sweep leaves a chapter alone ` +
    'until the nightly repair gives it another chance a week later; "Retry now" does that for this source at once, ' +
    'and "Find missing chapters" on the series still fetches it on purpose. ' +
    'A chapter saved with pages missing is listed on its series page and re-tried by the sweep, up to 10 a night.',
  // `status` is the ledger's (lib/chapterFailures.ts): incomplete, error, or the source's own status; `reason` the
  // downloader's own words.
  'failures.detail': ({ n, series, since, tries, capped, cap, title, number, status, reason }: {
    n: number; series: number; since: string; tries: number; capped: number; cap: number;
    title: string; number: number; status: string; reason: string | null;
  }) =>
    `${n} chapter${s(n, '', 's')} in ${series} series since ${day(since)}, tried up to ${tries} time${s(tries, '', 's')}` +
    `${capped ? `, ${capped} left alone after ${cap}` : ''}; ` +
    `latest: "${title}" ch ${number} (${status}${reason ? `: ${reason}` : ''})`,

  // ---- Series that can no longer update. `source` is the series' source id, as the English always printed it.
  'frozen.live': ({ n }: { n: number }) => `${n} series ${s(n, 'has', 'have')} no working source`,
  'frozen.none': () => 'Every series has a working source',
  'frozen.covered': ({ n }: { n: number }) => `${n} lost ${s(n, 'its', 'their')} primary but still follow${s(n, 's', '')} another`,
  'frozen.engineNote': () => 'Series that came from extensions wait for the extension engine; Admin → Sources shows how to bring it back.',
  'frozen.note': () =>
    'These read fine, but nothing can fetch new chapters for them and "find missing chapters" will not offer ' +
    'their own source. Switch the source back on, re-add the extension, or re-point the series at a source that carries it.',
  'frozen.noSource': ({ n }: { n: number }) => `${n} chapters; no source recorded`,
  'frozen.engineDown': ({ n, source }: { n: number; source: string }) =>
    `${n} chapters; its source ${source} can’t be reached because the extension engine isn’t answering`,
  'frozen.engineOff': ({ n, source }: { n: number; source: string }) =>
    `${n} chapters; its source ${source} can’t be reached because the extension engine is off`,
  'frozen.switchedOff': ({ n, source }: { n: number; source: string }) => `${n} chapters; its source ${source} is switched off`,
  // Enabled yet unregistered: dropped by SUWAYOMI_MAX_SOURCES, which the cap check names but a series page cannot see.
  'frozen.overLimit': ({ n, source }: { n: number; source: string }) =>
    `${n} chapters; its source ${source} is ${forDesktop('over the source limit (SUWAYOMI_MAX_SOURCES)', 'over the source limit')}`,
  'frozen.uninstalled': ({ n, source }: { n: number; source: string }) => `${n} chapters; its source ${source} is no longer installed`,
  // v0.52.0 (#123): its source is MangaDex in a language an admin switched off. `lang` is the app code (es-419).
  'frozen.mangadexOff': ({ n, lang }: { n: number; lang: string }) =>
    `${n} chapter${s(n, '', 's')}; MangaDex in ${langName(lang)} is switched off in Admin → Sources`,
  'frozen.following': ({ source, names: followed }: { source: string | null; names: string[] }) =>
    `primary ${source ?? '(none)'} gone; still following ${followed.join(', ')}`,
  // v0.54.0: a main source that is loaded and failing at a step an update needs; `offline` when the failure is the
  // site's own offline notice (lib/sources/offline.ts).
  'frozen.failing': ({ n, source, offline }: { n: number; source: string; offline: boolean }) =>
    `${n} chapter${s(n, '', 's')}; its source ${source} ${offline ? 'says it is offline' : 'is failing'}`,
  // v0.54.0: the main source is loaded but switched off or failing (`state`: off | failing), and a follower carries
  // the series.
  'frozen.followingDown': ({ source, state, names: followed }: { source: string; state: string; names: string[] }) =>
    `primary ${source} ${state === 'off' ? 'switched off' : 'failing'}; still following ${followed.join(', ')}`,

  // ---- Source health (#115). `status` is a SourceStatus code; `stage` a Stage.
  // v0.53.0: the summary counts the card's two groups that need a look, joined by 'dot'; with neither, `sources.unused`
  // while rows are listed for reference (never "all working" over a source nobody could test to the end), else
  // `sources.working`. The five after `sources.unused` are the summary before v0.53.0, no longer sent: a summary an
  // older server stored still carries them (the header reads the last stored report), so they keep their words.
  'sources.affected': ({ n }: { n: number }) => `${n} source${s(n, '', 's')} your series use ${s(n, 'needs', 'need')} a look`,
  'sources.failingUnused': ({ n }: { n: number }) => `${n} source${s(n, ' nothing uses is', 's nothing uses are')} failing`,
  'sources.working': () => 'All sources are working',
  'sources.unused': () => 'Nothing is failing that your library uses',
  'sources.live': ({ n }: { n: number }) => `${n} source${s(n, ' is', 's are')} failing or blocked`,
  'sources.none': () => 'All sources responding normally',
  'sources.off': ({ n }: { n: number }) => `${n} turned off by you`,
  'sources.idle': ({ n }: { n: number }) => `${n} no series use`,
  'sources.unfinished': ({ n }: { n: number }) => `${n} could not finish a test`,
  'sources.note': () =>
    'A source is failing when a Test or the daily check fails at a step (search, chapter list, page list), ' +
    'or when ordinary use fails at the same step three times in a row; downloading images is a step of its own. ' +
    'Only a later success at that same step clears it. Testing never changes a cooldown. ' +
    'A blocked source usually means the site returned 403 or a Cloudflare challenge we could not solve; if several ' +
    'fail at once and all of them mention the solver, check the solver rather than the sites. ' +
    'A cooldown on a source no series uses is listed for reference only, and so is a test that ran out of time.',
  'sources.turnedOff': () => 'turned off by you',
  'sources.expired': ({ status }: { status: string }) => `block expired, will retry on next use (was ${status})`,
  'sources.until': ({ status, until }: { status: string; until: string }) => `${status} until ${minute(until)}`,
  'sources.status': ({ status }: { status: string }) => status,
  'sources.uses': ({ n }: { n: number }) => (n ? `${n} series use it` : 'no series use it'),
  'sources.tested': ({ at, by }: { at: string; by: string | null }) =>
    `last tested ${minute(at)}${by === 'test' ? ' by Test' : by === 'sweep' ? ' by the daily check' : ''}`,
  'sources.failing': ({ stage, since, also }: { stage: StageName; since: string; also: string[] }) =>
    `${STAGE_LABEL[stage]} failing since ${minute(since)}` +
    (also.length ? ` (also ${also.map((x) => STAGE_LABEL[x as StageName].toLowerCase()).join(', ')})` : ''),
  // A diagnosis's reason inside a row (lib/sourceDiagnosis.ts REASONS), as a sentence of its own.
  'sources.reason': ({ diagnosis }: { diagnosis: string }) => {
    const r = REASONS[diagnosis as DiagnosisCode] ?? '';
    return !r || /[.!?]$/.test(r) ? r : `${r}.`;
  },
  'sources.inconclusive': ({ stage }: { stage: StageName }) => `the last test ran out of time while ${STAGE_WORD[stage]} — not proof it is broken`,
  // `at` the failure itself, for the web to say how long ago in the reader's words; `days` the English's count.
  'sources.stale': ({ stage, at: _at, days }: { stage: StageName; at: string; days: number }) =>
    `${STAGE_LABEL[stage]} failed ${days} days ago and nothing has checked it since — test it again`,

  // ---- Duplicate series
  'dupes.live': ({ n }: { n: number }) => `${n} title${s(n, ' appears', 's appear')} to be in the library twice`,
  'dupes.none': () => 'No duplicates found',
  'dupes.note': () =>
    'Detected by two series matching the same AniList entry, so it catches copies added from different ' +
    'sources under different names. Progress tracking works best with one copy of each. Merging is one-way and ' +
    'never automatic: the nightly repair leaves these alone and you confirm each one.',
  'dupes.same': () => 'Same AniList entry',
  'dupes.copies': ({ n }: { n: number }) => `${n} copies — merge them one pair at a time`,
  // v0.52.0 (#72): a pair in two languages. `a` and `b` are language codes; the web names them in the reader's language.
  'dupes.languages': ({ a, b }: { a: string; b: string }) =>
    `The same work in ${langName(a)} and ${langName(b)}: link them as editions rather than merging.`,

  // ---- Impossible chapter numbers
  'outliers.live': ({ n }: { n: number }) => `${n} series ${s(n, 'has', 'have')} chapters numbered far beyond the rest`,
  'outliers.none': () => 'No out-of-range chapters',
  'outliers.note': () =>
    'Catches chapters scraped from a site\'s sidebar widget, which belong to a different series. The parser ' +
    'now guards against this, so anything here predates that fix. Deleting is never automatic and the nightly ' +
    'repair never renumbers: "Delete chapters" removes the files (a bookmarked chapter is skipped), and a ' +
    'wrong number can be corrected on the series page instead.',
  'outliers.detail': ({ n, top, median }: { n: number; top: number; median: number }) =>
    `${n} chapter(s) up to ${top}, but the series sits around ${median}`,

  // ---- The same chapter saved twice (v0.50.0). `numbers` the first five later files, `more` how many besides.
  'twice.live': ({ n }: { n: number }) => `${n} series ${s(n, 'has', 'have')} chapters saved twice, split two ways`,
  'twice.none': () => 'No chapter saved twice',
  'twice.note': () =>
    'Sites split and number a chapter\'s parts differently, and before v0.50.0 an update could download a chapter ' +
    'you had again under another site\'s numbers. Each row names the files that arrived later. Deleting is never ' +
    'automatic: "Delete chapters" removes those files (a bookmarked chapter is skipped), everyone keeps their ' +
    'reading history, and updates do not fetch them back.',
  'twice.detail': ({ n, numbers, more, source }: { n: number; numbers: number[]; more: number; source: string }) =>
    `${n} file${s(n, '', 's')} from ${source} saved again in another split: ${numbers.join(', ')}${more > 0 ? ` and ${more} more` : ''}`,

  // ---- Cloudflare solver. ⚠️ On desktop the helper's address carries its access token: no `url` is sent there.
  'solver.down': ({ url, error }: { url?: string; error: string | null }) =>
    forDesktop(`Not answering at ${url}`, 'Not answering') + (error ? ` (${error})` : ''),
  'solver.downNote': () => forDesktop(
    'Sources on Cloudflare-protected sites cannot work without it. Check the container is running '
      + 'and that FLARESOLVERR_URL points at it.',
    "Sources on Cloudflare-protected sites cannot work without it. Uchiyomi's built-in Cloudflare helper "
      + "isn't answering; quit and reopen Uchiyomi.",
  ),
  'solver.helper': () => 'Cloudflare helper',
  'solver.notAnswering': ({ error }: { error: string | null }) => (error ? `not answering (${error})` : 'not answering'),
  'solver.names': () => 'failing, and its recorded error names the solver',
  'solver.blaming': ({ n }: { n: number }) => `Answering, but ${n} source${s(n, '', 's')} recently failed inside it`,
  'solver.ready': ({ version, latest }: { version: string | null; latest: string | null }) =>
    `Ready${solverVersionLabel(version)}${latest ? ` — v${latest} is available` : ''}`,
  'solver.failingNote': () => forDesktop(
    'It responds, but it has been failing mid-request. Chrome needs far more than Docker\'s default '
    + '64 MB of shared memory (set shm_size: 1gb), and the solver leaks memory, so it wants a restart.',
    'It responds, but it has been failing mid-request; quit and reopen Uchiyomi to restart it.',
  ),
  'solver.behind': () => 'a newer solver is out; Cloudflare changes often break older ones',
  'solver.inside': () => 'its last failure happened inside the solver',

  // ---- Version
  'version.offRunning': ({ version }: { version: string }) => `Running v${version} — update checks are off`,
  'version.off': () => 'Update checks are off',
  'version.offNote': () => 'Nothing is requested while this is off. Turn it on under Settings → Server to be told when a release is out.',
  'version.unknown': () => 'Could not read the running version',
  'version.behind': ({ version, latest }: { version: string; latest: string }) => `Running v${version} — ${latest} is available`,
  'version.current': ({ version }: { version: string }) => `Running v${version} — up to date`,
  'version.running': ({ version }: { version: string }) => `Running v${version}`,
  'version.unasked': () => 'GitHub could not be reached just now, so this is not a clean bill of health.',
  'version.newer': () => 'a newer release is published; see the changelog before upgrading',

  // ---- Extension source limit
  'cap.over': ({ n, cap }: { n: number; cap: number }) => `${n} enabled source${s(n, ' is', 's are')} not registered — over the limit of ${cap}`,
  'cap.unreachable': ({ cap }: { cap: number }) => `engine unreachable at the last load; nothing is registered (limit ${cap})`,
  'cap.inUse': ({ n, cap }: { n: number; cap: number }) => `${n} of ${cap} extension sources in use`,
  'cap.note': () => forDesktop(
    'Every registered source is searched at once, which is why there is a limit. Hiding the languages you do not read ' +
      'is the cheap way under it; SUWAYOMI_MAX_SOURCES raises it.',
    'Every registered source is searched at once, which is why there is a limit. Hide the languages you don\'t read ' +
      'to get under it.',
  ),
  'cap.title': () => forDesktop('SUWAYOMI_MAX_SOURCES', 'Source limit'),
  'cap.detail': ({ n, cap }: { n: number; cap: number }) => forDesktop(
    `${n} enabled sources not registered; the limit is ${cap}. Hide languages you do not read, or raise the limit.`,
    `${n} enabled sources not registered; the limit is ${cap}. Hide the languages you don't read.`,
  ),

  // ---- Library scan (#109). The walk's own findings, from lib/library.ts's WalkIssue.
  'scan.none': () => 'no scan has run since the server started',
  'scan.problems': ({ n, w }: { n: number; w: number }) => {
    const parts = [
      ...(n ? [`could not index ${n} folder${s(n, '', 's')}`] : []),
      ...(w ? [`left out ${w} folder${s(w, '', 's')} or file${s(w, '', 's')} it could not read`] : []),
    ];
    return `the last scan ${parts.join(' and ')}; ${n + w === 1 ? 'its' : 'their'} chapters are on disk but not in the library`;
  },
  'scan.indexed': ({ series, books }: { series: number; books: number }) => `the last scan indexed ${series} series, ${books} chapters`,
  'scan.note': () => 'Runs after every download, sweep and manual scan. Every other folder is still indexed when one fails.',
  'scan.shared': ({ n }: { n: number }) =>
    `${n} folder${s(n, ' shares', 's share')} a disk id with another folder (Unraid user shares and some network drives report ids like this). All of them were scanned; before v0.48.2 each one was skipped, with everything in it.`,
  'scan.removed': ({ n }: { n: number }) =>
    `${n} folder${s(n, ' belongs', 's belong')} to series someone removed, and ${s(n, 'was', 'were')} left alone; Admin → Library puts a series back.`,
  'walk.unreadable': ({ error }: { error: string }) => `could not be read (${error}), so nothing in it is in the library`,
  'walk.failed': ({ error }: { error: string }) => `could not be read (the walk failed: ${error}), so nothing in it is in the library`,
  'walk.stat': ({ error }: { error: string }) => `could not be checked (${error}), so nothing in it is in the library`,
  // `ancestor` '' is the root; without one (a report from before v0.49.1), the walk's own `detail`.
  'walk.loop': ({ ancestor, detail }: { ancestor?: string; detail?: string }) => `not scanned twice: ${loopedTo(ancestor, detail)}`,
  'walk.unchecked': ({ n, names: first }: { n: number; names: string[] }) =>
    `${n} entr${n === 1 ? 'y' : 'ies'} could not be checked: ${first.map((x) => `"${x}"`).join(', ')}${n > 3 ? ', …' : ''}`,
  'walk.depth': ({ n, max }: { n: number; max: number }) =>
    `${n} folder${n === 1 ? ' is' : 's are'} more than ${max} levels deep and ${n === 1 ? 'was' : 'were'} not looked into (LIBRARY_MAX_DEPTH)`,
  'walk.limit': ({ max }: { max: number }) => `the walk stopped after ${max.toLocaleString('en-US')} folders; the rest were not looked into`,

  // ---- Downloads missing from the library (#109)
  'missing.error': ({ error }: { error: string }) => `could not be checked just now: ${error}`,
  'missing.live': ({ n, m }: { n: number; m: number }) =>
    `${n} downloaded chapter${s(n, '', 's')} in ${m} folder${s(m, '', 's')} ${s(n, 'is', 'are')} on disk but not in the library`,
  'missing.unreadable': ({ n }: { n: number }) => `${n} folder${s(n, '', 's')} in the downloads could not be read`,
  'missing.none': ({ checked }: { checked: number }) => `every chapter file in the downloads folder is in the library (${checked} checked)`,
  'missing.compared': ({ root, fs }: { root: string; fs: string | null }) => `Every chapter file under ${root}${fs ? ` (${fs})` : ''}, against the library.`,
  'missing.noScan': () => 'No library scan has run since the server started; Scan now below runs one.',
  'missing.capped': () => 'The last scan stopped at its folder limit, so some folders were never looked into.',
  'missing.pending': ({ n }: { n: number }) => `${n} landed after the last scan began and ${s(n, 'waits', 'wait')} for the next one.`,
  'missing.removed': ({ n }: { n: number }) => `${n} belong${s(n, 's', '')} to series someone removed (Admin → Library puts one back).`,
  'missing.strays': ({ n }: { n: number }) => `${n} folder${s(n, ' holds', 's hold')} files of your own where the scan never reads chapters; listed, not counted.`,
  'missing.truncated': () => 'The folder is too big to check completely; the counts are a floor.',
  'missing.folderUnreadable': ({ error }: { error: string }) => `could not be read (${error})`,
  // `files` the first three names; `cut` whether there are more.
  'missing.files': ({ n, files, cut }: { n: number; files: string[]; cut: boolean }) =>
    `${n} chapter${s(n, '', 's')} not in the library (${files.join(', ')}${cut ? ', …' : ''})`,
  // Why the scan left a downloads folder out (lib/downloadCensus.ts). `above`: the folder the walk's trouble was
  // in, when it is one above this one ('' is the downloads folder itself); absent, this folder.
  'census.loose': () => 'chapter files straight in the downloads folder: only a folder can be a series',
  'census.deep': ({ max }: { max: number }) => `more than ${max} folders deep, and the scan looks no deeper (LIBRARY_MAX_DEPTH)`,
  'census.inside': ({ holder }: { holder: string }) =>
    `inside "${holder}", which the scan reads as a series, and a series' subfolders are not looked into`,
  'census.deleted': ({ n }: { n: number }) =>
    `the library still marks ${n === 1 ? 'it' : `these ${n}`} deleted, and no scan has read ${n === 1 ? 'the file' : 'the files'} since`,
  'census.refused': ({ error }: { error: string }) => `the library refused it: ${error}`,
  'census.unreadable': ({ above, error }: { above?: string | null; error: string }) => `the scan could not read ${where(above)}: ${error}`,
  'census.failed': ({ above, error }: { above?: string | null; error: string }) => `the scan could not read ${where(above)}: the walk failed: ${error}`,
  'census.stat': ({ above, error }: { above?: string | null; error: string }) => `the scan could not check ${where(above)}: ${error}`,
  'census.loop': ({ above, ancestor, detail }: { above?: string | null; ancestor?: string; detail?: string }) =>
    `the scan took ${where(above)} for a loop: ${loopedTo(ancestor, detail)}`,

  // ---- Folders scanned twice (v0.52.0, #134: lib/health.ts foldersScannedTwice). `folder` is where one root sits in
  // the other; `lib` and `dl` the two roots as configured.
  'nested.same': () => 'The downloads folder and the library are one folder, so every downloaded chapter is scanned twice',
  'nested.downloadsInside': ({ folder }: { folder: string }) =>
    `The downloads folder is inside the library, at ${folder}, so every downloaded chapter is scanned twice`,
  'nested.libraryInside': ({ folder }: { folder: string }) =>
    `The library is inside the downloads folder, at ${folder}, so every chapter in it is scanned twice`,
  'nested.byPath': () => 'Their paths put one inside the other.',
  'nested.byScan': () => 'The last library scan read the same files here a second time.',
  'nested.note': ({ lib, dl }: { lib: string; dl: string }) => forDesktop(
    `Uchiyomi scans the library (${lib}) and its downloads folder (${dl}) both, so neither may be inside the other: `
      + 'each downloaded chapter then shows up twice, once in a series with its source and once in a series with none. '
      + 'Mount them side by side, each in a folder of its own, and restart Uchiyomi; then remove the copies with no '
      + 'source. The Volumes section of the install guide shows how.',
    // The desktop app's own words (docs/DESKTOP.md): its "library folder" is the downloads, the reader's is the manga
    // folder they added.
    'Uchiyomi scans its library folder and the manga folder you added both, so neither may be inside the other: each '
      + 'downloaded chapter then shows up twice. Keep the two side by side; then remove the copies with no source.',
  ),

  // ---- The extension engine (#72, lib/engineHealth.ts)
  'engine.waiting': ({ n }: { n: number }) =>
    `${n} series that came from extensions ${s(n, 'keeps its', 'keep their')} chapters and ${s(n, 'gets', 'get')} no new ones until it is back`,
  // Its own words, never a source card's "Turned off": a language that agrees the word with its noun gave the engine a
  // source's gender ("Désactivée", "Desactivada"; the v0.49.1 translation review).
  'engine.switchedOff': () => 'Switched off',
  'engine.notSetUp': () => 'Not set up',
  'engine.offNote': () => 'Admin → Sources shows how to bring it back. Its data is kept while it is off.',
  'engine.fromExtensions': () => 'Series from extensions',
  'engine.notAnswering': ({ error }: { error: string | null }) => `Not answering${error ? ` (${error})` : ''}`,
  'engine.retries': () => 'Uchiyomi asks again every 5 minutes by itself, and its extensions come back without a restart.',
  'engine.reopen': () => 'If it stays this way, quit and reopen Uchiyomi, which starts its extension engine again.',
  'engine.checkAgain': () => 'Admin → Sources shows what to check for your setup, and Check again there asks at once.',
  'engine.notAnsweringTitle': () => 'Not answering',
  'engine.asked': ({ n }: { n: number }) => `asked ${n} ${s(n, 'time', 'times')} since it stopped answering`,
  'engine.noAnswer': () => 'no answer at the last try',
  'engine.registering': () => 'It answers again; its extensions are being registered.',
  'engine.cannotUse': () => 'It cannot use its Cloudflare helper',
  'engine.helper': () => 'Cloudflare helper',
  'engine.helperOff': ({ names: first, more, n }: { names: string[]; more: number; n: number }) =>
    `The engine says its own Cloudflare helper is switched off: ${names(first, more)} ${s(n, 'fails', 'fail')} because of it.`,
  'engine.noSolver': () => 'Uchiyomi has no Cloudflare helper of its own to share yet: set FLARESOLVERR_URL on Uchiyomi, then connect it here.',
  'engine.unreadConnect': () =>
    'Its Cloudflare helper setting could not be read just now. Connect points it at the helper Uchiyomi uses and switches it on; nothing restarts.',
  'engine.unread': () => 'Its Cloudflare helper setting could not be read just now.',
  'engine.unsupportedDesktop': () =>
    'This engine version does not report its Cloudflare setting, so Uchiyomi cannot switch it on from here.',
  'engine.unsupportedServer': () =>
    "This engine version does not report its Cloudflare setting, so Uchiyomi cannot switch it on: set FLARESOLVERR_ENABLED=true and FLARESOLVERR_URL on the engine's own container, or update the engine.",
  'engine.unsupported': () => 'This engine version does not report its Cloudflare setting.',
  'engine.answering': ({ version }: { version: string | null }) => `Answering${engineVersion(version)}`,
  'engine.readyCloudflare': ({ version }: { version: string | null }) => `Ready, and it can get past Cloudflare${engineVersion(version)}`,
  'engine.ready': ({ version }: { version: string | null }) => `Ready${engineVersion(version)}`,
  'engine.otherHelper': () => 'on, through a helper other than Uchiyomi’s own',
  'engine.otherHelperAt': ({ url }: { url: string }) => `on, through ${url} rather than Uchiyomi’s own helper`,
  'engine.localhost': () =>
    'The engine’s own Cloudflare helper is not in use: it points at localhost, where no helper runs. Extension sources on Cloudflare-protected sites fail until it is.',
  'engine.helperIsOff': () =>
    'The engine’s own Cloudflare helper is not in use: it is switched off. Extension sources on Cloudflare-protected sites fail until it is.',
  'engine.failing': ({ names: first, more, n }: { names: string[]; more: number; n: number }) => `${names(first, more)} ${s(n, 'fails', 'fail')} because of it.`,
  'engine.fronted': ({ names: first, more, n }: { names: string[]; more: number; n: number }) => `${names(first, more)} ${s(n, 'is', 'are')} behind Cloudflare.`,
  'engine.notInUse': () => 'Its Cloudflare helper is not in use',
  'engine.readyNotInUse': ({ version }: { version: string | null }) => `Ready${engineVersion(version)}; its Cloudflare helper is not in use`,
  'engine.connectNote': () =>
    'Connect points it at the helper Uchiyomi uses and switches it on; nothing restarts, and it stays that way unless the engine’s own container names another helper.',
  // Connected to Uchiyomi's own helper, which is not answering (v0.49.1): the solver row's ping, read here too.
  'engine.solverQuiet': () => 'Its Cloudflare helper is not answering',
  'engine.readySolverQuiet': ({ version }: { version: string | null }) => `Ready${engineVersion(version)}; its Cloudflare helper is not answering`,
  'engine.solverQuietDetail': () =>
    'It is connected to Uchiyomi’s own Cloudflare helper, which is not answering (the Cloudflare solver row says what to do). Extension sources on Cloudflare-protected sites fail until it answers again.',

  // ---- A download job's reason (Library → Downloads, the series band, Discover). `source` is a source's name.
  'job.noSpace': ({ error }: { error: string }) => `Not enough free space: ${error}`,
  'job.noSpaceToDownload': ({ error }: { error: string }) => `Not enough free space to download: ${error}.`,
  'job.saved': ({ done, total }: { done: number; total: number }) => `${done} of ${total} chapters saved.`,
  'job.slowedDown': ({ from, to }: { from: string; to: string }) => `${from} asked us to slow down — continued from ${to}`,
  'job.switched': ({ from, number, to }: { from: string; number: number; to: string }) =>
    `${from} could not serve chapter ${number} — took it from ${to}`,
  'job.partial': ({ number, n }: { number: number; n: number }) => `Chapter ${number} saved with ${n} page${s(n, '', 's')} missing`,
  'job.stopped': ({ source }: { source: string }) => `${source} stopped part-way`,
  'job.stoppedRefusing': ({ source, status }: { source: string; status: string }) => `${source} stopped part-way: it is ${statusWord(status)} downloads`,
  'job.refusing': ({ source, status }: { source: string; status: string }) => `${source} is currently ${statusWord(status)} downloads.`,
  'job.undownloadable': () => 'No downloadable chapters here — this title may be licensed or hosted externally on this source.',
  'job.failed': ({ n, error }: { n: number; error: string }) => `${n} chapter${s(n, '', 's')} could not be saved: ${error}`,
  'job.cancelled': ({ done, total }: { done: number; total: number }) => `Cancelled after ${done} of ${total} chapter${s(total, '', 's')}.`,
  'job.notSaved': ({ n }: { n: number }) => `${n} could not be saved.`,
  // What lib/downloadCensus.ts notInLibraryReason says: `numbers` the first five, `more` how many besides.
  'job.notInLibrary': ({ n, numbers, more }: { n: number; numbers: number[]; more: number }) =>
    `Chapter${s(n, '', 's')} ${numbers.join(', ')}${more > 0 ? ` and ${more} more` : ''} ${s(n, 'is', 'are')} on disk, but the library scan could not add ${s(n, 'it', 'them')}`,
  'job.healthDetails': () => 'Admin → Health → Downloads missing from the library has the details.',

  // ---- One chapter's download in the activity list (lib/downloadActivity.ts)
  'activity.arrived': ({ n }: { n: number }) => `arrived with ${n} page${s(n, '', 's')} missing`,
  'activity.saved': ({ n }: { n: number }) => `saved with ${n} page${s(n, '', 's')} missing`,
  'activity.notKept': () => 'not kept',

  // ---- A server run's card (lib/downloadJobs.ts endRun)
  'run.failed': () => 'The run failed. The server log has the details.',
  'run.updateFailed': () => 'The update run failed. The server log has the details.',
  'run.repairFailed': () => 'The repair failed. The server log has the details.',
  'run.diskFull': () => 'The library disk is full.',
  'run.chapterLimit': () => "Stopped at this run's chapter limit; the rest wait for the next one.",

  // ---- A renumbering refused or put off (routes/numbering.ts, lib/numbering.ts)
  'renumber.downloading': () => 'Chapters are being fetched for this series. Try again when that ends.',
  'renumber.checking': () => 'This series is being checked right now. Try again when that ends.',
  'renumber.onDisk': ({ file }: { file: string }) => `${file} is already on disk`,
  'renumber.leavesRoot': ({ file }: { file: string }) => `${file}: the path leaves its library root`,
  'renumber.unreachable': () => 'The source did not answer, so there is no plan to show. Try again in a moment.',

  // ---- An extension's settings refused (routes/numbering.ts, lib/sources/suwayomi/prefs.ts). `label` is the
  // setting's own title (the extension's words), or its key.
  'pref.notConfigured': () => 'No extension server is configured.',
  'pref.unknownSource': () => 'The extension server has no such source.',
  'pref.extensionFailed': ({ error }: { error: string }) => `The extension failed: ${error}`,
  'pref.unreachable': () => 'The extension server did not answer. Try again in a moment.',
  'pref.unknown': () => 'This extension has no such setting any more. Reopen its settings.',
  'pref.ambiguous': () => 'This extension lists that setting twice, so Uchiyomi cannot tell which to change.',
  'pref.disabled': ({ label }: { label: string }) => `${label} cannot be changed in this version of the extension.`,
  'pref.onOff': ({ label }: { label: string }) => `${label} takes on or off.`,
  'pref.noChoice': ({ label, value }: { label: string; value: string }) => `${label} has no choice "${value}".`,
  'pref.choices': ({ label }: { label: string }) => `${label} takes a list of its choices.`,
  'pref.text': ({ label }: { label: string }) => `${label} takes text.`,
  'pref.tooLong': ({ label }: { label: string }) => `${label} is too long.`,

  // ---- A follow refused for its language (v0.52.0, #123: routes/admin.ts, the manual follow's backstop). `theirs`
  // and `ours` are language codes: the English names them in English, the web in the reader's language.
  'follow.languageDiffers': ({ theirs, ours }: { theirs: string; ours: string }) =>
    `That source is in ${langName(theirs)} and this series is in ${langName(ours)}. Add it as an edition in ${langName(theirs)} instead: each language keeps its own chapters.`,
  // The same, when the work holds an edition that may follow the source already (`edition` is its language): no new
  // edition is wanted, the follow belongs there.
  'follow.languageDiffersEdition': ({ theirs, ours, edition }: { theirs: string; ours: string; edition: string }) =>
    `That source is in ${langName(theirs)} and this series is in ${langName(ours)}. Follow it on the ${langName(edition)} edition instead.`,

  // ---- Making a followed source a series' main source refused (v0.54.0: lib/mainSource.ts, the Replace run). A busy
  // series says 'renumber.checking'; another language, the follow's own two sentences.
  // Every path that lines two sources up by number refuses a series numbered by posting order (lib/numbering.ts).
  'numbering.postingRefusal': () => 'This series is numbered by posting order, so another source’s chapter numbers do not line up with it.',
  'main.isMain': () => 'That source is already this series’ main source.',
  'main.notFollowed': () => 'This series does not follow that source. Only a source it follows can become its main source.',
  'main.renumberPending': () => 'This series’ chapters are waiting to be renumbered. Review that on the series page first.',
  'main.unavailable': () => 'That source cannot be used right now: it is not installed, it is switched off, or it is not available on this account.',
  'main.moved': () => 'This series’ main source changed meanwhile. Look again.',
  // A source retired, or a site removed, while some series still has it as its main source (v0.54.0, lib/retireSource.ts).
  'retire.inUse': ({ n }: { n: number }) => `It is the main source of ${n} series. Replace it first.`,
};

export type SaidCode = keyof typeof EN;
type Args<C extends SaidCode> = Parameters<(typeof EN)[C]> extends [] ? [] : [params: Parameters<(typeof EN)[C]>[0]];

/** Every code the web must have words for, and its English: web/test/said.test.ts reads this. */
export const SAID_ENGLISH: Readonly<Record<SaidCode, (p: never) => string>> = EN;

/** One part: the sentence `code` says with `params`, in English, and its code for the web. */
export function say<C extends SaidCode>(code: C, ...args: Args<C>): Part {
  const params = args[0] as Record<string, Param | undefined> | undefined;
  const text = (EN[code] as (p?: unknown) => string)(params);
  const sent = clean(params);
  return { code, ...(sent ? { params: sent } : {}), text };
}

/** Params as they go on the wire: an absent value is left out, never sent as `undefined`; none at all, no object. */
function clean(p: Record<string, Param | undefined> | undefined): Record<string, Param> | null {
  if (!p) return null;
  const out: Record<string, Param> = {};
  for (const [k, v] of Object.entries(p)) if (v !== undefined) out[k] = v;
  return Object.keys(out).length ? out : null;
}

/** The same part, joined to the one before it this way. */
export const joined = (join: Join, p: Part): Part => ({ ...p, join });

/**
 * A part built elsewhere -- a Diagnosis's fix (lib/sourceDiagnosis.ts), which keeps its own codes -- from its Said
 * and its English. With no Said, the English as sent (`text`): the web shows it as it is.
 */
export function own(said: Said | null | undefined, text: string): Part {
  return said ? { ...said, text } : say('text', { text });
}

const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const JOIN: Record<Join, (a: string, b: string) => string> = {
  clause: (a, b) => `${a}; ${b}`,
  sentence: (a, b) => `${a} ${cap(b)}`,
  then: (a, b) => `${a} ${b}`,
  period: (a, b) => `${a}. ${cap(b)}`,
  dash: (a, b) => `${a} — ${b}`,
  dashCap: (a, b) => `${a} — ${cap(b)}`,
  paren: (a, b) => `${a} (${b})`,
  colon: (a, b) => `${a}: ${b}`,
  dot: (a, b) => `${a} · ${b}`,
};

type Parts = ReadonlyArray<Part | null | undefined | false>;
const present = (parts: Parts): Part[] => parts.filter((p): p is Part => !!p);

/** The line's English, joined as each part asks: exactly what the server has always written. */
export function english(parts: Parts): string {
  let out = '';
  for (const [i, p] of present(parts).entries()) out = i === 0 ? p.text : JOIN[p.join ?? 'clause'](out, p.text);
  return out;
}

/** What goes on the wire beside the English: every part's Said, without its English. */
export function saids(parts: Parts): Said[] {
  return present(parts).map(({ text: _text, ...said }) => said);
}

/**
 * The English that Saids on the wire say, read back from their codes alone -- what a test holds the English field
 * to, so a code and its sentence can never be sent apart. Null when a part's code is not in this registry (a
 * Diagnosis's fix code, lib/sourceDiagnosis.ts), which only its own English says.
 */
export function englishOf(said: ReadonlyArray<Said> | Said | null | undefined): string | null {
  const list = Array.isArray(said) ? said : said ? [said as Said] : [];
  const parts: Part[] = [];
  for (const s of list) {
    const en = (EN as Record<string, ((p?: unknown) => string) | undefined>)[s.code];
    if (!en) return null;
    parts.push({ ...s, text: en(s.params ?? {}) });
  }
  return english(parts);
}

/** One part's Said, for a field that is one sentence (a title, a fix, a refusal). */
export function saidOf(p: Part): Said {
  const { text: _text, ...said } = p;
  return said;
}

// A Health check's and a row's fields, each with its Said beside it (lib/health.ts, lib/engineHealth.ts).
export const summaryOf = (parts: Parts) => ({ summary: english(parts), summarySaid: saids(parts) });
/** No parts, no note: a check with nothing to explain carries neither field. */
export const noteOf = (parts: Parts) => (present(parts).length ? { note: english(parts), noteSaid: saids(parts) } : {});
export const detailOf = (parts: Parts) => ({ detail: english(parts), detailSaid: saids(parts) });
