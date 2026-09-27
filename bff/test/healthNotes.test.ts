// What the Health page's notes tell an admin to press. A note that names a place the page no longer has is a
// dead end for the one person reading it for a way out.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
process.env.DATABASE_URL ||= 'postgres://unused/unused';
process.env.CONFIG_DIR ||= '/tmp/uchiyomi-test-config';

test('the downloads check points at its own Scan now', async () => {
  // v0.49.0: the card carries a Scan now of its own (web HealthActions SCAN_CHECKS). Reintroduce the old
  // "Admin → Tasks → Library scan runs one.": the note sends an admin away from the button beside it.
  const { downloadsNotes } = await import('../src/lib/health');
  const census = { root: '/downloads', fsType: null, noScan: true, scanCapped: false, pending: 0, removed: 0, truncated: false };
  const notes = downloadsNotes(census, 0);
  assert.ok(notes.includes('No library scan has run since the server started; Scan now below runs one.'), notes.join(' | '));
  assert.ok(!notes.some((n) => /Admin → Tasks/.test(n)), 'a note still sends the admin to the Tasks tab');
  assert.equal(downloadsNotes({ ...census, noScan: false }, 0).length, 1, 'after a scan, only what was compared');
});
