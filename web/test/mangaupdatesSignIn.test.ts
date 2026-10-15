// MangaUpdates shows no token on any page: its Connections row opens on a username and password, which the server
// trades for a session token once (POST /api/trackers/mangaupdates/login). Pasting a token stays one link away.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';

const src = readFileSync(join(__dirname, '..', 'components/ProfileConnections.tsx'), 'utf8');

test('the MangaUpdates row signs in with a username and password, and never keeps the password in state past a connect', () => {
  assert.match(src, /const withPassword = t\.provider === 'mangaupdates' && !byToken;/);
  assert.match(src, /api<\{ account: string \}>\(`\/api\/trackers\/\$\{t\.provider\}\/login`, \{ json: \{ username: username\.trim\(\), password \} \}\)/);
  assert.match(src, /setToken\(''\); setPassword\(''\);/, 'a connect clears the password field');
  assert.match(src, /type="password" placeholder=\{tr\('Password'\)\}/);
});

test('a token can still be pasted instead, and every other provider is unchanged', () => {
  assert.match(src, /setByToken\(true\)/);
  assert.match(src, /\/api\/trackers\/\$\{t\.provider\}\/connect/);
  assert.doesNotMatch(src, /provider === 'kitsu'/, 'only MangaUpdates takes a password here');
});
