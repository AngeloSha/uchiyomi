/**
 * The server's sentences in the reader's language (v0.49.1).
 *
 * Health's summaries, explainers and rows, the header's headline, a source's diagnosis, a download's reason, a
 * refused renumbering or extension setting: the server writes each in English, and the page used to print it as
 * sent, so every finding read in English in all eight languages. The server now sends each with a code and what
 * fills it (bff lib/said.ts, the `…Said` fields), and this words the codes -- numbers counted in pairs, dates and
 * times in the reader's own locale and time zone (the English prints UTC with no zone).
 *
 * A line is a list of parts, each saying how it joins the one before it; they are joined the way the reader's
 * language punctuates ("；" in Japanese and Chinese, "؛" in Arabic). A code this build does not know -- a newer
 * server -- makes the whole line the server's English, never a line half in each.
 *
 * ⚠️ A code added in bff lib/said.ts (or a FixCode, or a DiagnosisCode) needs its words here in the same commit:
 * web/test/said.test.ts reads the server's registry and unions, fails by the code's name, and holds this English to
 * the server's wherever the two are meant to read alike.
 */
import { t as tr } from './i18n';
import { activeLocale, cached, durationText, languageName, relativeTime } from './format';
import { isDesktop } from './desktop';
import { SOURCE_STATUSES, sourceMark, type ProviderStatus } from './status';

/** How a part joins the one before it (bff lib/said.ts Join). */
export type Join = 'clause' | 'sentence' | 'then' | 'period' | 'dash' | 'dashCap' | 'paren' | 'colon' | 'dot';

/** A sentence as the server sends it: its code, what fills it, and how it joins the part before it. */
export interface Said {
  code: string;
  params?: Record<string, unknown>;
  join?: Join;
}

type P = Record<string, unknown>;
const num = (p: P, k: string): number => Number(p[k] ?? 0);
const str = (p: P, k: string): string => (p[k] == null ? '' : String(p[k]));
const strs = (p: P, k: string): string[] => (Array.isArray(p[k]) ? (p[k] as unknown[]).map(String) : []);

// ---- how the reader's language punctuates -------------------------------------------------------------------

/** Japanese and Chinese: full-width marks, and no space between sentences. */
const cjk = (): boolean => /^(ja|zh)/.test(activeLocale());
const arabic = (): boolean => activeLocale() === 'ar';
const intlTag = (): string => `${activeLocale()}-u-nu-latn`;
/** A list's separator: "A, B" / "A、B" / "A، B". */
const listSep = (): string => (cjk() ? '、' : arabic() ? '، ' : ', ');
/**
 * Between two clauses of one sentence, as a comma joins them. A list's mark everywhere but in Chinese, whose "、"
 * separates listed nouns only: a clause there takes "，" (the v0.49.1 translation review). Japanese "、" is the comma
 * of clauses too.
 */
const clauseSep = (): string => (/^zh/.test(activeLocale()) ? '，' : listSep());
const cap = (s: string): string => {
  const first = s.charAt(0);
  try { return first.toLocaleUpperCase(activeLocale()) + s.slice(1); } catch { return first.toUpperCase() + s.slice(1); }
};
/** A name mid-sentence ("also chapter list"), lower-cased -- except in German, which capitalises every noun. */
const midSentence = (s: string): string => {
  if (/^de/.test(activeLocale())) return s;
  const first = s.charAt(0);
  try { return first.toLocaleLowerCase(activeLocale()) + s.slice(1); } catch { return first.toLowerCase() + s.slice(1); }
};

/** Two worded parts, joined the way the reader's language punctuates `how`. */
export function joinPart(a: string, b: string, how: Join | undefined): string {
  switch (how ?? 'clause') {
    case 'clause': return `${a}${cjk() ? '；' : arabic() ? '؛ ' : '; '}${b}`;
    case 'sentence': return `${a}${cjk() ? '' : ' '}${cap(b)}`;
    // A sentence that opens on a name, in English ("mangapill fails because of it."): the name's case is its own.
    case 'then': return `${a}${cjk() ? '' : ' '}${b}`;
    case 'period': return `${a}${cjk() ? '。' : '. '}${cap(b)}`;
    case 'dash': return `${a} — ${b}`;
    case 'dashCap': return `${a} — ${cap(b)}`;
    case 'paren': return cjk() ? `${a}（${b}）` : `${a} (${b})`;
    case 'colon': return `${a}${cjk() ? '：' : ': '}${b}`;
    // v0.53.0: two counts side by side (Source health's summary), the separator the app writes between facts everywhere.
    case 'dot': return `${a} · ${b}`;
  }
  return `${a} ${b}`;
}

// ---- dates, times and numbers the reader's way --------------------------------------------------------------
// Each formatter is built once per language (lib/format.ts `cached`): a Health page says hundreds of these.

const otherYear = (d: Date): boolean => d.getFullYear() !== new Date().getFullYear();

/** "23 Sep" (with the year when it is not this one), in the reader's language. '' for anything not a date. */
export function dayText(iso: unknown): string {
  const d = new Date(String(iso ?? ''));
  if (!Number.isFinite(d.getTime())) return '';
  const year = otherYear(d);
  try {
    return cached(year ? 'said:dayYear' : 'said:day', () =>
      new Intl.DateTimeFormat(intlTag(), { day: 'numeric', month: 'short', ...(year ? { year: 'numeric' } : {}) })).format(d);
  } catch { return d.toLocaleDateString(); }
}

/**
 * "23 Sep, 16:20", in the reader's language AND time zone. The server's English prints the same moment as
 * "2026-09-23 14:20" in UTC with no zone, which read as local time everywhere but Greenwich (#115's source row).
 * Reintroduce `timeZone: 'UTC'`: "the moment is not the reader's" in said.test.ts fails.
 */
export function momentText(iso: unknown): string {
  const d = new Date(String(iso ?? ''));
  if (!Number.isFinite(d.getTime())) return '';
  const year = otherYear(d);
  try {
    return cached(year ? 'said:momentYear' : 'said:moment', () => new Intl.DateTimeFormat(intlTag(), {
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', ...(year ? { year: 'numeric' } : {}),
    })).format(d);
  } catch { return d.toLocaleString(); }
}

const numText = (n: number): string => {
  try { return cached('said:number', () => new Intl.NumberFormat(intlTag())).format(n); } catch { return String(n); }
};

// ---- shared words ------------------------------------------------------------------------------------------

type Stage = 'search' | 'chapters' | 'pages' | 'images';
/** A stage as a noun (lib/sourceEvidence.ts STAGE_LABELS: 'Search step', never the search button's verb). */
const stageName = (s: unknown): string =>
  s === 'chapters' ? tr('Chapter list') : s === 'pages' ? tr('Page list') : s === 'images' ? tr('Images') : tr('Search step');

/**
 * A source's status (SourceStatus), as the source card words it. Null for one this build does not know (a newer
 * server's), which sourceMark would call "Healthy" in a line saying it is failing: the whole line is the English.
 */
const statusText = (s: unknown): string | null =>
  SOURCE_STATUSES.includes(s as ProviderStatus) ? sourceMark(s as ProviderStatus).label : null;
/** A sentence about a source's status, or null when the status cannot be worded (statusText). */
const withStatus = (p: P, say: (status: string) => string): string | null => {
  const status = statusText(p.status);
  return status === null ? null : say(status);
};

/** What the chapter-failure ledger records (bff lib/chapterFailures.ts statusOf): its own two, or a source status. */
const failureStatus = (s: unknown): string | null =>
  s === 'incomplete' ? tr('pages missing') : s === 'error' ? tr('failed') : statusText(s);

/** "A, B and 3 more": the names a sentence lists, and how many it left out. */
const namesText = (p: P): string => {
  const first = strs(p, 'names').join(listSep());
  const more = num(p, 'more');
  return more > 0 ? `${first} ${tr('and {n} more', { n: more })}` : first;
};

/** Where a census reason found the walk's trouble: this folder, or one above it ('' the downloads folder). */
const whereText = (p: P): string =>
  p.above == null ? tr('this folder')
    : str(p, 'above') ? tr('"{folder}" (a folder above it)', { folder: str(p, 'above') })
    : tr('the downloads folder (above it)');

/** What a loop in the walk led back to (bff lib/library.ts findSeriesDirs). */
const loopedTo = (p: P): string =>
  p.ancestor === undefined ? str(p, 'detail')
    : str(p, 'ancestor') ? tr('the same folder as "{folder}", reached again through a mount', { folder: str(p, 'ancestor') })
    : tr('the same folder as the root, reached again through a mount');

const engineVersion = (p: P): string => str(p, 'version').replace(/^v/i, '');

/** "v3.4.6" for FlareSolverr, "uchiyomi-desktop-0.44.0" for the desktop helper (bff solverVersionLabel). */
const solverVersion = (v: string): string => `${/^\d/.test(v) ? 'v' : ''}${v}`;

// ---- a diagnosis (bff lib/sourceDiagnosis.ts) -----------------------------------------------------------------

const NEEDS_ADMIN = () => tr('This source needs a check from an admin.');

/** Each diagnosis code's public sentence: a reason is its code's (bff REASONS), so it is worded by code alone. */
const REASON_WORDS: Record<string, () => string> = {
  ok: () => '',
  disabled: () => tr('This source is switched off.'),
  moved: () => tr('This source\'s website moved. An admin needs to point it at the new address.'),
  edge_403: () => tr('This source is blocking this server right now.'),
  cf_challenge: () => tr('This source is protected by a check we could not get past.'),
  solver_crash: NEEDS_ADMIN,
  solver_down: NEEDS_ADMIN,
  solver_timeout: NEEDS_ADMIN,
  timeout: () => tr('This source did not answer in time.'),
  too_slow: () => tr('This source answers, but takes longer than the time it is given.'),
  markup_drift: () => tr('This source stopped listing new titles. An admin needs to check it.'),
  unreachable: () => tr('This source is not answering right now.'),
  rate_limited: () => tr('This source asked us to slow down.'),
  // "the extension engine", the component's name everywhere else in the app (the server's says "server").
  upstream_down: () => tr('The extension engine did not answer.'),
  extension_error: () => tr('This source\'s extension reported an error.'),
  unnumbered: () => tr('This source lists chapters without numbers Uchiyomi can use.'),
  site_offline: () => tr('The site says it is offline (its own page)'),
  unknown: NEEDS_ADMIN,
};

/** The codes REASON_WORDS words, for the test that holds them to the server's union. */
export const REASON_CODES = Object.keys(REASON_WORDS);

/**
 * A diagnosis's reason in the reader's language, by its code; the server's own sentence for a code this build does
 * not know (a newer server), or when there is no code.
 */
export function diagnosisReason(d: { code?: string | null; reason?: string | null } | null | undefined): string {
  const w = d?.code ? REASON_WORDS[d.code] : undefined;
  return w ? w() : d?.reason ?? '';
}

/** A diagnosis's fix in the reader's language: its own code when it has one, else the server's sentence. */
export function diagnosisFix(d: { fix?: string | null; fixSaid?: Said | null } | null | undefined): string {
  return saidText(d?.fixSaid, d?.fix ?? '');
}

/** The first sentence of a fix that names the stage it failed at: one sentence per stage, never a fragment glued in. */
const byStage = (p: P, words: Record<Stage | 'none', () => string>): string => {
  const s = p.stage as Stage | null | undefined;
  return (s && words[s] ? words[s] : words.none)();
};

// ---- every code ----------------------------------------------------------------------------------------------

/** A code's words. Null: this build cannot word it (a newer server's code inside it), so the line is the English. */
const WORDS: Record<string, (p: P) => string | null> = {
  // As sent: the server had no code for it.
  text: (p) => str(p, 'text'),

  // ---- shared by the checks
  ignored: (p) => (num(p, 'n') === 1 ? tr('1 ignored') : tr('{n} ignored', { n: num(p, 'n') })),
  hidden: (p) => (num(p, 'n') === 1 ? tr('1 more not shown.') : tr('{n} more not shown.', { n: num(p, 'n') })),
  folder: (p) => `${str(p, 'root') === 'downloads' ? tr('Downloads') : tr('Library')} / ${str(p, 'folder') || tr('(the folder itself)')}`,
  roots: (p) => {
    const parts = [
      p.library ? tr('Library: {fs}', { fs: str(p, 'library') }) : '',
      p.downloads ? tr('Downloads: {fs}', { fs: str(p, 'downloads') }) : '',
    ].filter(Boolean);
    return `${parts.join(' · ')}${cjk() ? '。' : '.'}`;
  },

  // ---- Chapter gaps
  'gaps.live': (p) => (num(p, 'n') === 1 ? tr('1 series has missing chapters') : tr('{n} series have missing chapters', { n: num(p, 'n') })),
  'gaps.none': () => tr('No gaps that need attention'),
  'gaps.quiet': (p) => (num(p, 'n') === 1 ? tr('1 already looked into') : tr('{n} already looked into', { n: num(p, 'n') })),
  'gaps.archiving': (p) => (num(p, 'n') === 1 ? tr('1 being archived slowly') : tr('{n} being archived slowly', { n: num(p, 'n') })),
  'gaps.note': () => tr('Gaps are normal when a source skipped a number or a series is still being downloaded. "Fill now" runs the repair\'s gap search for one series: it looks for another source that carries our numbering on both sides of the hole, follows it and fetches. A series it has already asked about is greyed with what it found.'),
  'gaps.detail': (p) => (num(p, 'n') === 1
    ? tr('1 missing — {ranges}', { ranges: str(p, 'ranges') })
    : tr('{n} missing — {ranges}', { n: num(p, 'n'), ranges: str(p, 'ranges') })),

  // ---- Chapter numbering (#116). A source that could not be named at all is "Its source" where it opens the sentence,
  // "its source" inside one.
  'numbering.live': (p) => (num(p, 'n') === 1 ? tr('1 series waits for a numbering review') : tr('{n} series wait for a numbering review', { n: num(p, 'n') })),
  'numbering.none': () => tr('No numbering change waits for a review'),
  'numbering.lately': (p) => (num(p, 'n') === 1 ? tr('1 numbered by posting order lately') : tr('{n} numbered by posting order lately', { n: num(p, 'n') })),
  'numbering.note': () => tr('Some sources give many different posts the same chapter number (Webtoons numbers a post by the episode it belongs to). A new series from such a source is numbered by posting order; one already in your library is renumbered only when you confirm its plan, and downloads nothing until then. Renaming keeps every file, and reading progress stays with its chapter. "Keep the source\'s numbers" records your choice; the source\'s own "Use sequential chapter numbering" setting, under Admin → Sources, is the other way out.'),
  'numbering.shared': (p) => tr('{name} gives {extras} of {posts} posts a number another post has', { name: sourceName(p), extras: num(p, 'extras'), posts: num(p, 'posts') }),
  'numbering.sharedMost': (p) => tr('{name} gives {extras} of {posts} posts a number another post has ({most} are all {number})', {
    name: sourceName(p), extras: num(p, 'extras'), posts: num(p, 'posts'), most: num(p, 'most'), number: num(p, 'number'),
  }),
  'numbering.sharedMany': (p) => tr('{name} gives many different posts the same number', { name: sourceName(p) }),
  'numbering.interrupted': () => tr('A renumber was interrupted before it finished; the next check of this series finishes it.'),
  'numbering.applying': () => tr('Its confirmed renumber is being applied now.'),
  'numbering.remap': (p) => opensOnOwnWords(p, tr('An extension setting changed {name}\'s chapter numbers; the chapters on disk wait to be matched to the new ones.', { name: sourceNameMid(p) })),
  'numbering.reviewWaits': () => tr('numbering them by posting order waits for your review.'),
  'numbering.askedWaits': () => tr('Numbering by posting order, as asked, waits to be applied.'),
  'numbering.sourceWaits': (p) => opensOnOwnWords(p, tr('Going back to {name}\'s own numbers waits to be applied.', { name: sourceNameMid(p) })),
  'numbering.since': (p) => tr('numbered by posting order since {date}.', { date: dayText(p.at) }),
  'numbering.hint': () => tr('they may be different chapters listed as versions of one.'),
  'numbering.kept': () => tr('you chose to keep the source\'s own numbers.'),
  'numbering.held': () => tr('Nothing downloads for this series until then.'),

  // ---- Suspiciously short chapters
  'short.live': (p) => (num(p, 'n') === 1 ? tr('1 chapter contains only one or two images') : tr('{n} chapters contain only one or two images', { n: num(p, 'n') })),
  'short.none': () => tr('No truncated chapters found'),
  'short.quiet': (p) => (num(p, 'n') === 1 ? tr('1 confirmed short at the source') : tr('{n} confirmed short at the source', { n: num(p, 'n') })),
  'short.note': () => tr('Counted nightly by the repair task, which opens the chapter files nobody has read yet, so this is no longer limited to chapters someone has opened. Half-chapters are excluded since author notices really are one page. "Fix" replaces the chapter only if another source has a longer copy; "It\'s fine" records that it really is this short, and the nightly stops looking at it.'),
  'short.detail': (p) => (num(p, 'pages') === 1
    ? tr('Chapter {number} has 1 page', { number: num(p, 'number') })
    : tr('Chapter {number} has {n} pages', { number: num(p, 'number'), n: num(p, 'pages') })),

  // ---- Chapters that would not download
  'failures.live': (p) => {
    const n = num(p, 'n');
    const m = num(p, 'm');
    if (n === 1) return m === 1 ? tr('1 chapter across 1 source keeps failing') : tr('1 chapter across {m} sources keeps failing', { m });
    return m === 1 ? tr('{n} chapters across 1 source keep failing', { n }) : tr('{n} chapters across {m} sources keep failing', { n, m });
  },
  'failures.none': () => tr('Every attempted chapter landed'),
  'failures.note': (p) => tr('One entry per source, counting chapters still missing after an attempt and how often each has been tried. They clear themselves the moment the chapter lands. After {cap} failed tries the nightly sweep leaves a chapter alone until the nightly repair gives it another chance a week later; "Retry now" does that for this source at once, and "Find missing chapters" on the series still fetches it on purpose. A chapter saved with pages missing is listed on its series page and re-tried by the sweep, up to 10 a night.', { cap: num(p, 'cap') }),
  'failures.detail': (p) => {
    const n = num(p, 'n');
    const m = num(p, 'series');
    const date = dayText(p.since);
    const head = n === 1
      ? m === 1 ? tr('1 chapter in 1 series since {date}', { date }) : tr('1 chapter in {m} series since {date}', { m, date })
      : m === 1 ? tr('{n} chapters in 1 series since {date}', { n, date }) : tr('{n} chapters in {m} series since {date}', { n, m, date });
    const t = num(p, 'tries');
    const tries = t === 1 ? tr('tried up to 1 time') : tr('tried up to {n} times', { n: t });
    const c = num(p, 'capped');
    const capped = !c ? '' : c === 1 ? tr('1 left alone after {cap}', { cap: num(p, 'cap') }) : tr('{n} left alone after {cap}', { n: c, cap: num(p, 'cap') });
    const status = failureStatus(p.status);
    if (status === null) return null;
    const vars = { title: str(p, 'title'), number: num(p, 'number'), status, reason: str(p, 'reason') };
    const latest = p.reason ? tr('latest: "{title}" ch {number} ({status}: {reason})', vars) : tr('latest: "{title}" ch {number} ({status})', vars);
    // Clauses, not a list: "since 20 Sep, tried up to 5 times, 1 left alone after 10".
    return joinPart([head, tries, capped].filter(Boolean).join(clauseSep()), latest, 'clause');
  },

  // ---- Series that can no longer update. `source` is the series' source id.
  'frozen.live': (p) => (num(p, 'n') === 1 ? tr('1 series has no working source') : tr('{n} series have no working source', { n: num(p, 'n') })),
  'frozen.none': () => tr('Every series has a working source'),
  'frozen.covered': (p) => (num(p, 'n') === 1 ? tr('1 lost its primary but still follows another') : tr('{n} lost their primary but still follow another', { n: num(p, 'n') })),
  'frozen.engineNote': () => tr('Series that came from extensions wait for the extension engine; Admin → Sources shows how to bring it back.'),
  'frozen.note': () => tr('These read fine, but nothing can fetch new chapters for them and "find missing chapters" will not offer their own source. Switch the source back on, re-add the extension, or re-point the series at a source that carries it.'),
  'frozen.noSource': (p) => (num(p, 'n') === 1 ? tr('1 chapter; no source recorded') : tr('{n} chapters; no source recorded', { n: num(p, 'n') })),
  'frozen.engineDown': (p) => (num(p, 'n') === 1
    ? tr('1 chapter; its source {source} can’t be reached because the extension engine isn’t answering', { source: str(p, 'source') })
    : tr('{n} chapters; its source {source} can’t be reached because the extension engine isn’t answering', { n: num(p, 'n'), source: str(p, 'source') })),
  'frozen.engineOff': (p) => (num(p, 'n') === 1
    ? tr('1 chapter; its source {source} can’t be reached because the extension engine is off', { source: str(p, 'source') })
    : tr('{n} chapters; its source {source} can’t be reached because the extension engine is off', { n: num(p, 'n'), source: str(p, 'source') })),
  'frozen.switchedOff': (p) => (num(p, 'n') === 1
    ? tr('1 chapter; its source {source} is switched off', { source: str(p, 'source') })
    : tr('{n} chapters; its source {source} is switched off', { n: num(p, 'n'), source: str(p, 'source') })),
  'frozen.overLimit': (p) => {
    const v = { n: num(p, 'n'), source: str(p, 'source') };
    if (isDesktop()) return v.n === 1 ? tr('1 chapter; its source {source} is over the source limit', v) : tr('{n} chapters; its source {source} is over the source limit', v);
    return v.n === 1 ? tr('1 chapter; its source {source} is over the source limit (SUWAYOMI_MAX_SOURCES)', v)
      : tr('{n} chapters; its source {source} is over the source limit (SUWAYOMI_MAX_SOURCES)', v);
  },
  'frozen.uninstalled': (p) => (num(p, 'n') === 1
    ? tr('1 chapter; its source {source} is no longer installed', { source: str(p, 'source') })
    : tr('{n} chapters; its source {source} is no longer installed', { n: num(p, 'n'), source: str(p, 'source') })),
  // v0.52.0 (#123): a MangaDex language switched off. The language in the reader's own words, never its code.
  'frozen.mangadexOff': (p) => {
    const v = { n: num(p, 'n'), language: languageName(str(p, 'lang')) };
    return v.n === 1 ? tr('1 chapter; MangaDex in {language} is switched off in Admin → Sources', v)
      : tr('{n} chapters; MangaDex in {language} is switched off in Admin → Sources', v);
  },
  'frozen.following': (p) => tr('primary {source} gone; still following {names}', { source: p.source == null ? tr('(none)') : str(p, 'source'), names: strs(p, 'names').join(listSep()) }),
  // v0.54.0: a loaded main source that is failing, or says it is offline; and one switched off or failing that a
  // follower covers.
  'frozen.failing': (p) => {
    const v = { n: num(p, 'n'), source: str(p, 'source') };
    if (p.offline) return v.n === 1 ? tr('1 chapter; its source {source} says it is offline', v) : tr('{n} chapters; its source {source} says it is offline', v);
    return v.n === 1 ? tr('1 chapter; its source {source} is failing', v) : tr('{n} chapters; its source {source} is failing', v);
  },
  'frozen.followingDown': (p) => {
    const v = { source: str(p, 'source'), names: strs(p, 'names').join(listSep()) };
    return p.state === 'off' ? tr('primary {source} switched off; still following {names}', v) : tr('primary {source} failing; still following {names}', v);
  },

  // ---- Source health (#115)
  // v0.53.0: the summary counts the card's two groups that need a look. 'sources.live', 'none', 'off', 'idle' and
  // 'unfinished' are no longer sent, and keep their words for a summary an older server stored (bff lib/said.ts).
  'sources.affected': (p) => (num(p, 'n') === 1 ? tr('1 source your series use needs a look') : tr('{n} sources your series use need a look', { n: num(p, 'n') })),
  'sources.failingUnused': (p) => (num(p, 'n') === 1 ? tr('1 source nothing uses is failing') : tr('{n} sources nothing uses are failing', { n: num(p, 'n') })),
  'sources.working': () => tr('All sources are working'),
  'sources.live': (p) => (num(p, 'n') === 1 ? tr('1 source is failing or blocked') : tr('{n} sources are failing or blocked', { n: num(p, 'n') })),
  'sources.unused': () => tr('Nothing is failing that your library uses'),
  'sources.none': () => tr('All sources responding normally'),
  'sources.off': (p) => (num(p, 'n') === 1 ? tr('1 turned off by you') : tr('{n} turned off by you', { n: num(p, 'n') })),
  'sources.idle': (p) => (num(p, 'n') === 1 ? tr('1 that no series uses') : tr('{n} that no series uses', { n: num(p, 'n') })),
  'sources.unfinished': (p) => (num(p, 'n') === 1 ? tr('1 could not finish a test') : tr('{n} could not finish a test', { n: num(p, 'n') })),
  'sources.note': () => tr('A source is failing when a Test or the daily check fails at a step (search, chapter list, page list), or when ordinary use fails at the same step three times in a row; downloading images is a step of its own. Only a later success at that same step clears it. Testing never changes a cooldown. A blocked source usually means the site returned 403 or a Cloudflare challenge we could not solve; if several fail at once and all of them mention the solver, check the solver rather than the sites. A cooldown on a source no series uses is listed for reference only, and so is a test that ran out of time.'),
  'sources.turnedOff': () => tr('turned off by you'),
  'sources.expired': (p) => withStatus(p, (status) => tr('block expired, will retry on next use (was {status})', { status })),
  'sources.until': (p) => withStatus(p, (status) => tr('{status} until {when}', { status, when: momentText(p.until) })),
  'sources.status': (p) => statusText(p.status),
  'sources.uses': (p) => {
    const n = num(p, 'n');
    return !n ? tr('no series use it') : n === 1 ? tr('1 series uses it') : tr('{n} series use it', { n });
  },
  'sources.tested': (p) => {
    const when = momentText(p.at);
    return p.by === 'test' ? tr('last tested {when} with the Test button', { when })
      : p.by === 'sweep' ? tr('last tested {when} by the daily check', { when })
      : tr('last tested {when}', { when });
  },
  'sources.failing': (p) => {
    const lead = tr('{stage} failing since {when}', { stage: stageName(p.stage), when: momentText(p.since) });
    const also = strs(p, 'also');
    // Mid-sentence, as the server's English says them: "(also chapter list, page list)".
    return also.length ? joinPart(lead, tr('also {stages}', { stages: also.map((x) => midSentence(stageName(x))).join(listSep()) }), 'paren') : lead;
  },
  // The reason ends its sentence as the server's does (bff lib/said.ts 'sources.reason' adds the full stop a reason
  // lacks): site_offline's is the one without its own, and aqua's row read "…(its own page) 195 series use it".
  // Reintroduce the reason as it is: "sources.reason for 'site_offline' reads otherwise" in said.test.ts.
  'sources.reason': (p) => {
    const code = str(p, 'diagnosis');
    if (!REASON_WORDS[code]) return null;
    const r = diagnosisReason({ code });
    return !r || /[.!?。！？؟]$/.test(r) ? r : `${r}${cjk() ? '。' : '.'}`;
  },
  'sources.inconclusive': (p) => byStage(p, {
    search: () => tr('the last test ran out of time while searching — not proof it is broken'),
    chapters: () => tr('the last test ran out of time while listing chapters — not proof it is broken'),
    pages: () => tr('the last test ran out of time while listing pages — not proof it is broken'),
    images: () => tr('the last test ran out of time while downloading images — not proof it is broken'),
    none: () => tr('the last test ran out of time while searching — not proof it is broken'),
  }),
  'sources.stale': (p) => tr('{stage} failed {when} and nothing has checked it since — test it again', { stage: stageName(p.stage), when: relativeTime(str(p, 'at')) }),

  // ---- Duplicate series
  'dupes.live': (p) => (num(p, 'n') === 1 ? tr('1 title appears to be in the library twice') : tr('{n} titles appear to be in the library twice', { n: num(p, 'n') })),
  'dupes.none': () => tr('No duplicates found'),
  'dupes.note': () => tr('Detected by two series matching the same AniList entry, so it catches copies added from different sources under different names. Progress tracking works best with one copy of each. Merging is one-way and never automatic: the nightly repair leaves these alone and you confirm each one.'),
  'dupes.same': () => tr('Same AniList entry'),
  'dupes.copies': (p) => tr('{n} copies — merge them one pair at a time', { n: num(p, 'n') }),
  // v0.52.0 (#72): a pair in two languages; the codes named in the reader's language.
  'dupes.languages': (p) => tr('The same work in {a} and {b}: link them as editions rather than merging.', { a: languageName(str(p, 'a')), b: languageName(str(p, 'b')) }),

  // ---- Impossible chapter numbers
  'outliers.live': (p) => (num(p, 'n') === 1 ? tr('1 series has chapters numbered far beyond the rest') : tr('{n} series have chapters numbered far beyond the rest', { n: num(p, 'n') })),
  'outliers.none': () => tr('No out-of-range chapters'),
  'outliers.note': () => tr('Catches chapters scraped from a site\'s sidebar widget, which belong to a different series. The parser now guards against this, so anything here predates that fix. Deleting is never automatic and the nightly repair never renumbers: "Delete chapters" removes the files (a bookmarked chapter is skipped), and a wrong number can be corrected on the series page instead.'),
  'outliers.detail': (p) => (num(p, 'n') === 1
    ? tr('1 chapter up to {top}, but the series sits around {median}', { top: num(p, 'top'), median: num(p, 'median') })
    : tr('{n} chapters up to {top}, but the series sits around {median}', { n: num(p, 'n'), top: num(p, 'top'), median: num(p, 'median') })),

  // ---- The same chapter saved twice (v0.50.0)
  'twice.live': (p) => (num(p, 'n') === 1 ? tr('1 series has chapters saved twice, split two ways') : tr('{n} series have chapters saved twice, split two ways', { n: num(p, 'n') })),
  'twice.none': () => tr('No chapter saved twice'),
  'twice.note': () => tr('Sites split and number a chapter\'s parts differently, and before v0.50.0 an update could download a chapter you had again under another site\'s numbers. Each row names the files that arrived later. Deleting is never automatic: "Delete chapters" removes those files (a bookmarked chapter is skipped), everyone keeps their reading history, and updates do not fetch them back.'),
  'twice.detail': (p) => {
    const more = num(p, 'more');
    const numbers = strs(p, 'numbers').join(listSep()) + (more > 0 ? ` ${tr('and {n} more', { n: more })}` : '');
    return num(p, 'n') === 1
      ? tr('1 file from {source} saved again in another split: {numbers}', { source: str(p, 'source'), numbers })
      : tr('{n} files from {source} saved again in another split: {numbers}', { n: num(p, 'n'), source: str(p, 'source'), numbers });
  },

  // ---- Cloudflare solver. On desktop no address is sent: it carries the helper's token.
  'solver.down': (p) => {
    const head = isDesktop() || !p.url ? tr('Not answering') : tr('Not answering at {url}', { url: str(p, 'url') });
    return p.error ? joinPart(head, str(p, 'error'), 'paren') : head;
  },
  'solver.downNote': () => (isDesktop()
    ? tr('Sources on Cloudflare-protected sites cannot work without it. Uchiyomi\'s built-in Cloudflare helper isn\'t answering; quit and reopen Uchiyomi.')
    : tr('Sources on Cloudflare-protected sites cannot work without it. Check the container is running and that FLARESOLVERR_URL points at it.')),
  'solver.helper': () => tr('Cloudflare helper'),
  'solver.notAnswering': (p) => (p.error ? tr('not answering ({error})', { error: str(p, 'error') }) : tr('not answering')),
  'solver.names': () => tr('failing, and its recorded error names the solver'),
  'solver.blaming': (p) => (num(p, 'n') === 1 ? tr('Answering, but 1 source recently failed inside it') : tr('Answering, but {n} sources recently failed inside it', { n: num(p, 'n') })),
  'solver.ready': (p) => {
    const ready = p.version ? tr('Ready ({version})', { version: solverVersion(str(p, 'version')) }) : tr('Ready to solve challenges');
    return p.latest ? joinPart(ready, tr('v{version} is available', { version: str(p, 'latest') }), 'dash') : ready;
  },
  'solver.failingNote': () => (isDesktop()
    ? tr('It responds, but it has been failing mid-request; quit and reopen Uchiyomi to restart it.')
    : tr('It responds, but it has been failing mid-request. Chrome needs far more than Docker\'s default 64 MB of shared memory (set shm_size: 1gb), and the solver leaks memory, so it wants a restart.')),
  'solver.behind': () => tr('a newer solver is out; Cloudflare changes often break older ones'),
  'solver.inside': () => tr('its last failure happened inside the solver'),

  // ---- Version
  'version.offRunning': (p) => tr('Running v{version} — update checks are off', { version: str(p, 'version') }),
  'version.off': () => tr('Update checks are off'),
  'version.offNote': () => tr('Nothing is requested while this is off. Turn it on under Settings → Server to be told when a release is out.'),
  'version.unknown': () => tr('Could not read the running version'),
  'version.behind': (p) => tr('Running v{version} — {latest} is available', { version: str(p, 'version'), latest: str(p, 'latest') }),
  'version.current': (p) => tr('Running v{version} — up to date', { version: str(p, 'version') }),
  'version.running': (p) => tr('Running v{version}', { version: str(p, 'version') }),
  'version.unasked': () => tr('GitHub could not be reached just now, so this is not a clean bill of health.'),
  'version.newer': () => tr('a newer release is published; see the changelog before upgrading'),

  // ---- Extension source limit
  'cap.over': (p) => (num(p, 'n') === 1
    ? tr('1 enabled source is not registered — over the limit of {cap}', { cap: num(p, 'cap') })
    : tr('{n} enabled sources are not registered — over the limit of {cap}', { n: num(p, 'n'), cap: num(p, 'cap') })),
  'cap.unreachable': (p) => tr('engine unreachable at the last load; nothing is registered (limit {cap})', { cap: num(p, 'cap') }),
  'cap.inUse': (p) => tr('{n} of {cap} extension sources in use', { n: num(p, 'n'), cap: num(p, 'cap') }),
  'cap.note': () => (isDesktop()
    ? tr('Every registered source is searched at once, which is why there is a limit. Hide the languages you don\'t read to get under it.')
    : tr('Every registered source is searched at once, which is why there is a limit. Hiding the languages you do not read is the cheap way under it; SUWAYOMI_MAX_SOURCES raises it.')),
  'cap.title': () => (isDesktop() ? tr('Source limit') : 'SUWAYOMI_MAX_SOURCES'),
  'cap.detail': (p) => {
    const v = { n: num(p, 'n'), cap: num(p, 'cap') };
    if (isDesktop()) {
      return v.n === 1 ? tr('1 enabled source not registered; the limit is {cap}. Hide the languages you don\'t read.', v)
        : tr('{n} enabled sources not registered; the limit is {cap}. Hide the languages you don\'t read.', v);
    }
    return v.n === 1 ? tr('1 enabled source not registered; the limit is {cap}. Hide languages you do not read, or raise the limit.', v)
      : tr('{n} enabled sources not registered; the limit is {cap}. Hide languages you do not read, or raise the limit.', v);
  },

  // ---- Library scan (#109)
  'scan.none': () => tr('no scan has run since the server started'),
  'scan.problems': (p) => {
    const n = num(p, 'n');
    const w = num(p, 'w');
    const parts = [
      n ? (n === 1 ? tr('could not index 1 folder') : tr('could not index {n} folders', { n })) : '',
      w ? (w === 1 ? tr('left out 1 folder or file it could not read') : tr('left out {n} folders or files it could not read', { n: w })) : '',
    ].filter(Boolean);
    let what = parts.join(' ');
    // Two things the scan did, joined as "and" joins them. Chinese "和" joins nouns only: "无法索引 1 个文件夹和略过了 2
    // 个…" (the v0.49.1 translation review), so there they are two clauses. The Japanese translation words both as
    // nouns ("…フォルダー 1 件"), which its list joins as it should.
    if (/^zh/.test(activeLocale())) what = parts.join(clauseSep());
    else try { what = cached('said:and', () => new Intl.ListFormat(intlTag(), { type: 'conjunction' })).format(parts); } catch { /* an old WebView: the two side by side */ }
    return n + w === 1
      ? tr('the last scan {what}; its chapters are on disk but not in the library', { what })
      : tr('the last scan {what}; their chapters are on disk but not in the library', { what });
  },
  'scan.indexed': (p) => {
    const n = num(p, 'series');
    const m = num(p, 'books');
    if (n === 1) return m === 1 ? tr('the last scan indexed 1 series, 1 chapter') : tr('the last scan indexed 1 series, {m} chapters', { m });
    return m === 1 ? tr('the last scan indexed {n} series, 1 chapter', { n }) : tr('the last scan indexed {n} series, {m} chapters', { n, m });
  },
  'scan.note': () => tr('Runs after every download, sweep and manual scan. Every other folder is still indexed when one fails.'),
  'scan.shared': (p) => (num(p, 'n') === 1
    ? tr('1 folder shares a disk id with another folder (Unraid user shares and some network drives report ids like this). All of them were scanned; before v0.48.2 each one was skipped, with everything in it.')
    : tr('{n} folders share a disk id with another folder (Unraid user shares and some network drives report ids like this). All of them were scanned; before v0.48.2 each one was skipped, with everything in it.', { n: num(p, 'n') })),
  'scan.removed': (p) => (num(p, 'n') === 1
    ? tr('1 folder belongs to series someone removed, and was left alone; Admin → Library puts a series back.')
    : tr('{n} folders belong to series someone removed, and were left alone; Admin → Library puts a series back.', { n: num(p, 'n') })),
  'walk.unreadable': (p) => tr('could not be read ({error}), so nothing in it is in the library', { error: str(p, 'error') }),
  'walk.failed': (p) => tr('could not be read (the walk failed: {error}), so nothing in it is in the library', { error: str(p, 'error') }),
  'walk.stat': (p) => tr('could not be checked ({error}), so nothing in it is in the library', { error: str(p, 'error') }),
  'walk.loop': (p) => tr('not scanned twice: {what}', { what: loopedTo(p) }),
  'walk.unchecked': (p) => {
    const names = strs(p, 'names').map((x) => `"${x}"`).join(listSep()) + (num(p, 'n') > 3 ? `${listSep()}…` : '');
    return num(p, 'n') === 1 ? tr('1 entry could not be checked: {names}', { names }) : tr('{n} entries could not be checked: {names}', { n: num(p, 'n'), names });
  },
  'walk.depth': (p) => (num(p, 'n') === 1
    ? tr('1 folder is more than {max} levels deep and was not looked into (LIBRARY_MAX_DEPTH)', { max: num(p, 'max') })
    : tr('{n} folders are more than {max} levels deep and were not looked into (LIBRARY_MAX_DEPTH)', { n: num(p, 'n'), max: num(p, 'max') })),
  'walk.limit': (p) => tr('the walk stopped after {max} folders; the rest were not looked into', { max: numText(num(p, 'max')) }),

  // ---- Downloads missing from the library (#109)
  'missing.error': (p) => tr('could not be checked just now: {error}', { error: str(p, 'error') }),
  'missing.live': (p) => {
    const n = num(p, 'n');
    const m = num(p, 'm');
    if (n === 1) return m === 1 ? tr('1 downloaded chapter in 1 folder is on disk but not in the library') : tr('1 downloaded chapter in {m} folders is on disk but not in the library', { m });
    return m === 1 ? tr('{n} downloaded chapters in 1 folder are on disk but not in the library', { n }) : tr('{n} downloaded chapters in {m} folders are on disk but not in the library', { n, m });
  },
  'missing.unreadable': (p) => (num(p, 'n') === 1 ? tr('1 folder in the downloads could not be read') : tr('{n} folders in the downloads could not be read', { n: num(p, 'n') })),
  'missing.none': (p) => (num(p, 'checked') === 1
    ? tr('every chapter file in the downloads folder is in the library (1 checked)')
    : tr('every chapter file in the downloads folder is in the library ({n} checked)', { n: num(p, 'checked') })),
  'missing.compared': (p) => (p.fs
    ? tr('Every chapter file under {root} ({fs}), against the library.', { root: str(p, 'root'), fs: str(p, 'fs') })
    : tr('Every chapter file under {root}, against the library.', { root: str(p, 'root') })),
  'missing.noScan': () => tr('No library scan has run since the server started; Scan now below runs one.'),
  'missing.capped': () => tr('The last scan stopped at its folder limit, so some folders were never looked into.'),
  'missing.pending': (p) => (num(p, 'n') === 1
    ? tr('1 landed after the last scan began and waits for the next one.')
    : tr('{n} landed after the last scan began and wait for the next one.', { n: num(p, 'n') })),
  'missing.removed': (p) => (num(p, 'n') === 1
    ? tr('1 belongs to series someone removed (Admin → Library puts one back).')
    : tr('{n} belong to series someone removed (Admin → Library puts one back).', { n: num(p, 'n') })),
  'missing.strays': (p) => (num(p, 'n') === 1
    ? tr('1 folder holds files of your own where the scan never reads chapters; listed, not counted.')
    : tr('{n} folders hold files of your own where the scan never reads chapters; listed, not counted.', { n: num(p, 'n') })),
  'missing.truncated': () => tr('The folder is too big to check completely; the counts are a floor.'),
  'missing.folderUnreadable': (p) => tr('could not be read ({error})', { error: str(p, 'error') }),
  'missing.files': (p) => {
    const files = strs(p, 'files').join(listSep()) + (p.cut ? `${listSep()}…` : '');
    return num(p, 'n') === 1 ? tr('1 chapter not in the library ({files})', { files }) : tr('{n} chapters not in the library ({files})', { n: num(p, 'n'), files });
  },
  'census.loose': () => tr('chapter files straight in the downloads folder: only a folder can be a series'),
  'census.deep': (p) => tr('more than {max} folders deep, and the scan looks no deeper (LIBRARY_MAX_DEPTH)', { max: num(p, 'max') }),
  'census.inside': (p) => tr('inside "{folder}", which the scan reads as a series, and a series\' subfolders are not looked into', { folder: str(p, 'holder') }),
  'census.deleted': (p) => (num(p, 'n') === 1
    ? tr('the library still marks it deleted, and no scan has read the file since')
    : tr('the library still marks these {n} deleted, and no scan has read the files since', { n: num(p, 'n') })),
  'census.refused': (p) => tr('the library refused it: {error}', { error: str(p, 'error') }),
  'census.unreadable': (p) => tr('the scan could not read {where}: {error}', { where: whereText(p), error: str(p, 'error') }),
  'census.failed': (p) => tr('the scan could not read {where}: the walk failed: {error}', { where: whereText(p), error: str(p, 'error') }),
  'census.stat': (p) => tr('the scan could not check {where}: {error}', { where: whereText(p), error: str(p, 'error') }),
  'census.loop': (p) => tr('the scan took {where} for a loop: {what}', { where: whereText(p), what: loopedTo(p) }),

  // ---- Folders scanned twice (v0.52.0, #134)
  'nested.same': () => tr('The downloads folder and the library are one folder, so every downloaded chapter is scanned twice'),
  'nested.downloadsInside': (p) => tr('The downloads folder is inside the library, at {folder}, so every downloaded chapter is scanned twice', { folder: str(p, 'folder') }),
  'nested.libraryInside': (p) => tr('The library is inside the downloads folder, at {folder}, so every chapter in it is scanned twice', { folder: str(p, 'folder') }),
  'nested.byPath': () => tr('Their paths put one inside the other.'),
  'nested.byScan': () => tr('The last library scan read the same files here a second time.'),
  'nested.note': (p) => (isDesktop()
    ? tr('Uchiyomi scans its library folder and the manga folder you added both, so neither may be inside the other: each downloaded chapter then shows up twice. Keep the two side by side; then remove the copies with no source.')
    : tr('Uchiyomi scans the library ({lib}) and its downloads folder ({dl}) both, so neither may be inside the other: each downloaded chapter then shows up twice, once in a series with its source and once in a series with none. Mount them side by side, each in a folder of its own, and restart Uchiyomi; then remove the copies with no source. The Volumes section of the install guide shows how.', { lib: str(p, 'lib'), dl: str(p, 'dl') })),

  // ---- The extension engine (#72)
  'engine.waiting': (p) => (num(p, 'n') === 1
    ? tr('1 series that came from extensions keeps its chapters and gets no new ones until it is back')
    : tr('{n} series that came from extensions keep their chapters and get no new ones until it is back', { n: num(p, 'n') })),
  // Not the source status "Turned off" (lib/status.ts SOURCE_LABELS): that one agrees with a source, and read
  // "Désactivée" above "le moteur".
  'engine.switchedOff': () => tr('Switched off'),
  'engine.notSetUp': () => tr('Not set up'),
  'engine.offNote': () => tr('Admin → Sources shows how to bring it back. Its data is kept while it is off.'),
  'engine.fromExtensions': () => tr('Series from extensions'),
  'engine.notAnswering': (p) => (p.error ? joinPart(tr('Not answering'), str(p, 'error'), 'paren') : tr('Not answering')),
  'engine.retries': () => tr('Uchiyomi asks again every 5 minutes by itself, and its extensions come back without a restart.'),
  'engine.reopen': () => tr('If it stays this way, quit and reopen Uchiyomi, which starts its extension engine again.'),
  'engine.checkAgain': () => tr('Admin → Sources shows what to check for your setup, and Check again there asks at once.'),
  'engine.notAnsweringTitle': () => tr('Not answering'),
  'engine.asked': (p) => (num(p, 'n') === 1 ? tr('asked 1 time since it stopped answering') : tr('asked {n} times since it stopped answering', { n: num(p, 'n') })),
  'engine.noAnswer': () => tr('no answer at the last try'),
  'engine.registering': () => tr('It answers again; its extensions are being registered.'),
  'engine.cannotUse': () => tr('It cannot use its Cloudflare helper'),
  'engine.helper': () => tr('Cloudflare helper'),
  'engine.helperOff': (p) => (num(p, 'n') === 1
    ? tr('The engine says its own Cloudflare helper is switched off: {names} fails because of it.', { names: namesText(p) })
    : tr('The engine says its own Cloudflare helper is switched off: {names} fail because of it.', { names: namesText(p) })),
  'engine.noSolver': () => tr('Uchiyomi has no Cloudflare helper of its own to share yet: set FLARESOLVERR_URL on Uchiyomi, then connect it here.'),
  'engine.unreadConnect': () => tr('Its Cloudflare helper setting could not be read just now. Connect points it at the helper Uchiyomi uses and switches it on; nothing restarts.'),
  'engine.unread': () => tr('Its Cloudflare helper setting could not be read just now.'),
  'engine.unsupportedDesktop': () => tr('This engine version does not report its Cloudflare setting, so Uchiyomi cannot switch it on from here.'),
  'engine.unsupportedServer': () => tr('This engine version does not report its Cloudflare setting, so Uchiyomi cannot switch it on: set FLARESOLVERR_ENABLED=true and FLARESOLVERR_URL on the engine\'s own container, or update the engine.'),
  'engine.unsupported': () => tr('This engine version does not report its Cloudflare setting.'),
  'engine.answering': (p) => (p.version ? tr('Answering (v{version})', { version: engineVersion(p) }) : tr('Answering')),
  'engine.readyCloudflare': (p) => (p.version
    ? tr('Ready, and it can get past Cloudflare (v{version})', { version: engineVersion(p) })
    : tr('Ready, and it can get past Cloudflare')),
  'engine.ready': (p) => (p.version ? tr('Ready (v{version})', { version: engineVersion(p) }) : tr('Ready to use')),
  'engine.otherHelper': () => tr('on, through a helper other than Uchiyomi’s own'),
  'engine.otherHelperAt': (p) => tr('on, through {url} rather than Uchiyomi’s own helper', { url: str(p, 'url') }),
  'engine.localhost': () => tr('The engine’s own Cloudflare helper is not in use: it points at localhost, where no helper runs. Extension sources on Cloudflare-protected sites fail until it is.'),
  'engine.helperIsOff': () => tr('The engine’s own Cloudflare helper is not in use: it is switched off. Extension sources on Cloudflare-protected sites fail until it is.'),
  'engine.failing': (p) => (num(p, 'n') === 1 ? tr('{names} fails because of it.', { names: namesText(p) }) : tr('{names} fail because of it.', { names: namesText(p) })),
  'engine.fronted': (p) => (num(p, 'n') === 1 ? tr('{names} is behind Cloudflare.', { names: namesText(p) }) : tr('{names} are behind Cloudflare.', { names: namesText(p) })),
  'engine.notInUse': () => tr('Its Cloudflare helper is not in use'),
  'engine.readyNotInUse': (p) => (p.version
    ? tr('Ready (v{version}); its Cloudflare helper is not in use', { version: engineVersion(p) })
    : tr('Ready; its Cloudflare helper is not in use')),
  'engine.connectNote': () => tr('Connect points it at the helper Uchiyomi uses and switches it on; nothing restarts, and it stays that way unless the engine’s own container names another helper.'),
  'engine.solverQuiet': () => tr('Its Cloudflare helper is not answering'),
  'engine.readySolverQuiet': (p) => (p.version
    ? tr('Ready (v{version}); its Cloudflare helper is not answering', { version: engineVersion(p) })
    : tr('Ready; its Cloudflare helper is not answering')),
  'engine.solverQuietDetail': () => tr('It is connected to Uchiyomi’s own Cloudflare helper, which is not answering (the Cloudflare solver row says what to do). Extension sources on Cloudflare-protected sites fail until it answers again.'),

  // ---- A download job's reason. `source`, `from` and `to` are sources' names.
  'job.noSpace': (p) => tr('Not enough free space: {error}', { error: str(p, 'error') }),
  'job.noSpaceToDownload': (p) => tr('Not enough free space to download: {error}.', { error: str(p, 'error') }),
  'job.saved': (p) => (num(p, 'total') === 1
    ? tr('{done} of 1 chapter saved.', { done: num(p, 'done') })
    : tr('{done} of {n} chapters saved.', { done: num(p, 'done'), n: num(p, 'total') })),
  'job.slowedDown': (p) => tr('{from} asked us to slow down — continued from {to}', { from: str(p, 'from'), to: str(p, 'to') }),
  'job.switched': (p) => tr('{from} could not serve chapter {number} — took it from {to}', { from: str(p, 'from'), number: num(p, 'number'), to: str(p, 'to') }),
  'job.partial': (p) => (num(p, 'n') === 1
    ? tr('Chapter {number} saved with 1 page missing', { number: num(p, 'number') })
    : tr('Chapter {number} saved with {n} pages missing', { number: num(p, 'number'), n: num(p, 'n') })),
  'job.stopped': (p) => tr('{source} stopped part-way', { source: str(p, 'source') }),
  'job.stoppedRefusing': (p) => {
    const v = { source: str(p, 'source') };
    return p.status === 'rate_limited' ? tr('{source} stopped part-way: it is rate-limiting downloads', v)
      : p.status === 'blocked' ? tr('{source} stopped part-way: it is blocking downloads', v)
      : tr('{source} stopped part-way: it is unreachable for downloads', v);
  },
  'job.refusing': (p) => {
    const v = { source: str(p, 'source') };
    return p.status === 'rate_limited' ? tr('{source} is currently rate-limiting downloads.', v)
      : p.status === 'blocked' ? tr('{source} is currently blocking downloads.', v)
      : tr('{source} is currently unreachable for downloads.', v);
  },
  'job.undownloadable': () => tr('No downloadable chapters here — this title may be licensed or hosted externally on this source.'),
  'job.failed': (p) => (num(p, 'n') === 1
    ? tr('1 chapter could not be saved: {error}', { error: str(p, 'error') })
    : tr('{n} chapters could not be saved: {error}', { n: num(p, 'n'), error: str(p, 'error') })),
  'job.cancelled': (p) => (num(p, 'total') === 1
    ? tr('Cancelled after {done} of 1 chapter.', { done: num(p, 'done') })
    : tr('Cancelled after {done} of {n} chapters.', { done: num(p, 'done'), n: num(p, 'total') })),
  // With its noun: "2 could not be saved" gave a gendered language nothing to agree with.
  'job.notSaved': (p) => (num(p, 'n') === 1 ? tr('1 chapter could not be saved.') : tr('{n} chapters could not be saved.', { n: num(p, 'n') })),
  'job.notInLibrary': (p) => {
    const more = num(p, 'more');
    const numbers = strs(p, 'numbers').join(listSep()) + (more > 0 ? ` ${tr('and {n} more', { n: more })}` : '');
    return num(p, 'n') === 1
      ? tr('Chapter {numbers} is on disk, but the library scan could not add it', { numbers })
      : tr('Chapters {numbers} are on disk, but the library scan could not add them', { numbers });
  },
  'job.healthDetails': () => tr('Admin → Health → Downloads missing from the library has the details.'),

  // ---- One chapter's download
  'activity.arrived': (p) => (num(p, 'n') === 1 ? tr('arrived with 1 page missing') : tr('arrived with {n} pages missing', { n: num(p, 'n') })),
  'activity.saved': (p) => (num(p, 'n') === 1 ? tr('saved with 1 page missing') : tr('saved with {n} pages missing', { n: num(p, 'n') })),
  'activity.notKept': () => tr('not kept'),

  // ---- A server run's card
  'run.failed': () => tr('The run failed. The server log has the details.'),
  'run.updateFailed': () => tr('The update run failed. The server log has the details.'),
  'run.repairFailed': () => tr('The repair failed. The server log has the details.'),
  'run.diskFull': () => tr('The library disk is full.'),
  'run.chapterLimit': () => tr('Stopped at this run\'s chapter limit; the rest wait for the next one.'),

  // ---- A renumbering refused or put off
  'renumber.downloading': () => tr('Chapters are being fetched for this series. Try again when that ends.'),
  'renumber.checking': () => tr('This series is being checked right now. Try again when that ends.'),
  'renumber.onDisk': (p) => tr('{file} is already on disk', { file: str(p, 'file') }),
  'renumber.leavesRoot': (p) => tr('{file}: the path leaves its library root', { file: str(p, 'file') }),
  'renumber.unreachable': () => tr('The source did not answer, so there is no plan to show. Try again in a moment.'),

  // ---- An extension's settings refused. "The extension engine", the component's name everywhere else in the app.
  'pref.notConfigured': () => tr('No extension engine is set up.'),
  'pref.unknownSource': () => tr('The extension engine has no such source.'),
  'pref.extensionFailed': (p) => tr('The extension failed: {error}', { error: str(p, 'error') }),
  'pref.unreachable': () => tr('The extension engine did not answer. Try again in a moment.'),
  'pref.unknown': () => tr('This extension has no such setting any more. Reopen its settings.'),
  'pref.ambiguous': () => tr('This extension lists that setting twice, so Uchiyomi cannot tell which to change.'),
  'pref.disabled': (p) => tr('{label} cannot be changed in this version of the extension.', { label: str(p, 'label') }),
  'pref.onOff': (p) => tr('{label} takes on or off.', { label: str(p, 'label') }),
  'pref.noChoice': (p) => tr('{label} has no choice "{value}".', { label: str(p, 'label'), value: str(p, 'value') }),
  'pref.choices': (p) => tr('{label} takes a list of its choices.', { label: str(p, 'label') }),
  'pref.text': (p) => tr('{label} takes text.', { label: str(p, 'label') }),
  'pref.tooLong': (p) => tr('{label} is too long.', { label: str(p, 'label') }),

  // ---- A follow refused for its language (v0.52.0, #123): the two languages by the reader's own names for them.
  'follow.languageDiffers': (p) => tr('That source is in {theirs} and this series is in {ours}. Add it as an edition in {theirs} instead: each language keeps its own chapters.', {
    theirs: languageName(str(p, 'theirs')), ours: languageName(str(p, 'ours')),
  }),
  // ...when the work holds an edition that may follow the source already: the follow belongs there.
  'follow.languageDiffersEdition': (p) => tr('That source is in {theirs} and this series is in {ours}. Follow it on the {edition} edition instead.', {
    theirs: languageName(str(p, 'theirs')), ours: languageName(str(p, 'ours')), edition: languageName(str(p, 'edition')),
  }),

  // ---- Make main refused (v0.54.0, bff lib/mainSource.ts): the Sources sheet's key and the Replace run's review.
  'numbering.postingRefusal': () => tr('This series is numbered by posting order, so another source’s chapter numbers do not line up with it.'),
  'main.isMain': () => tr('That source is already this series’ main source.'),
  'main.notFollowed': () => tr('This series does not follow that source. Only a source it follows can become its main source.'),
  'main.renumberPending': () => tr('This series’ chapters are waiting to be renumbered. Review that on the series page first.'),
  'main.unavailable': () => tr('That source cannot be used right now: it is not installed, it is switched off, or it is not available on this account.'),
  'main.moved': () => tr('This series’ main source changed meanwhile. Look again.'),

  // ---- A diagnosis's fix (bff lib/sourceDiagnosis.ts FixCode). ADMIN ONLY, like the server's.
  'fix.solverCrash': () => (isDesktop()
    ? tr('The browser inside Uchiyomi\'s built-in Cloudflare helper crashed. Quit and reopen Uchiyomi to restart it.')
    : tr('The Cloudflare solver\'s browser crashed. Chrome in Docker needs far more than the default 64 MB of shared memory: set shm_size: 1gb on the flaresolverr service and recreate it.')),
  'fix.solverDown': () => (isDesktop()
    ? tr('Uchiyomi\'s built-in Cloudflare helper is not answering. Quit and reopen Uchiyomi to restart it.')
    : tr('The Cloudflare solver is not answering. Check the container is up and FLARESOLVERR_URL is right. It also leaks memory, so it wants a periodic restart.')),
  'fix.solverTimeout': () => tr('The site presented a Cloudflare challenge the solver could not finish in time. Often transient, so re-test first. If it persists, the site has raised its protection.'),
  'fix.bypassOff': () => (isDesktop()
    ? tr('The extension engine isn\'t using Uchiyomi\'s built-in Cloudflare helper. Quit and reopen Uchiyomi to restart it.')
    : tr('The extension engine\'s own Cloudflare bypass is switched off. On the Suwayomi engine\'s container (uchiyomi-suwayomi in the shipped compose files) set FLARESOLVERR_ENABLED=true and FLARESOLVERR_URL to the same solver address Uchiyomi uses (http://uchiyomi-flaresolverr:8191 in the shipped files), then recreate it. The v0.37.0 compose files already set both, so an upgrade that recreates the engine is the fix there.')),
  'fix.engineLogin': () => (isDesktop()
    ? tr('Uchiyomi\'s extension engine refused Uchiyomi\'s own login. Quit and reopen Uchiyomi to restart both.')
    : tr('The extension engine refused Uchiyomi\'s login. Set SUWAYOMI_USERNAME and SUWAYOMI_PASSWORD to the engine\'s own basic-auth user and password (or turn its auth off), then restart Uchiyomi.')),
  'fix.engineDown': () => (isDesktop()
    ? tr('This is Uchiyomi\'s extension engine, not the site. Quit and reopen Uchiyomi to restart it.')
    : tr('This is the Suwayomi extension server, not the site. Check that container.')),
  'fix.engineTimeout': (p) => joinPart(byStage(p, {
    none: () => tr('The extension engine did not answer in time.'),
    search: () => tr('The extension engine did not answer in time while searching.'),
    chapters: () => tr('The extension engine did not answer in time while listing chapters.'),
    pages: () => tr('The extension engine did not answer in time while listing pages.'),
    images: () => tr('The extension engine did not answer in time while downloading images.'),
  }), tr('It may be busy with a slow site or a long chapter list; re-test, and if it keeps happening, check the engine\'s own log.'), 'sentence'),
  'fix.challenge': () => tr('A Cloudflare interstitial was served and not solved. Confirm the solver is healthy, then re-test.'),
  'fix.cdnRefuses': () => tr('The site\'s CDN is refusing this server outright with a 403. A challenge solver cannot fix that; it is usually a datacentre-IP block. Change egress or drop the source.'),
  'fix.rateLimited': () => tr('The downloader slows itself down on this source (one page at a time, a longer pause) for the next chapters and takes a chapter from another followed source when this one still refuses. The cooldown widens automatically and clears itself.'),
  'fix.unreachable': () => tr('The address could not be reached at all. Check the URL. The site may be gone.'),
  'fix.siteTimeout': (p) => joinPart(byStage(p, {
    none: () => tr('The extension engine answered, but the site behind the extension did not answer it in time.'),
    search: () => tr('The extension engine answered, but the site behind the extension did not answer it in time while searching.'),
    chapters: () => tr('The extension engine answered, but the site behind the extension did not answer it in time while listing chapters.'),
    pages: () => tr('The extension engine answered, but the site behind the extension did not answer it in time while listing pages.'),
    images: () => tr('The extension engine answered, but the site behind the extension did not answer it in time while downloading images.'),
  }), tr('Often transient: re-test. If it persists, the site may be down or slow for the engine.'), 'sentence'),
  'fix.extensionFailed': (p) => joinPart(byStage(p, {
    none: () => tr('The extension engine answered, but the extension itself failed.'),
    search: () => tr('The extension engine answered, but the extension itself failed while searching.'),
    chapters: () => tr('The extension engine answered, but the extension itself failed while listing chapters.'),
    pages: () => tr('The extension engine answered, but the extension itself failed while listing pages.'),
    images: () => tr('The extension engine answered, but the extension itself failed while downloading images.'),
  }), tr('Usually the site changed or refused the extension: update the extension (Admin → Sources), check its settings, or open the site in a browser. The engine\'s own message is shown with the test.'), 'sentence'),
  'fix.timeout': () => tr('A timeout alone does not say why. Re-test it: that distinguishes a moved domain, a challenge that never completed, and a genuinely slow site.'),
  'fix.disabled': () => tr('Turn it back on in Admin → Sources.'),
  'fix.moved': (p) => tr('The site now redirects to {host}. Update its address in Admin → Sources.', { host: str(p, 'host') }),
  'fix.unreachableAt': (p) => tr('The address could not be reached ({error}). Check the URL. The site may be gone.', { error: str(p, 'transport') }),
  'fix.cdnAnswered403': () => tr('The site\'s CDN answered 403 to a direct request. A challenge solver cannot fix that; it is usually a datacentre-IP block.'),
  'fix.nothingToDo': () => tr('Nothing to do. The cooldown widens automatically and clears itself.'),
  'fix.solverBroken': () => (isDesktop()
    ? tr('The site answers fine from this computer, so Uchiyomi\'s built-in Cloudflare helper is the broken part. Quit and reopen Uchiyomi to restart it.')
    : tr('The site answers fine from this server, so the Cloudflare solver is the broken part. Check that container.')),
  'fix.markupChanged': () => tr('The site answers, but its listing no longer matches the parser, so the site changed its markup. Re-add it with auto-detect to re-pick the engine.'),
  'fix.unknownLive': (p) => byStage(p, {
    none: () => tr('The live test failed while searching, and the error matches nothing known. It is shown with the test.'),
    search: () => tr('The live test failed while searching, and the error matches nothing known. It is shown with the test.'),
    chapters: () => tr('The live test failed while listing chapters, and the error matches nothing known. It is shown with the test.'),
    pages: () => tr('The live test failed while listing pages, and the error matches nothing known. It is shown with the test.'),
    images: () => tr('The live test failed while downloading images, and the error matches nothing known. It is shown with the test.'),
  }),
  'fix.unnumbered': () => tr('The extension lists this source\'s chapters, but none of them with a chapter number, so there is nothing to order, name or download. Look for a numbering option in the extension\'s own settings (Admin → Sources), or Ignore it here.'),
  'fix.emptySearch': () => tr('It answers without an error but returns nothing, which usually means the site changed its markup or is serving a challenge page. Re-test it to find out which.'),
  'fix.emptyChapters': () => tr('It finds titles, but lists no chapters for the titles it tried, which usually means the chapter list moved or changed its markup. Re-add it with auto-detect, or update the extension.'),
  'fix.emptyPages': () => tr('It lists chapters, but no pages for the chapters it tried, which usually means the reader page changed its markup or hides pages behind a script. Re-add it with auto-detect, or update the extension.'),
  'fix.testTimeout': (p) => joinPart(byStage(p, {
    none: () => tr('The live test ran out of time while searching.'),
    search: () => tr('The live test ran out of time while searching.'),
    chapters: () => tr('The live test ran out of time while listing chapters.'),
    pages: () => tr('The live test ran out of time while listing pages.'),
    images: () => tr('The live test ran out of time while downloading images.'),
  }), tr('That alone is not proof it is broken: re-test, and if it keeps happening, raise SOURCE_TEST_TIMEOUT_MS or look at the site itself.'), 'sentence'),
  'fix.tooSlow': (p) => (p.seconds != null
    ? tr('It keeps taking longer than {time} to return its newest page. Raise SOURCE_LATEST_TIMEOUT_MS if the wait is acceptable; otherwise the site itself, or the Cloudflare solver in front of it, is the slow part.', { time: durationText(num(p, 'seconds') * 1000) })
    : tr('It keeps taking longer than the time allowed to return its newest page. Raise SOURCE_LATEST_TIMEOUT_MS if the wait is acceptable; otherwise the site itself, or the Cloudflare solver in front of it, is the slow part.')),
  'fix.unknown': () => tr('The recorded error does not match anything known. Re-test it for a live verdict.'),
  'fix.unexplained': () => tr('The live test failed, and nothing recorded explains it. Re-test it and read the failing step.'),
  'fix.siteOffline': () => tr('Wait for the site to come back, or find other sources for its series.'),
};

/** A numbering row's source, by name; "Its source" when there was none to name. */
function sourceName(p: P): string {
  return p.name == null ? tr('Its source') : str(p, 'name');
}

/**
 * The same inside a sentence: "changed its source's chapter numbers", where one key read "changed Its source's…" (the
 * v0.49.1 translation review). A translation may put the name first all the same (German, French and Russian open
 * the renumbering sentences on it): `opensOnOwnWords` raises its first letter there.
 */
function sourceNameMid(p: P): string {
  return p.name == null ? tr('its source') : str(p, 'name');
}

/**
 * A sentence that opens on the page's own words for a source it could not name starts with a capital. Only then: a
 * source's own name keeps its case ("mangapill numérote…"), as the 'then' join keeps it.
 */
function opensOnOwnWords(p: P, sentence: string): string {
  return p.name == null ? cap(sentence) : sentence;
}

/** Every code this build words, for the test that holds them to the server's registry and unions. */
export const SAID_CODES = Object.keys(WORDS);

/**
 * A line in the reader's language: `said`'s parts worded and joined. Null when there is nothing to word (a server
 * older than v0.49.1), or when any part's code is one this build does not know: never a line half in each.
 */
export function saidWords(said: Said | readonly Said[] | null | undefined): string | null {
  const parts = Array.isArray(said) ? (said as readonly Said[]) : said ? [said as Said] : [];
  if (!parts.length) return null;
  let out = '';
  for (const [i, s] of parts.entries()) {
    const words = s && WORDS[s.code];
    const text = words ? words(s.params ?? {}) : null;
    if (text === null) return null;
    out = i === 0 ? text : joinPart(out, text, s.join);
  }
  return out;
}

/** The line in the reader's language (saidWords), or `fallback` -- the server's English -- when it cannot be. */
export function saidText(said: Said | readonly Said[] | null | undefined, fallback = ''): string {
  return saidWords(said) ?? fallback;
}

// ---- the fields that carry them ------------------------------------------------------------------------------

/** A Health check's summary, note, and a row's title and detail, in the reader's language (bff lib/health.ts). */
export const checkSummary = (c: { summary: string; summarySaid?: Said[] }): string => saidText(c.summarySaid, c.summary);
export const checkNote = (c: { note?: string; noteSaid?: Said[] }): string => saidText(c.noteSaid, c.note ?? '');
export const itemTitle = (i: { title: string; titleSaid?: Said }): string => saidText(i.titleSaid, i.title);
export const itemDetail = (i: { detail: string; detailSaid?: Said[] }): string => saidText(i.detailSaid, i.detail);

/**
 * A download job's, a chapter's or a server run's reason (bff routes/sources.ts, lib/downloadActivity.ts,
 * lib/downloadJobs.ts). The English decides whether there is a reason at all, the codes only its words: an entry
 * whose `reason` was taken away (a healed chapter's) says nothing, whatever codes were left beside it.
 */
export const reasonText = (x: { reason?: string | null; reasonSaid?: Said | Said[] | null } | null | undefined): string =>
  (x?.reason ? saidText(x.reasonSaid, x.reason) : '');

/** A refusal's message, from a failed API call's body: `messageSaid` worded, else the message as sent, else nothing. */
export function refusalMessage(body: { message?: string; messageSaid?: Said } | null | undefined): string {
  return saidText(body?.messageSaid, body?.message ?? '');
}
