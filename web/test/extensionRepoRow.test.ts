// Adding an extension repository, made obvious (v0.45.0): Admin → Extensions' repository row, read from source.
//
// The owner's ask was "mention better how to add the extensions repo so people know how to do it", and the
// audit found the UI itself in the way: the input sat behind a collapsed "Manage" row even with no repository
// at all (while the empty catalogue said "add a repository above"), the placeholder named a file Mihon users do
// not have, the server's reason for a refusal was never shown, and not one string of the flow was translated.
// Each of those is invisible to a type check, so each is pinned here and names the edit that brings it back.
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
  const b = src.indexOf(to, a + 1);
  assert.ok(a >= 0 && b > a, `${from} … ${to} is not where this test looks`);
  return src.slice(a, b);
};
const trKeys = (src: string): Set<string> => {
  const keys = new Set<string>();
  for (const m of src.matchAll(/\btr\(\s*'((?:[^'\\]|\\.)*)'/g)) keys.add(m[1].replace(/\\'/g, "'"));
  return keys;
};

const admin = code(read('app/admin/page.tsx'));
const ext = slice(admin, 'function Extensions(', '\n}\n');
const row = slice(ext, '<button onClick={() => setShowRepos(!reposOpen)}', 'onClick={() => setShowLangs(!showLangs)}');

test('the repository row opens by itself while there are none, and a click wins from then on', () => {
  // Reintroduce by `useState(false)` for showRepos (or rendering `{showRepos && (`): the first visit shows a
  // closed "Manage" row, the input is hidden, and "opens by itself" fails.
  assert.match(ext, /const \[showRepos, setShowRepos\] = useState<boolean \| null>\(null\);/, 'the toggle starts decided instead of following the list');
  assert.match(ext, /const reposOpen = showRepos \?\? \(!!repos && repos\.content\.length === 0\);/, 'opens by itself');
  assert.match(row, /^<button onClick=\{\(\) => setShowRepos\(!reposOpen\)\} aria-expanded=\{reposOpen\}/, 'the toggle flips what is shown, not the raw state');
  assert.match(row, /\{reposOpen && \(/, 'the row renders from reposOpen');
  assert.doesNotMatch(row, /\{showRepos && \(/, 'the row still renders from the raw toggle');
  // After an add the list is no longer empty; the row stays where the person is working.
  const add = slice(ext, 'const addRepo = async', 'const removeRepo = async');
  assert.match(add, /setShowRepos\(true\);/, 'a successful add collapses the row under the cursor');
});

test('the input asks for the address Mihon users have, and the help says what a repository is', () => {
  // Reintroduce by putting back `placeholder="https://…/index.json"`: the first assertion fails.
  assert.match(row, /placeholder="https:\/\/…\/index\.min\.json"/, 'the placeholder does not show the index.min.json shape');
  assert.doesNotMatch(row, /placeholder="https:\/\/…\/index\.json"/);
  assert.match(row, /tr\('An extension repository is a list of extensions that someone publishes\. Uchiyomi doesn’t host any, so you add one you trust\.'\)/);
  assert.match(row, /tr\('Paste the same address you added in Mihon \(\{path\}\); a repository’s “Add to Mihon” link works too\.', \{ path: tr\('More → Settings → Browse → Extension repos'\) \}\)/, 'the help does not say where the address is in Mihon');
  // The old help promised an index.json retry "where most repositories now keep the real catalogue"; on the
  // pinned engine that alternative cannot succeed for a folder, and the server no longer tries it for one.
  assert.doesNotMatch(row, /where most repositories now keep/);
  // While the (slow) check runs, say so.
  assert.match(row, /\{addingRepo && \(\s*<p role="status" aria-live="polite"[^>]*>\s*\{tr\('Checking the repository — this can take up to a minute\.'\)\}/, 'no time hint while Checking');
});

test('the toast says what the server said, in the viewer\'s language, and counts only this repository', () => {
  // Reintroduce by `const why = msgOf(e, tr('Could not add that repository'))` in addRepo: "every code the
  // route sends is translated" still passes but "addRepo shows the server's refusal" fails; by dropping a
  // `case` from repoAddError: "…has no translated line" fails, naming the code; by deleting the
  // `{repoError && …}` line: "the refusal outlives the toast" fails.
  const add = slice(ext, 'const addRepo = async', 'const removeRepo = async');
  assert.match(add, /catch \(e: unknown\) \{\s*const why = repoAddError\(e\);\s*setRepoError\(why\);\s*toast\(why, 'error'\);\s*\}/, 'addRepo shows the server\'s refusal');
  // A toast lasts 3.2 s; the two-sentence refusal stays under the input until the address is edited.
  assert.match(row, /\{repoError && !addingRepo && \(\s*<p role="alert"[^>]*>\{repoError\}<\/p>/, 'the refusal outlives the toast');
  assert.match(row, /onChange=\{\(e\) => \{ setRepoUrl\(e\.target\.value\); setRepoError\(null\); \}\}/, 'an old refusal stays up while the address is being fixed');
  assert.match(add, /api<\{ url: string; corrected: boolean; added: number \}>/, 'the success toast reads something other than `added`');
  assert.doesNotMatch(add, /r\.total/, 'the success toast counts the whole catalogue again ("Added — 1396 extensions")');
  // Every code the route can answer has its own translated line; the engine's reason is appended as it came.
  const helper = slice(admin, 'function repoAddError(', 'function Extensions(');
  const route = readFileSync(join(ROOT, '..', 'bff/src/routes/admin.ts'), 'utf8');
  const post = slice(route, "app.post('/api/admin/extensions/repos'", "app.delete('/api/admin/extensions/repos'");
  const lib = readFileSync(join(ROOT, '..', 'bff/src/lib/sources/suwayomi/extensions.ts'), 'utf8');
  const codes = new Set<string>([...post.matchAll(/error: '([a-z_]+)'/g)].map((m) => m[1]));
  for (const m of slice(lib, 'export const REPO_MESSAGES = {', '} as const;').matchAll(/^\s+([a-z_]+):/gm)) codes.add(m[1]);
  assert.ok(codes.size >= 6, `only ${codes.size} codes found in the route -- the scan is broken`);
  for (const c of codes) assert.match(helper, new RegExp(`case '${c}':`), `the server's '${c}' has no translated line`);
  assert.match(helper, /default: return msgOf\(e, tr\('Could not add that repository'\)\);/, 'an unknown code does not fall back to the server\'s own message');
});

test('after a first repository, the next step and the source limit are said once, beside the row', () => {
  // Reintroduce by deleting the `{justAdded !== null && (` block: the next-step assertions fail.
  const next = slice(ext, '{justAdded !== null && (', 'onClick={() => setShowLangs(!showLangs)}');
  assert.match(next, /tr\('Next: choose extensions from the list below and press Add on each one you want\.'\)/);
  assert.match(next, /tr\('Tip: hide the languages you don’t read first — only \{n\} sources can be switched on at once\.', \{ n: status\.cap \?\? 25 \}\)/, 'the tip does not state the limit the server enforces');
  assert.match(next, /onClick=\{\(\) => setShowLangs\(true\)\}/, 'the tip does not open Languages');
});

test('no English is left bare in the repository flow', () => {
  // Reintroduce by writing any line of the row as plain JSX text (e.g. `{addingRepo ? 'Checking…' : tr('Add')}`)
  // or a toast as a string literal: "bare English" fails and names it.
  const flow = [
    row,
    slice(ext, 'const refreshRepos = async', 'const toggleLang = async'),
    slice(ext, '{justAdded !== null && (', 'onClick={() => setShowLangs(!showLangs)}'),
    slice(ext, '{!list.length && !isFetching && (', '{isFetching && !list.length'),
    slice(ext, 'if (!status.configured) {', 'const refreshAll = () =>'),
  ].join('\n');
  const bare = [
    ...[...flow.matchAll(/>\s*([A-Za-z][^<>{}]*[A-Za-z.…])\s*</g)].map((m) => m[1]),
    ...[...flow.matchAll(/toast\(\s*(['"`][^'"`]*['"`])/g)].map((m) => m[1]),
    ...[...flow.matchAll(/\?\s*'([A-Z][^']*)'\s*:/g)].map((m) => m[1]),
  ].filter((t) => !/^(uchiyomi-suwayomi|docker compose up -d)$/.test(t));
  assert.deepEqual(bare, [], `bare English in the repository flow: ${bare.join(' | ')}`);
});

test('the Docker card names the shipped container, and the Providers card does not call a missing download a fault', () => {
  // Reintroduce by putting `docker compose up -d yomi-suwayomi` back (the development stack's name): the
  // first assertion fails. By dropping the `engine === 'absent'` arm of ExtensionsLink: "not installed yet"
  // fails, and desktop's first visit reads "The extension engine isn't running" again.
  const card = slice(ext, 'if (!status.configured) {', 'const refreshAll = () =>');
  assert.match(card, /<code key=\{i\} className="text-fog-300">uchiyomi-suwayomi<\/code>/, 'the card does not name the shipped container');
  assert.doesNotMatch(card, /[>\s]yomi-suwayomi[<\s]/, 'the card names the development stack\'s container');
  assert.match(card, /\.split\(\/\(\\\{name\\\}\|\\\{command\\\}\)\/\)/, 'the placeholders are split in a fixed order a translation cannot move');
  const link = slice(admin, 'function ExtensionsLink(', 'function ArtReview(');
  assert.match(link, /: down && engine === 'absent' \? tr\('Not installed yet — download it under Extensions'\)/, 'not installed yet');
  assert.match(link, /: down \? tr\('The extension engine isn’t running'\)/, 'the server build lost its own line');
  const hook = slice(admin, 'function useDesktopEngineState(', 'function ExtensionsLink(');
  assert.match(hook, /useState<EngineStatus\['state'\] \| null>\(null\)/, 'the hook answers something before the shell does');
  assert.match(hook, /const b = bridge\(\);\s*if \(!b\?\.engine\) return;/, 'the hook asks for an engine where there is no bridge');
});

test('one extension available is said in the singular', () => {
  // A repository offering exactly one extension read "1 extension repository · 1 extensions available" (v0.44.0's
  // hard-coded line had the same bug; the real engine and a one-extension repository showed it in the v0.45.0 review).
  // Reintroduce by dropping either `cat?.total === 1` arm from the row's summary: its assertion fails.
  assert.match(row, /cat\?\.total === 1\s*\?\s*tr\('1 extension repository · 1 extension available'\)/, 'one repository, one extension');
  assert.match(row, /cat\?\.total === 1\s*\?\s*tr\('\{n\} extension repositories · 1 extension available', \{ n: repos\.content\.length \}\)/, 'several repositories, one extension');
});

test('the repository flow is translated in all eight languages', () => {
  // Reintroduce by deleting any one of these keys from public/locales/ar.json.
  const keys = new Set<string>([
    ...trKeys(slice(admin, 'function repoAddError(', 'function Extensions(')),
    ...trKeys(row),
    ...trKeys(slice(ext, 'const refreshRepos = async', 'const toggleLang = async')),
    ...trKeys(slice(ext, '{justAdded !== null && (', 'onClick={() => setShowLangs(!showLangs)}')),
    ...trKeys(slice(ext, '{!list.length && !isFetching && (', '{isFetching && !list.length')),
    ...trKeys(slice(ext, 'if (!status.configured) {', 'const refreshAll = () =>')),
    ...trKeys(slice(admin, 'function ExtensionsLink(', 'function ArtReview(')),
    ...trKeys(read('components/EngineInstall.tsx')),
  ]);
  assert.ok(keys.size >= 40, `only ${keys.size} strings found -- the scan is broken`);
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
