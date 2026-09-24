// CLI for the PowerShell and shell checks: node record.mjs <id> <PASS|FAIL|EXPECTED|INFO> "<summary>" [evidence.json]
import { readFileSync } from 'node:fs';
import { record } from './lib.mjs';

const [id, verdict, summary, ev] = process.argv.slice(2);
let evidence = {};
if (ev) {
  try { evidence = JSON.parse(readFileSync(ev, 'utf8').replace(/^﻿/, '')); } catch (e) { evidence = { unreadable: String(e), raw: readFileSync(ev, 'utf8').slice(0, 4000) }; }
}
record(id, verdict, summary, evidence);
