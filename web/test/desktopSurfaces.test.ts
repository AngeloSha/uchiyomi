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
  for (const f of files) {
    const rel = f.slice(ROOT.length + 1);
    if (rel === 'lib/desktop.ts') continue;
    const src = code(readFileSync(f, 'utf8'));
    if (/navigator\.onLine/.test(src)) online.push(rel);
    if (/uchiyomiDesktop/.test(src)) marker.push(rel);
  }
  assert.deepEqual(online, [], `navigator.onLine is read outside lib/desktop.ts: ${online.join(', ')}`);
  assert.deepEqual(marker, [], `the preload marker is read outside lib/desktop.ts: ${marker.join(', ')}`);
  // The five call sites the helper replaced still ask it (not merely stopped asking anything).
  for (const f of ['lib/auth.tsx', 'lib/offlineSync.ts', 'app/downloads/page.tsx', 'app/reader/page.tsx']) {
    assert.match(code(read(f)), /serverReachableHint\(\)/, `${f} no longer consults serverReachableHint()`);
  }
  assert.equal((code(read('app/reader/page.tsx')).match(/serverReachableHint\(\)/g) ?? []).length, 2, 'the reader has two offline checks');
});

test('the admin and profile consoles hide tabs by filtering what the rail receives, and keep their pinned lines', () => {
  // The tab lists are pinned (settingsConsole.test.ts, importBatch.test.ts) and `useTabParam` reads them, so
  // they stay whole; only ConsoleNav's copy is filtered, and a deep link to a hidden tab falls back to the
  // first one with the panel withheld meanwhile. Reintroduce by passing `groups={GROUPS}` again: "the admin
  // rail still lists Members and Sessions on desktop" fails; by dropping `{hiddenTab ? null : panel}`: "a
  // hidden tab's panel renders" fails.
  assert.deepEqual([...DESKTOP_HIDDEN.adminTabs], ['Members', 'Sessions']);
  assert.deepEqual([...DESKTOP_HIDDEN.profileTabs], ['Account']);
  const admin = code(read('app/admin/page.tsx'));
  assert.match(admin, /const \[tab, setTab\] = useTabParam<Tab>\(TABS, 'Overview'\);/, 'the pinned admin useTabParam line changed');
  assert.match(admin, /keys\('Members', 'Sessions', 'Activity'\)/, 'GROUPS itself was edited rather than filtered');
  assert.match(admin, /<ConsoleNav groups=\{isDesktop\(\) \? visibleGroups\(GROUPS, DESKTOP_HIDDEN\.adminTabs\) : GROUPS\}/, 'the admin rail still lists Members and Sessions on desktop');
  assert.match(admin, /const hiddenTab = hiddenOnDesktop\(DESKTOP_HIDDEN\.adminTabs, tab\);\s*useEffect\(\(\) => \{ if \(hiddenTab\) setTab\('Overview'\); \}, \[hiddenTab\]\);/, 'a deep link to a hidden admin tab does not fall back to Overview');
  assert.match(admin, /\{hiddenTab \? null : panel\}/, 'a hidden tab\'s panel renders');
  const profile = code(read('app/profile/page.tsx'));
  assert.match(profile, /const \[tab, setTab\] = useTabParam<Tab>\(PROFILE_TABS, 'You'\);/, 'the pinned profile useTabParam line changed');
  assert.match(profile, /keys\('You', 'Settings', 'Connections', 'Account'\)/, 'the pinned profile tab literal changed');
  assert.match(profile, /<ConsoleNav groups=\{isDesktop\(\) \? visibleGroups\(PROFILE_GROUPS, DESKTOP_HIDDEN\.profileTabs\) : PROFILE_GROUPS\}/, 'the profile rail still lists Account on desktop');
  assert.match(profile, /useEffect\(\(\) => \{ if \(hiddenTab\) setTab\('You'\); \}, \[hiddenTab\]\);/, 'a deep link to Account does not fall back to You');
  assert.match(profile, /\{hiddenTab \? null : panel\}/, 'the Account panel renders on desktop');
  // Sign out: the rail's button, gated; the Account tab's own row goes with the tab.
  const rail = slice(profile, 'function RailActions(', 'function GoalModal(');
  assert.match(rail, /\{!isDesktop\(\) && \(\s*<button onClick=\{logout\}/, 'the rail offers Sign out on desktop');
});

test('the Overview does not ask for sessions on desktop, and the hero does not count members', () => {
  // `GET /api/admin/sessions` is a 404 on desktop; the Overview asked for it on every visit and showed a
  // Sessions tile that opened a tab that is not there. Reintroduce by dropping `enabled: !desktop` from the
  // sessions query: "the Overview asks for sessions on desktop" fails.
  const admin = code(read('app/admin/page.tsx'));
  const overview = slice(admin, 'function Overview(', 'function NeedsAttention(');
  assert.match(overview, /queryKey: \['admin-sessions'\], queryFn: \(\) => api<\{ content: any\[\] \}>\('\/api\/admin\/sessions'\), enabled: !desktop \}/, 'the Overview asks for sessions on desktop');
  assert.match(overview, /const desktop = isDesktop\(\);/, 'the Overview does not decide from lib/desktop');
  assert.match(overview, /\{!desktop && \(\s*<TabTile label=\{tr\('Sessions'\)\}/, 'the Sessions tile shows on desktop');
  const hero = slice(admin, 'function AdminHero(', 'function Overview(');
  assert.match(hero, /stats && !isDesktop\(\) \? \(stats\.members === 1/, 'the hero counts members on desktop');
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
  const ext = slice(admin, 'function Extensions(', 'const refreshAll = () =>');
  const gate = ext.indexOf('if (isDesktop() && !(status.configured && status.reachable)) return <EngineInstall span={span} />;');
  assert.ok(gate > 0, 'Extensions on desktop is still the Docker card');
  assert.ok(gate < ext.indexOf('if (!status.configured) {'), 'the Docker card is decided before the desktop one');
  assert.ok(gate > ext.indexOf('if (!status) return null;'), 'the engine card renders before the server has answered');
  assert.match(ext, /docker compose up -d yomi-suwayomi/, 'the server\'s own Docker card changed');
  assert.match(admin, /\{isDesktop\(\) \? ' Hide languages you don\\'t read\.' : ' Hide languages you don\\'t read, or raise SUWAYOMI_MAX_SOURCES\.'\}/, 'the source-limit line names an env var on desktop, or changed on the server');
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
  const note = slice(admin, 'function DesktopUpdateNote(', 'interface ExtStatus');
  assert.match(note, /if \(!b \|\| !u\?\.available\) return null;/, 'the update note renders on the server, or with nothing to say');
});

test('the profile settings and connections hide what only other devices use', () => {
  // Downloads and This device (Save offline, push, "Install app"), OPDS and API tokens. The sections are
  // gated where the grid composes them, and still defined: settingsConsole.test.ts pins their insides.
  // Reintroduce by rendering `<DeviceSection />` unconditionally: "This device shows on desktop" fails.
  const settings = code(read('components/ProfileSettings.tsx'));
  assert.match(settings, /\{!desktop && <DownloadsSection \/>\}/, 'Downloads shows on desktop');
  assert.match(settings, /\{!desktop && <DeviceSection \/>\}/, 'This device shows on desktop');
  assert.match(settings, /function DeviceSection\(/, 'DeviceSection was deleted rather than gated');
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
  assert.match(server, /\{!desktop && \(\s*<SwitchRow label=\{tr\('Open registration'\)\}/, 'the registration switch shows on desktop');
  assert.match(server, /\{!desktop && <SwitchWithMore label=\{tr\('Count this server in the anonymous install count'\)\}/, 'the install count shows on desktop');
  const house = slice(src, 'function HousekeepingSection(', 'const NO_PREFS');
  assert.match(house, /\{!isDesktop\(\) && \(\s*<SwitchRow label=\{tr\('Show missing chapters in Mihon'\)\}/, 'the Mihon row shows on desktop');
  // The backup hour gains one sentence on desktop and keeps its own on the server.
  const sched = slice(src, 'function SchedulesSection(', 'function HousekeepingSection(');
  assert.match(sched, /const nightly = tr\('Nightly, local time\. Shown under Tasks\.'\);/);
  assert.match(sched, /help=\{isDesktop\(\) \? `\$\{nightly\} \$\{tr\('If the PC is off then, it runs the next time Uchiyomi opens\.'\)\}` : nightly\}/, 'the backup help does not say a missed backup catches up on desktop');
});

test('"Save offline" and the Offline tab are hidden on desktop, and smart offline never runs there', () => {
  // The chapters ARE on this disk; copying them into the window's storage stores every one twice. Reintroduce
  // by dropping `!isDesktop() &&` from "Save all offline": "Save all offline shows on desktop" fails.
  const series = code(read('app/series/page.tsx'));
  assert.match(series, /\{!nothingYet && !isDesktop\(\) && \(/, 'Save all offline shows on desktop');
  assert.match(series, /\{!isDesktop\(\) && <button\s+onClick=\{async \(\) => \{\s*if \(busy\) return;\s*setBusy\(true\);\s*try \{ await onToggleDownload\(\); \}/, 'a chapter row offers Save offline on desktop');
  assert.match(series, /\{!isDesktop\(\) && <button disabled=\{acting \|\| !saveable\.length\} onClick=\{bulkSave\}/, 'select mode offers Save offline on desktop');
  // The nav and the palette keep the entries (the server build shows them) and filter them on desktop.
  assert.deepEqual([...DESKTOP_HIDDEN.navHrefs], ['/downloads']);
  assert.deepEqual([...DESKTOP_HIDDEN.paletteKeys], ['downloads']);
  const nav = code(read('components/BottomNav.tsx'));
  assert.match(nav, /href: '\/downloads'/, 'the Offline tab is gone from the server build too');
  assert.match(nav, /const shown = isDesktop\(\) \? allowed\.filter\(\(i\) => !\(DESKTOP_HIDDEN\.navHrefs as readonly string\[\]\)\.includes\(i\.href\)\) : allowed;/, 'the Offline tab shows on desktop');
  const pal = code(read('components/CommandPalette.tsx'));
  assert.match(pal, /key: 'downloads'/, 'the palette lost Offline downloads on the server build too');
  assert.match(pal, /\.filter\(\(a\) => !hiddenOnDesktop\(DESKTOP_HIDDEN\.paletteKeys, a\.key\)\)/, 'the palette offers Offline downloads on desktop');
  assert.match(code(read('components/AppShell.tsx')), /if \(status !== 'authed' \|\| !so\?\.enabled \|\| isDesktop\(\)\) return;/, 'smart offline runs on desktop');
});

test('nothing on desktop lands on the hidden Offline page: a first add opens the library, a deep link is redirected', () => {
  // The first add on a fresh desktop, "Open in library" before the first chapter is scanned, fell back to
  // /downloads/: "Offline · No downloads yet · Tap the download icon on any chapter", pointing only at controls the
  // app hides -- on the main first-use path. Reintroduce by dropping `isDesktop() ? '/library/' :` from the
  // search fallback: "the add dialog's fallback opens the Offline page on desktop" fails; by deleting the
  // page's redirect: "the Offline page renders on desktop" fails.
  const dlg = code(read('components/AddSeriesDialog.tsx'));
  const open = slice(dlg, 'const openIt = async', 'if (done) {');
  assert.match(open, /router\.push\(hit \? `\/series\/\?id=\$\{hit\.id\}` : isDesktop\(\) \? '\/library\/' : '\/downloads\/'\);/, 'the add dialog\'s fallback opens the Offline page on desktop');
  assert.match(open, /catch \{ router\.push\(isDesktop\(\) \? '\/library\/' : '\/downloads\/'\); \}/, 'the add dialog\'s error fallback opens the Offline page on desktop');
  assert.equal((open.match(/'\/downloads\/'/g) ?? []).length, 2, 'a /downloads/ fallback without a desktop arm');
  const page = code(read('app/downloads/page.tsx'));
  assert.match(page, /const desktop = isDesktop\(\);\s*useEffect\(\(\) => \{ if \(desktop\) router\.replace\('\/library\/'\); \}, \[desktop, router\]\);/, 'a deep link to the Offline page is not redirected on desktop');
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
  assert.match(libs, /\{desktopLibs\s*\? tr\('A library is a folder, plus any series you file into it by hand\. Give it an age rating and everything in it inherits that\.'\)\s*: tr\('A library is a folder, plus any series you file into it by hand\. Give it an age rating and everything in it inherits that, and choose who can open it\.'\)\}/, 'the Libraries line offers access control on desktop');
  const prov = slice(admin, 'function Providers(', 'function ExtensionsLink(');
  assert.match(prov, /\{isDesktop\(\) \? \(\s*<p [^>]*>\{tr\('Add a site above, or download the extension engine under Extensions and turn on an extension source\. With none, Uchiyomi reads only the library you already own\.'\)\}<\/p>\s*\) : \(\s*<p className="mx-auto mt-1 max-w-md text-xs text-fog-500">Mount a compiled source pack at the server&apos;s <code/, 'the Providers empty state tells desktop to mount SOURCES_DIR, or the server\'s changed');
  const expl = code(read('components/SourcesExplainer.tsx'));
  const desk = slice(expl, '{isDesktop() ? (', ') : (');
  assert.match(desk, /tr\('Fetch brings a chapter into your library folder on this computer\.'\)/);
  assert.doesNotMatch(desk, /Save offline/, 'the explainer defines Save offline on desktop');
  const disc = code(read('app/discover/page.tsx'));
  assert.match(disc, /sub=\{isDesktop\(\)\s*\? tr\('Add a site, or turn on an extension source, in Admin → Providers\.'\)\s*: tr\('Mount a source pack at SOURCES_DIR, or switch on an extension source, then reload from the Providers tab\.'\)\}/, 'Discover tells desktop to mount SOURCES_DIR');
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
