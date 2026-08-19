// Boolean environment variables.
//
// This exists because of a real bug: OIDC_ALLOW_SIGNUP was declared as z.coerce.boolean(), which is just
// Boolean(value), so the string "false" came out TRUE. The flag could only ever be turned off by leaving it
// unset, and setting it to "false" opened self-registration on an SSO server instead of closing it. An
// end-to-end login test caught it; these assertions stop it coming back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

// mirrors the parser in src/env.ts
const envFlag = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? def : /^(1|true|yes|on)$/i.test(v.trim())));

const off = envFlag(false);
const on = envFlag(true);

test('the word "false" turns a flag off', () => {
  // the exact bug: Boolean("false") is true
  assert.equal(off.parse('false'), false);
  assert.equal(on.parse('false'), false);
});

test('common ways of saying yes', () => {
  for (const v of ['true', 'TRUE', 'True', '1', 'yes', 'YES', 'on', ' true ']) {
    assert.equal(off.parse(v), true, `expected ${JSON.stringify(v)} to be true`);
  }
});

test('common ways of saying no', () => {
  for (const v of ['false', '0', 'no', 'off', 'nope', 'disabled']) {
    assert.equal(on.parse(v), false, `expected ${JSON.stringify(v)} to be false`);
  }
});

test('unset or blank falls back to the default', () => {
  assert.equal(off.parse(undefined), false);
  assert.equal(on.parse(undefined), true);
  assert.equal(off.parse(''), false);
  assert.equal(on.parse(''), true);
  assert.equal(on.parse('   '), true);
});
