// The S2-ii rows that read the fallback smokes' digests (s2-postgres.mjs), as plain functions of what the smokes
// returned, so they are tested without a packaged app (test/smoke.s2.test.mjs).
//
// ⚠️ Every field of a digest is optional. A smoke that wrote no result -- killed at lib.mjs smoke()'s 10-minute
// timeout because the shell froze -- leaves only its exit, its run time and the tail of its output (`error`). The
// v0.55.9 and v0.55.10 release runs fed such a digest to `JSON.stringify(b.engine).slice(0, 300)`: JSON.stringify
// of undefined is undefined, the TypeError ended s2-postgres.mjs, and the job's only row was "s2-postgres.mjs itself
// failed (exit 1)" -- nothing about what the smoke had done, and the checks after it never ran.

/** JSON for a summary line, whatever the value (JSON.stringify(undefined) is not a string). */
export const brief = (v, n = 300) => String(JSON.stringify(v ?? null)).slice(0, n);

/** Why a smoke failed: its own error, or -- when it wrote no result at all -- how it ended and its last output. */
export function smokeWhy(d) {
  if (d.wroteResult !== false) return String(d.error || 'no error recorded').slice(0, 300);
  return `the smoke wrote no result (exit ${d.exit ?? 'none'} after ${Math.round((d.ms || 0) / 1000)} s); its output ended: ${String(d.error || '').slice(-300)}`;
}

/**
 * S2-ii-nonascii-fallback: binaries, data and the process's profile under the non-ASCII folder, the fallback ON,
 * the extension engine installed into it. PASS only when the smoke passed, the bff's backup landed, the engine
 * (when a pack was served) answered, and the fallback folder is private to this user.
 * @param {{ b: any, served: boolean, acl: string, base: string, profile: string, shortName: string, eightDot3: string, copyMs: number }} o
 */
export function fallbackRow({ b, served, acl, base, profile, shortName, eightDot3, copyMs }) {
  const engineOk = !served || b.engine?.pass === true;
  const works = !!b.ok && !!b.bffBackup?.pass && engineOk;
  // The cluster left %LOCALAPPDATA% (private to this user) for %ProgramData% (readable by every local user by
  // inheritance), so the lock-down is part of the pass condition, not a nicety.
  const aclPrivate = !!acl && !/BUILTIN\\Users|Everyone|Authenticated Users/i.test(acl);
  const engine = !served ? 'no fixture'
    : engineOk ? `installed and answering (${(b.engine?.states || []).join(' -> ')})`
      : `FAILED ${b.engine ? brief(b.engine) : '(no engine result)'}`;
  return {
    verdict: works && aclPrivate ? 'PASS' : 'FAIL',
    aclPrivate,
    summary: `binaries+data under "${base}", USERPROFILE+TEMP under "${profile}", fallback ON: ${works ? 'works' : `FAILS${b.ok ? '' : ` (${smokeWhy(b)})`}`}, fallback dir private to this user: ${aclPrivate}; cluster at ${b.fallback?.base || '(no fallback used)'} (binaries copied: ${b.fallback?.copied}); bff backup ${b.bffBackup?.files?.['db.sql.gz']} B into the non-ASCII BACKUP_DIR; extension engine: ${engine}; 8.3 short path "${shortName}" (${eightDot3}); app copy ${copyMs} ms`,
  };
}

/**
 * S2-ii-fallback-private: the fallback folder is the app's own, a second start re-verified and reused it, and a
 * recorded folder other accounts can open was refused.
 * @param {{ named: boolean, reused: boolean, refused: boolean, again: any, dErr: string }} o
 */
export function fallbackPrivateRow({ named, reused, refused, again, dErr }) {
  return {
    verdict: named && reused && refused ? 'PASS' : 'FAIL',
    summary: `fallback named Uchiyomi-<16 hex> directly under %ProgramData%: ${named}; a second start re-verified and reused it: ${reused}${again && !reused ? ` (${again.error ? smokeWhy(again) : brief(again.fallback)})` : ''}; a recorded folder other accounts can open was refused: ${refused}${refused ? '' : ` (${String(dErr || '').slice(0, 400)})`}`,
  };
}
