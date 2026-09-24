// The job's verdict table: every RESULT row from ci-out/results.jsonl (and any downloaded ones), into the log and
// the GitHub job summary. Exits 1 when any row is FAIL, so a red job means a failed check, not a crashed script.
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OUT } from './lib.mjs';

const dirs = [OUT, ...process.argv.slice(2)];
const rows = [];
for (const d of dirs) {
  if (!existsSync(d)) continue;
  for (const f of readdirSync(d, { recursive: true }).map(String).filter((f) => f.endsWith('results.jsonl'))) {
    for (const l of readFileSync(join(d, f), 'utf8').split('\n').filter(Boolean)) rows.push(JSON.parse(l));
  }
}
const md = ['| check | os | verdict | evidence |', '|---|---|---|---|', ...rows.map((r) => `| ${r.id} | ${r.os} | **${r.verdict}** | ${String(r.summary).replace(/\|/g, '/').slice(0, 900)} |`)].join('\n');
console.log(md);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Desktop checks\n\n${md}\n`);
const failed = rows.filter((r) => r.verdict === 'FAIL');
if (!rows.length) { console.log('no results recorded'); process.exit(1); }
if (failed.length) { console.log(`\n${failed.length} FAIL: ${failed.map((r) => r.id).join(', ')}`); process.exit(1); }
