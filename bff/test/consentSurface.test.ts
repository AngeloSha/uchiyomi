// The promises the settings page makes, checked against the code that has to keep them.
//
// Everything here is a claim a person reads before consenting: that the update check tells nobody anything,
// that the count is a separate switch to a separate place, that turning it off destroys the identifier, and
// that what they were shown is what gets sent. Each one is cheap to break by accident and impossible to
// notice afterwards, because the settings page would go on saying it either way.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = new URL('../src', import.meta.url).pathname;
const read = (p: string) => readFileSync(join(SRC, p), 'utf8');
/** Source with comments stripped, since several of them quote the thing they forbid. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

test('the update check and the install count do not share a destination', () => {
  // ⚠️ THE LOAD-BEARING SEPARATION. If the update check hit a server the project runs, that server could
  // count installs from its access log with nobody consenting, and "updates on, counting off" would be a
  // setting that does nothing. It must stay a public GitHub url.
  // Reintroduce by pointing githubRelease.ts at uchiyomi.com, or PING_URL at api.github.com.
  const gh = code(read('lib/githubRelease.ts'));
  const ping = code(read('lib/installPing.ts'));

  assert.match(gh, /https:\/\/api\.github\.com\//, 'the update check no longer reads GitHub');
  assert.doesNotMatch(gh, /uchiyomi\.com/, 'the update check now points at a server we run');
  assert.match(ping, /uchiyomi\.com/, 'the count no longer goes to the collector');
  assert.doesNotMatch(ping, /api\.github\.com/, 'the count is being sent to the update-check host');
});

test('the update check sends no request body and no facts about this install', () => {
  // A GET with no body is the entire claim. Reintroduce by adding `method: 'POST'` and a body: GitHub would
  // learn the running version, and the sentence in the settings page would be false.
  const gh = code(read('lib/githubRelease.ts'));
  assert.doesNotMatch(gh, /method:\s*['"]POST['"]/, 'the update check now posts something');
  assert.doesNotMatch(gh, /\bbody:/, 'the update check now sends a body');
  assert.doesNotMatch(gh, /appVersion|installFacts|buildPayload/, 'install facts reached the update check');
});

test('opting out destroys the secret rather than merely stopping the sending', () => {
  // ⚠️ Reintroduce by dropping `install_ping_secret = NULL` from the opt-out: the switch would still stop
  // the pings, so nothing observable changes -- but a permanent identifier stays on disk and re-enabling
  // silently re-links this server to its own past. The whole rotating-id design rests on this line.
  const admin = code(read('routes/admin.ts'));
  const off = /install_ping = false[\s\S]{0,200}?install_ping_secret = NULL/;
  assert.match(admin, off, 'opting out no longer clears the secret');
  assert.match(admin, /sendForget\(/, 'opting out no longer asks the collector to forget');
});

test('the background job re-reads consent every run', () => {
  // ⚠️ Reintroduce by reading the flag once at boot: an admin who turns it off keeps being counted until
  // the container restarts, which they have no way to know.
  const server = code(readFileSync(join(SRC, 'server.ts'), 'utf8'));
  const tick = /const tick = async \(\) => \{[\s\S]{0,900}?install_ping AS on[\s\S]{0,900}?sendPing\(/;
  assert.match(server, tick, 'the ping job no longer reads install_ping inside the tick');
});

test('the preview an admin is shown is built by the code that sends', () => {
  // ⚠️ The settings page renders this endpoint's output. If it built its own object -- or the UI described
  // the payload in prose -- the two could drift, and the drift would be invisible to everyone.
  // Reintroduce by hand-rolling the preview object in the route, or by hard-coding the list in the UI.
  const admin = code(read('routes/admin.ts'));
  assert.match(admin, /install-ping\/preview/, 'the preview endpoint is gone');
  assert.match(admin, /payload: buildPayload\(/, 'the preview no longer uses the real payload builder');
});

test('nothing in the ping module can read the library', () => {
  // A blunt structural guard: the module that decides what to send must not have the means to send
  // anything interesting. Reintroduce by importing `q` from ./db here to count series.
  // Comments stripped: this file's own prose explains why it cannot see users, and a scan that cannot tell
  // the explanation from the thing it forbids fails on its own documentation.
  const ping = code(read('lib/installPing.ts'));
  assert.doesNotMatch(ping, /from '\.\/db'/, 'the ping module can now query the database');
  assert.doesNotMatch(ping, /lib_series|read_progress|\busers\b/, 'the ping module now names library tables');
});
