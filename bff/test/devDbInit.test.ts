// #363: exercise the development image's real initializer. Changing its major breaks existing volumes;
// changing its peer map alone still leaves the Supabase migration role missing. No app data is used here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { parse as parseYaml } from 'yaml';

const REPO = join(__dirname, '..', '..');
const compose = parseYaml(readFileSync(join(REPO, 'docker-compose.yml'), 'utf8'));
const service = compose.services['yomi-db'];
const hook = './deploy/dev-db/zz-uchiyomi.sh:/docker-entrypoint-initdb.d/zz-uchiyomi.sh:ro';

test('development database preserves PostgreSQL 15 volumes and uses the vendor bootstrap identity', () => {
  assert.equal(service.image, 'supabase/postgres:15.8.1.085', 'a database major/image replacement needs a separate migration');
  assert.equal(service.environment.POSTGRES_USER, 'supabase_admin');
  assert.equal(service.environment.POSTGRES_DB, 'postgres');
  assert.ok(service.volumes.includes(hook), 'the app role/database must be created after the vendor migrations');
  assert.equal(service.ports, undefined, 'the development database must remain private');
  assert.deepEqual(service.networks, ['yomi_internal']);
});

test('fresh initialization and existing PostgreSQL 15 data survive container recreation', {
  skip: process.env.TEST_DEV_DB_INIT === '1' ? false : 'set TEST_DEV_DB_INIT=1 to run isolated Docker initialization checks',
  timeout: 300_000,
}, async (t) => {
  const prefix = `uchiyomi-dev-db-check-${process.pid}-${randomUUID().slice(0, 8)}`;
  const password = 'uchiyomi_disposable_initialization_check';
  const network = `${prefix}-net`;
  const containers = new Set<string>();
  const volumes: string[] = [];
  let sequence = 0;
  const docker = (args: string[], timeout = 30_000): string => execFileSync('docker', args, {
    encoding: 'utf8', stdio: 'pipe', timeout, maxBuffer: 5 * 1024 * 1024,
  }).trim();
  const query = (name: string, user: string, database: string, sql: string): string => docker([
    'exec', '-e', `PGPASSWORD=${password}`, name, 'psql', '-X', '--no-password', '-h', '127.0.0.1',
    '-U', user, '-d', database, '-Atqc', sql,
  ]);
  const waitForQuery = async (name: string, user: string, database: string): Promise<void> => {
    for (let attempt = 0; attempt < 120; attempt++) {
      if (docker(['inspect', '--format', '{{.State.Running}}', name]) !== 'true')
        assert.fail(`database exited before becoming ready:\n${docker(['logs', name])}`);
      try { if (query(name, user, database, 'SELECT 1') === '1') return; } catch { /* init server is socket-only */ }
      await setTimeout(250);
    }
    assert.fail(`database did not become ready:\n${docker(['logs', name])}`);
  };
  const createVolume = (suffix: string): string => {
    const name = `${prefix}-${suffix}`;
    docker(['volume', 'create', name]); volumes.push(name); return name;
  };
  const start = (volume: string, mode: 'fixed' | 'vendor' | 'legacy'): string => {
    const name = `${prefix}-${++sequence}`;
    const args = ['run', '-d', '--name', name, '--network', network,
      '-e', `POSTGRES_PASSWORD=${password}`,
      '-e', `POSTGRES_USER=${mode === 'legacy' ? 'yomi' : service.environment.POSTGRES_USER}`,
      '-e', `POSTGRES_DB=${mode === 'legacy' ? 'yomi' : service.environment.POSTGRES_DB}`,
      '--mount', `type=volume,source=${volume},target=/var/lib/postgresql/data`];
    if (mode === 'fixed') args.push('--mount', `type=bind,source=${join(REPO, 'deploy/dev-db/zz-uchiyomi.sh')},target=/docker-entrypoint-initdb.d/zz-uchiyomi.sh,readonly`);
    args.push(service.image); containers.add(name); docker(args); return name;
  };
  const remove = (name: string): void => {
    docker(['stop', '--timeout', '10', name]); docker(['rm', name]); containers.delete(name);
  };
  const seed = (name: string): void => {
    query(name, 'yomi', 'yomi', 'CREATE EXTENSION pg_trgm');
    query(name, 'yomi', 'yomi', "CREATE TABLE saved_development_rows (id integer PRIMARY KEY, note text); INSERT INTO saved_development_rows VALUES (1, 'keep this row')");
    query(name, 'yomi', 'yomi', "ALTER SYSTEM SET log_min_messages = 'warning'");
    query(name, 'yomi', 'yomi', 'SELECT pg_reload_conf()');
  };
  const snapshot = (name: string): string => query(name, 'yomi', 'yomi', `
    SELECT json_build_object('note', (SELECT note FROM saved_development_rows WHERE id = 1),
      'extension', (SELECT extversion FROM pg_extension WHERE extname = 'pg_trgm'),
      'hba', current_setting('hba_file'), 'ident', current_setting('ident_file'),
      'preload', current_setting('shared_preload_libraries'), 'messages', current_setting('log_min_messages'))`);
  const client = (name: string, suppliedPassword: string): string => docker([
    'run', '--rm', '--network', network, '-e', `PGPASSWORD=${suppliedPassword}`, '--entrypoint', 'psql',
    service.image, '-X', '--no-password', '-h', name, '-U', 'yomi', '-d', 'yomi', '-Atqc', 'SELECT 1',
  ]);

  try {
    docker(['pull', service.image], 180_000);
    docker(['network', 'create', '--internal', network]);
    await t.test('fresh volume finishes vendor migrations, accepts app credentials and keeps rows on restart', async () => {
      const volume = createVolume('fresh');
      let name = start(volume, 'fixed');
      await waitForQuery(name, 'yomi', 'yomi');
      assert.match(query(name, 'yomi', 'yomi', "SELECT current_setting('server_version_num')"), /^15\d{4}$/);
      assert.equal(query(name, 'supabase_admin', 'postgres', "SELECT count(*) FROM pg_extension WHERE extname = 'supabase_vault'"), '1');
      assert.equal(client(name, password), '1');
      assert.throws(() => client(name, 'incorrect-password'), /password authentication failed/, 'TCP clients must still authenticate');
      docker(['exec', name, 'sh', '-c', service.healthcheck.test[1]]);
      seed(name);
      const before = snapshot(name);
      remove(name); name = start(volume, 'fixed');
      await waitForQuery(name, 'yomi', 'yomi');
      assert.equal(snapshot(name), before);
      assert.match(docker(['logs', name]), /Skipping initialization/);
    });

    await t.test('an existing vendor cluster keeps its rows, extensions and configuration under the new initializer settings', async () => {
      const volume = createVolume('existing');
      let name = start(volume, 'vendor');
      await waitForQuery(name, 'supabase_admin', 'postgres');
      query(name, 'supabase_admin', 'postgres', `CREATE ROLE yomi WITH LOGIN SUPERUSER PASSWORD '${password}'`);
      query(name, 'supabase_admin', 'postgres', 'CREATE DATABASE yomi OWNER yomi');
      seed(name);
      const before = snapshot(name);
      remove(name); name = start(volume, 'legacy');
      await waitForQuery(name, 'yomi', 'yomi');
      assert.equal(snapshot(name), before, 'representative existing volume must work with the previous compose settings');
      remove(name); name = start(volume, 'fixed');
      await waitForQuery(name, 'yomi', 'yomi');
      assert.equal(snapshot(name), before);
      assert.equal(client(name, password), '1');
      docker(['exec', name, 'sh', '-c', service.healthcheck.test[1]]);
      assert.match(docker(['logs', name]), /Skipping initialization/);
    });

    await t.test('a previous failed initialization is detected without silently rewriting its cluster', async () => {
      const volume = createVolume('interrupted');
      let name = start(volume, 'legacy');
      for (let attempt = 0; attempt < 120; attempt++) {
        if (docker(['inspect', '--format', '{{.State.Running}}', name]) !== 'true') break;
        await setTimeout(250);
      }
      assert.equal(docker(['inspect', '--format', '{{.State.Running}}', name]), 'false');
      assert.match(docker(['logs', name]), /Peer authentication failed for user "yomi"/);
      remove(name); name = start(volume, 'fixed');
      await waitForQuery(name, 'yomi', 'postgres');
      assert.throws(() => query(name, 'yomi', 'yomi', 'SELECT 1'), /database "yomi" does not exist/);
      assert.throws(() => docker(['exec', name, 'sh', '-c', service.healthcheck.test[1]]), /database "yomi" does not exist/);
      assert.equal(query(name, 'yomi', 'postgres', "SELECT count(*) FROM pg_roles WHERE rolname = 'supabase_admin'"), '0', 'existing clusters must not run the new init hook');
      assert.match(docker(['logs', name]), /Skipping initialization/);
    });
  } finally {
    for (const name of containers) {
      try { docker(['stop', '--timeout', '10', name]); docker(['rm', name]); } catch { /* preserve test failure */ }
    }
    for (const volume of volumes) { try { docker(['volume', 'rm', volume]); } catch { /* preserve test failure */ } }
    try { docker(['network', 'rm', network]); } catch { /* setup may not have reached network creation */ }
  }
});
