// Sign-in modes (v0.63.0, #208, lib/authMode.ts), case by case, without a database: which configurations stop the
// server at boot, who a new SSO-only server's first sign-in makes admin, and how AUTH_MODE is read. The routes are
// pinned against a real provider and a real database in ssoOnly.int.test.ts.
import test, { before, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';

let m: typeof import('../src/lib/authMode');
before(async () => { m = await import('../src/lib/authMode'); });
afterEach(() => { delete process.env.AUTH_MODE; delete process.env.AUTH_RESCUE_ADMIN; });

const facts = (o: Partial<import('../src/lib/authMode').AuthFacts> = {}) => ({
  mode: 'oidc-only', desktop: false, oidc: true, linkByUsername: false, bootstrapSub: '', adminGroup: 'admins', hasUsers: false, ...o,
});

test('SSO-only mode starts only in a configuration that can work', () => {
  assert.deepEqual(m.authModeProblems(facts()), [], 'a provider and a group to make the first admin from');
  assert.deepEqual(m.authModeProblems(facts({ adminGroup: '', bootstrapSub: 'sub-1' })), [], 'or a named subject');
  // A server past its first admin needs no way to make one. Reintroduce by asking regardless: every upgraded install
  // with accounts and no group refuses to start.
  assert.deepEqual(m.authModeProblems(facts({ adminGroup: '', hasUsers: true })), []);
  // Reintroduce by dropping a rule: its line names what is missing.
  assert.match(m.authModeProblems(facts({ oidc: false })).join(), /OIDC_ISSUER and OIDC_CLIENT_ID/);
  assert.match(m.authModeProblems(facts({ linkByUsername: true })).join(), /OIDC_LINK_BY_USERNAME/);
  assert.match(m.authModeProblems(facts({ adminGroup: '' })).join(), /first admin/);
  assert.equal(m.authModeProblems(facts({ oidc: false, linkByUsername: true, adminGroup: '' })).length, 3, 'every problem is said at once');
});

test('a typo in AUTH_MODE stops the server rather than leave the password routes open', () => {
  // Reintroduce by reading an unknown value as local: the operator believes the routes closed, and they are open.
  assert.match(m.authModeProblems(facts({ mode: 'oidc_only' })).join(), /AUTH_MODE is "oidc_only": use local or oidc-only/);
  for (const ok of ['', 'local', 'LOCAL', ' oidc-only ']) assert.deepEqual(m.authModeProblems(facts({ mode: ok, adminGroup: 'g' })), [], ok);
  // Local mode asks nothing of single sign-on, and Uchiyomi Desktop ignores the mode.
  assert.deepEqual(m.authModeProblems(facts({ mode: 'local', oidc: false, adminGroup: '' })), []);
  assert.deepEqual(m.authModeProblems(facts({ desktop: true, oidc: false, adminGroup: '' })), []);
});

test('AUTH_MODE is read when asked, and the rescue door exists only in SSO-only mode', () => {
  assert.equal(m.authMode(), 'local');
  process.env.AUTH_MODE = ' OIDC-ONLY ';
  assert.equal(m.authMode(), 'oidc-only');
  assert.equal(m.ssoOnly(), true);
  // The boot check refuses a typo; were one to slip past it, it reads as nothing turned on, never as half a mode.
  process.env.AUTH_MODE = 'oidc_only';
  assert.equal(m.authMode(), 'local');
  process.env.AUTH_RESCUE_ADMIN = 'boss';
  assert.equal(m.rescueAdmin(), null, 'every account signs in with its password in local mode: no rescue to speak of');
  process.env.AUTH_MODE = 'oidc-only';
  assert.equal(m.rescueAdmin(), 'boss');
});

test('a new server\'s first admin: the subject named, else the group, never both ways at once', () => {
  const who = (sub: string, groups: string[] = []) => ({ sub, groups });
  const named = { bootstrapSub: 'sub-boss', adminGroup: 'admins' };
  assert.equal(m.mayBootstrap(who('sub-boss'), named), true);
  // Reintroduce the group as a second door beside a named subject: anyone in it takes a fresh server.
  assert.equal(m.mayBootstrap(who('sub-other', ['admins']), named), false);
  const group = { bootstrapSub: '', adminGroup: 'admins' };
  assert.equal(m.mayBootstrap(who('sub-any', ['readers', 'admins']), group), true);
  assert.equal(m.mayBootstrap(who('sub-any', ['readers']), group), false);
  assert.equal(m.mayBootstrap(who('sub-any', ['']), { bootstrapSub: '', adminGroup: '' }), false, 'no way configured: nobody');
});
