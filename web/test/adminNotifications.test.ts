// Admin → Settings → Notifications (v0.43.0, #70), read from source like settingsConsole.test.ts.
//
// What a type check cannot see: that the panel never puts a stored credential back on screen, that Test
// sends an id and nothing else, that the section sits where the e2e rig and the settings pins expect it,
// and that the live preview renders exactly what the server sends. Every guard names the edit that makes it
// fail again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as preview from '../lib/notifyDigest';

const ROOT = join(__dirname, '..');
// ⚠️ The server's template is loaded at RUN time, by a computed path, and never with `import … from
// '../../bff/…'`. The image's web stage (Dockerfile.aio) copies web/ alone, and `next build` type-checks
// test/ as well, so a static import of a bff file fails the release image with TS2307 -- while every check run
// from a full checkout (npm test, tsc, npm run build) passes. It shipped that way in the v0.43.0 build until
// the e2e image refused to build. The last test in this file keeps it out of every web file.
const server: typeof preview = require(join(ROOT, '../bff/src/lib/notify/template'));
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
/** The file with its comments removed -- the comments quote the code they forbid. */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const PANEL = 'components/AdminNotifications.tsx';

test('the Notifications section is mounted once, after the four pinned sections, and Server stays first', () => {
  // run.mjs reads the first 4000 characters of the Settings tab for the install-count payload, so Server
  // must stay first, and settingsConsole.test.ts pins the other three after it in order.
  // Reintroduce by moving `<NotificationsSection />` above `<ServerSection`: the order assertion fails.
  const src = code(read('components/AdminSettings.tsx'));
  assert.match(src, /import \{ NotificationsSection \} from '@\/components\/AdminNotifications';/);
  assert.equal((src.match(/<NotificationsSection\b/g) ?? []).length, 1, 'the section is mounted more than once, or not at all');
  const grid = src.slice(src.indexOf('return (\n    <div className={SETTINGS_GRID}>'));
  assert.match(grid, /<ServerSection [^\n]*\/>\s*<SchedulesSection [^\n]*\/>\s*<HousekeepingSection [^\n]*\/>\s*<ScanlatorsSection [^\n]*\/>\s*\{\}\s*<NotificationsSection \/>/,
    'Notifications is not the last section after Server, Updates & schedules, Library housekeeping and Scanlators');
});

test('A STORED ADDRESS, TOKEN OR TOPIC IS NEVER PUT BACK ON SCREEN -- credential fields start empty, even on edit', () => {
  // The server never sends them, and the panel must not grow a way to show them either: no field of the
  // target type carries one, and the three credential boxes start from '' whatever is being edited.
  // Reintroduce by `useState(target?.target ?? '')` for the address: the url state assertion fails.
  const src = code(read(PANEL));
  const type = src.slice(src.indexOf('interface NotifyTarget {'), src.indexOf('}', src.indexOf('interface NotifyTarget {')));
  assert.ok(type.length > 0, 'no NotifyTarget type');
  assert.doesNotMatch(type, /\b(url|token|topic|secret)\s*:/, 'the target type grew a credential field');
  for (const f of ['url', 'token', 'topic']) {
    const setter = `set${f[0].toUpperCase()}${f.slice(1)}`;
    assert.match(src, new RegExp(`const \\[${f}, ${setter}\\] = useState\\(''\\);`), `the ${f} box does not start empty`);
  }
  assert.doesNotMatch(src, /\b(t|target)\??\.(url|token|topic|secret)\b/, 'the panel reads a credential off a target');
  // Every credential box is write-only: a token and a Discord address render as password fields.
  const dialog = src.slice(src.indexOf('function TargetDialog('), src.indexOf('function Field('));
  assert.match(dialog, /label=\{tr\('Discord webhook address'\)\}[\s\S]{0,400}?type="password"/, 'the Discord address is typed into a visible field');
  const tokenBox = src.slice(src.indexOf('function TokenField('));
  assert.match(tokenBox, /type="password" autoComplete="new-password"/, 'the token box is not a password field');
});

test('TEST SENDS THE SAVED TARGET\'S ID AND NOTHING ELSE', () => {
  // The server tests only saved targets; a body with an address is the shape of a port scanner and must not
  // be something the panel ever learns to send. Reintroduce by adding `json: { url }` to the Test call.
  const src = code(read(PANEL));
  const path = '/api/admin/notify-targets/${t.id}/test`';
  assert.equal(src.split(path).length, 2, 'the Test call is not where this test looks (or there are two)');
  const at = src.indexOf(path) + path.length;
  assert.equal(src.slice(at, src.indexOf(');', at) + 1).trim(), ", { method: 'POST' })", 'the Test call sends a body');
});

test('A NEW ADDRESS ASKS FOR THE TOKEN AGAIN -- and a new ntfy server for its topic', () => {
  // The server refuses a re-point that keeps the stored credential (reenter_token / reenter_topic in
  // routes/notify.ts), because a token that follows an address to another host is a reveal by another name.
  // The dialog must not offer a Save that is certain to be refused, and must say why. Only another ORIGIN
  // counts: correcting a webhook's path keeps its token here exactly as it does on the server.
  // Reintroduce by dropping the two `moved &&` clauses from `missing`: the two Save assertions fail.
  const src = code(read(PANEL));
  assert.match(src, /const moved = editing && !!url\.trim\(\) && !!typedOrigin && !!storedOrigin && typedOrigin !== storedOrigin;/,
    'the dialog no longer works out that the address moved to another origin');
  const missing = src.slice(src.indexOf('const missing ='), src.indexOf('const save ='));
  assert.ok(missing.length > 0, 'no `missing` rule');
  assert.match(missing, /moved && !!target\?\.hasToken && !token\.trim\(\) && !removeToken/, 'a moved address can be saved with the stored token');
  assert.match(missing, /moved && kind === 'ntfy' && !topic\.trim\(\)/, 'a moved ntfy server can be saved with the stored topic');
  assert.match(src, /tr\('A new address needs the token typed again'\)/, 'the token box does not say why it is needed again');
  assert.match(src, /tr\('A new server needs the topic typed again'\)/, 'the topic box does not say why it is needed again');
});

test('THE 18+ OPT-IN IS OFF BY DEFAULT AND TRAVELS WITH THE TARGET', () => {
  // A digest names 18+ titles only when the target asked for them, the way an OPDS link and an API token do
  // (Show 18+ is a session cookie the server never sees). Reintroduce by `useState(true)` for includeAdult,
  // or by leaving includeAdult out of `common`: the assertions below fail.
  const src = code(read(PANEL));
  assert.match(src, /const \[includeAdult, setIncludeAdult\] = useState\(target\?\.includeAdult \?\? false\);/,
    'the 18+ opt-in does not start from the target, off by default');
  assert.match(src, /const common = \{[^}]*\bincludeAdult\b[^}]*\};/, 'includeAdult is not sent when the target is saved');
  assert.match(src, /tr\('Include 18\+ series'\)/, 'there is no 18+ checkbox in the dialog');
});

test('deleting a target asks first, in the rose dialog', () => {
  // Reintroduce by calling the DELETE straight from the row's button.
  const src = code(read(PANEL));
  assert.match(src, /onClick=\{onDelete\}/, 'the row\'s Delete does not open the confirmation');
  assert.match(src, /<ConfirmDialog[\s\S]{0,400}?danger[\s\S]{0,200}?onConfirm=\{remove\}/, 'Delete does not go through the danger dialog');
  assert.equal((src.match(/method: 'DELETE'/g) ?? []).length, 1);
  assert.ok(src.indexOf("method: 'DELETE'") > src.indexOf('const remove = async'), 'a DELETE is sent from outside the confirmed path');
});

test('THE PREVIEW RENDERS EXACTLY WHAT THE SERVER SENDS -- the web copy of renderDigest matches the server\'s', () => {
  // web/lib/notifyDigest.ts is a copy (the web build cannot import the server). Reintroduce by changing
  // LIST_MAX to 5 in the copy, or the default template's wording: the fixtures below disagree.
  const s = (n: number) => Array.from({ length: n }, (_, i) => ({ title: `Series ${i + 1}`, added: i % 3 }));
  const fixtures: Array<[string | null, Array<{ title: string; added: number }>]> = [
    [null, [{ title: 'Solo Leveling', added: 3 }]],
    [null, [{ title: 'Solo Leveling', added: 1 }]],
    ['', s(3)],
    [null, s(14)],
    ['{count} new: {list}', s(12)],
    ['{list} | {series} | {count}', [{ title: '{count}', added: 1 }, { title: '{series}', added: 2 }]],
    ['{chapters} in {series}\r\nsecond line\u0007', [{ title: 'Evil\nFAKE line', added: 1 }]],
    ['{list}', [{ title: 'x'.repeat(5000), added: 1 }]],
    ['   ', [{ title: '', added: 2 }]],
  ];
  for (const [tpl, series] of fixtures) {
    assert.equal(preview.renderDigest(tpl, series), server.renderDigest(tpl, series), `the preview drifted for ${JSON.stringify(tpl)}`);
  }
  assert.equal(preview.DEFAULT_TEMPLATE, server.DEFAULT_TEMPLATE);
  assert.equal(preview.LIST_MAX, server.LIST_MAX);
  assert.equal(preview.MESSAGE_MAX, server.MESSAGE_MAX);
  assert.deepEqual([...preview.TEMPLATE_VARIABLES], [...server.TEMPLATE_VARIABLES]);
  // And the panel actually shows it, from the copy, for what is being typed.
  assert.match(code(read(PANEL)), /renderDigest\(template, SAMPLE\)/, 'the preview is not rendered from the template being typed');
});

test('NO WEB FILE IMPORTS A SERVER FILE -- the image builds the web app from web/ alone', () => {
  // Dockerfile.aio's web stage copies web/ and nothing else, and `next build` type-checks every .ts under it,
  // tests included. A static `import … from '../../bff/…'` anywhere here is TS2307 in the release image and
  // green everywhere else. Reading a bff file as text (readFileSync) or loading it at run time is fine.
  // Reintroduce by putting back `import * as server from '../../bff/src/lib/notify/template';` at the top of
  // this file: the offender is named.
  const walk = (dir: string): string[] => readdirSync(join(ROOT, dir)).flatMap((f) => {
    if (f === 'node_modules' || f.startsWith('.') || f === 'out') return [];
    const rel = `${dir}/${f}`;
    return statSync(join(ROOT, rel)).isDirectory() ? walk(rel) : /\.(ts|tsx|mts|cts)$/.test(f) ? [rel] : [];
  });
  const files = ['app', 'components', 'lib', 'test'].flatMap(walk);
  assert.ok(files.length > 100, `only ${files.length} web files scanned -- the walk itself is broken`);
  const offenders = files.filter((f) => /^\s*(?:import|export)\b[^;]*?\bfrom\s+['"](?:\.\.\/)+bff\//m.test(code(read(f)))
    || /\bimport\(\s*['"](?:\.\.\/)+bff\//.test(code(read(f))));
  assert.deepEqual(offenders, [], `a web file imports from bff/, which the image's web stage does not have: ${offenders.join(', ')}`);
});
