/**
 * What version of Uchiyomi is actually running.
 *
 * ⚠️ NOTHING KNEW THIS. The version lived in `bff/package.json`, `web/package.json` and `openapi.yaml` and
 * was never read at runtime -- so the server could not tell an admin what it was running, let alone whether
 * anything newer existed. The release workflow does stamp `org.opencontainers.image.version` as an OCI
 * label, but a label is metadata ABOUT the image and is not readable from inside the container.
 *
 * Resolved the same way `apiDocs.ts` finds openapi.yaml: relative to this file, which is `dist/lib/` in the
 * image and `src/lib/` under tsx, so one walk works in both. `bff/package.json` is copied into the runtime
 * image (Dockerfile.aio needs it for `npm ci --omit=dev`), so it is genuinely there.
 *
 * Read once and memoised: it cannot change while the process is alive.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let cached: string | null | undefined;

/** Where package.json lives relative to the running code; exported so a test reads the same file. */
export function packageJsonPath(): string {
  return resolve(__dirname, '..', '..', 'package.json');
}

/**
 * The running version, e.g. `0.27.0`. Null when it cannot be determined.
 *
 * ⚠️ Never throws, and null is a legitimate answer rather than an error. A missing or malformed
 * package.json means "no opinion": the update check simply has nothing to compare and says so. Taking the
 * server down over a version string would be a far worse bug than not knowing the version.
 */
export function appVersion(): string | null {
  if (cached !== undefined) return cached;
  cached = null;
  try {
    const raw = JSON.parse(readFileSync(packageJsonPath(), 'utf8')) as { version?: unknown };
    if (typeof raw.version === 'string' && /^\d+\.\d+\.\d+/.test(raw.version.trim())) cached = raw.version.trim();
  } catch {
    /* not packaged the way we expect -- see above, this is not an error */
  }
  return cached;
}

/** Test seam: drop the memoised answer. */
export function resetAppVersion(): void {
  cached = undefined;
}
