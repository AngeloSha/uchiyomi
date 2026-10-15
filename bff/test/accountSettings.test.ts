// The device switches that follow the account (show-not-yet-on-server chapters, also-follow)
// are stored in the settings row as booleans. The web app mirrors them to localStorage and trusts the server's
// answer, so a non-boolean must be refused at the door: "false" the string is truthy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ACCOUNT_BOOL_SETTINGS, settingsBody } from '../src/lib/accountSettings';

test('the two switches are named', () => {
  assert.deepEqual([...ACCOUNT_BOOL_SETTINGS], ['showGhosts', 'alsoFollow']);
});

test('booleans pass, alone or with the free-form keys', () => {
  assert.ok(settingsBody.safeParse({ showGhosts: true }).success);
  assert.ok(settingsBody.safeParse({ showGhosts: false, alsoFollow: true, accent: '#7c5cff', reader: { mode: 'paged' }, weeklyGoal: 5 }).success);
  assert.ok(settingsBody.safeParse({}).success);
});

test('a switch that is not a boolean is refused, naming the field', () => {
  for (const k of ACCOUNT_BOOL_SETTINGS) {
    for (const bad of ['false', 1, null, {}]) {
      const r = settingsBody.safeParse({ [k]: bad });
      assert.equal(r.success, false, `${k}=${JSON.stringify(bad)}`);
      if (!r.success) assert.deepEqual(r.error.issues[0].path, [k]);
    }
  }
});

test('other keys stay unvalidated', () => {
  assert.ok(settingsBody.safeParse({ somethingNew: 'x', nested: { a: [1] } }).success);
});
