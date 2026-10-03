// Adding an extension repository, made obvious (v0.45.0), in Admin → Extensions as v0.53.0 lays it out: read from source.
//
// The owner's ask was "mention better how to add the extensions repo so people know how to do it", and the
// audit found the UI itself in the way: the input sat behind a collapsed "Manage" row even with no repository
// at all (while the empty catalogue said "add a repository above"), the placeholder named a file Mihon users do
// not have, the server's reason for a refusal was never shown, and not one string of the flow was translated.
// Since v0.53.0 the form stands on Browse itself on a first visit (components/ExtensionsPanel.tsx) and is a sheet
// behind the repositories link in Browse's count line after that (components/ExtensionRepos.tsx); since v0.54.0 Browse
// is part of Admin → Sources' Add sources (components/SourcesPanel.tsx). Each rule is pinned here and names the edit
// that brings its fault back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
/** The file with its comments removed -- several comments quote the code they forbid. */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const slice = (src: string, from: string, to: string): string => {
  const a = src.indexOf(from);
  const b = to ? src.indexOf(to, a + 1) : src.length;
  assert.ok(a >= 0 && b > a, `${from} … ${to} is not where this test looks`);
  return src.slice(a, b);
};
const trKeys = (src: string): Set<string> => {
  const keys = new Set<string>();
  for (const m of src.matchAll(/\btr\(\s*'((?:[^'\\]|\\.)*)'/g)) keys.add(m[1].replace(/\\'/g, "'"));
  return keys;
};

const panel = code(read('components/ExtensionsPanel.tsx'));
const sources = code(read('components/SourcesPanel.tsx'));
const repos = code(read('components/ExtensionRepos.tsx'));
const browse = slice(panel, 'function BrowseView(', 'function NothingFound(');
const form = slice(repos, 'export function RepoForm(', 'export function ReposSheet(');

test('with no repository, the form stands on Browse itself, and a list with no source offers the way to add one', () => {
  // Reintroduce by showing the catalogue's empty line instead (`firstRun` gone): a first visit says "add a repository"
  // with no field in sight -- the v0.45.0 audit's first finding. Your sources lists the built-ins and MangaDex, so it is
  // the first view; with no source at all it says how to add one and offers Add sources. Drop that key: this fails.
  assert.match(browse, /const firstRun = noRepos && !!first && first\.total === 0;/, 'the first-run card is not decided by "no repository, empty catalogue"');
  assert.match(browse, /\{firstRun \? \(\s*<div className="[^"]*" data-ext-first-run>[\s\S]*?<RepoForm \/>/, 'the first visit has no repository field');
  assert.match(browse, /tr\('An extension repository is a list of extensions that someone publishes\. Uchiyomi doesn’t host any, so you add one you trust\.'\)/,
    'the first visit does not say what a repository is');
  const empty = slice(sources, 'data-sources-empty>', '</div>');
  assert.match(empty, /<button type="button" onClick=\{onAdd\} className="btn-key mt-3">\{tr\('Add sources'\)\}<\/button>/, 'a list with no source has no way to add one');
  assert.match(sources, /onAdd=\{\(\) => setView\('add'\)\}/, 'Add sources in the empty list does not open Add sources');
  // Later, the repositories are one press away, counted, as a link in Browse's count line (round 2: a key before).
  assert.match(browse, /<button type="button" onClick=\{onRepos\} className="text-accent hover:underline" data-ext-repos>\s*\{!repos \? tr\('Repositories'\) : repos\.length === 1 \? tr\('1 repository'\)/, 'Browse has no way to the repositories');
  assert.match(repos, /export function ReposSheet\([\s\S]*?<RepoForm \/>/, 'the repositories sheet cannot add one');
});

test('the input asks for the address Mihon users have, and the help says where Mihon keeps it', () => {
  // Reintroduce by putting back `placeholder="https://…/index.json"`: the first assertion fails.
  assert.match(form, /placeholder="https:\/\/…\/index\.min\.json"/, 'the placeholder does not show the index.min.json shape');
  assert.doesNotMatch(form, /placeholder="https:\/\/…\/index\.json"/);
  assert.match(form, /tr\('Paste the same address you added in Mihon \(\{path\}\); a repository’s “Add to Mihon” link works too\.', \{ path: tr\('More → Settings → Browse → Extension repos'\) \}\)/, 'the help does not say where the address is in Mihon');
  // While the (slow) check runs, say so.
  assert.match(form, /\{addingRepo && \(\s*<p role="status" aria-live="polite"[^>]*>\s*\{tr\('Checking the repository — this can take up to a minute\.'\)\}/, 'no time hint while Checking');
  // An address reads left to right in Arabic too: an RTL field put "https://" at its end.
  assert.match(form, /inputMode="url" dir="ltr"/, 'the address field follows the page\'s direction');
});

test('the toast says what the server said, in the viewer\'s language, and counts only this repository', () => {
  // Reintroduce by `const why = msgOf(e, tr('Could not add that repository'))` in addRepo: "every code the route sends
  // is translated" still passes but "addRepo shows the server's refusal" fails; by dropping a `case` from repoAddError:
  // "…has no translated line" fails, naming the code; by deleting the `{repoError && …}` line: "the refusal outlives
  // the toast" fails.
  const add = slice(form, 'const addRepo = async', 'return (');
  assert.match(add, /catch \(e: unknown\) \{\s*const why = repoAddError\(e\);\s*setRepoError\(why\);\s*toast\(why, 'error'\);\s*\}/, 'addRepo shows the server\'s refusal');
  assert.match(form, /\{repoError && !addingRepo && \(\s*<p role="alert"[^>]*>\{repoError\}<\/p>/, 'the refusal outlives the toast');
  assert.match(form, /onChange=\{\(e\) => \{ setRepoUrl\(e\.target\.value\); setRepoError\(null\); \}\}/, 'an old refusal stays up while the address is being fixed');
  assert.match(add, /api<\{ url: string; corrected: boolean; added: number \}>/, 'the success toast reads something other than `added`');
  assert.doesNotMatch(add, /r\.total/, 'the success toast counts the whole catalogue again ("Added — 1396 extensions")');
  // Every code the route can answer has its own translated line; the engine's reason is appended as it came.
  const helper = slice(repos, 'export function repoAddError(', 'const REPO_KEYS');
  const route = readFileSync(join(ROOT, '..', 'bff/src/routes/admin.ts'), 'utf8');
  const post = slice(route, "app.post('/api/admin/extensions/repos'", "app.delete('/api/admin/extensions/repos'");
  const lib = readFileSync(join(ROOT, '..', 'bff/src/lib/sources/suwayomi/extensions.ts'), 'utf8');
  const codes = new Set<string>([...post.matchAll(/error: '([a-z_]+)'/g)].map((m) => m[1]));
  for (const m of slice(lib, 'export const REPO_MESSAGES = {', '} as const;').matchAll(/^\s+([a-z_]+):/gm)) codes.add(m[1]);
  assert.ok(codes.size >= 6, `only ${codes.size} codes found in the route -- the scan is broken`);
  for (const c of codes) assert.match(helper, new RegExp(`case '${c}':`), `the server's '${c}' has no translated line`);
  assert.match(helper, /default: return msgOf\(e, tr\('Could not add that repository'\)\);/, 'an unknown code does not fall back to the server\'s own message');
});

test('a repository change asks again for everything it can move', () => {
  // An add brings a catalogue, a removal takes one away -- and with it what Installed and the engine's counts say.
  // Reintroduce by invalidating ['ext-repos'] alone: Browse keeps the old catalogue until the next reload.
  assert.match(repos, /const REPO_KEYS = \[\['ext-repos'\], \['ext-catalog'\], \['ext-installed'\], \['ext-status'\], \['ext-sources'\]\] as const;/,
    'a repository change leaves a list stale');
  assert.equal((repos.match(/for \(const queryKey of REPO_KEYS\) void qc\.invalidateQueries/g) ?? []).length, 2, 'the add or the removal does not ask again');
});

test('with no engine its setup screen stands above your sources, never instead of them', () => {
  // v0.49.0 (#72): the not-configured card was one sentence for every platform ("If you turned it off by emptying
  // SUWAYOMI_URL, put that line back"), wrong for a Compose admin who set EXTENSION_ENGINE=0 and for Unraid and
  // CasaOS where no engine ever ran. It is components/EngineSetup.tsx, whose steps engineSetup.test.ts pins; v0.53.0
  // made it the whole Extensions tab while the engine was off, not set up or not answering. In Admin → Sources
  // (v0.54.0) the built-ins, MangaDex and sites work without the engine, so its setup stands at the top and the list
  // follows. Reintroduce the old card: "the old one-sentence card" fails; return the setup screen alone: "your sources
  // wait for the engine" does.
  const top = slice(sources, 'export function SourcesPanel(', 'function AttentionRow(');
  assert.match(top, /\{!status \? <div className="skeleton h-16 rounded-2xl" aria-busy="true" \/>\s*: isDesktop\(\) && !ready \? <EngineInstall \/>\s*: !ready \? <EngineSetup status=\{status\} \/>\s*: <EngineReady status=\{status\} desktop=\{isDesktop\(\)\} \/>\}/,
    'the setup screen');
  assert.doesNotMatch(top, /if \(!ready\) return\b|if \(!status\) return\b/, 'your sources wait for the engine');
  assert.match(top, /<YourSources overview=\{overview\}/);
  assert.doesNotMatch(panel + sources, /emptying SUWAYOMI_URL|put that line back/, 'the old one-sentence card is back');
});

test('the engine\'s state is a mark in the viewer\'s words, not an English capsule', () => {
  // v0.49.0 ("no more pills"): the header's `rounded-full border px-2` badge read "ready · v2.3.2243" or "engine
  // unreachable" in every language. v0.53.0's header says the engine and its Cloudflare helper each as a mark, from
  // lib/extensions.ts engineLine / helperLine. Reintroduce a badge with English in it: the assertions name it.
  const ready = slice(code(read('components/EngineSetup.tsx')), 'export function EngineReady(', 'function EngineOffSheet(');
  assert.match(ready, /<StatusMark tone=\{engine\.tone\} label=\{engine\.label\} size="md" \/>/, 'the engine\'s state is not a mark');
  assert.match(ready, /const engine = engineLine\(status\);\s*const helper = helperLine\(status\.solver\);/, 'the header does not read its states from lib/extensions.ts');
  assert.doesNotMatch(ready, /engine unreachable|`ready|rounded-full/, 'the English badge, or a capsule, is back');
});

test('the sheets are portalled out of every card, and a hide asks inside its sheet, in the reader\'s words', () => {
  // A `.card` blurs its backdrop, which makes it the containing block of a `fixed` dialog: a sheet inside one dimmed
  // only the card and could land off-screen. Every sheet the tab opens goes to <body>. A ConfirmDialog over a Sheet
  // paints UNDER it (z-50 against z-60), so the hide asks inside the Languages sheet. Reintroduce a bare
  // `<SourceSheet` (no OnBody): the first assertion names it.
  const lists = slice(sources, 'export function SourcesPanel(', 'function AttentionRow(');
  assert.match(lists, /<OnBody>\s*<SourceSheet\b/, 'a source\'s sheet is rendered inside the panel');
  assert.match(lists, /<OnBody>\s*<ReplaceDialog\b/, 'the Replace dialog is rendered inside the panel');
  assert.match(lists, /<OnBody><ReposSheet\b/, 'the repositories sheet is rendered inside the panel');
  assert.match(lists, /<OnBody><LanguagesSheet\b/, 'the languages sheet is rendered inside the panel');
  const langs = code(read('components/ExtensionLanguages.tsx'));
  assert.doesNotMatch(langs, /<ConfirmDialog\b|<Modal\b/, 'the hide question is a dialog the sheet would cover');
  const ask = slice(langs, '{asking === code && code !== null && (', '</li>');
  assert.match(ask, /role="alertdialog" aria-label=\{tr\('Hide \{lang\}\?', \{ lang: name \}\)\}/, 'the question is English, or not announced');
  // Its own key, not the bare "Hide", which is the app's collapse toggle ("收起" in Chinese).
  assert.match(ask, /\{tr\('Hide \{lang\}', \{ lang: name \}\)\}<\/button>/, 'the key is English, or the collapse toggle\'s word');
  // One sentence per count: "turns off 1 sources", and "1 series … they stay readable".
  assert.match(ask, /l\.enabled === 1\s*\? tr\('Hiding \{lang\} turns off 1 source\.'/, 'one source is said with the plural');
  assert.match(ask, /l\.used === 1\s*\? tr\('1 series from \{lang\} will stop updating/, 'one series is said with the plural');
  // A hide that stops nothing updating goes straight through; one that would asks first.
  assert.match(langs, /onChange=\{\(v\) => \(v \? void toggleLang\(l, true\) : l\.used > 0 \? setAsking\(code\) : void toggleLang\(l, false\)\)\}/,
    'a hide that stops series updating does not ask first');
});

test('the repository flow is translated in all eight languages', () => {
  // Reintroduce by deleting any one of these keys from public/locales/ar.json.
  const keys = new Set<string>([
    ...trKeys(repos),
    ...trKeys(browse),
    ...trKeys(sources),
    ...trKeys(read('components/EngineInstall.tsx')),
    ...trKeys(read('components/EngineSetup.tsx')),
    ...trKeys(read('lib/engineSetup.ts')),
  ]);
  assert.ok(keys.size >= 50, `only ${keys.size} strings found -- the scan is broken`);
  const dir = join(ROOT, 'public/locales');
  const locales = readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.equal(locales.length, 8);
  for (const f of locales) {
    const d = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    const missing = [...keys].filter((k) => !(k in d) || !String(d[k]).trim());
    assert.deepEqual(missing, [], `${missing.length} repository strings are missing from ${f}: ${missing.slice(0, 8).join(' | ')}`);
    // A placeholder the code fills must survive translation, or the toast shows a literal "{n}".
    for (const k of keys) {
      for (const ph of k.match(/\{[a-z]+\}/g) ?? []) {
        assert.ok(String(d[k] ?? '').includes(ph), `${f}: "${k}" lost ${ph}`);
      }
    }
  }
});
