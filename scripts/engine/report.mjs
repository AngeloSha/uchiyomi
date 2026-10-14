#!/usr/bin/env node
// report.mjs: what the weekly canary found, as one result per engine and, when posting is on, as issues and a branch.
//
//   node scripts/engine/report.mjs --record <dir>     (probe job) write <dir>/result.json from the steps' outcomes
//   node scripts/engine/report.mjs --report <dir>     (report job) act on every <dir>/*/result.json  [--dry]
//
// The report job runs only with the repository variable ENGINE_CANARY_POST=on (off until the owner opts in), and is
// the one job with write permissions: issues, and contents for the bump branch. What it does:
//   * a NEWER STABLE engine passed: `scripts/engine/bump.mjs <tag>` on a branch engine-bump/<tag>, pushed, and one
//     issue for that version with the checklist of what is left. A branch, not a pull request: one made with
//     GITHUB_TOKEN would run no workflows, so a person opens the PR and CI runs on it. Never main, never a tag;
//   * an engine FAILED: one issue for that version naming the step and what the engine refused; a comment only when the
//     failure is a different one from last time (its signature), so a red canary is not a weekly notification;
//   * the PREVIEW: one long-lived issue, its body replaced each week, never a comment;
//   * the PIN itself failing is said too: then the canary, or the image under the pinned tag, changed;
//   * an issue about a version that is now the pin is closed.
// Each issue is found again by a hidden marker in its body (<!-- engine-canary:KEY -->), among the issues this
// workflow opened (creator github-actions[bot]). Dependency-free; GITHUB_TOKEN and GITHUB_REPOSITORY from the job.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STEPS_LEFT } from './bump.mjs';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const STEPS = ['start', 'env', 'schema', 'operations', 'conform', 'live', 'suite'];
const STEP_NAMES = {
  start: 'starting the engine', env: 'the deploy variables', schema: 'capturing its schema',
  operations: "Uchiyomi's operations on its schema", conform: 'the fake engine against it', live: "Uchiyomi's own code against it",
  suite: 'the fake-based tests on its schema',
};
const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');

/** The probe job's outcome for one engine, from its steps (STEP_<NAME>=success|failure|skipped) and their logs. */
export function record(dir, env = process.env) {
  const steps = Object.fromEntries(STEPS.map((s) => [s, env[`STEP_${s.toUpperCase()}`] || 'skipped']));
  const ops = read(join(dir, 'operations.txt'));
  const live = read(join(dir, 'live.txt'));
  const refused = [...new Set([...ops.matchAll(/(\w+) is refused by/g)].map((m) => m[1]))].sort();
  const deprecated = [...new Set([...ops.matchAll(/uses deprecated ([\w.(), ]+?) on/g)].map((m) => m[1]))].sort();
  // The conform battery reports and never fails the run: what differs is kept for the issue.
  const conform = /(\d+) of (\d+) identical/.exec(read(join(dir, 'conform.txt')));
  const result = {
    kind: env.KIND, tag: env.TAG, pin: env.PIN, image: env.IMAGE, fresh: env.FRESH === 'true', publishedAt: env.PUBLISHED_AT || null,
    steps, failed: STEPS.find((s) => s !== 'conform' && steps[s] === 'failure') ?? null,
    refused, deprecated, conform: conform ? `${conform[1]} of ${conform[2]} identical` : null,
    liveFailed: /^not ok/m.test(live), runUrl: env.RUN_URL || null,
  };
  writeFileSync(join(dir, 'result.json'), JSON.stringify(result, null, 2));
  return result;
}

const marker = (key) => `<!-- engine-canary:${key} -->`;
const signatureOf = (r) => createHash('sha256').update(JSON.stringify([r.failed, r.refused, r.deprecated])).digest('hex').slice(0, 16);
const isNewer = (a, b) => {
  const p = (v) => (/^v(\d+)\.(\d+)\.(\d+)$/.exec(v ?? '') ?? []).slice(1).map(Number);
  const [x, y] = [p(a), p(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
};

function body(r, dir, extra = []) {
  const diff = read(join(dir, 'schema-diff.txt')).trim();
  const env = read(join(dir, 'env.txt')).trim();
  return [
    ...extra,
    `**Engine:** \`${r.image}\` (${r.kind}${r.publishedAt ? `, released ${r.publishedAt.slice(0, 10)}` : ''}${r.fresh ? ', less than 14 days old' : ''}). **Pin:** ${r.pin}.`,
    '',
    '| Step | Outcome |', '| --- | --- |',
    ...STEPS.map((s) => `| ${STEP_NAMES[s]} | ${r.steps[s]}${s === 'conform' && r.conform ? ` (${r.conform})` : ''} |`),
    '',
    r.refused.length ? `**Refused:** ${r.refused.join(', ')}` : null,
    r.deprecated.length ? `**Deprecated and used by Uchiyomi:** ${r.deprecated.join(', ')}` : null,
    diff ? `<details><summary>Schema changes against the pin</summary>\n\n\`\`\`\n${diff.slice(0, 20000)}\n\`\`\`\n</details>` : null,
    env ? `<details><summary>Deploy variables</summary>\n\n\`\`\`\n${env.slice(0, 5000)}\n\`\`\`\n</details>` : null,
    r.runUrl ? `\n[The run](${r.runUrl}) keeps the captured schema, the logs and the conform battery's differences.` : null,
  ].filter((x) => x !== null).join('\n');
}

export async function report(dir, o = {}) {
  const repo = o.repo ?? process.env.GITHUB_REPOSITORY;
  const token = o.token ?? process.env.GITHUB_TOKEN;
  const api = (o.api ?? 'https://api.github.com').replace(/\/+$/, '');
  const dry = !!o.dry;
  const actions = [];
  const call = async (method, path, payload) => {
    if (dry && method !== 'GET') {
      actions.push(`${method} ${path} ${payload?.title ?? payload?.state ?? ''}`.trim(), ...(payload?.body ? [payload.body.replace(/^/gm, '    ')] : []));
      return {};
    }
    const r = await fetch(`${api}/repos/${repo}${path}`, {
      method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), accept: 'application/vnd.github+json', 'content-type': 'application/json' },
      body: payload ? JSON.stringify(payload) : undefined,
    });
    if (!r.ok) throw new Error(`${method} ${path}: HTTP ${r.status} ${await r.text()}`);
    return r.status === 204 ? {} : r.json();
  };
  const issues = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await call('GET', `/issues?creator=${encodeURIComponent('github-actions[bot]')}&state=all&per_page=100&page=${page}`);
    issues.push(...(batch ?? []).filter((i) => !i.pull_request));
    if (!batch?.length || batch.length < 100) break;
  }
  const find = (key) => issues.find((i) => String(i.body ?? '').includes(marker(key)));
  const results = readdirSync(dir).map((d) => join(dir, d, 'result.json')).filter(existsSync)
    .map((f) => ({ r: JSON.parse(readFileSync(f, 'utf8')), dir: join(f, '..') }));
  const pin = results[0]?.r.pin;

  for (const { r, dir: rdir } of results) {
    const key = r.kind === 'preview' ? 'preview' : r.kind === 'pin' ? `pin-${r.tag}` : r.tag;
    const existing = find(key);
    if (r.kind === 'preview') {
      const text = `${marker(key)}\nThe newest Suwayomi-Server preview, tested every week and only reported: nothing is bumped from a preview.\n\n${body(r, rdir)}`;
      const title = `Engine canary: preview ${r.tag} ${r.failed ? `fails at ${STEP_NAMES[r.failed]}` : 'passes'}`;
      if (existing) await call('PATCH', `/issues/${existing.number}`, { title, body: text });
      else await call('POST', '/issues', { title, body: text });
      continue;
    }
    if (r.failed) {
      const sig = signatureOf(r);
      const title = r.kind === 'pin' ? `Engine canary: the pinned engine ${r.tag} fails at ${STEP_NAMES[r.failed]}`
        : `Engine canary: Suwayomi-Server ${r.tag} fails at ${STEP_NAMES[r.failed]}`;
      const lead = r.kind === 'pin'
        ? ['The CONTROL failed: the engine every install runs today. The canary, or the image under that tag, changed -- not a new engine.', '']
        : [`Suwayomi-Server ${r.tag} fails ${STEP_NAMES[r.failed]}. Keep the pin until it passes; this issue gets a comment only when the failure changes.`, ''];
      const text = `${marker(key)}\n<!-- engine-canary-signature:${sig} -->\n${body(r, rdir, lead)}`;
      if (!existing) await call('POST', '/issues', { title, body: text });
      else if (!String(existing.body).includes(`engine-canary-signature:${sig}`)) {
        await call('PATCH', `/issues/${existing.number}`, { title, body: text, state: 'open' });
        await call('POST', `/issues/${existing.number}/comments`, { body: `It fails differently now: ${STEP_NAMES[r.failed]}${r.refused.length ? `; refused ${r.refused.join(', ')}` : ''}.${r.runUrl ? ` [Run](${r.runUrl}).` : ''}` });
      }
      continue;
    }
    if (r.kind === 'pin') {
      // The control passes: a failure it had is over.
      if (existing?.state === 'open') {
        await call('POST', `/issues/${existing.number}/comments`, { body: `The pinned engine passes again.${r.runUrl ? ` [Run](${r.runUrl}).` : ''}` });
        await call('PATCH', `/issues/${existing.number}`, { state: 'closed' });
      }
      continue;
    }
    if (r.kind === 'stable' && isNewer(r.tag, r.pin)) {
      const branch = `engine-bump/${r.tag}`;
      if (!dry) {
        const git = (...a) => execFileSync('git', a, { cwd: o.root ?? ROOT, stdio: 'inherit' });
        git('checkout', '-B', branch);
        execFileSync(process.execPath, [join(o.root ?? ROOT, 'scripts', 'engine', 'bump.mjs'), r.tag, '--schema', join(rdir, 'schema.json')], { cwd: o.root ?? ROOT, stdio: 'inherit' });
        git('add', '-A');
        git('-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
          'commit', '-m', `Engine ${r.tag}: every pin, its schema and its FlareSolverr DTOs (scripts/engine/bump.mjs)`);
        // Only ever this branch: never main, never a tag (bff/test/releasePipeline.test.ts holds it to that).
        git('push', '--force', 'origin', `HEAD:refs/heads/${branch}`);
      } else actions.push(`push ${branch}`);
      const steps = STEPS_LEFT(r.pin, r.tag).map((s) => `- [ ] ${s}`);
      const text = [
        marker(key), '<!-- engine-canary-state:passed -->',
        `Suwayomi-Server ${r.tag} passed the canary${r.fresh ? ' -- released less than 14 days ago, so give it a little longer before the soak' : ''}.`,
        `The branch \`${branch}\` moves every pin to it (scripts/engine/bump.mjs). Open a pull request from it: CI runs there.`,
        '', '**Left to do by hand:**', ...steps, '', body(r, rdir),
      ].join('\n');
      const title = `Engine canary: Suwayomi-Server ${r.tag} passed -- branch ${branch}`;
      if (!existing) await call('POST', '/issues', { title, body: text });
      // An issue a person closed stays closed; one that said it failed now says it passes.
      else if (existing.state === 'open') await call('PATCH', `/issues/${existing.number}`, { title, body: text });
    }
  }
  // A version that is the pin now needs no issue.
  for (const i of issues) {
    if (i.state === 'open' && pin && String(i.body ?? '').includes(marker(pin))) {
      await call('POST', `/issues/${i.number}/comments`, { body: `${pin} is the pinned engine now.` });
      await call('PATCH', `/issues/${i.number}`, { state: 'closed' });
    }
  }
  return actions;
}

async function main(argv) {
  const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  if (opt('--record')) { console.log(JSON.stringify(record(opt('--record')), null, 2)); return 0; }
  if (opt('--report')) {
    const done = await report(opt('--report'), { dry: argv.includes('--dry') });
    if (done.length) console.log(done.join('\n'));
    return 0;
  }
  console.error('usage: report.mjs --record <dir> | --report <dir> [--dry]');
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e?.message ?? e); process.exit(1); });
}
