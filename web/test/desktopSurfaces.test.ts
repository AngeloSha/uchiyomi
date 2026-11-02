// Uchiyomi Desktop: what the web app hides there, read from source.
//
// One web bundle serves the Docker server and the desktop app, so every difference is a runtime gate
// through lib/desktop.ts. A gate that goes missing is invisible to a type check and to the server's own
// tests -- the server build never takes the desktop arm -- and on desktop it is a button whose route
// answers 404 (the server hides those routes: bff/src/lib/desktop.ts). The owner's standing rule also holds
// here: nothing on either build may LOOK different, only be absent on desktop, so each gate is checked to
// keep the server's own markup as its other arm. Every guard names the edit that makes it fail again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import { DESKTOP_HIDDEN } from '../lib/desktop';
import { offlineKeyShown } from '../lib/seriesActions';
import { PROFILE_SETTINGS } from '../lib/settingsIndex.profile';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
/** The file with its comments removed -- several comments quote the code they forbid. */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}
const slice = (src: string, from: string, to: string): string => {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + 1);
  assert.ok(a >= 0 && b > a, `${from} … ${to} is not where this test looks`);
  return src.slice(a, b);
};

test('the desktop app is recognised in one place only', () => {
  // `navigator.onLine` and the preload marker are the two signals every gate depends on; a second reader of
  // either is a gate that can disagree with lib/desktop.ts -- a copy of "no Wi-Fi = offline" on desktop sends
  // someone with a full local library to the offline screen. Reintroduce by putting
  // `!navigator.onLine` back in lib/offlineSync.ts: "navigator.onLine is read outside lib/desktop.ts" fails;
  // by testing `window.uchiyomiDesktop` in BottomNav: "the preload marker is read outside" fails.
  const files = [...walk(join(ROOT, 'app')), ...walk(join(ROOT, 'components')), ...walk(join(ROOT, 'lib'))];
  assert.ok(files.length > 80, `only ${files.length} source files scanned -- the walk is broken`);
  const online: string[] = [];
  const marker: string[] = [];
  const shellMarker: string[] = [];
  for (const f of files) {
    const rel = f.slice(ROOT.length + 1);
    if (rel === 'lib/desktop.ts') continue;
    const src = code(readFileSync(f, 'utf8'));
    if (/navigator\.onLine/.test(src)) online.push(rel);
    if (/uchiyomiDesktop/.test(src)) marker.push(rel);
    if (/uchiyomiShell/.test(src)) shellMarker.push(rel);
  }
  assert.deepEqual(online, [], `navigator.onLine is read outside lib/desktop.ts: ${online.join(', ')}`);
  assert.deepEqual(marker, [], `the preload marker is read outside lib/desktop.ts: ${marker.join(', ')}`);
  // v0.45.0: server mode's inert marker has one reader too (inDesktopWindow), and it never feeds isDesktop():
  // in server mode the page is the ordinary server app. Reintroduce by testing `window.uchiyomiShell` in
  // ProfileSettings: "the server-mode marker is read outside" fails; by `|| inDesktopWindow()` in isDesktop:
  // "isDesktop() reads the server-mode marker" fails.
  assert.deepEqual(shellMarker, [], `the server-mode marker is read outside lib/desktop.ts: ${shellMarker.join(', ')}`);
  const lib = code(read('lib/desktop.ts'));
  assert.match(lib, /export function isDesktop\(\): boolean \{\s*return desktopShell\(\) \|\| serverSaid;\s*\}/, 'isDesktop() reads the server-mode marker');
  // The five call sites the helper replaced still ask it (not merely stopped asking anything).
  for (const f of ['lib/auth.tsx', 'lib/offlineSync.ts', 'app/downloads/page.tsx', 'app/reader/page.tsx']) {
    assert.match(code(read(f)), /serverReachableHint\(\)/, `${f} no longer consults serverReachableHint()`);
  }
  assert.equal((code(read('app/reader/page.tsx')).match(/serverReachableHint\(\)/g) ?? []).length, 2, 'the reader has two offline checks');
});

test('the admin and profile consoles hide Desktop\'s missing pages by their registries, and a link to one opens the first', () => {
  // v0.88.0: one list each (components/ConsoleLayout.tsx), drawn from the registry's pages that are `shown` under the
  // console's conditions, and `?tab=` read only among those -- so a link to Members on Desktop opens Overview. Reintroduce
  // by passing `web: true` from either page: "the admin console lists Members and Sessions on desktop" fails; by reading
  // `?tab=` among every page: "a link to a hidden page opens it" fails.
  const admin = code(read('app/admin/page.tsx'));
  assert.match(admin, /conds=\{\{ web: !desktop,/, 'the admin console lists Members and Sessions on desktop');
  const profile = code(read('app/profile/page.tsx'));
  assert.match(profile, /conds=\{\{ web: !desktop,/, 'the profile console lists Account and This device on desktop');
  const layout = code(read('components/ConsoleLayout.tsx'));
  assert.match(layout, /const pages = useMemo\(\(\) => index\.categories\.filter\(\(c\) => shown\(c\.when, conds\) && views\[c\.id\]\)/, 'the console lists a page its conditions hide');
  assert.match(layout, /const fromUrl = readPage\(index, params\.get\('tab'\), params\.get\('cat'\), ids\);/, 'a link to a hidden page opens it');
  // Sign out: the profile's foot row, gated; the Account page's own row goes with the page.
  const foot = slice(profile, 'function FootRows(', 'function GoalModal(');
  assert.match(foot, /\{!isDesktop\(\) && <ConsoleFootRow onClick=\{logout\}/, 'the profile offers Sign out on desktop');
});

test('the Overview asks nothing Desktop does not answer, and the server card does not count members there', () => {
  // `GET /api/admin/sessions` is a 404 on desktop; the Overview asked for it on every visit, for a Sessions tile that
  // opened a tab that is not there. v0.88.0: the tiles are gone -- the list is the way to every page -- and with them
  // every question the Overview asked for one. Reintroduce a sessions query on the Overview: "the Overview asks for
  // sessions" fails; drop `!isDesktop()` from the card's facts: "the server card counts members on desktop" fails.
  const admin = code(read('app/admin/page.tsx'));
  const overview = slice(admin, 'function Overview(', 'function NeedsAttention(');
  assert.doesNotMatch(overview, /\/api\/admin\/sessions/, 'the Overview asks for sessions');
  const card = slice(admin, 'function AdminHero(', 'function VersionLine(');
  assert.match(card, /stats && !isDesktop\(\) \? \(stats\.members === 1/, 'the server card counts members on desktop');
});

test('per-person library access is hidden on desktop, and Extensions becomes the engine download', () => {
  // Libraries and their age rating stay; who may open one does not exist with one person. The Extensions
  // card's Docker sentence cannot help on desktop, where the engine is a download (EngineInstall), and the
  // Docker card stays as it was on the server. Reintroduce by deleting the `return <EngineInstall …/>`
  // line: "Extensions on desktop is still the Docker card" fails.
  const admin = code(read('app/admin/page.tsx'));
  const libs = slice(admin, 'function LibrariesSection(', 'function LibraryAccessDialog(');
  assert.match(libs, /const desktopLibs = isDesktop\(\);/);
  assert.match(libs, /\{!desktopLibs && <button onClick=\{\(\) => setAccess\(l\)\} className="chip text-xs">\{tr\('Access'\)\}<\/button>\}/, 'the Access chip shows on desktop');
  assert.match(libs, /\{!desktopLibs && <>\{' · '\}\{!anyMembers \? tr\('admins only'\)/, 'the "who can open it" fact shows on desktop');
  // v0.54.0: the engine's card is the top of Admin → Sources (components/SourcesPanel.tsx), above the rest of the
  // sources -- never instead of them; the desktop gate is its own, before the server's setup card.
  const panel = slice(code(read('components/SourcesPanel.tsx')), 'export function SourcesPanel(', 'function AttentionRow(');
  const top = /\{!status \? <div className="skeleton[^"]*" aria-busy="true" \/>\s*: (.+?)\s*: (.+?)\s*: (<EngineReady status=\{status\} desktop=\{isDesktop\(\)\} \/>)\}/.exec(panel);
  assert.ok(top, 'the engine card renders before the server has answered, or no longer as one choice');
  assert.equal(top![1], 'isDesktop() && !ready ? <EngineInstall />', 'Extensions on desktop is still the Docker card');
  // v0.49.0 (#72): the server's card is the setup screen (components/EngineSetup.tsx), whose steps name the shipped
  // container; engineSetup.test.ts pins them.
  assert.equal(top![2], '!ready ? <EngineSetup status={status} />', 'the server\'s own card is not the setup screen, or comes before the desktop one');
  // v0.49.1: in the reader's words, with the variable's name copied into the sentence, never translated -- under the
  // engine's strip since v0.53.0, whose count it limits.
  assert.match(code(read('components/EngineSetup.tsx')), /\{over\}\{sentenceGap\(over\)\}\s*<span[^>]*>\{desktop\s*\? tr\('Hide languages you don’t read\.'\)\s*: tr\('Hide languages you don’t read, or raise \{name\}\.', \{ name: 'SUWAYOMI_MAX_SOURCES' \}\)\}/,
    'the source-limit line names an env var on desktop, or changed on the server');
  assert.equal(top![3], '<EngineReady status={status} desktop={isDesktop()} />', 'the header is not told it is on desktop');
  // The engine card is driven by the bridge only, and polls the server while the engine starts.
  const card = code(read('components/EngineInstall.tsx'));
  assert.match(card, /import \{ bridge, type EngineStatus \} from '@\/lib\/desktop';/);
  assert.match(card, /b\.engine\.onStatus\?\.\(/, 'the card does not follow the shell\'s progress');
  assert.match(card, /queryKey: \['ext-status'\]/, 'the card never asks the server whether the engine is up');
  assert.match(card, /await b\.engine\.install\(\);/, 'the button does not ask the shell to install');
});

test('the desktop-only admin additions render nothing without the bridge', () => {
  // The backups folder and restore under Tasks, and the shell's update note under Health's Version card, are
  // desktop-only. Each returns null without the preload bridge, so the server's Tasks and Health look as they
  // did. Reintroduce by dropping `!b ||` from DesktopBackups' guard: "Tasks grows buttons on the server" fails.
  const admin = code(read('app/admin/page.tsx'));
  const tasks = slice(admin, 'function Tasks(', 'function DesktopBackups(');
  assert.match(tasks, /<div className="board">\s*<DesktopBackups \/>/, 'Tasks does not mount the backups line');
  const backups = slice(admin, 'function DesktopBackups(', 'function Activity(');
  assert.match(backups, /if \(!b \|\| \(typeof b\.revealBackups !== 'function' && typeof b\.restoreBackup !== 'function'\)\) return null;/, 'Tasks grows buttons on the server');
  assert.match(backups, /onClick=\{\(\) => b\.revealBackups\(\)\}/);
  assert.match(backups, /<ConfirmDialog[\s\S]*?danger[\s\S]*?onConfirm=\{\(\) => \{ void restore\(\); \}\}/, 'restoring does not ask first');
  assert.match(admin, /\{c\.id === 'update' && <DesktopUpdateNote \/>\}/, 'the Version card has no desktop update note');
  const note = admin.slice(admin.indexOf('function DesktopUpdateNote('));
  assert.ok(note.length > 0, 'DesktopUpdateNote is not where this test looks');
  assert.match(note, /if \(!b \|\| !u\?\.available\) return null;/, 'the update note renders on the server, or with nothing to say');
});

test('the profile settings and connections hide what only other devices use', () => {
  // Offline downloads and This device's alerts (Save offline, push, "Install app"), OPDS and API tokens. Since v0.86.0
  // the two are the This device category, which the registry draws only on a web install (`when: ['web']`), and the
  // page says which install it is. Reintroduce by dropping `when: ['web']` from the category: "This device shows on
  // desktop" fails; by passing `web: true`: "the page does not say it is on desktop" fails.
  const settings = code(read('components/ProfileSettings.tsx'));
  const device0 = PROFILE_SETTINGS.categories.find((c) => c.id === 'device');
  assert.deepEqual(device0?.when, ['web'], 'This device shows on desktop');
  assert.match(code(read('app/profile/page.tsx')), /conds=\{\{ web: !desktop, /, 'the page does not say it is on desktop');
  assert.match(settings, /<DownloadsSection usage=\{usage\} \/>\s*<DeviceSection \/>/, 'the This device category lost a group');
  assert.match(settings, /function DeviceSection\(/, 'DeviceSection was deleted rather than gated');
  // v0.45.0: the desktop app's server mode is a plain window onto the server, so the server's own settings
  // render there -- but the window IS the installed app. Reintroduce by dropping `|| inDesktopWindow()`:
  // "Install Uchiyomi shows inside the desktop app" fails.
  const device = settings.slice(settings.indexOf('function DeviceSection('));
  assert.match(device, /setStandalone\(window\.matchMedia\('\(display-mode: standalone\)'\)\.matches \|\| \(navigator as any\)\.standalone === true \|\| inDesktopWindow\(\) \|\| usesNativeCache\(\)\);/, 'Install Uchiyomi shows inside the desktop or iOS app');
  assert.match(device, /\{!standalone && \(\s*<Row id="install" stacked label=\{tr\('Install Uchiyomi'\)\}>/, 'the install row is no longer gated on standalone');
  // ...and the window has no push service (Electron ships none): the push switch there could only fail with
  // "The browser did not grant it." (V2 review). Reintroduce by rendering the SwitchRow whatever `inApp` says:
  // "the push switch is offered inside the desktop app" fails; by dropping `!inApp &&` from `supported`: "push
  // counts as supported inside the desktop app" fails.
  assert.match(device, /const \[inApp\] = useState\(\(\) => inDesktopWindow\(\)\);/, 'the device section no longer asks whether it is inside the desktop app');
  assert.match(device, /const \[supported\] = useState\(\(\) => !inApp && !usesNativeCache\(\) && typeof window !== 'undefined'/, 'push counts as supported inside the desktop or iOS app');
  assert.match(device, /\{enabledSrv && \(inApp \? \(\s*<Row id="chapter-alerts" stacked label=\{tr\('New-chapter alerts'\)\}>\s*<p[^>]*>\{tr\('The desktop app cannot receive push notifications\./, 'the push switch is offered inside the desktop app');
  // The server's own row is unchanged in a browser.
  assert.match(device, /\) : \(\s*<SwitchRow id="chapter-alerts" device label=\{tr\('New-chapter alerts'\)\}\s*help=\{supported \? tr\('Get a push notification when one of your favorites gets a new chapter, or when someone comments on a chapter you commented on\.'\) : tr\('Not supported on this browser\.'\)\}\s*on=\{on\} disabled=\{!supported\} onChange=\{toggle\} \/>/, 'the browser\'s push switch changed');
  const conn = code(read('components/ProfileConnections.tsx'));
  assert.match(conn, /<TrackerSection focus=\{focusTracking\} \/>\s*\{!desktop && <OpdsSection \/>\}\s*\{!desktop && <TokensSection \/>\}/, 'OPDS or API tokens show on desktop, or the trackers moved');
  for (const [f, src] of [['ProfileSettings', settings], ['ProfileConnections', conn]] as const) {
    assert.match(src, /const desktop = isDesktop\(\);/, `${f} does not decide from lib/desktop`);
  }
});

test('Admin → Settings hides registration, the install count and the Mihon row on desktop, and never asks for the preview', () => {
  // The install count is hidden there and its preview route answers 404, so the query must not run at all.
  // Reintroduce by dropping `enabled: !desktop` from the preview query: "the install-count preview is
  // requested on desktop" fails.
  const src = code(read('components/AdminSettings.tsx'));
  const server = slice(src, 'function ServerSection(', 'function SchedulesSection(');
  assert.match(server, /queryFn: \(\) => api<[^\n]*'\/api\/admin\/install-ping\/preview'\),\s*staleTime: 60_000,\s*enabled: !desktop,/, 'the install-count preview is requested on desktop');
  // `!ssoOnly(authConfig)` since v0.63.0: an SSO-only server has no sign-up either (web/test/ssoOnly.test.ts).
  assert.match(server, /\{!desktop && !ssoOnly\(authConfig\) && \(\s*<SwitchRow id="registration" label=\{tr\('Open registration'\)\}/, 'the registration switch shows on desktop');
  assert.match(server, /\{!desktop && <SwitchWithMore id="install-count" label=\{tr\('Count this server in the anonymous install count'\)\}/, 'the install count shows on desktop');
  const series = slice(src, 'function SeriesSection(', 'function SchedulesSection(');
  assert.match(series, /\{!isDesktop\(\) && \(\s*<MoreOptions id="series-more">\s*<SwitchRow id="mihon-missing" label=\{tr\('Show missing chapters in Mihon'\)\}/, 'the Mihon row shows on desktop');
  // The backup gains one sentence on desktop and keeps its own on the server (Maintenance since v0.86.0).
  const maintenance = slice(src, 'function MaintenanceSection(', 'export function NightlyModeRow(');
  assert.match(maintenance, /const nightly = tr\('Nightly, local time\. Shown under Tasks\.'\);/);
  assert.match(maintenance, /isDesktop\(\) \? `\$\{nightly\} \$\{tr\('If the PC is off then, it runs the next time Uchiyomi opens\.'\)\}` : nightly,/, 'the backup help does not say a missed backup catches up on desktop');
});

test('"Save offline" and the Offline tab are hidden on desktop, and smart offline never runs there', () => {
  // The chapters ARE on this disk; copying them into the window's storage stores every one twice. Since v0.60.0
  // "Save all offline" is the series page's Offline key, drawn when lib/seriesActions.ts offlineKeyShown says so.
  // Reintroduce it on desktop -- drop `!x.desktop` there, or draw the key without asking it -- and "Save all offline
  // shows on desktop" fails.
  const series = code(read('app/series/page.tsx'));
  assert.match(series, /\{offlineKeyShown\(\{ nothingYet, desktop: isDesktop\(\) \}\) && \(\s*<SeriesKey [\s\S]{0,300}?name=\{downloadingAll \? tr\('Saving…'\) : tr\('Save all offline'\)\}/,
    'Save all offline shows on desktop');
  assert.equal(offlineKeyShown({ nothingYet: false, desktop: true }), false, 'Save all offline shows on desktop');
  assert.equal(offlineKeyShown({ nothingYet: false, desktop: false }), true, 'Save all offline is gone from the server build too');
  assert.match(series, /\{!isDesktop\(\) && <button\s+onClick=\{async \(\) => \{\s*if \(busy\) return;\s*setBusy\(true\);\s*try \{ await onToggleDownload\(\); \}/, 'a chapter row offers Save offline on desktop');
  assert.match(series, /\{!isDesktop\(\) && <button disabled=\{acting \|\| !saveable\.length\} onClick=\{bulkSave\}/, 'select mode offers Save offline on desktop');
  // The nav and the palette keep the entries (the server build shows them) and filter them on desktop.
  assert.deepEqual([...DESKTOP_HIDDEN.navHrefs], ['/downloads']);
  // 'server-downloads' (Library -> Downloads) is NOT hidden: on desktop it is the only "downloads" there is.
  // Reintroduce by adding it here: "the desktop app loses its downloads entry" fails.
  assert.deepEqual([...DESKTOP_HIDDEN.paletteKeys], ['downloads'], 'the desktop app loses its downloads entry');
  const nav = code(read('components/BottomNav.tsx'));
  assert.match(nav, /href: '\/downloads'/, 'the Offline tab is gone from the server build too');
  assert.match(nav, /const shown = isDesktop\(\) \? allowed\.filter\(\(i\) => !\(DESKTOP_HIDDEN\.navHrefs as readonly string\[\]\)\.includes\(i\.href\)\) : allowed;/, 'the Offline tab shows on desktop');
  const pal = code(read('components/CommandPalette.tsx'));
  assert.match(pal, /key: 'downloads'/, 'the palette lost Offline downloads on the server build too');
  assert.match(pal, /\.filter\(\(a\) => !hiddenOnDesktop\(DESKTOP_HIDDEN\.paletteKeys, a\.key\)\)/, 'the palette offers Offline downloads on desktop');
  assert.match(code(read('components/AppShell.tsx')), /if \(status !== 'authed' \|\| !so\?\.enabled \|\| isDesktop\(\)\) return;/, 'smart offline runs on desktop');
});

test('nothing on desktop lands on the hidden Offline page: a first add opens Library -> Downloads, a deep link is redirected', () => {
  // The first add on a fresh desktop, "Open in library" before the first chapter is scanned, fell back to
  // /downloads/: "Offline · No downloads yet · Tap the download icon on any chapter", pointing only at controls the
  // app hides -- on the main first-use path. Since v0.49.0 both builds go to Library -> Downloads, which exists
  // on both, so the dialog has no desktop arm and no /downloads/ at all. Reintroduce '/downloads/' in openIt: "a
  // first add lands on the Offline tab" fails; delete the page's redirect: "the Offline page renders on desktop".
  const dlg = code(read('components/AddSeriesDialog.tsx'));
  const open = slice(dlg, 'const openIt = async', 'if (done) {');
  assert.doesNotMatch(open, /'\/downloads\/'|isDesktop\(\)/, 'a first add lands on the Offline tab');
  assert.equal((open.match(/downloadsHref\(done\.folder\)/g) ?? []).length, 2, 'a fallback that does not go to Library -> Downloads');
  // A deep link to the Offline page -- the reader's end-of-downloads button, an old bookmark, the tray -- goes to
  // what "downloads" means on desktop: what the app fetched onto this PC.
  const page = code(read('app/downloads/page.tsx'));
  assert.match(page, /const desktop = isDesktop\(\);\s*useEffect\(\(\) => \{ if \(desktop\) router\.replace\('\/library\/\?view=downloads'\); \}, \[desktop, router\]\);/, 'a deep link to the Offline page is not redirected to Library -> Downloads on desktop');
  // After every hook (rules of hooks), before the page's own markup.
  const early = page.indexOf('if (desktop) return null;');
  assert.ok(early > 0, 'the Offline page renders on desktop');
  assert.ok(early > page.lastIndexOf('useEffect(') && early < page.search(/\n {2}return \(\n/), 'the desktop return is not after the hooks and before the markup');
});

test('copy that explains a hidden feature has a desktop arm, and the server keeps its own words', () => {
  // The Libraries line ended "…and choose who can open it" beside a hidden Access chip; the sources explainer
  // defined "Save offline", which desktop hides; and both no-sources states said to mount a pack at SOURCES_DIR.
  // Reintroduce by dropping the `desktopLibs ?` arm: "the Libraries line offers access control on desktop" fails.
  const admin = code(read('app/admin/page.tsx'));
  const libs = slice(admin, 'function LibrariesSection(', 'function LibraryAccessDialog(');
  assert.match(libs, /\{desktopLibs\s*\? tr\('A library is one or more folders, plus any series you file into it by hand\. Give it an age rating and everything in it inherits that\.'\)\s*: tr\('A library is one or more folders, plus any series you file into it by hand\. Give it an age rating and everything in it inherits that, and choose who can open it\.'\)\}/, 'the Libraries line offers access control on desktop');
  // v0.54.0: Admin → Sources' empty state, in the reader's words on both arms (the server's was bare English).
  const empty = slice(code(read('components/SourcesPanel.tsx')), 'data-sources-empty', '</div>');
  assert.match(empty, /\{isDesktop\(\)\s*\? tr\('Add a site, or download the extension engine and add an extension, under Add sources\. With none, Uchiyomi reads only the library you already own\.'\)\s*: tr\('Add a site or an extension under Add sources, or mount a source pack at the server’s \{dir\}\. With none, Uchiyomi reads only the library you already own\.', \{ dir: 'SOURCES_DIR' \}\)\}/,
    'the Sources empty state tells desktop to mount SOURCES_DIR, or the server\'s changed');
  const expl = code(read('components/SourcesExplainer.tsx'));
  const desk = slice(expl, '{isDesktop() ? (', ') : (');
  assert.match(desk, /tr\('Fetch brings a chapter into your library folder on this computer\.'\)/);
  assert.doesNotMatch(desk, /Save offline/, 'the explainer defines Save offline on desktop');
  const disc = code(read('app/discover/page.tsx'));
  assert.match(disc, /sub=\{isDesktop\(\)\s*\? tr\('Add a site, or turn on an extension source, in Admin → Sources\.'\)\s*: tr\('Add a site or an extension in Admin → Sources, or mount a source pack at SOURCES_DIR\.'\)\}/, 'Discover tells desktop to mount SOURCES_DIR');
});

test('the desktop window never shows a sign-in form, and a browser tab on its port is told where the library opens', () => {
  // `anon` inside the app's own window means the app's sign-in was refused; a password form there is a dead
  // end. The decision is the MARKER, not the server's word: a browser tab on the same port must get the
  // sign-in screen's sentence, not a Retry button it cannot use. Reintroduce by rendering `<LoginScreen />`
  // for every `anon`: "the desktop window can show the sign-in form" fails.
  const shell = code(read('components/AppShell.tsx'));
  assert.match(shell, /if \(status === 'anon'\) return desktopShell\(\) \? <DesktopReconnect \/> : <LoginScreen \/>;/, 'the desktop window can show the sign-in form');
  const login = code(read('components/LoginScreen.tsx'));
  assert.match(login, /if \(c\.desktop === true\) \{ noteServerDesktop\(true\); setMode\('desktop'\); \}/, 'the sign-in screen ignores /auth/config\'s desktop flag');
  assert.match(login, /\{mode === 'desktop' && \(/, 'there is no desktop sentence');
  assert.match(login, /tr\('This library opens in the Uchiyomi app on this computer\.'\)/);
  // A 404 from the setup route waits for /auth/config instead of flashing the form.
  assert.match(login, /if \(e instanceof ApiError && e\.status === 404\) desktopMaybe = true;\s*else setMode\('login'\);/, 'a desktop tab flashes the sign-in form first');
  // Boot: the splash waits for the desktop server and never goes offline there; the provider hands out the
  // flag and the Retry DesktopReconnect presses.
  const auth = code(read('lib/auth.tsx'));
  assert.match(auth, /const r = await untilReachable\(refreshSession, \(\) => alive\);/, 'the desktop splash does not wait for its server');
  assert.match(auth, /if \(saved && !serverReachableHint\(\)\) \{/, 'the phone offline shortcut is not routed through lib/desktop');
  assert.match(auth, /desktop: isDesktop\(\), reconnect \}\}>/, 'the provider does not hand out desktop and reconnect');
  const rec = code(read('components/DesktopReconnect.tsx'));
  assert.match(rec, /const \{ reconnect \} = useAuth\(\);/);
  assert.match(rec, /onClick=\{retry\}/);
  assert.ok(existsSync(join(ROOT, 'components/EngineInstall.tsx')));
});

test('every string the desktop surfaces add is in all eight locale files', () => {
  // None of the new files is in settingsConsole.test.ts's list, and a string that reaches no locale file
  // falls back to English in every language with nothing failing. Reintroduce by deleting "Open backups
  // folder" from public/locales/ar.json.
  const keys = new Set<string>();
  const trKeys = (src: string) => { for (const m of src.matchAll(/\btr\(\s*'((?:[^'\\]|\\.)*)'/g)) keys.add(m[1].replace(/\\'/g, "'")); };
  for (const f of ['components/DesktopReconnect.tsx', 'components/EngineInstall.tsx']) trKeys(read(f));
  // Inside files that already have untranslated gaps of their own, only the desktop additions are checked.
  for (const k of [
    'This library opens in the Uchiyomi app on this computer.', 'Open Uchiyomi from the Start menu or your Applications folder.',
    'Open backups folder', 'Restore a backup…', 'Restore a backup?', 'Choose a backup…', 'Could not restore that backup',
    'Uchiyomi closes your library, replaces its database and settings with the backup you choose, and opens again. Everything since that backup — reading progress, new series, settings — is replaced. The manga files themselves are not touched.',
    'New version available — {version}', 'New version available', 'Restart to update', 'Download',
    'If the PC is off then, it runs the next time Uchiyomi opens.',
    'The desktop app cannot receive push notifications. Your server can still send new chapters to your phone, Home Assistant or Discord through a notification target, which an admin sets up under Admin → Settings → Notifications.',
  ]) keys.add(k);
  assert.ok(keys.size >= 25, `only ${keys.size} strings found -- the scan is broken`);
  const dir = join(ROOT, 'public/locales');
  const locales = readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.equal(locales.length, 8);
  for (const f of locales) {
    const d = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    const missing = [...keys].filter((k) => !(k in d) || !String(d[k]).trim());
    assert.deepEqual(missing, [], `${missing.length} desktop strings are missing from ${f}: ${missing.slice(0, 8).join(' | ')}`);
  }
});
