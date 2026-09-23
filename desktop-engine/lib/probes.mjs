// OS probes for the spike: listening sockets, RSS, child processes, Windows console attachment, footprint.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const win = process.platform === 'win32', mac = process.platform === 'darwin';

async function sh(cmd, args, opts = {}) {
  try {
    const r = await run(cmd, args, { maxBuffer: 16 << 20, windowsHide: true, ...opts });
    return r.stdout;
  } catch (e) {
    return e.stdout || '';
  }
}

export async function powershell(script) {
  return sh('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]);
}

/** Every TCP listener owned by pid: [{addr, port, raw}]. */
export async function listeners(pid) {
  const out = [];
  if (win) {
    const txt = await sh('netstat', ['-ano']);
    for (const line of txt.split(/\r?\n/)) {
      const m = /^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/.exec(line);
      if (m && Number(m[3]) === pid) out.push({ addr: m[1], port: Number(m[2]), raw: line.trim() });
    }
  } else if (mac) {
    const txt = await sh('lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN']);
    for (const line of txt.split('\n').slice(1)) {
      const m = /\s(\S+):(\d+) \(LISTEN\)/.exec(line);
      if (m) out.push({ addr: m[1], port: Number(m[2]), raw: line.trim() });
    }
  } else {
    const txt = await sh('ss', ['-ltnpH']);
    for (const line of txt.split('\n')) {
      if (!line.includes(`pid=${pid},`)) continue;
      const m = /\s(\S+):(\d+)\s+\S+:\S+\s/.exec(line);
      if (m) out.push({ addr: m[1], port: Number(m[2]), raw: line.trim() });
    }
  }
  return out;
}

// Linux's dual-stack Java sockets print an IPv4 bind as the mapped address [::ffff:127.0.0.1].
export const isLoopback = (a) => /^\[?(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)\]?$/i.test(a) || a === 'localhost';

/** Resident memory in bytes (Windows: working set) plus Windows private bytes when available. */
export async function rss(pid) {
  if (win) {
    const txt = await powershell(`$p = Get-Process -Id ${pid}; "$($p.WorkingSet64) $($p.PrivateMemorySize64)"`);
    const [ws, priv] = txt.trim().split(/\s+/).map(Number);
    return { rss: ws, privateBytes: priv };
  }
  if (mac) {
    const txt = await sh('ps', ['-o', 'rss=', '-p', String(pid)]);
    return { rss: Number(txt.trim()) * 1024 };
  }
  const st = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
  return { rss: Number(/VmRSS:\s+(\d+)/.exec(st)[1]) * 1024 };
}

export async function children(pid) {
  if (win) {
    const txt = await powershell(`Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | ForEach-Object { "$($_.ProcessId) $($_.Name)" }`);
    return txt.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  }
  const txt = mac ? await sh('pgrep', ['-lP', String(pid)]) : await sh('ps', ['-o', 'pid=,comm=', '--ppid', String(pid)]);
  return txt.split('\n').map((s) => s.trim()).filter(Boolean);
}

export async function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/**
 * Windows: does `pid` own a console? FreeConsole + AttachConsole(pid) from a helper PowerShell.
 * attached=false with error 6 (ERROR_INVALID_HANDLE) = the process has no console, so nothing can flash.
 */
export async function consoleProbe(pid, scratch) {
  const out = path.join(scratch, `console-${pid}.json`);
  const script = `
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class ConProbe {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
}
"@
[ConProbe]::FreeConsole() | Out-Null
$ok = [ConProbe]::AttachConsole([uint32]${pid})
$err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
$h = [ConProbe]::GetConsoleWindow()
$vis = $false; if ($h -ne [IntPtr]::Zero) { $vis = [ConProbe]::IsWindowVisible($h) }
[ConProbe]::FreeConsole() | Out-Null
Set-Content -LiteralPath '${out.replace(/'/g, "''")}' -Value ('{"attached":' + $ok.ToString().ToLower() + ',"error":' + $err + ',"hwnd":' + $h.ToInt64() + ',"visible":' + $vis.ToString().ToLower() + '}')
`;
  await powershell(script);
  try { return JSON.parse(fs.readFileSync(out, 'utf8').replace(/^﻿/, '')); } catch (e) { return { error: `probe failed: ${e.message}` }; }
}

/** Places a Suwayomi/JVM could write outside its rootDir. */
export async function footprint() {
  const home = os.homedir();
  const tmp = os.tmpdir();
  const paths = win
    ? [path.join(tmp, 'Tachidesk'), path.join(process.env.LOCALAPPDATA || '', 'Tachidesk'), path.join(process.env.APPDATA || '', 'Tachidesk'), path.join(home, '.java')]
    : mac
      ? [path.join(tmp, 'Tachidesk'), path.join(home, 'Library', 'Application Support', 'Tachidesk'), path.join(home, 'Library', 'Preferences', 'com.apple.java.util.prefs.plist'), path.join(home, '.java')]
      : [path.join(tmp, 'Tachidesk'), path.join(home, '.local', 'share', 'Tachidesk'), path.join(home, '.java')];
  const res = {};
  for (const p of paths) res[p] = fs.existsSync(p);
  if (win) {
    const q = await sh('reg', ['query', 'HKCU\\Software\\JavaSoft\\Prefs']);
    res['HKCU\\Software\\JavaSoft\\Prefs'] = /JavaSoft\\Prefs/i.test(q);
  }
  return res;
}
