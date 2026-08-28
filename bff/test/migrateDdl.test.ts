// The schema is one TypeScript template literal, and a backtick inside a SQL comment ends it.
//
// This is not hypothetical: it was introduced three separate times in one working session, in migrate.ts
// and again in health.ts, each time by writing a SQL comment in the same prose style as the surrounding
// TypeScript. It always fails the build, so it never reached anyone -- but it costs a cycle every time, and
// the failure message ("',' expected") points at the syntax rather than at the comment.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..', 'src', 'lib');

/** The characters that terminate a template literal, in files whose SQL lives inside one. */
test('no SQL comment contains a backtick or a template placeholder', () => {
  for (const file of ['migrate.ts', 'health.ts', 'sourceHealth.ts']) {
    const text = readFileSync(join(SRC, file), 'utf8');
    text.split('\n').forEach((line, i) => {
      const sql = line.trimStart();
      if (!sql.startsWith('--')) return;
      assert.ok(
        !sql.includes('`'),
        `${file}:${i + 1} has a backtick inside a SQL comment, which closes the template literal:\n  ${sql}`,
      );
      assert.ok(
        !/\$\{/.test(sql),
        `${file}:${i + 1} has \${...} inside a SQL comment, which interpolates into the schema:\n  ${sql}`,
      );
    });
  }
});
