// v0.61.0's small touches on the web: Incognito reading carried by every way a page read reaches the server and said
// on screen, and Home's two new rails drawn only when they hold something, in the owner's order.
import 'fake-indexeddb/auto';
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { incognitoOf } from '../lib/incognito';
import { HOME_RAILS } from '../lib/homeRails';

process.env.NEXT_PUBLIC_API_BASE = '';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const code = (src: string): string => src.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

// The outbox's flush, against a server that only records what it was sent.
const bodies: any[] = [];
globalThis.fetch = (async (_u: unknown, init?: { body?: unknown }) => {
  bodies.push(JSON.parse(String(init?.body ?? '{}')));
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
}) as any;
let dl: typeof import('../lib/downloads');

before(async () => {
  dl = await import('../lib/downloads');
  const { setCurrentUser } = await import('../lib/api');
  setCurrentUser('u-incognito');
  await dl.flushOutbox(); // let the app create its own schema first
});

test('Incognito is the account\'s switch, and only a real true turns it on', () => {
  assert.equal(incognitoOf({ incognito: true }), true);
  for (const v of [false, 'true', 1, null, undefined]) assert.equal(incognitoOf({ incognito: v }), false, String(v));
  assert.equal(incognitoOf(undefined), false);
});

test('a page read under Incognito says so when the outbox sends it, and only then', async () => {
  // Reintroduce the flush without `incognito`: a chapter read offline under the switch, sent after it was turned off,
  // lands in history -- "the queued incognito page is sent as one" fails.
  bodies.length = 0;
  await dl.queueProgress({ bookId: 'b-inc', seriesId: 's1', page: 4, completed: true, incognito: true });
  await dl.queueProgress({ bookId: 'b-plain', seriesId: 's1', page: 5, completed: false });
  assert.equal(await dl.flushOutbox(), 2);
  const sent = new Map(bodies.map((b) => [b.page, b]));
  assert.equal(sent.get(4)?.incognito, true, 'the queued incognito page is sent as one');
  assert.ok(!('incognito' in (sent.get(5) ?? {})), 'an ordinary page says nothing about it');
  assert.ok(sent.get(4)?.at, 'and still carries when it was read');
});

test('the service worker\'s flush and the reader\'s live write carry it too', () => {
  // The worker is plain JS with no module surface (swCache.test.ts evaluates it whole); its body line is read here.
  assert.match(code(read('public/sw.js')), /JSON\.stringify\(\{[^}]*\bat: ev\.ts, \.\.\.\(ev\.incognito \? \{ incognito: true \} : \{\}\) \}\)/,
    "the worker's flush drops the flag");
  const reader = read('app/reader/page.tsx');
  assert.match(reader, /import \{ IncognitoTag, incognitoRef \} from '@\/components\/IncognitoBanner';/);
  // The payload goes to the live PUT and, when that fails, into the outbox whole: `queueProgress({ bookId, ...payload })`.
  assert.match(reader, /queueProgress\(\{ bookId: chId, \.\.\.payload \}\)/, 'a failed live write loses the flag on its way to the outbox');
  assert.match(reader, /<IncognitoTag \/>/, 'the reader does not say it is incognito');
});

test('the shell keeps the switch for the reader, and says it is on above every page', () => {
  // Reintroduce by calling useIncognito() only in the banner: on the reader's route the shell returns before rendering
  // it, the payload's ref is never set, and a page read live under Incognito is sent without the flag.
  const shell = code(read('components/AppShell.tsx'));
  const hook = shell.indexOf('useIncognito();');
  assert.ok(hook > 0, 'the shell does not keep the switch');
  assert.ok(hook < shell.indexOf("if (status === 'loading') return"), 'the shell keeps it below an early return');
  assert.match(shell, /\{status === 'offline' && <OfflineBanner name=\{user\?\.displayName \|\| ''\} \/>\}\s*\{status === 'authed' && <IncognitoBanner \/>\}/,
    'the banner is not beside the offline one');
  const banner = code(read('components/IncognitoBanner.tsx'));
  assert.match(banner, /useEffect\(\(\) => \{ incognitoRef\.current = on; \}, \[on\]\);/);
  assert.match(banner, /className="btn-key [^"]*" data-incognito-off>\{tr\('Turn off'\)\}/, 'Turn off is not a key');
  assert.match(banner, /if \(!on\) return null;[\s\S]*data-incognito-banner/, 'the banner shows while it is off');
  // Both switches are the account's, through the one hook.
  assert.match(code(read('components/ProfileSettings.tsx')), /<SwitchRow id="incognito" label=\{tr\(INCOGNITO_TEXT\[0\]\)\} help=\{tr\(INCOGNITO_TEXT\[1\]\)\} on=\{incognito\.on\} onChange=\{incognito\.set\} \/>/);
  assert.match(code(read('components/ReaderSettings.tsx')), /<Switch on=\{incognito\.on\} label=\{tr\(INCOGNITO_TEXT\[0\]\)\}/);
});

test("Home draws Pick back up and Hidden gems only when they hold something, in the owner's order", () => {
  const home = code(read('app/page.tsx'));
  // Reintroduce an unconditional section: an older server sends neither, and Home shows an empty rail.
  assert.match(home, /case 'pickUp':[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*return \(data\?\.pickUp\?\.length \?\? 0\) > 0 && \(\s*<section className="pt-8" data-home-pickup>/);
  assert.match(home, /case 'gems':[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*return \(data\?\.gems\?\.length \?\? 0\) > 0 && \(\s*<section className="pt-8" data-home-gems>/);
  // The owner's order (UI refresh, phase 3): Home draws its rails in the reader's own order now, and the default -- the
  // order everybody gets who never opens Customize -- is lib/homeRails.ts HOME_RAILS, where this pin moved. Reorder the
  // registry and this fails; homeRails.test.ts pins the whole of it.
  const order = HOME_RAILS.map((r) => r.key);
  const at = (k: string) => { const i = order.indexOf(k as never); assert.ok(i >= 0, `not a rail: ${k}`); return i; };
  const owner = ['continue', 'forYou', 'newEpisodes', 'favorites', 'lists', 'pickUp', 'recentlyAdded', 'popular', 'gems', 'top10'].map(at);
  assert.deepEqual([...owner].sort((a, b) => a - b), owner, 'the rails are out of the owner\'s order');
  // Pick back up says when the reading stopped; a gem says AniList's score; See all is the Library's own answer.
  assert.match(home, /<ContinueCard key=\{b\.id\} book=\{b\} note=\{b\.stoppedAt \? tr\('Read \{when\}', \{ when: relativeTime\(b\.stoppedAt\) \}\) : undefined\} \/>/);
  assert.match(home, /<SeriesCard key=\{s\.id\} series=\{s\} note=\{sortValue\(s, 'score'\)\} \/>/);
  assert.match(home, /href="\/library\?sort=score&read=UNREAD"/);
  const cards = code(read('components/cards.tsx'));
  assert.match(cards, /\{note && <span className="text-fog-500" data-continue-note> · \{note\}<\/span>\}/, 'the card does not say its note');
});
