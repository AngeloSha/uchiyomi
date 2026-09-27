// Where the server's downloads show since v0.49.0, read from source: the floating pill is gone, the Offline tab
// is this device's copies only, one poller feeds every surface, and the Library ring is on the Library tab and
// beside the Updates bell for a viewer who may download -- and nowhere for anyone else.
//
// The behaviour behind these (what goes in which section, what turns the ring, how fast the poll runs) is
// serverDownloads.test.ts; the ring's drawing and its one motion rule are progressRing.test.ts. The browser
// half is test/e2e/run.mjs (the no-download member, the Offline tab, /library/?view=downloads at 390 px).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

test('the floating pill is gone, and the Offline tab is this device only', () => {
  // The owner removed the pill and put the server's downloads in Library -> Downloads. Reintroduce by
  // mounting <DownloadsIndicator /> in AppShell again ("the floating pill is back"), or <ServerDownloads> on
  // the Offline page ("server downloads on the device tab").
  assert.ok(!existsSync(join(ROOT, 'components/DownloadsIndicator.tsx')), 'the floating pill is back');
  assert.ok(!existsSync(join(ROOT, 'components/ServerDownloads.tsx')), 'server downloads on the device tab');
  assert.doesNotMatch(code(read('components/AppShell.tsx')), /DownloadsIndicator/, 'the floating pill is back');
  const offline = code(read('app/downloads/page.tsx'));
  assert.doesNotMatch(offline, /ServerDownloads\b|\/api\/sources\/jobs|useServerDownloads|source-jobs/, 'server downloads on the device tab');
  // One line points the way, online and signed in only: offline there is no server to show.
  assert.match(offline, /\{online && status === 'authed' && canDownload\(user\) && \(\s*<p data-server-downloads-pointer/, 'the pointer shows offline, or to a viewer who may not download');
  assert.match(offline, /tr\('What the server fetches is under Library → Downloads\.'\)/);
});

test('ONE poller: only AppShell polls the jobs, and only the two dialogs keep a poll of their own', () => {
  // In TanStack Query v5 every observer with a refetchInterval runs its own timer; BottomNav and TopNav are
  // both always mounted. Reintroduce Discover's `refetchInterval: (qy) => …` on ['source-jobs'], or the series
  // page's `refetchInterval: 2000`: "a second poller" fails.
  const pollers: string[] = [];
  for (const f of [...walk(join(ROOT, 'app')), ...walk(join(ROOT, 'components')), ...walk(join(ROOT, 'lib'))]) {
    const src = code(readFileSync(f, 'utf8'));
    for (const m of src.matchAll(/useQuery\(\{\s*queryKey: \['source-jobs'\],[\s\S]*?\n\s*\}\);/g)) {
      if (/refetchInterval/.test(m[0])) pollers.push(relative(ROOT, f));
    }
  }
  assert.deepEqual(pollers.sort(), ['components/AddSeriesDialog.tsx', 'components/FindMissingDialog.tsx', 'lib/useServerDownloads.ts'], `a second poller: ${pollers.join(', ')}`);
  const hook = code(read('lib/useServerDownloads.ts'));
  assert.match(hook, /refetchInterval: poll \? \(qy\) => jobsPollInterval\(qy\.state\.data\) : undefined,/, 'the poller does not pace itself by jobsPollInterval');
  assert.match(hook, /enabled: enabled && status === 'authed' && canDownload\(user\),/, 'the jobs are asked for offline, or by a viewer the route refuses');
  // …and the only caller that polls is AppShell, above its early returns.
  const callers: string[] = [];
  for (const f of [...walk(join(ROOT, 'app')), ...walk(join(ROOT, 'components'))]) {
    if (/useServerDownloads\(\{[^}]*poll: true/.test(code(readFileSync(f, 'utf8')))) callers.push(relative(ROOT, f));
  }
  assert.deepEqual(callers, ['components/AppShell.tsx'], 'more than one component polls the jobs');
  const shell = code(read('components/AppShell.tsx'));
  const poll = shell.indexOf("useServerDownloads({ poll: true, enabled: !path.startsWith('/reader') });");
  assert.ok(poll > 0 && poll < shell.indexOf("if (status === 'loading') return <Splash />;"), 'the poller is not a hook above the early returns');
  // The page that starts a Fetch asks at once rather than waiting out an idle poll.
  const series = code(read('app/series/page.tsx'));
  const start = series.slice(series.indexOf('const startJob = async'), series.indexOf('const bulkFetch ='));
  assert.match(start, /void kickDownloads\(qc\);/, 'startJob does not kick the jobs poll');
  assert.doesNotMatch(series, /refetchInterval: 2000/, 'the series page polls the jobs itself again');
});

test('the Library ring: on the phone\'s Library tab, beside the desktop bell, never for a viewer who may not download', () => {
  // Reintroduce by dropping the canDownload gate in DownloadsNavIcon: "the desktop ring shows to a viewer who
  // may not download" fails (and run.mjs's no-download member finds [data-downloads-ring]).
  const nav = code(read('components/BottomNav.tsx'));
  assert.match(nav, /const ringed = href === '\/library' && ring\.show;/, 'the ring is not on the Library tab alone');
  assert.match(nav, /\{ringed \? <LibraryTabIcon ring=\{ring\}><Icon width=\{22\} height=\{22\} \/><\/LibraryTabIcon> : <Icon width=\{22\} height=\{22\} \/>\}/);
  assert.match(nav, /href: '\/library', label: NAV_LABELS\[1\]/, 'the Library tab no longer leads to the Library');
  const ringHook = code(read('lib/useServerDownloads.ts'));
  assert.match(ringHook, /return status === 'authed' && canDownload\(user\) \? ring : \{ \.\.\.ring, show: false, attention: false, count: 0 \};/, 'the Library tab wears the ring for a viewer who may not download');
  const top = code(read('components/TopNav.tsx'));
  const icon = top.indexOf('<DownloadsNavIcon />');
  assert.ok(icon > 0 && icon < top.indexOf('<Link href="/updates"'), 'the desktop ring is not just before the Updates bell');
  const dl = code(read('components/DownloadsRing.tsx'));
  const btn = dl.slice(dl.indexOf('export function DownloadsNavIcon('));
  assert.match(btn, /if \(status !== 'authed' \|\| !canDownload\(user\)\) return null;/, 'the desktop ring shows to a viewer who may not download');
  assert.match(btn, /<Link href=\{downloadsHref\(\)\}/, 'the desktop ring does not lead to Library -> Downloads');
  // The still "slow" mark while only the archive works: static, amber, the hourglass.
  const map = dl.slice(dl.indexOf('export function ringProps('), dl.indexOf('export function LibraryTabIcon('));
  assert.match(map, /static: ring\.slow,/, 'the ring turns while only the slow archive works');
  assert.match(map, /glyph: ring\.slow \? <IcHourglass/);
  // The palette's way in, for the same viewers only, and kept on desktop.
  const pal = code(read('components/CommandPalette.tsx'));
  assert.match(pal, /\.\.\.\(mayDownload \? \[\{ key: 'server-downloads', label: tr\('Server downloads'\)/, 'the palette offers Server downloads to a viewer who may not download');
  assert.match(pal, /const mayDownload = status === 'authed' && canDownload\(user\);/);
  assert.match(pal, /run: \(\) => go\(downloadsHref\(\)\)/);
});

test('every way that used to lead to the pill or the Offline tab leads to Library -> Downloads', () => {
  // Reintroduce the Offline tab as the add dialog's fallback: addSeriesDialog.test.ts and desktopSurfaces.test.ts
  // fail too. Here: Discover's strip and its "See all", and the series band's "See all".
  const discover = code(read('app/discover/page.tsx'));
  // Where each card leads is lib/libraryView.ts stripHref's (libraryView.test.ts); a card it sends nowhere is not a link.
  assert.match(discover, /const href = stripHref\(j\);[\s\S]*?return href\s*\? <Link key=\{j\.folder\} href=\{href\}/, 'a strip card leads nowhere');
  assert.match(discover, /<Link href=\{downloadsHref\(\)\}[^>]*>\{tr\('See all'\)\}<\/Link>/, 'the strip has no way to the whole list');
  assert.match(code(read('components/SeriesServerDownloads.tsx')), /const href = downloadsHref\(/);
  assert.match(code(read('app/series/page.tsx')), /<SeriesServerDownloads seriesId=\{id\} folder=\{series\?\.folder\} \/>/, 'the series page has no band');
});

test('no pill clearance is left: the select bars no longer make room for a pill that is gone', () => {
  // The series bar reserved `pe-36` and the library bar `pb-8` for the pill floating over them. Reintroduce
  // `pe-36`: the series bar wraps a row sooner than it has to at 390 px.
  const series = code(read('app/series/page.tsx'));
  assert.doesNotMatch(series, /\bpe-36\b/, 'the series select bar still makes room for the pill');
  const lib = code(read('app/library/page.tsx'));
  const bar = /bottom-\[calc\(5\.75rem\+env\(safe-area-inset-bottom\)\)\] z-40[^"]*"/.exec(lib)?.[0] ?? '';
  assert.ok(bar, 'could not find the library select bar');
  assert.doesNotMatch(bar, /\bpb-8\b/, 'the library select bar still makes room for the pill');
});

test("'Downloads' names the server's view only: the reader's way to this device's chapters says Offline", () => {
  // The critic's vocabulary ruling (v0.49.0): the Library switch keeps "Downloads"; the reader's button to
  // /downloads/ and the profile's section are about THIS DEVICE's copies. Reintroduce tr('Downloads') on either:
  // "a second meaning of Downloads" fails.
  const reader = code(read('app/reader/page.tsx'));
  assert.match(reader, /router\.push\('\/downloads\/'\)\} className="[^"]*">\{tr\('Offline'\)\}<\/button>/, "the reader's button to the Offline tab is not called Offline");
  assert.match(code(read('components/ProfileSettings.tsx')), /<Section id="downloads" title=\{tr\('Offline downloads'\)\}/,
    "the profile's section about this device's copies is called Downloads");
  const users: string[] = [];
  for (const f of ['app/reader/page.tsx', 'components/ProfileSettings.tsx', 'app/library/page.tsx', 'app/downloads/page.tsx', 'components/BottomNav.tsx', 'components/TopNav.tsx']) {
    if (/tr\('Downloads'\)/.test(code(read(f)))) users.push(f);
  }
  assert.deepEqual(users, ['app/library/page.tsx'], 'a second meaning of Downloads');
});

test('the Downloads view says when it could not read the server, with a way to ask again', () => {
  // Reintroduce the old `if (empty)` without the error branch: a 500 reads "Nothing is being fetched right now".
  const view = code(read('components/ServerDownloadsView.tsx'));
  assert.match(view, /const state = viewState\(\{ data, isLoading, isError \}, s\);/, 'the view decides its state on its own');
  assert.match(view, /if \(state === 'error'\) \{[\s\S]*?onClick=\{\(\) => void refetch\(\)\}[^>]*>\{tr\('Try again'\)\}/, 'a failed read has no retry');
});

test('the desktop header fits at 1024 px: round buttons keep their 40 px, and the search is what gives', () => {
  // v0.49.0's downloads button pushed the lg header past the window: the page scrolled sideways and the flex row
  // squeezed each round button into a 21 px oval (Russian ran 213 px over). Reintroduce `w-72` on the search, or
  // drop `shrink-0` from a round button: the matching assertion fails. layout.mjs measures the real thing at
  // 1024 and 1280 px in de and ru.
  const nav = code(read('components/TopNav.tsx'));
  const header = nav.slice(nav.indexOf('<header'));
  for (const m of header.matchAll(/className=\{?[`"]([^`"]*\bh-10 w-10\b[^`"]*)[`"]/g)) {
    assert.match(m[1], /\bshrink-0\b/, `a round header button can be squeezed into an oval: ${m[1].slice(0, 80)}`);
  }
  assert.ok([...header.matchAll(/\bh-10 w-10\b/g)].length >= 3, 'the round buttons moved -- redo this scan');
  assert.match(code(read('components/DownloadsRing.tsx')), /className="grid h-10 w-10 shrink-0 /, 'the downloads button can be squeezed into an oval');
  assert.match(code(read('components/HealthAlert.tsx')), /relative grid h-10 w-10 shrink-0 /, "the Health marker can be squeezed into an oval");
  assert.match(header, /<Link href="\/profile" className="shrink-0 /, 'the avatar can be squeezed');
  // The search takes what is left: flexible, never a fixed 18 rem, its words truncating down to the icon.
  assert.match(header, /className="ms-auto flex min-w-0 max-w-72 flex-1 /, 'the search is a fixed width again');
  assert.doesNotMatch(header, /(?<![\w-])w-72\b/, 'the search is a fixed width again');
  // Down to its icon, never to a sliver of its word (ru at 1024 px for an admin, and at exactly 1280 px, showed a
  // stroke of the "П"): the button is a size container, and the label and the ⌘K hint show only when it has room
  // for them. Reintroduce the always-shown `min-w-0 flex-1 truncate` label: "shows a sliver" fails.
  assert.match(header, /className="ms-auto flex min-w-0 max-w-72 flex-1 @container /, 'the search is not a size container');
  assert.match(header, /<span data-search-label className="hidden min-w-0 flex-1 truncate text-sm text-fog-500 @\[4\.5rem\]:block">/,
    'the search label shows a sliver when the search is squeezed');
  assert.match(header, /<kbd data-search-kbd className="hidden [^"]*\bxl:@\[12rem\]:block">/, 'the ⌘K hint shows in a squeezed search');
  assert.match(header, /aria-label=\{tr\('Search…'\)\}/, 'with its label hidden the search has no accessible name');
  // Below xl: 12 px gaps, the logo's mark alone (its words kept for screen readers), and no ⌘K hint.
  assert.match(header, /<div className="shell flex items-center gap-3 py-3 xl:gap-6">/, 'the header keeps its 24 px gaps at lg');
  assert.match(header, /<Lockup className="text-2xl max-xl:sr-only" markSize=\{38\} \/>/, "the logo's words take their width at lg");
});
