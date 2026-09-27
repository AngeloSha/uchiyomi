// #115 on the Providers card: a source whose Test or daily check failed says "Failing", not "Healthy".
//
// "Manga Ball (EN)" failed its Test while its card said "ok": the card read the public status, which knows only
// cooldowns and which any download or the nightly lapsed-block reset puts back to 'ok'. The admin rows now carry
// the open, confirmed failures (`failing`), and providerStatus overlays them. The wiring facts about page.tsx are
// read from source, as healthActions.test.ts does, each guard naming the edit that fails it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { groupProviders, providerStatus, worstStatus, type ProviderSrc } from '../lib/providerGroups';
import { sourceMark, SOURCE_STATUSES } from '../lib/status';

const ROOT = join(__dirname, '..');
/** The file with its comments removed -- several comments quote the code they forbid. */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const page = () => code(readFileSync(join(ROOT, 'app/admin/page.tsx'), 'utf8'));
/** The Providers function of page.tsx. */
const providers = () => { const s = page(); return s.slice(s.indexOf('function Providers('), s.indexOf('function useDesktopEngineState(')); };

const failing = { failing: [{ stage: 'search' }] };

test('a confirmed failure turns a healthy or quiet card into "failing"', () => {
  // Reintroduce by returning `pub ?? 'ok'` alone (the card built from the public status): 'ok' comes back.
  assert.equal(providerStatus('ok', failing), 'failing');
  assert.equal(providerStatus(undefined, failing), 'failing', 'a source with no status yet is no healthier');
  assert.equal(providerStatus('quiet', failing), 'failing', 'a failing step says more than "answers empty"');
  assert.equal(providerStatus('ok', { failing: [] }), 'ok');
  assert.equal(providerStatus('ok', null), 'ok');
  assert.equal(providerStatus('ok'), 'ok');
});

test('a cooldown or a switched-off source keeps its own words', () => {
  for (const st of ['disabled', 'blocked', 'rate_limited', 'down'] as const) {
    assert.equal(providerStatus(st, failing), st, `${st} became "failing"`);
  }
});

test('"failing" has an amber mark and its own word, and outranks healthy on a package card', () => {
  assert.deepEqual(sourceMark('failing'), { tone: 'warn', label: 'Failing' });
  assert.ok(SOURCE_STATUSES.includes('failing'), 'sourceMark does not know failing');
  // Reintroduce by leaving `failing` out of SEVERITY (it then ranks as 1, like ok): the header stays healthy.
  assert.equal(worstStatus(['ok', 'failing', 'quiet']), 'failing');
  assert.equal(worstStatus(['failing', 'blocked']), 'failing', 'ties keep the first seen');
  const variant = (id: string, status: ProviderSrc['status']): ProviderSrc => ({
    id: `sw:${id}`, name: `X (${id})`, lang: id, status, extension: { pkgName: 'pkg.x', name: 'X' },
  });
  const [g] = groupProviders([variant('en', 'ok'), variant('fr', 'failing'), variant('de', 'disabled')]);
  assert.equal(g.worst, 'failing', 'a failing language colours the folded card');
});

test('Providers builds its cards through providerStatus, from the admin rows', () => {
  // Reintroduce by building `list` from `srcs.content` as it is: the overlay never happens and the card says ok.
  assert.match(providers(), /\.map\(\(s\) => \(\{ \.\.\.s, status: providerStatus\(s\.status as any, hmap\.get\(s\.id\)\) \}\)\)/);
  assert.match(providers(), /const groups = groupProviders\(list\);/);
});

test('"Working normally." is never the page\'s own fallback', () => {
  // It is said only by lib/sourceEvidence.ts answerView, and only under a passing Test with no ✗ on screen.
  // Reintroduce `{d.reason || 'Working normally.'}` in the card: this fails.
  assert.doesNotMatch(page(), /Working normally/);
  assert.match(providers(), /<SourceEvidence answer=\{t\}/, 'the card no longer shows a live Test through SourceEvidence');
  assert.match(providers(), /<SourceEvidence lines=\{h\.evidence\} tested=\{h\.live\}/, 'a reload loses the verdict: the stored evidence is not shown');
});

test('a Test, a cleared block or a switched-off source refreshes Health and the header mark too', () => {
  // Reintroduce by dropping invalHealth() from inval (or act): Health keeps saying what it said before the Test.
  const p = providers();
  assert.match(p, /const invalHealth = \(\) => \{ qc\.invalidateQueries\(\{ queryKey: \['admin-health'\] \}\); qc\.invalidateQueries\(\{ queryKey: \['health-summary'\] \}\); \};/);
  const inval = p.slice(p.indexOf('const inval = '), p.indexOf('\n', p.indexOf('const inval = ')));
  assert.match(inval, /invalHealth\(\)/, 'inval() does not refresh Health');
  const act = p.slice(p.indexOf('const act = '), p.indexOf('\n', p.indexOf('const act = ')));
  assert.match(act, /invalHealth\(\)/, 'act() does not refresh Health');
});

test('the Test key ticks against the limit, and Check all says where it has got to', () => {
  // Reintroduce `'Testing…'` as the running label: the clock is gone and a 50-second Test reads as stuck.
  const p = providers();
  assert.match(p, /testingId === s\.id \? testClock\(now - testFrom, health\?\.testMs\) : tr\('Test'\)/);
  assert.match(p, /const now = useTicker\(!!testingId\);/);
  assert.match(p, /checking \? checkAllLabel\(progress\) :/);
  assert.match(p, /await checkAllSources\(api, setProgress\)/, 'the progress never reaches the button');
  assert.match(p, /followRunningCheck\(api,/, 'a sweep already running when the tab opens is not followed');
});
