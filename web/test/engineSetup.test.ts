// Admin → Extensions' setup screen for the extension engine (v0.49.0, #72): the steps per platform, the wiring that
// makes "Check again" and the polling work, and the words in all eight languages.
//
// The steps are the part people copy from, so they are pinned line by line: the shipped names only (never the
// development stack's `yomi-suwayomi`), the switch on Compose rather than the old "empty SUWAYOMI_URL" advice, a
// command only where there is one to run, and never a translated command.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import {
  PLATFORM_CHIPS, STEP_TEXT, dataPlace, dataWarning, defaultPlatform, headline, offSteps, onSteps, stillLine,
  type Headline, type Platform, type Step,
} from '../lib/engineSetup';
import { healthLinks } from '../lib/healthLinks';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

const PLATFORMS: Platform[] = [...PLATFORM_CHIPS, 'desktop'];
const HEADLINES: Headline[] = ['switched_off', 'unset', 'unreachable'];
const everything = (): Array<{ where: string; step: Step }> => [
  ...PLATFORMS.flatMap((p) => HEADLINES.flatMap((h) => onSteps(p, h).map((step) => ({ where: `${p}/${h}`, step })))),
  ...PLATFORMS.flatMap((p) => offSteps(p).map((step) => ({ where: `${p}/off`, step }))),
];
/** Everything a step shows: its sentence, the literals in it, and its command. */
const shown = (s: Step) => [s.text, ...Object.values(s.vars ?? {}), s.command ?? ''].join(' ');

/**
 * Reintroduce the old advice as a step ("If you turned it off by emptying SUWAYOMI_URL, put that line back"), or
 * drop the EXTENSION_ENGINE line: the Compose case fails.
 */
test('switched off on Compose: take the switch line out and start it, never "empty SUWAYOMI_URL"', () => {
  const steps = onSteps('compose', 'switched_off');
  assert.deepEqual(steps.map((s) => s.command).filter(Boolean), ['EXTENSION_ENGINE=0', 'docker compose up -d']);
  for (const { where, step } of everything()) {
    assert.doesNotMatch(shown(step), /emptying SUWAYOMI_URL|put that line back/i, `${where}: the pre-v0.49.0 advice is back`);
  }
  // Not set up at all on Compose: an emptied SUWAYOMI_URL= line, or a file from before the switch existed.
  const unset = onSteps('compose', 'unset');
  assert.equal(unset[0].vars?.name, 'SUWAYOMI_URL=');
  assert.match(unset[1].command ?? '', /^curl -O https:\/\/raw\.githubusercontent\.com\/AngeloSha\/uchiyomi\/main\/deploy\/docker-compose\.yml$/);
  assert.equal(unset.at(-1)?.command, 'docker compose up -d');
  // Not answering: look, start, read the log -- all on the shipped container.
  assert.deepEqual(onSteps('compose', 'unreachable').map((s) => s.command),
    ['docker compose ps uchiyomi-suwayomi', 'docker compose up -d', 'docker compose logs --tail 50 uchiyomi-suwayomi']);
  // Turning it off: the one line, then the one command -- and the volume named, so nobody deletes it.
  const off = offSteps('compose');
  assert.deepEqual(off.map((s) => s.command), ['EXTENSION_ENGINE=0', 'docker compose up -d']);
  assert.equal(off[1].vars?.volume, 'uchiyomi_suwayomi');
});

/**
 * Reintroduce `yomi-suwayomi` (the development stack's name) in any step: it exists on one machine, and every
 * shipped file and template says uchiyomi-suwayomi.
 */
test('every step names the shipped engine, never the development stack', () => {
  for (const { where, step } of everything()) {
    assert.doesNotMatch(shown(step), /(?<![\w-])yomi-(suwayomi|flaresolverr)/, `${where}: ${shown(step)}`);
    // A command someone pastes must never delete what it is warning about.
    assert.doesNotMatch(step.command ?? '', /down -v|volume rm|rm -rf/, `${where}: a command that deletes the engine's data`);
  }
  const unraid = onSteps('unraid', 'unset');
  assert.equal(unraid[0].vars?.name, 'uchiyomi-suwayomi', 'the Unraid template is named');
  assert.match(unraid[1].command ?? '', /chown 1000:1000 \/mnt\/user\/appdata\/uchiyomi-suwayomi$/, 'its folder is made writable for the engine first');
  assert.equal(unraid[2].command, 'http://YOUR-SERVER-IP:4567');
  const casaos = onSteps('casaos', 'switched_off');
  assert.match(casaos[1].command ?? '', /\/deploy\/casaos\/uchiyomi-suwayomi\.yml$/, 'the CasaOS add-on is the file to import');
  assert.equal(casaos[2].command, 'http://uchiyomi-suwayomi:4567');
});

test('Umbrel says it is not available, with nothing to run', () => {
  for (const h of HEADLINES) {
    const steps = onSteps('umbrel', h);
    assert.equal(steps.length, 1);
    assert.equal(steps[0].command, undefined);
    assert.match(steps[0].text, /^Not available on Umbrel/);
  }
  assert.equal(dataPlace('umbrel'), null, 'no data to warn about where it cannot run');
});

test('somewhere else: the shipped protections in one command', () => {
  const run = onSteps('other', 'unset')[0].command ?? '';
  for (const part of ['--memory=1536m', '-Xmx768m', 'AUTO_DOWNLOAD_CHAPTERS=false', 'DOWNLOAD_AS_CBZ=true', 'WEB_UI_ENABLED=false',
    'FLARESOLVERR_ENABLED=true', '-v uchiyomi_suwayomi:/home/suwayomi/.local/share/Tachidesk', 'ghcr.io/suwayomi/suwayomi-server:v2.3.2243']) {
    assert.ok(run.includes(part), `the docker run lacks ${part}`);
  }
});

test('the page opens on the platform the server guessed, and says which state it is in', () => {
  assert.equal(defaultPlatform({ platform: 'unraid' }), 'unraid');
  assert.equal(defaultPlatform({ platform: 'casaos' }), 'casaos');
  assert.equal(defaultPlatform({ platform: 'desktop' }), 'desktop');
  assert.equal(defaultPlatform({ platform: 'unknown' }), 'compose', 'an older compose file passes no clue');
  assert.equal(defaultPlatform({}), 'compose');
  assert.equal(headline({ configured: false, reachable: false, off: 'switch' }), 'switched_off');
  assert.equal(headline({ configured: false, reachable: false, off: 'unset' }), 'unset');
  assert.equal(headline({ configured: false, reachable: false }), 'unset');
  assert.equal(headline({ configured: true, reachable: false }), 'unreachable');
  assert.equal(headline({ configured: true, reachable: true }), 'ready');
  assert.equal(stillLine({ configured: true, reachable: false, error: 'suwayomi unreachable: fetch failed (ECONNREFUSED)' }),
    'Still no answer: suwayomi unreachable: fetch failed (ECONNREFUSED)');
  assert.match(stillLine({ configured: false, reachable: false, off: 'switch' }), /^Still off\./);
});

test('the data warning names the place and counts what is at stake', () => {
  assert.equal(dataPlace('compose'), 'uchiyomi_suwayomi');
  assert.equal(dataPlace('unraid'), '/mnt/user/appdata/uchiyomi-suwayomi');
  assert.equal(dataPlace('casaos'), '/DATA/AppData/uchiyomi-suwayomi');
  assert.match(dataWarning(1), /it keeps 1 series linked to its source/);
  assert.match(dataWarning(12), /it keeps 12 series linked to their source/);
  assert.match(dataWarning(0), /the link for every series you add through them/);
  for (const n of [0, 1, 12]) assert.ok(dataWarning(n).includes('{place}'), 'the place is filled in as code by the component');
});

/**
 * Reintroduce by dropping the interval (or the refetch in Check again): an engine someone just started never shows
 * up without a reload, and "polls" / "Check again refetches" fails.
 */
test('the card polls the status while it is looked at, and Check again refetches it', () => {
  const src = code(read('components/EngineSetup.tsx'));
  assert.match(src, /setInterval\(\(\) => \{\s*if \(document\.visibilityState === 'visible'\) void qc\.invalidateQueries\(\{ queryKey: \['ext-status'\] \}\);/, 'polls');
  assert.match(src, /await qc\.refetchQueries\(\{ queryKey: \['ext-status'\] \}\);/, 'Check again refetches');
  assert.match(src, /api\('\/api\/admin\/extensions\/solver', \{ json: \{\} \}\)/, 'Connect posts the solver route');
  // Commands are rendered as they are, inside code, and no command ever reaches tr().
  assert.match(src, /<code className="[^"]*">\{command\}<\/code>/, 'a command is not shown as code');
  assert.doesNotMatch(src, /tr\([^)]*command/, 'a command goes through tr()');
  assert.match(src, /\{withCode\(tr\(s\.text\), s\.vars\)\}/, 'a step is its translated sentence with its literals as code');
  // No motion of its own: the ring is ProgressRing's, which stops under Reduce effects and reduced motion.
  assert.match(src, /<ProgressRing size="bar" progress=\{waiting \? 'spin' : 'idle'\}/);
  assert.doesNotMatch(src, /animate-|@keyframes|motion\./, 'a custom animation the Reduce effects switch does not reach');
  assert.doesNotMatch(src, /rounded-full/, 'a capsule');
  const admin = code(read('app/admin/page.tsx'));
  assert.match(admin, /<EngineReadyFoot status=\{status\} desktop=\{isDesktop\(\)\} \/>/, 'the ready panel lost its helper line and Turning it off');
});

test('the engine row on Health opens the Extensions tab', () => {
  assert.deepEqual(healthLinks('extension-engine', { title: 'Cloudflare helper', detail: '' } as any), [{ href: '/admin/?tab=Extensions' }]);
});

/** Reintroduce by deleting any one of these keys from public/locales/ar.json: the test names it. */
test('every word of the setup screen is translated in all eight languages', () => {
  const keys = new Set<string>(STEP_TEXT);
  for (const f of ['components/EngineSetup.tsx', 'lib/engineSetup.ts']) {
    for (const m of code(read(f)).matchAll(/\btr\(\s*'((?:[^'\\]|\\.)*)'/g)) keys.add(m[1].replace(/\\'/g, "'"));
  }
  assert.ok(keys.size >= 50, `only ${keys.size} strings found -- the scan is broken`);
  const dir = join(ROOT, 'public/locales');
  const locales = readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.equal(locales.length, 8);
  for (const f of locales) {
    const d = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    const missing = [...keys].filter((k) => !(k in d) || !String(d[k]).trim());
    assert.deepEqual(missing, [], `${missing.length} setup-screen strings are missing from ${f}: ${missing.slice(0, 6).join(' | ')}`);
    // A sentence left in English is untranslated; a single word may be the same word (French "Extensions").
    const english = [...keys].filter((k) => d[k] === k && /\s/.test(k));
    assert.deepEqual(english, [], `${f} keeps these in English: ${english.slice(0, 6).join(' | ')}`);
    for (const k of keys) {
      for (const ph of k.match(/\{[a-z]+\}/g) ?? []) assert.ok(String(d[k]).includes(ph), `${f}: "${k}" lost ${ph}`);
    }
  }
});
