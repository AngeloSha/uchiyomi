import { Pool, types } from 'pg';
import { env } from '../env';

// Return bigint counts as JS numbers (safe at our scale) instead of strings.
types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

/**
 * How many values a statement expects, from the placeholders it actually writes.
 *
 * Postgres already refuses a mismatched bind, but it does so with an opaque error that reaches the client
 * as a bare 500 with no message -- which is how `PUT /api/admin/series/:id/meta` spent a release rejecting
 * every save while the UI could only say "Could not save". A precondition names both counts at the call
 * site instead, and the first test to touch the route sees it immediately.
 *
 * Correct for generated SQL too: `Params.add()` in lib/visibility.ts pushes a value and returns
 * `$values.length`, so the highest placeholder always equals the array length there as well.
 */
function expectedParams(text: string): number {
  let max = 0;
  // `$$` is dollar-quoting, not a placeholder; requiring a digit and a non-digit boundary is enough.
  for (const m of text.matchAll(/\$(\d+)/g)) max = Math.max(max, Number(m[1]));
  return max;
}

export async function q<T = any>(text: string, params: any[] = []): Promise<T[]> {
  const want = expectedParams(text);
  if (want !== params.length) {
    throw new Error(
      `query binds ${params.length} value(s) but its SQL uses $${want}: ${text.trim().slice(0, 160)}`,
    );
  }
  const res = await pool.query(text, params);
  return res.rows as T[];
}

export async function one<T = any>(text: string, params: any[] = []): Promise<T | null> {
  const rows = await q<T>(text, params);
  return rows[0] ?? null;
}

/**
 * Run several statements as one unit. `q()` is autocommit-per-statement, which is fine for most of this
 * codebase but not for the scanner: once a series' rows can move between series, a half-applied folder is a
 * corrupt library rather than a slightly stale one.
 *
 * The callback gets a scoped `q` bound to the transaction's own connection — using the module-level `q`
 * inside it would take a different connection from the pool and quietly run outside the transaction.
 */
export async function tx<T>(fn: (qq: <R = any>(text: string, params?: any[]) => Promise<R[]>) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const scoped = async <R = any>(text: string, params: any[] = []): Promise<R[]> => {
      // Same precondition as `q()`: a transaction is exactly where an opaque bind error is hardest to read,
      // because the rollback hides which statement threw.
      const want = expectedParams(text);
      if (want !== params.length) {
        throw new Error(
          `query binds ${params.length} value(s) but its SQL uses $${want}: ${text.trim().slice(0, 160)}`,
        );
      }
      return (await client.query(text, params)).rows as R[];
    };
    const out = await fn(scoped);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
