// Which Uchiyomi is running, where an admin looks for it (v0.55.4, #150).
//
// Kedryn: "I can't find anymore what version I'm running. I'm pretty sure it was in a menu on the left somewhere." It
// was only Health's Version card. Now the foot of the admin rail says "Uchiyomi v0.55.4 · up to date" (or "· update
// available (v0.55.5)", linking to that release), and a phone, which has no rail, says it among the header's facts.
// The update half is read from Health's own `update` check -- never a GitHub call of its own -- so the pure half is
// called here, and the wiring is read from source as the other console tests do.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { RELEASES_URL, releaseHref, shownVersion, updateState } from '../lib/versionLine';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
/** The file with its comments removed -- comments here quote the code they describe. */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const slice = (src: string, from: string, to: string): string => {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + 1);
  assert.ok(a >= 0 && b > a, `${from} … ${to} is not where this test looks`);
  return src.slice(a, b);
};
/** Health's Version card as the server sends it (bff lib/health.ts updateCheck, lib/said.ts `version.*`). */
const update = (code: string, params?: Record<string, unknown>) =>
  [{ id: 'sources', summarySaid: [{ code: 'sources.none' }] }, { id: 'update', summarySaid: [{ code, ...(params ? { params } : {}) }] }];

test('"update available" and "up to date" are said only when Health\'s update check said them', () => {
  // Reintroduce `return { kind: 'current' }` for every answer that is not `version.behind`: an admin with update checks
  // off, or whose server could not reach GitHub, reads "up to date" -- "the version-off check says nothing" fails.
  assert.deepEqual(updateState(update('version.behind', { version: '0.55.4', latest: 'v0.55.5' })), { kind: 'behind', latest: 'v0.55.5' });
  assert.deepEqual(updateState(update('version.current', { version: '0.55.4' })), { kind: 'current' });
  for (const quiet of ['version.off', 'version.offRunning', 'version.running', 'version.unknown']) {
    assert.equal(updateState(update(quiet, { version: '0.55.4' })), null, `the ${quiet} check says something`);
  }
  assert.equal(updateState(update('version.behind', { version: '0.55.4' })), null, 'a "behind" with no release named links nowhere');
  assert.equal(updateState(update('version.behind', { version: '0.55.4', latest: '  ' })), null);
  assert.equal(updateState([{ id: 'sources' }]), null, 'no Version card is not "up to date"');
  assert.equal(updateState(undefined), null, 'no answer yet is not "up to date"');
});

test('the link goes to the release the check named, and never to a path of the tag\'s choosing', () => {
  // Reintroduce `${RELEASES_URL}/tag/${tag}` for anything: "a tag that is not a version" fails.
  assert.equal(releaseHref('v0.55.5'), 'https://github.com/AngeloSha/uchiyomi/releases/tag/v0.55.5');
  assert.equal(releaseHref('0.56.0'), `${RELEASES_URL}/tag/0.56.0`);
  assert.equal(releaseHref('v0.56.0-rc.1'), `${RELEASES_URL}/tag/v0.56.0-rc.1`);
  assert.equal(releaseHref('../../evil'), RELEASES_URL, 'a tag that is not a version');
  assert.equal(releaseHref('v1.2.3/../../x'), RELEASES_URL);
  assert.equal(shownVersion('0.55.4'), 'v0.55.4');
  assert.equal(shownVersion('v0.55.4'), 'v0.55.4', 'the v is doubled');
});

test('the admin rail ends with the version, and a phone says it among the header\'s facts', () => {
  // Reintroduce the ConsoleNav without `footer={<VersionLine />}`: "the admin rail has no version" fails; drop the hero's
  // `data-hero-version` span: "a phone cannot find the version" fails; ask anything but the cached Health answer for the
  // update half: "the version line asks for an update of its own" fails.
  const admin = code(read('app/admin/page.tsx'));
  // The pinned prefix (desktopSurfaces.test.ts) stays as it was; the footer is added after it.
  assert.match(admin, /<ConsoleNav groups=\{isDesktop\(\) \? visibleGroups\(GROUPS, DESKTOP_HIDDEN\.adminTabs\) : GROUPS\} tab=\{tab\} onTab=\{setTab\} ariaLabel=\{tr\('Admin'\)\}\s*footer=\{<VersionLine \/>\}>/,
    'the admin rail has no version');
  const line = slice(admin, 'function VersionLine(', 'function VersionFacts(');
  assert.match(line, /queryKey: \['admin-stats'\], queryFn: \(\) => api<any>\('\/api\/admin\/stats'\)/, 'the version is not the server\'s');
  assert.match(line, /queryKey: \['admin-health'\],\s*queryFn: \(\) => api<[^\n]*>\('\/api\/admin\/health'\)/, 'the version line asks for an update of its own');
  assert.doesNotMatch(admin, /api\.github\.com|releases\/latest/, 'the page asks GitHub itself');
  // Desktop: the app's own version, the one the person installed.
  assert.match(line, /const running: string \| null = bridge\(\)\?\.version \|\| stats\?\.version \|\| null;/, 'Desktop does not show the app\'s version');
  assert.match(line, /<VersionFacts running=\{running\} update=\{updateState\(health\?\.checks\)\} \/>/);
  const facts = slice(admin, 'function VersionFacts(', 'function Overview(');
  assert.match(facts, /<bdi>Uchiyomi \{shownVersion\(running\)\}<\/bdi>/, 'the version is not isolated from an Arabic neighbour');
  assert.match(facts, /\{update\?\.kind === 'behind' && \([\s\S]*?href=\{releaseHref\(update\.latest\)\} target="_blank" rel="noopener noreferrer"[\s\S]*?tr\('update available \(\{version\}\)'/, 'an update does not link to its release');
  assert.match(facts, /\{update\?\.kind === 'current' && <>\{' · '\}<bdi className="inline-block">\{tr\('up to date'\)\}<\/bdi><\/>\}/);
  // The update is one block when the line wraps: the rail broke "update available" from its "(v0.55.5)".
  assert.match(facts, /className="inline-block text-accent hover:underline"><bdi>\{tr\('update available/, 'the update breaks inside itself');
  // A phone: the same facts at the end of the header's line, hidden where the rail shows them.
  const hero = slice(admin, 'function AdminHero(', 'function VersionLine(');
  assert.match(hero, /<span data-hero-version className="lg:hidden">\s*\{facts\.length > 0 && ' · '\}<VersionFacts running=\{running\} update=\{updateState\(health\?\.checks\)\} \/>/,
    'a phone cannot find the version');
  assert.match(hero, /const running: string \| null = bridge\(\)\?\.version \|\| stats\?\.version \|\| null;/);
  // The rail's footer is drawn on a desktop, and in the phone's group sheet (ConsoleNav).
  const nav = code(read('components/ConsoleNav.tsx'));
  assert.match(nav, /\{footer && \(\s*<div className="space-y-1 border-t border-ink-800\/80 pt-4">\{footer\}<\/div>/, 'the rail no longer draws its footer');
  assert.match(nav, /\{footer && <div className="space-y-1 border-t border-ink-800\/80 pt-4">\{footer\}<\/div>\}/, 'the group sheet no longer draws the footer');
});
