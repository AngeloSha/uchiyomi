// The server's sentences in the reader's language (v0.49.1, lib/said.ts).
//
// Health's summaries, explainers and rows, the header's headline, a source's diagnosis, a download's reason, a
// refused renumbering: the server wrote all of it in English and the page printed it as sent. It now sends codes
// (bff lib/said.ts, lib/sourceDiagnosis.ts), and these hold the web's words to them: every code the server can send
// has words here, read from the server's own registry and unions so a new one fails by name; the words say what
// the server's English says, word for word wherever they are meant to; a code this build does not know leaves the
// whole line in the server's English; and the lines are joined the way the reader's language punctuates.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  REASON_CODES, SAID_CODES, dayText, diagnosisFix, diagnosisReason, joinPart, momentText, reasonText, refusalMessage, saidText,
  checkSummary, itemDetail, type Said,
} from '../lib/said';
import { setActiveDict } from '../lib/i18n';
import { setActiveLocale } from '../lib/format';
import { headlineText } from '../lib/healthAlert';

const BFF = join(__dirname, '..', '..', 'bff', 'src', 'lib');
const haveBff = existsSync(join(BFF, 'said.ts'));
const ISO = '2026-09-23T14:20:00.000Z';

/**
 * A sample for each parameter the server's sentences take, by name: a count follows `c` (1 or 3), so both halves of
 * every counted pair are said. A new parameter name fails until it has one here.
 */
const SAMPLE: Record<string, (c: number) => unknown> = {
  n: (c) => c, m: (c) => c, w: (c) => c, total: (c) => c, pages: (c) => c, tries: (c) => c, capped: (c) => c, series: (c) => c,
  books: (c) => c, checked: (c) => c, more: (c) => (c === 1 ? 0 : 2),
  extras: () => 4, posts: () => 13, most: () => 5, number: () => 12, done: () => 2, cap: () => 5, max: () => 6, top: () => 9001,
  median: () => 40, seconds: () => 30, days: () => 9,
  at: () => ISO, since: () => ISO, until: () => ISO,
  stage: () => 'chapters', also: () => ['pages'], status: () => 'rate_limited', by: () => 'sweep', diagnosis: () => 'cf_challenge',
  version: () => '3.4.6', latest: () => '3.5.0', root: () => 'downloads', folder: () => 'Walk/Gap', holder: () => 'Walk',
  ancestor: () => 'Walk', above: () => 'Walk', names: () => ['Manga Ball', 'MangaDex'], numbers: () => [21, 22],
  files: () => ['Chapter 1.cbz', 'Chapter 2.cbz'], cut: () => true, error: () => 'EACCES', reason: () => 'no images downloaded',
  detail: () => 'the same folder as "Walk", reached again through a mount', text: () => 'as sent', file: () => 'Chapter 21.cbz',
  label: () => 'Image quality', value: () => 'best', url: () => 'http://solver:8191', host: () => 'aquareader.org',
  transport: () => 'ENOTFOUND', name: () => 'Webtoons', source: () => 'aqua', from: () => 'Aqua', to: () => 'MangaDex',
  title: () => 'Walk Tale', ranges: () => '3-7, 12', fs: () => 'ext4', library: () => 'ext4', downloads: () => 'nfs',
};

/**
 * Codes whose web English is not the server's, on purpose -- each with why. Everything else must read word for word
 * as the server's English does (dates aside: the web says them in the reader's time zone).
 */
const DIFFERS: Record<string, string> = {
  'sources.idle': 'the server\'s "3 no series use" has no verb a translator can agree with: "3 that no series uses"',
  'sources.tested': 'the Test button by its name, as the source\'s evidence lines say it',
  'sources.failing': 'the stage as a noun: "Search step", never the search button\'s verb',
  'sources.stale': 'how long ago in the reader\'s words, not a count of days',
  'sources.status': 'a source\'s status in words ("Rate-limited"), not its code',
  'sources.until': 'a source\'s status in words',
  'sources.expired': 'a source\'s status in words',
  'failures.detail': 'the ledger\'s status in words',
  'outliers.detail': '"1 chapter" or "3 chapters", never "chapter(s)"',
  'job.notSaved': 'with its noun, "3 chapters could not be saved.": a gendered language needs one to agree with',
  'census.unreadable': 'where, as "(a folder above it)" without the server\'s stray comma ("above it,:")',
  'census.failed': 'where, without the server\'s stray comma',
  'census.stat': 'where, without the server\'s stray comma',
  'census.loop': 'where, without the server\'s stray comma',
  'pref.notConfigured': '"the extension engine", the component\'s name everywhere else in the app',
  'pref.unknownSource': '"the extension engine"',
  'pref.unreachable': '"the extension engine"',
};
/** Codes whose web English differs at a count of 1 only: the server's English says "1 chapter contain", "1 series use it". */
const ONE_DIFFERS = new Set([
  'short.live', 'failures.live', 'job.saved', 'cap.detail', 'sources.uses', 'scan.indexed',
  'frozen.noSource', 'frozen.engineDown', 'frozen.engineOff', 'frozen.switchedOff', 'frozen.overLimit', 'frozen.uninstalled',
]);

/** The parameter names a server sentence takes: its one destructured argument, read from its source. */
function paramNames(fn: (...a: never[]) => string): string[] {
  const src = fn.toString();
  if (/^\(\s*\)/.test(src)) return [];
  const m = /^\(\s*\{([^}]*)\}/.exec(src);
  assert.ok(m, `a server sentence takes something other than one destructured object -- this test cannot fill it: ${src.slice(0, 80)}`);
  return m![1].split(',').map((x) => x.split(':')[0].trim()).filter(Boolean);
}

function sample(names: string[], c: number, code: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const n of names) {
    assert.ok(SAMPLE[n], `no sample for "${n}" (bff lib/said.ts '${code}'): add one to SAMPLE`);
    out[n] = SAMPLE[n](c);
  }
  return out;
}

/** The two Englishes with their dates put aside: the server's UTC, the web's the reader's own. */
const undated = (server: string, web: string) => ({
  server: server.replace(/\d{4}-\d\d-\d\d( \d\d:\d\d)?/g, '<date>'),
  web: web.split(momentText(ISO)).join('<date>').split(dayText(ISO)).join('<date>'),
});

/** Worded: not empty, not a code, no placeholder left unfilled. */
function worded(line: string, code: string): boolean {
  return !!line.trim() && line !== code && !/\{\w+\}/.test(line) && !/\b[a-z]+\.[a-z][A-Za-z]+\b/.test(line.replace(/\.(cbz|org)\b/g, ''));
}

test('every sentence the server builds has words here, and they read as the server\'s English', async (t) => {
  if (!haveBff) { t.skip('no bff/ beside web/ in this checkout'); return; }
  // Reintroduce by deleting any entry from WORDS (lib/said.ts), say 'gaps.live': "'gaps.live' has no words" fails.
  // Change its English (drop "missing"): "'gaps.live' reads otherwise than the server" fails.
  const server = (await import(join(BFF, 'said.ts'))) as { SAID_ENGLISH: Record<string, (p: never) => string> };
  const codes = Object.keys(server.SAID_ENGLISH);
  assert.ok(codes.length > 200, `only ${codes.length} codes read from bff lib/said.ts -- the import is broken`);
  for (const code of codes) {
    const fn = server.SAID_ENGLISH[code];
    const names = paramNames(fn);
    for (const c of [3, 1]) {
      const params = sample(names, c, code);
      const english = (fn as (p: unknown) => string)(params);
      const web = saidText({ code, params }, '<the server\'s English>');
      assert.notEqual(web, '<the server\'s English>', `'${code}' has no words`);
      assert.ok(worded(web, code), `'${code}' is not worded: ${web}`);
      if (DIFFERS[code] || (c === 1 && ONE_DIFFERS.has(code))) continue;
      const u = undated(english, web);
      assert.equal(u.web, u.server, `'${code}' reads otherwise than the server (count ${c})`);
    }
  }
  // Nothing worded here that the server no longer says: a stale entry is a translation nobody will ever see.
  const fixes = [...readFileSync(join(BFF, 'sourceDiagnosis.ts'), 'utf8').matchAll(/'(fix\.[A-Za-z0-9]+)'/g)].map((m) => m[1]);
  for (const code of SAID_CODES) assert.ok(codes.includes(code) || fixes.includes(code), `'${code}' is worded here, and the server never says it`);
  // The lists of exceptions only shrink: an entry whose code is gone goes too.
  for (const code of [...Object.keys(DIFFERS), ...ONE_DIFFERS]) assert.ok(codes.includes(code), `${code} is no longer a server code: drop it from this test's exceptions`);
});

test('every diagnosis the server can reach reads as its English: each reason by its code, each fix by its own', async (t) => {
  if (!haveBff) { t.skip('no bff/ beside web/ in this checkout'); return; }
  // Reintroduce by deleting REASON_WORDS.edge_403: "diagnosis 'edge_403' has no reason" fails. Deleting
  // WORDS['fix.cdnRefuses'] fails "'fix.cdnRefuses' has no words here" -- and only that: a fix without words falls
  // back to the server's English, which is exactly what the comparison below holds it to. Changing its words fails
  // "'fix.cdnRefuses' reads otherwise". A DiagnosisCode or a FixCode the server gains fails by name below.
  const { diagnose } = (await import(join(BFF, 'sourceDiagnosis.ts'))) as { diagnose: (f: object, p?: object, base?: string) => { code: string; reason: string; fix: string; fixSaid?: Said } };
  // Comments dropped: one inside DiagnosisCode ("outright; not solvable…") ended the union at its semicolon.
  const src = readFileSync(join(BFF, 'sourceDiagnosis.ts'), 'utf8').replace(/\/\/.*$/gm, '');
  const union = (name: string): string[] => {
    const m = new RegExp(`export type ${name} =([^;]+);`).exec(src);
    assert.ok(m, `${name} is not in sourceDiagnosis.ts -- this scan is broken`);
    return [...m![1].matchAll(/'([a-zA-Z_.0-9]+)'/g)].map((x) => x[1]);
  };
  const diagnosisCodes = union('DiagnosisCode');
  const fixCodes = union('FixCode');
  assert.ok(diagnosisCodes.length >= 15 && fixCodes.length >= 25, 'the unions were not read -- this scan is broken');
  for (const code of diagnosisCodes) {
    assert.ok(REASON_CODES.includes(code), `diagnosis '${code}' has no reason here (lib/said.ts REASON_WORDS)`);
    if (code !== 'ok') assert.ok(worded(diagnosisReason({ code }), code), `diagnosis '${code}' has no words`);
  }
  // The fixes are not in the server's registry (the first test's walk): each FixCode by name, here.
  for (const code of fixCodes) assert.ok(SAID_CODES.includes(code), `'${code}' has no words here`);

  // Every rule, by the evidence that reaches it (bff test/sourceDiagnosis.test.ts has the verbatim strings).
  const facts = (lastError: string | null, o: object = {}) => ({
    status: 'down', lastError, consecutive: 1, lastOkAt: null, emptyStreak: 0, blockedUntil: null, disabled: false, ...o,
  });
  const live = (stage: string | null, kind: string, error?: string) => ({ adapterOk: false, failure: { stage, kind, error } });
  const cases: Array<[string, object, object?, string?]> = [
    ['crash', facts('flaresolverr: Error solving the challenge. Message: Service /app/chromedriver unexpectedly exited.')],
    ['down', facts("flaresolverr: HTTPConnectionPool(host='localhost', port=1): Max retries exceeded with url: /session")],
    ['solver timeout', facts('flaresolverr: Error solving the challenge. Timeout after 60.0 seconds.')],
    ['bypass', facts('suwayomi: java.io.IOException: Cloudflare bypass currently disabled')],
    ['engine login', facts('suwayomi 401')],
    ['engine down', facts('suwayomi unreachable: ECONNREFUSED')],
    ['engine timeout', facts('suwayomi timeout after 30000ms')],
    ['engine timeout, live', facts(null), live('pages', 'timeout', 'suwayomi timeout after 30000ms')],
    ['challenge', facts('Just a moment...')],
    ['403', facts('HTTP 403 Forbidden')],
    ['429', facts('HTTP 429 Too Many Requests')],
    ['unreachable', facts('getaddrinfo ENOTFOUND example.org')],
    ['site timeout', facts('suwayomi: java.net.SocketTimeoutException: timeout')],
    ['site timeout, live', facts(null), live('search', 'error', 'suwayomi: java.net.SocketTimeoutException: timeout')],
    ['extension', facts('suwayomi: HTTP error 500')],
    ['extension, live', facts(null), live('chapters', 'error', 'suwayomi: HTTP error 500')],
    ['timeout', facts('timeout after 25000ms')],
    ['disabled', facts(null, { disabled: true })],
    ['moved', facts(null), { adapterOk: false, httpStatus: 200, finalUrl: 'https://new.example.org/' }, 'https://old.example.org'],
    ['unreachable at', facts(null), { adapterOk: false, transport: 'ENOTFOUND' }, 'https://old.example.org'],
    ['403 probe', facts(null), { adapterOk: false, httpStatus: 403 }, 'https://old.example.org'],
    ['429 probe', facts(null), { adapterOk: false, httpStatus: 429 }, 'https://old.example.org'],
    ['solver broken', facts('flaresolverr: something odd'), { adapterOk: false, httpStatus: 200 }, 'https://old.example.org'],
    ['markup changed', facts(null, { emptyStreak: 3 }), { adapterOk: false, httpStatus: 200, looksHtml: true }, 'https://old.example.org'],
    ['unknown live', facts(null), live('pages', 'error', 'something nobody has seen')],
    ['unnumbered', facts(null), live('chapters', 'unnumbered')],
    ['empty search', facts(null), live('search', 'empty')],
    ['empty chapters', facts(null), live('chapters', 'empty')],
    ['empty pages', facts(null), live('pages', 'empty')],
    ['test timeout', facts(null), live('images', 'timeout')],
    ['too slow', facts('timeout after 25000ms', { slowStreak: 3, budgetMs: 30_000 })],
    ['too slow, no budget', facts('timeout after 25000ms', { slowStreak: 3 })],
    ['empty streak', facts(null, { emptyStreak: 3 })],
    ['unknown', facts('something nobody has seen')],
    ['unexplained', facts(null), { adapterOk: false }],
    // v0.49.1: the site's own offline notice, stored as its classified error (bff lib/sources/offline.ts) and seen live.
    ['site offline', facts('site_offline: the site says it is offline ("Aqua Manga is temporarily offline")')],
    ['site offline, live', facts(null), live('search', 'site_offline', 'site_offline: the site says it is offline ("Aqua Manga is temporarily offline")')],
  ];
  const seen = new Set<string>();
  for (const [what, f, probe, base] of cases) {
    const d = diagnose(f, probe, base);
    assert.ok(d.fixSaid, `${what}: the diagnosis (${d.code}) carries no fix code`);
    seen.add(d.fixSaid!.code);
    // Worded here, not the fallback: diagnosisFix() falls back to `d.fix` itself, which the comparison below passes.
    assert.notEqual(saidText(d.fixSaid, '\0'), '\0', `${what}: '${d.fixSaid!.code}' has no words here`);
    // "the extension engine", the component's name, where the server says "server" (DIFFERS above).
    if (d.code !== 'upstream_down') assert.equal(diagnosisReason(d), d.reason, `${what}: reason '${d.code}' reads otherwise than the server`);
    const fix = diagnosisFix(d);
    if (d.fixSaid!.code === 'fix.tooSlow') {
      // The budget the reader's way ("30 sec"), not the server's "30s".
      assert.match(fix, /SOURCE_LATEST_TIMEOUT_MS/);
      assert.equal(fix.replace(/30 sec/, '30s'), d.fix, `${what}: the slow source's fix reads otherwise than the server`);
    } else {
      assert.equal(fix, d.fix, `${what}: '${d.fixSaid!.code}' reads otherwise than the server`);
    }
  }
  for (const code of fixCodes) assert.ok(seen.has(code), `'${code}' is reached by none of these cases -- add the evidence that reaches it`);
  // Inside a Health row a reason ends its sentence as the server's English ends it: the server adds the full stop a
  // reason lacks (site_offline's), and the web read "…(its own page) 195 series use it". Every code but the one whose
  // words differ on purpose (DIFFERS: "the extension engine"), and in Japanese its own full stop.
  const saidServer = (await import(join(BFF, 'said.ts'))) as { SAID_ENGLISH: Record<string, (p: never) => string> };
  const inRow = saidServer.SAID_ENGLISH['sources.reason'] as (p: { diagnosis: string }) => string;
  for (const code of diagnosisCodes) {
    if (code === 'ok' || code === 'upstream_down') continue;
    assert.equal(saidText({ code: 'sources.reason', params: { diagnosis: code } }, '\0'), inRow({ diagnosis: code }),
      `sources.reason for '${code}' reads otherwise than the server`);
  }
  try {
    setActiveLocale('ja');
    setActiveDict(JSON.parse(readFileSync(join(__dirname, '..', 'public', 'locales', 'ja.json'), 'utf8')));
    assert.match(saidText({ code: 'sources.reason', params: { diagnosis: 'site_offline' } }, '\0'), /）。$/, 'in Japanese the reason does not end its sentence');
  } finally {
    setActiveLocale('en');
    setActiveDict({});
  }
  // A fix without a code (a sentence written without one) is shown as it came.
  assert.equal(diagnosisFix({ fix: 'as sent' }), 'as sent');
});

test('a source that could not be named is "its source" inside a sentence, and opens one with a capital', async (t) => {
  if (!haveBff) { t.skip('no bff/ beside web/ in this checkout'); return; }
  // One key, "Its source", read "An extension setting changed Its source's chapter numbers" and "Going back to Its
  // source's own numbers" (the v0.49.1 translation review, all eight languages). Reintroduce 'Its source' in the
  // server's remap: "the server's fallback is capitalised mid-sentence"; sourceName in the web's: "the web's fallback
  // reads otherwise than the server"; drop opensOnOwnWords: French "sa source numérote…"; cap every sentence: "a
  // source's own name loses its case".
  const server = (await import(join(BFF, 'said.ts'))) as { SAID_ENGLISH: Record<string, (p: never) => string> };
  for (const code of ['numbering.remap', 'numbering.sourceWaits']) {
    const en = (server.SAID_ENGLISH[code] as (p: { name: null }) => string)({ name: null });
    assert.match(en, /\bits source's\b/, `${code}: the server's fallback is capitalised mid-sentence`);
    assert.equal(saidText({ code, params: { name: null } }, '\0'), en, `${code}: the web's fallback reads otherwise than the server`);
  }
  assert.match(saidText({ code: 'numbering.sharedMany', params: { name: null } }, '\0'), /^Its source gives /, 'a sentence that opens on it lost its capital');
  try {
    setActiveLocale('fr');
    setActiveDict(JSON.parse(readFileSync(join(__dirname, '..', 'public', 'locales', 'fr.json'), 'utf8')));
    assert.match(saidText({ code: 'numbering.remap', params: { name: null } }, '\0'), /^Sa source numérote /, 'French opens the sentence on it in lower case');
    assert.match(saidText({ code: 'numbering.sourceWaits', params: { name: null } }, '\0'), /propres à sa source /, 'French capitalises it mid-sentence');
    assert.match(saidText({ code: 'numbering.remap', params: { name: 'mangapill' } }, '\0'), /^mangapill numérote /, 'a source\'s own name loses its case');
  } finally {
    setActiveLocale('en');
    setActiveDict({});
  }
});

test("the engine's switched-off state has its own words, never a source card's", () => {
  // "Turned off" is a source's (lib/status.ts SOURCE_LABELS), and French, Spanish and Portuguese agree it with a source:
  // the Extension engine row read "Désactivée" above "le moteur" (the v0.49.1 translation review). Reintroduce
  // tr('Turned off') for engine.switchedOff: "the engine takes a source's word" fails.
  const fr = JSON.parse(readFileSync(join(__dirname, '..', 'public', 'locales', 'fr.json'), 'utf8'));
  try {
    setActiveLocale('fr');
    setActiveDict(fr);
    assert.notEqual(saidText({ code: 'engine.switchedOff' }, '\0'), fr['Turned off'], "the engine takes a source's word");
    assert.equal(saidText({ code: 'engine.switchedOff' }, '\0'), 'Désactivé', 'the engine is not masculine in French');
  } finally {
    setActiveLocale('en');
    setActiveDict({});
  }
  assert.equal(saidText({ code: 'engine.switchedOff' }, '\0'), 'Switched off');
});

test('a line is joined the reader\'s way, and a code this build does not know leaves all of it in English', () => {
  const parts: Said[] = [
    { code: 'gaps.live', params: { n: 3 } }, { code: 'gaps.quiet', params: { n: 2 } }, { code: 'ignored', params: { n: 1 } },
  ];
  assert.equal(saidText(parts, 'x'), '3 series have missing chapters; 2 already looked into; 1 ignored', 'a summary and its tails are not joined as the server joins them');
  // Never a line half in each: a newer server's code anywhere in it, and the whole line is its English. Reintroduce
  // by skipping the unknown part: the line reads "3 series have missing chapters" with its tail lost.
  assert.equal(saidText([...parts, { code: 'from.a.newer.server' }], 'the English'), 'the English', 'a line with a code this build does not know is not all English');
  // A reason inside a row, for a diagnosis code this build does not know (Fs's site_offline, say), is the same.
  assert.equal(saidText([{ code: 'sources.reason', params: { diagnosis: 'from_a_newer_server' } }], 'the English'), 'the English');
  // So is a source status it does not know, which the source card's word would call "Healthy" in a failing row.
  // Reintroduce `sourceMark(…).label` for every status in statusText: "an unknown status is worded" fails.
  for (const code of ['sources.status', 'sources.until', 'sources.expired', 'failures.detail']) {
    const params = { status: 'from_a_newer_server', until: ISO, n: 2, series: 1, since: ISO, tries: 3, capped: 0, cap: 5, title: 'Walk Tale', number: 3, reason: null };
    assert.equal(saidText([{ code, params }], 'the English'), 'the English', `${code}: an unknown status is worded`);
  }
  assert.equal(saidText([{ code: 'sources.status', params: { status: 'rate_limited' } }]), 'Rate-limited');
  assert.equal(saidText(undefined, 'from an older server'), 'from an older server');
  // The joins, as the server's English writes them.
  assert.equal(saidText([{ code: 'job.noSpace', params: { error: 'x' } }, { code: 'job.saved', params: { done: 2, total: 5 }, join: 'period' }]),
    'Not enough free space: x. 2 of 5 chapters saved.');
  assert.equal(saidText([{ code: 'sources.turnedOff' }, { code: 'sources.uses', params: { n: 0 } }]), 'turned off by you; no series use it');
  assert.equal(saidText([{ code: 'sources.inconclusive', params: { stage: 'pages' } }, { code: 'sources.uses', params: { n: 0 }, join: 'dashCap' }]),
    'the last test ran out of time while listing pages — not proof it is broken — No series use it');
  // In Japanese and Arabic, their own marks: "；" and "؛", "（…）", and no space between sentences.
  try {
    setActiveLocale('ja');
    assert.equal(joinPart('A', 'B', 'clause'), 'A；B');
    assert.equal(joinPart('A。', 'B', 'sentence'), 'A。B');
    assert.equal(joinPart('A。', 'b', 'then'), 'A。b', 'in Japanese, a sentence that opens on a name is joined otherwise');
    assert.equal(joinPart('A', 'B', 'paren'), 'A（B）');
    setActiveLocale('ar');
    assert.equal(joinPart('أ', 'ب', 'clause'), 'أ؛ ب');
  } finally {
    setActiveLocale('en');
  }
});

test('a sentence that opens on a source\'s name keeps the name as the source spells it, as the server\'s English does', async () => {
  // The engine row's "…fail until it is. mangapill fails because of it." joins with 'then' (bff lib/engineHealth.ts):
  // the 'sentence' join raised the first letter and renamed the source. Reintroduce `cap(b)` for 'then' in
  // joinPart: "a source's name is capitalised" fails.
  const parts: Said[] = [
    { code: 'engine.helperIsOff' },
    { code: 'engine.failing', params: { names: ['mangapill'], more: 0, n: 1 }, join: 'then' },
  ];
  const english = 'The engine’s own Cloudflare helper is not in use: it is switched off. Extension sources on Cloudflare-protected sites fail until it is. mangapill fails because of it.';
  assert.equal(saidText(parts), english, 'a source\'s name is capitalised');
  if (haveBff) {
    const server = (await import(join(BFF, 'said.ts'))) as { englishOf: (s: Said[]) => string | null };
    assert.equal(server.englishOf(parts), english, 'the server\'s English capitalises a source\'s name');
  }
});

test('Health\'s cards, rows, headline, refusals and reasons read their codes, and their English without them', () => {
  const check = {
    id: 'sources', title: 'Source health', status: 'warn' as const, summary: '1 source is failing or blocked', items: [],
    summarySaid: [{ code: 'sources.live', params: { n: 1 } }],
  };
  assert.equal(checkSummary(check), '1 source is failing or blocked');
  assert.equal(checkSummary({ summary: 'as the server said' }), 'as the server said', 'a server older than v0.49.1');
  assert.equal(itemDetail({ detail: 'x', detailSaid: [{ code: 'short.detail', params: { number: 3, pages: 1 } }] }), 'Chapter 3 has 1 page');
  // The header: the worst check's title and summary, from checks[0] -- never the stored English when there are codes;
  // a summary stored before v0.49.1, as stored. Reintroduce `return s.headline` in headlineText: "the headline is
  // the stored English" fails (and the banner reads English whatever the page's language).
  assert.equal(headlineText({ headline: 'Source health: in English', checks: [check] }), 'Source health: 1 source is failing or blocked',
    'the headline is the stored English');
  assert.equal(headlineText({ headline: 'stored before', checks: [{ id: 'sources', title: 'Source health', status: 'warn', summary: 'x' }] }), 'stored before');
  assert.equal(headlineText({ headline: null, checks: [] }), null);
  assert.equal(reasonText({ reason: 'x', reasonSaid: [{ code: 'job.partial', params: { number: 21, n: 3 } }] }), 'Chapter 21 saved with 3 pages missing');
  assert.equal(reasonText({ reason: 'the site\'s own error' }), 'the site\'s own error');
  // The English decides whether there is a reason, the codes only its words: an entry whose reason was taken away (a
  // healed chapter, lib/downloadActivity.ts) and whose codes were left says nothing. Reintroduce
  // `saidText(x?.reasonSaid, x?.reason ?? '')`: "a reason taken away is still said" fails.
  for (const reason of [undefined, null, '']) {
    assert.equal(reasonText({ reason, reasonSaid: [{ code: 'activity.saved', params: { n: 2 } }] }), '', `a reason taken away is still said (${reason})`);
  }
  assert.equal(refusalMessage({ message: 'x', messageSaid: { code: 'renumber.onDisk', params: { file: 'Chapter 21.cbz' } } }), 'Chapter 21.cbz is already on disk');
});

test('in German, a Health summary, a row and a date read in German, in the reader\'s own time', () => {
  // The words are real translations (web/test/localeCoverage.test.ts holds every key in all eight files); this
  // holds the wiring: the dictionary is what the codes are worded through, and a date is the reader's.
  const de = JSON.parse(readFileSync(join(__dirname, '..', 'public', 'locales', 'de.json'), 'utf8'));
  // Said (and so built) in English first: the formatters are built once per language (lib/format.ts `cached`), and a
  // change of language must build them again. Drop `formatters.clear()` from setActiveLocale: this fails.
  const inEnglish = [dayText(ISO), momentText(ISO)];
  try {
    setActiveDict(de);
    setActiveLocale('de');
    assert.notDeepEqual([dayText(ISO), momentText(ISO)], inEnglish, 'a date keeps the language it was first said in');
    const one = saidText([{ code: 'sources.live', params: { n: 1 } }]);
    assert.equal(one, de['1 source is failing or blocked'], 'a summary is not worded through the German dictionary');
    assert.notEqual(one, '1 source is failing or blocked', 'German reads English');
    const since = saidText({ code: 'numbering.since', params: { at: ISO } });
    assert.ok(since.includes(dayText(ISO)) && !since.includes('2026-09-23'), `the date is not the reader's: ${since}`);
    // A summary with a newer server's code in it cannot be worded, so the whole headline is the stored English --
    // never the title in German beside a summary in English. Reintroduce `checkSummary(c)` for the summary in
    // headlineText: "the headline is half German" fails.
    const newer = { id: 'sources', title: 'Source health', status: 'warn' as const, summary: 'a newer summary', summarySaid: [{ code: 'from.a.newer.server' }] };
    assert.equal(headlineText({ headline: 'Source health: a newer summary', checks: [newer] }), 'Source health: a newer summary',
      'the headline is half German');
  } finally {
    setActiveDict({});
    setActiveLocale('en');
  }
});

test('a moment is said in the reader\'s own time zone, never the UTC the server\'s English prints', () => {
  // 14:20 UTC is 23:20 in Tokyo. In a child process, whose TZ is set before anything is built: a formatter keeps the
  // time zone it was built in, and this process has built its own already (lib/format.ts `cached`). Reintroduce
  // `timeZone: 'UTC'` in momentText: "the moment is not the reader's" fails.
  const script = "import { momentText } from './lib/said.ts'; import { setActiveLocale } from './lib/format.ts';"
    + ` setActiveLocale('de'); process.stdout.write(momentText('${ISO}'));`;
  const r = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: join(__dirname, '..'), env: { ...process.env, TZ: 'Asia/Tokyo' }, encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\b23:20\b/, `the moment is not the reader's: ${r.stdout}`);
});

test('a stage named mid-sentence is lower-case, as the server\'s English says it; German nouns keep their capital', () => {
  // A source row's "(also chapter list, page list)". Reintroduce `also.map(stageName)` in 'sources.failing': the
  // English reads "(also Chapter list, Page list)", and "a stage mid-sentence is capitalised" fails.
  const row: Said = { code: 'sources.failing', params: { stage: 'search', since: ISO, also: ['chapters', 'pages'] } };
  assert.match(saidText(row), /^Search step failing since .+ \(also chapter list, page list\)$/, 'a stage mid-sentence is capitalised');
  const cases: Array<[string, RegExp]> = [
    ['ru', /^Поиск: .+ \(также список глав, список страниц\)$/],
    ['pt-BR', /^Busca .+ \(também lista de capítulos, lista de páginas\)$/],
    ['de', /^Suche: .+ \(auch Kapitelliste, Seitenliste\)$/],
  ];
  try {
    for (const [locale, want] of cases) {
      setActiveDict(JSON.parse(readFileSync(join(__dirname, '..', 'public', 'locales', `${locale}.json`), 'utf8')));
      setActiveLocale(locale);
      assert.match(saidText(row), want, `${locale}: the stages mid-sentence read otherwise`);
    }
  } finally {
    setActiveDict({});
    setActiveLocale('en');
  }
});

test('every view that prints a download\'s reason words it: Library → Downloads, the series band, Discover, Find missing', () => {
  // The job card's, the run card's and a chapter's reason come with codes (bff routes/sources.ts, lib/downloadJobs.ts,
  // lib/downloadActivity.ts); a view that prints `.reason` itself prints English in every language. Reintroduce
  // `{a.job.reason || tr('Fetch stopped. Try another source or wait.')}` in ServerDownloadsView: it is named here.
  const ROOT = join(__dirname, '..');
  for (const f of ['components/ServerDownloadsView.tsx', 'components/SeriesServerDownloads.tsx', 'app/discover/page.tsx',
    'components/FindMissingDialog.tsx', 'app/series/page.tsx']) {
    const src = readFileSync(join(ROOT, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const bare = src.match(/\{[^{}]*\b(?:j|r|f|a\.job|failed\.job|job|ended)\??\.reason\s*(?:\|\||\?\s*[`'])[^{}]*\}|toast\([^)]*\bended\??\.reason\s*\|\|/g);
    assert.equal(bare, null, `${f} prints a reason as the server wrote it: ${bare?.join(' | ')}`);
    assert.match(src, /reasonText\(/, `${f} no longer words a reason`);
  }
});

// ⚠️ LAST: noteServerDesktop is sticky for the life of the module, and every test above reads the server's words.
test('on the desktop app, every platform wording says Uchiyomi, never a container, an env var or a compose file', async () => {
  // Reintroduce by returning the server's sentence from 'fix.solverCrash' on desktop: "shm_size" fails it.
  const { noteServerDesktop } = await import('../lib/desktop');
  noteServerDesktop(true);
  const DOCKERISH = /PUID|PGID|chown|docker|compose|(?<!process)\.env\b|container|\buid\b|shm_size|FLARESOLVERR_|SUWAYOMI_|10002/i;
  const DESKTOP = [
    'solver.down', 'solver.downNote', 'solver.failingNote', 'cap.note', 'cap.title', 'cap.detail', 'frozen.overLimit',
    'fix.solverCrash', 'fix.solverDown', 'fix.bypassOff', 'fix.engineLogin', 'fix.engineDown', 'fix.solverBroken',
  ];
  for (const code of DESKTOP) {
    const line = saidText({ code, params: { n: 2, cap: 25, source: 'sw:1', url: 'http://127.0.0.1:1/token', error: null } });
    assert.ok(line && !DOCKERISH.test(line), `${code} on desktop: ${line}`);
    assert.ok(!line.includes('token'), `${code} prints the helper's address on desktop`);
  }
});
