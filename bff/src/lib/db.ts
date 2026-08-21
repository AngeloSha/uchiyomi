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

export async function q<T = any>(text: string, params: any[] = []): Promise<T[]> {
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
    const scoped = async <R = any>(text: string, params: any[] = []): Promise<R[]> =>
      (await client.query(text, params)).rows as R[];
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
