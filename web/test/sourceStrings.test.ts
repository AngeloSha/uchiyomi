// The English source strings the translators flagged (v0.49.0, i18n pass 1).
//
// Sixteen native reviewers in eight languages flagged 37 keys: counts with no singular that show at a count of one,
// dead keys, English that reads two ways ("the read library", "no longer copy", "at its floor"), a count glued on
// in English word order, a button left in English. A key IS its English string, so most fixes are new keys, and
// localeCoverage.test.ts holds those in all eight files. What no English assertion can see is a singular: "1
// updated" reads the same whether it came from '1 updated' or from '{n} updated' filled with 1, and only the second
// is "1 atualizadas" in Portuguese. So the counted lines here are translated with a dictionary that MARKS a count
// once it is filled.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setActiveDict } from '../lib/i18n';
import { taskResult } from '../lib/tasks';
import { outcomeLine } from '../lib/healthCopy';
import { sweepToast } from '../lib/sourceEvidence';
import { stillLine } from '../lib/engineSetup';
import { deviceName, shownDeviceName } from '../lib/device';
import { scanState } from '../components/HealthActions';
import { healthLine } from '../lib/chapterPicker';
import type { HealthOutcome } from '../lib/types';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

/**
 * Every key the app ships, "translated" into itself with each count placeholder marked: '{n} updated' renders
 * "1′ updated" for one, where '1 updated' renders "1 updated". es.json's keys are the app's (library.test.ts holds
 * the eight files to one set).
 */
function markedCounts(): Record<string, string> {
  const es = JSON.parse(read('public/locales/es.json')) as Record<string, unknown>;
  return Object.fromEntries(Object.keys(es).filter((k) => k !== '_meta').map((k) => [k, k.replace(/\{(n|m|count)\}/g, '{$1}′')]));
}
function marked<T>(f: () => T): T {
  setActiveDict(markedCounts());
  try { return f(); } finally { setActiveDict({}); }
}
/** Counts of one that went into a plural key. */
const onesFilled = (s: string): string[] => s.match(/(?<![\d.,])1′/g) ?? [];

test('a count of one takes its singular key, never a plural key filled with 1', () => {
  // Reintroduce any one of them -- `tr('{n} updated', { n: updated })` for every count in lib/tasks.ts, the scan's
  // `{m}` keys for one series, `'{n} of {m} sources answered'` for a chapter asked once: its line below names
  // the "1′" it filled. The marks are real: a count of two shows one (the last assertion).
  const repair = marked(() => taskResult({
    counted: 1, uncounted: 1,
    short: { looked: 3, replaced: 1, confirmed: 1, left: 1 },
    gaps: { series: 1, followed: 1, fetched: 1, unfillable: 0, sweep: 0 },
    groups: { looked: 2, replaced: 1, left: 1 },
    directions: { asked: 1, learned: 1 },
    failures: { reset: 1, retried: { series: 1, added: 1, failed: 1 } },
    solver: { reset: true, unblocked: 1, expired: 1 },
  }));
  assert.deepEqual(onesFilled(repair), [], `the repair line said a count of one with a plural key: ${repair}`);
  const verify = marked(() => taskResult({ checked: 1, missing: 1, readLibraryMissing: 1, unmounted: ['/library-dl'] }));
  assert.deepEqual(onesFilled(verify), [], `the verify line said a count of one with a plural key: ${verify}`);
  const extensions = marked(() => taskResult({
    refreshed: true, autoUpdate: false, updated: ['A'], failed: [{ name: 'B' }], updatesAvailable: ['C'], obsolete: ['D'], reinstalled: ['E'],
  }));
  assert.deepEqual(onesFilled(extensions), [], `the extension line said a count of one with a plural key: ${extensions}`);
  // The read-chapter cleanup and the chapter sweep (web2s review): "1 could not be deleted" and "+1 chapters" were
  // the plural key filled with one.
  const cleanup = marked(() => taskResult({ deleted: 1, bytes: 1024, failed: 1 }));
  assert.deepEqual(onesFilled(cleanup), [], `the cleanup line said a count of one with a plural key: ${cleanup}`);
  const sweep = marked(() => taskResult({ added: 1, healthy: false, failed: 1, chapterFailures: 1 }));
  assert.deepEqual(onesFilled(sweep), [], `the sweep line said a count of one with a plural key: ${sweep}`);
  for (const [series, books] of [[1, 1], [1, 7], [4, 1]]) {
    const s = marked(() => scanState({ scanned: true, series, books }, Date.now()));
    const said = s.kind === 'done' ? s.outcome ?? '' : '';
    assert.ok(said.startsWith('Scan done:'), `a scan of ${series} series and ${books} chapters said ${JSON.stringify(s)}`);
    assert.deepEqual(onesFilled(said), [], `a scan of ${series} series and ${books} chapters: ${said}`);
  }
  // A chapter of a series that follows one source is asked once; nobody answering is the common case.
  const once: HealthOutcome = { kind: 'short', at: new Date().toISOString(), why: 'source_silent', asked: 1, answered: 0 } as HealthOutcome;
  const asked = marked(() => outcomeLine(once));
  assert.match(asked, /0′ of 1 source answered/);
  assert.deepEqual(onesFilled(asked), [], `a chapter asked once: ${asked}`);
  const toast = marked(() => sweepToast({ needsAttention: [1], inconclusive: [1] }).text);
  assert.deepEqual(onesFilled(toast), [], `the check-all toast: ${toast}`);
  assert.match(marked(() => taskResult({ refreshed: true, autoUpdate: true, updated: ['A', 'B'] })), /2′ updated/, 'the marking dictionary is not in use');
});

test('a source\'s streak is inside ONE sentence per status, never glued on in English order', () => {
  // "rate-limited us" + " 3 times in a row" put the count after the verb, which German and Japanese cannot say.
  // Reintroduce the glued `tr('{n} times in a row').replace('{n}', …)`: the first assertion fails (and the key is
  // in no locale file any more, so localeCoverage names it too).
  const src = read('components/FindMissingDialog.tsx');
  assert.doesNotMatch(src, /tr\('\{n\} times in a row'\)/, 'the streak is glued after a separately translated verb');
  const lib = read('lib/chapterPicker.ts');
  const fn = lib.slice(lib.indexOf('export function healthLine('));
  for (const k of ['rate-limited us', 'refused us', 'did not answer']) {
    assert.ok(fn.includes(`tr('${k} {n} times in a row', { n })`), `"${k}" has no whole sentence with its streak inside`);
    assert.ok(fn.includes(`tr('${k}')`), `"${k}" is not said on its own for a single failure`);
  }
  assert.match(src, /\{tr\('Recently unreliable'\)\} · \{healthLine\(c\.health\)\}/, 'the health line does not use the whole sentences');
});

test('one failure is the bare status, and the streak is said from two on', () => {
  // The streak sentences need no "1 time" key only because a single failure never reaches them (localeCoverage's
  // NOT_PAIRED says so). Reintroduce `n >= 1` on any line of healthLine: its "1" assertion here names the status,
  // reading "refused us 1 times in a row" (web2s review: nothing caught it).
  for (const [status, bare] of [['rate_limited', 'rate-limited us'], ['blocked', 'refused us'], ['down', 'did not answer']] as const) {
    assert.equal(healthLine({ status, consecutive: 1 }), bare, `${status}: one failure is said as a streak of 1`);
    assert.equal(healthLine({ status, consecutive: 0 }), bare, `${status}: no failure in a row is said as a streak`);
    assert.equal(healthLine({ status }), bare, `${status}: a count the server did not send is said as a streak`);
    assert.equal(healthLine({ status, consecutive: 3 }), `${bare} 3 times in a row`, `${status}: a streak of 3 is not said`);
  }
});

test('Admin → Providers says Reload sources, its busy word and its toasts in the reader\'s language', () => {
  // It stayed English beside a translated "Check all now" (i18n pass 1, pt-BR). Reintroduce
  // `{reloading ? 'Reloading…' : '↻ Reload sources'}`: "the reload key is English" fails.
  const page = read('app/admin/page.tsx');
  assert.match(page, /\{reloading \? tr\('Reloading…'\) : `↻ \$\{tr\('Reload sources'\)\}`\}/, 'the reload key is English');
  assert.doesNotMatch(page, /'↻ Reload sources'|: 'Reloading…'|toast\(`Reloaded|toast\('Reload failed'/, 'a reload word is left in bare English');
  assert.match(page, /toast\(r\.available === 1 \? tr\('Reloaded — 1 source available'\) : tr\('Reloaded — \{n\} sources available', \{ n: r\.available \}\), 'success'\)/,
    'the reload toast is English, or has no singular');
  assert.match(page, /toast\(tr\('Reload failed'\), 'error'\)/);
});

test('the engine card says "Still no answer" without a reason it does not have, and one try as a time', () => {
  // "Still no answer: no reply" said it twice. Reintroduce `s.error || tr('no reply')`: the first assertion reads
  // "Still no answer: no reply".
  assert.equal(stillLine({ configured: true, reachable: false }), 'Still no answer');
  assert.equal(stillLine({ configured: true, reachable: false, error: 'fetch failed' }), 'Still no answer: fetch failed');
  const card = read('components/EngineSetup.tsx');
  assert.match(card, /const why = msgOf\(e, ''\);\n\s*setStill\(why \? tr\('Still no answer: \{reason\}', \{ reason: why \}\) : tr\('Still no answer'\)\);/,
    'Check again still pads a missing reason with "no reply"');
  // One try has no "since" ("Tried 1 time since 14:02"): it happened AT that time.
  assert.match(card, /retry\.attempts === 1\n\s*\? tr\('Tried once, at \{time\} · next try \{when\}'/, 'one try is said as "1 time since"');
});

test('a device the browser does not name is "another device" in the reader\'s words, never an English "Browser"', () => {
  // The name is stored at sign-in and shown on every device in its reader's language: "no Browser" in Portuguese.
  // Reintroduce `return 'Browser';` in deviceName(): the first assertion fails; let shownDeviceName pass names
  // through: the stored "Browser" of an older sign-in is shown.
  const had = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const as = (userAgent: string) => Object.defineProperty(globalThis, 'navigator', { value: { userAgent }, configurable: true });
  try {
    as('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36');
    assert.equal(deviceName(), undefined, 'an unknown platform is named in English');
    as('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148');
    assert.equal(deviceName(), 'iPhone');
  } finally {
    if (had) Object.defineProperty(globalThis, 'navigator', had);
    else delete (globalThis as { navigator?: unknown }).navigator;
  }
  assert.equal(shownDeviceName('Browser'), null, 'an older sign-in\'s English "Browser" is shown');
  assert.equal(shownDeviceName('device'), null);
  assert.equal(shownDeviceName(null), null);
  assert.equal(shownDeviceName('Android'), 'Android');
  assert.match(read('components/ProfileAccount.tsx'), /\{shownDeviceName\(s\.device_name\) \|\| tr\('Device'\)\}/,
    'the session list shows a stored English fallback');
  // Admin → Sessions is the other session list (web2s review): it printed the stored name raw, with a bare-English
  // "Device". Reintroduce `{s.device_name || 'Device'}` there: this names it.
  const admin = read('app/admin/page.tsx');
  const sessions = admin.slice(admin.indexOf('function Sessions('), admin.indexOf('\n}\n', admin.indexOf('function Sessions(')));
  assert.match(sessions, /\{shownDeviceName\(s\.device_name\) \|\| tr\('Device'\)\}/, 'Admin → Sessions shows a stored English fallback, or "Device" in English');
  assert.doesNotMatch(sessions, /device_name \|\| 'Device'/, 'Admin → Sessions still has the bare-English "Device"');
});

test('the device names the server stores in English are shown in the reader\'s words, and a sign-in method is no place', () => {
  // v0.49.1: the desktop window signs in as 'This PC' and single sign-on as 'SSO' (bff routes/auth.ts), stored as the
  // session's device name and shown in English in every language. Reintroduce by passing them through as stored:
  // the German session list reads "This PC".
  const de = JSON.parse(read('public/locales/de.json')) as Record<string, string>;
  assert.ok(de['This PC'] && de['This PC'] !== 'This PC' && de['Single sign-on'] && de['Single sign-on'] !== 'Single sign-on', 'PREMISE: both are translated');
  setActiveDict(de);
  try {
    assert.equal(shownDeviceName('This PC'), de['This PC'], 'the desktop window\'s stored name is shown in English');
    assert.equal(shownDeviceName('SSO'), de['Single sign-on'], 'a single sign-on is shown as the English "SSO"');
    assert.equal(shownDeviceName('iPhone'), 'iPhone', 'a platform is a name');
    // "on {device}": a single sign-on says how, not where, so ContinueCard says "another device" for it.
    assert.equal(shownDeviceName('SSO', { device: true }), null, 'a sign-in method reads as a place');
    assert.equal(shownDeviceName('This PC', { device: true }), de['This PC']);
  } finally {
    setActiveDict({});
  }
  assert.match(read('components/cards.tsx'), /shownDeviceName\(elsewhere\.name, \{ device: true \}\) \|\| tr\('another device'\)/,
    'the Continue card names a sign-in method as a device');
});

/** The source with its comments gone, JSX ones included: what renders, and what the checks below read. */
const code = (src: string): string =>
  src.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
/**
 * JSX text a person reads that is not a tr() call: words between a tag's `>` and the next `<`. Code has `(`, `;` or
 * `=` in it (an arrow's `=>` then a call, a generic's `>` then its argument) and JSX text as good as never does. Nor
 * does it follow an arrow's `>` (`queryFn: () => api<Page>(…)` read as the text "api"), or hold `&&` or `||` (a
 * comparison's `>` before a condition: `{n > MAX && <span`).
 */
const bareText = (src: string): string[] =>
  [...code(src).matchAll(/(?<!=)>([^<>{}();=]*[A-Za-z]{2,}[^<>{}();=]*)</g)].map((m) => m[1].trim()).filter((t) => t && !/&&|\|\|/.test(t));
/** A toast, a confirm or an error fallback written as an English template or string, not through tr(). */
const bareCalls = (src: string): string[] =>
  [...code(src).matchAll(/\b(?:toast|confirm|msgOf\([^,]+,)\s*\(?\s*(`[^`]*[A-Za-z]{3,}[^`]*`|'[^']*[A-Za-z]{3,}[^']*')/g)].map((m) => m[1]);

test("Admin → Extensions → Languages and the Offline page say nothing in bare English", () => {
  // v0.49.1: pre-existing English in every language -- the Languages panel's heading, counts, note, empty line and
  // paragraph, the over-the-limit banner and the hide/show toasts; the Offline page's counts ("Deleted ${n} chapters",
  // "12 chapters · …"), its confirms and its storage line. Reintroduce any one of them as it was: this names it.
  // v0.53.0: the Languages panel is a sheet of its own (components/ExtensionLanguages.tsx), toggleLang with it.
  const panel = read('components/ExtensionLanguages.tsx');
  assert.ok(panel.includes('/api/admin/extensions/sources/bulk') && panel.includes("tr('Languages')"), 'PREMISE: the file holds toggleLang and the Languages panel');
  assert.deepEqual(bareText(panel), [], 'bare English text in the Languages panel');
  assert.deepEqual(bareCalls(panel), [], 'a bare English toast in the Languages panel');
  const offline = read('app/downloads/page.tsx');
  assert.deepEqual(bareText(offline), [], 'bare English text on the Offline page');
  assert.deepEqual(bareCalls(offline), [], 'a bare English toast or confirm on the Offline page');
  assert.doesNotMatch(code(offline), /label: '[A-Z]/, 'a bare English button label on the Offline page');
  // The counts beside them, one pair each (localeCoverage.test.ts holds every pair in the app to its other half).
  assert.match(read('app/library/page.tsx'), /total === 1 \? tr\('1 series'\) : tr\('\{n\} series', \{ n: total \}\)/, 'the library counts its series in English');
  assert.match(read('app/series/page.tsx'), /momentCount === 1 \? tr\('1 saved page'\)/, '"1 saved pages" on the series page');
  assert.match(read('components/SourcePicker.tsx'), /count === 1 \? tr\('1 source'\)/, '"All sources · 1 sources" on Discover');
});

test("the rest of Admin → Extensions, and Providers' source rows, say nothing in bare English", () => {
  // v0.52.0: the catalogue's paragraph, the out-of-date banner and its Update all, a row's Update / Add / Remove and
  // obsolete tag, the Added filter, the "Showing n of m" line and the add / update / remove toasts were English in
  // every language; so were Providers' Enable / Disable and their toasts, which every MangaDex language's row now
  // carries. Reintroduce any one as it was -- `{busy === '__updateall' ? 'Updating…' : 'Update all'}`, say -- and
  // this names it.
  const admin = read('app/admin/page.tsx');
  const between = (src: string, a: string, b: string) => {
    const i = src.indexOf(a);
    const j = b ? src.indexOf(b, i) : src.length;
    assert.ok(i >= 0 && j > i, `PREMISE: ${a} … ${b} is not where this test looks`);
    return src.slice(i, j);
  };
  // v0.53.0: the tab is components/ExtensionsPanel.tsx and its sheets; the engine's header is EngineSetup.tsx's.
  const ext = [
    read('components/ExtensionsPanel.tsx'), read('components/ExtensionSheet.tsx'), read('components/ExtensionRepos.tsx'),
    read('components/ExtensionBits.tsx'), between(read('components/EngineSetup.tsx'), 'export function EngineReady(', ''),
  ].join('\n');
  const rows = between(admin, 'function controlsOf(', 'function sourceCard(');
  /**
   * Any word of English in a string or template left outside tr(): a label a ternary picks (`? 'Update' :`), a toast's
   * other arm (`n ? updated : 'Everything is already up to date'`), a template a toast is built from. A key compared
   * with `===` ('Enter') is not shown to anyone.
   */
  const bareLiterals = (src: string): string[] => {
    const c = code(src).replace(/\btr\(\s*('(?:[^'\\\n]|\\.)*'|`[^`]*`)/g, 'tr(').replace(/[!=]==\s*'[^']*'/g, '');
    return [...c.matchAll(/'((?:[^'\\\n]|\\.)*)'|`([^`]*)`/g)].map((m) => (m[1] ?? m[2]).replace(/\$\{[^}]*\}/g, ' '))
      .filter((t) => /\b[A-Z][a-z]+\b/.test(t) || /\b[a-z]{3,} [a-z]{3,}\b/.test(t));
  };
  // Whole files since v0.53.0, so what a file says to the bundler (its imports, 'use client') and a class list a
  // ternary picks are not words anyone reads: a class list is tokens of Tailwind's shape with one hyphenated at least.
  // An English phrase in lower case ("none of its sources are on") has no hyphenated token, and is still caught.
  const isClassList = (t: string) => t.trim().split(/\s+/).every((w) => /^[a-z0-9:[\]/.%!-]+$/.test(w)) && /(^|\s)-?[a-z]+-[a-z0-9[]/.test(t.trim());
  const program = (src: string) => src.split('\n').filter((l) => !/^\s*(import\b|'use client';)/.test(l) && !/^\s*\} from '/.test(l)).join('\n');
  for (const [name, src] of [['Admin → Extensions', program(ext)], ["Providers' source rows", rows]] as const) {
    assert.deepEqual(bareText(src), [], `bare English text in ${name}`);
    assert.deepEqual(bareCalls(src), [], `a bare English toast in ${name}`);
    assert.deepEqual(bareLiterals(src).filter((t) => !isClassList(t)), [], `bare English in a string in ${name}`);
  }
  // Counted, one sentence per count (localeCoverage.test.ts holds each pair to its other half). Round 2's group headers
  // agree with their count in most of the eight ("Requiere atención · 1", "Requieren atención · 3").
  assert.match(ext, /g\.list\.length === 1 \? tr\('Needs attention · 1'\) : tr\('Needs attention · \{n\}', \{ n: g\.list\.length \}\)/,
    'a group of one is said with the plural');
  assert.match(ext, /repos\.length === 1 \? tr\('1 repository'\) : tr\('\{n\} repositories', \{ n: numberText\(repos\.length\) \}\)/, '"1 repositories"');
  assert.match(ext, /first\.matched === 1 \? tr\('1 extension matches'\) : tr\('\{n\} extensions match', \{ n: numberText\(first\.matched\) \}\)/,
    '"1 extensions match"');
  assert.match(ext, /ext\.used === 1 \? tr\('1 series from it will stop updating but stay readable\.'\)/, 'Remove counts one series in the plural');
});
