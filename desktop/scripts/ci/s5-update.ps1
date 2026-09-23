# S5: an NSIS update from vN to vN+1 while the app's children run, using the shutdown path the updater will use.
#   install vN silently -> launch it (postgres + bff up) -> write data (the first admin) -> `Uchiyomi --quit-for-update`
#   (full ordered shutdown, then waits for the old instance to be gone) -> install vN+1 silently over it
#   PASS = both installers exit 0, nothing of the old install is left running, vN+1 boots on the SAME data dir and
#   the bff still has vN's admin (setup closed, the password signs in).
# Then the CONTROL: install over a RUNNING app with no ordered shutdown, to show what the installer does on its own
# (electron-builder's NSIS script force-stops every process whose image lives under the install dir -- which
# includes postgres.exe) and whether the next boot recovers from that.
param(
  [Parameter(Mandatory = $true)][string]$SetupN,
  [Parameter(Mandatory = $true)][string]$SetupN1,
  [Parameter(Mandatory = $true)][string]$VersionN1
)
$ErrorActionPreference = 'Continue'
$Desktop = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$Out = Join-Path $Desktop 'ci-out'
New-Item -ItemType Directory -Force $Out | Out-Null
$Inst = Join-Path $env:LOCALAPPDATA 'Programs\Uchiyomi'
$Exe = Join-Path $Inst 'Uchiyomi.exe'
$Data = Join-Path $env:LOCALAPPDATA 'Uchiyomi'
$Body = '{"username":"s5admin","password":"s5-passw0rd-123"}'

function Rec($id, $verdict, $summary, $evidence) {
  $f = Join-Path $env:RUNNER_TEMP "ev-$id.json"
  ($evidence | ConvertTo-Json -Depth 8) | Set-Content -Encoding utf8 $f
  node (Join-Path $PSScriptRoot 'record.mjs') $id $verdict $summary $f
}
function Install($setup) {
  $t = Get-Date
  $p = Start-Process -FilePath $setup -ArgumentList '/S' -PassThru
  if (-not $p.WaitForExit(300000)) { try { $p.Kill() } catch {}; return @{ exit = 'timeout'; ms = 300000 } }
  return @{ exit = $p.ExitCode; ms = [int]((Get-Date) - $t).TotalMilliseconds }
}
function Procs {
  @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($Inst, [StringComparison]::OrdinalIgnoreCase) } |
    ForEach-Object { [ordered]@{ pid = $_.ProcessId; name = $_.Name; path = $_.ExecutablePath.Substring($Inst.Length) } })
}
function WaitHealthy([int]$timeoutSec = 180) {
  $deadline = (Get-Date).AddSeconds($timeoutSec)
  while ((Get-Date) -lt $deadline) {
    try {
      $s = Get-Content (Join-Path $Data 'state.json') -Raw | ConvertFrom-Json
      if ($s.uiPort -and $s.mainPid) {
        $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 "http://127.0.0.1:$($s.uiPort)/healthz"
        if ($r.StatusCode -eq 200) { return [int]$s.uiPort }
      }
    } catch {}
    Start-Sleep -Milliseconds 500
  }
  return 0
}
function Versions { @(Select-String -Path (Join-Path $Data 'logs\desktop.log') -Pattern 'Uchiyomi Desktop (\S+) starting \{"mode":"app"' | ForEach-Object { $_.Matches[0].Groups[1].Value }) }
function StopLines { @(Select-String -Path (Join-Path $Data 'logs\desktop.log') -Pattern 'supervisor: stopped' | ForEach-Object { $_.Line.Substring(0, [Math]::Min(300, $_.Line.Length)) }) }

Remove-Item -Recurse -Force $Data -ErrorAction SilentlyContinue
$ev = [ordered]@{}

# ---- vN
$ev.installN = Install $SetupN
$ev.versionN = (Get-Item $Exe -ErrorAction SilentlyContinue).VersionInfo.ProductVersion
Start-Process -FilePath $Exe
$port = WaitHealthy
$ev.portN = $port
try { $null = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$port/api/setup" -ContentType 'application/json' -Body $Body; $ev.setupN = 'created' } catch { $ev.setupN = "failed: $($_.Exception.Message)" }
$ev.runningN = Procs
$pgdataN = (Get-Content (Join-Path $Data 'state.json') -Raw | ConvertFrom-Json).pgdata

# ---- the updater's shutdown path
$t = Get-Date
$q = Start-Process -FilePath $Exe -ArgumentList '--quit-for-update' -PassThru -Wait
$ev.quitForUpdate = @{ exit = $q.ExitCode; ms = [int]((Get-Date) - $t).TotalMilliseconds }
Start-Sleep -Seconds 2
$ev.leftAfterQuit = Procs
$ev.stopLog = StopLines

# ---- vN+1 over it
$ev.installN1 = Install $SetupN1
$ev.versionN1 = (Get-Item $Exe -ErrorAction SilentlyContinue).VersionInfo.ProductVersion
Start-Process -FilePath $Exe
$port1 = WaitHealthy
$ev.portN1 = $port1
try { $ev.setupStatusN1 = (Invoke-RestMethod "http://127.0.0.1:$port1/api/setup/status") } catch { $ev.setupStatusN1 = "failed: $($_.Exception.Message)" }
try { $lr = Invoke-WebRequest -UseBasicParsing -Method Post -Uri "http://127.0.0.1:$port1/auth/login" -ContentType 'application/json' -Body $Body; $ev.loginN1 = $lr.StatusCode } catch { $ev.loginN1 = "failed: $($_.Exception.Message)" }
$ev.pgdataSame = ((Get-Content (Join-Path $Data 'state.json') -Raw | ConvertFrom-Json).pgdata -eq $pgdataN)
$ev.versionsBooted = Versions

$pass = ($ev.installN.exit -eq 0) -and ($ev.quitForUpdate.exit -eq 0) -and ($ev.leftAfterQuit.Count -eq 0) -and ($ev.installN1.exit -eq 0) -and `
  ($ev.versionsBooted -contains $VersionN1) -and ($port1 -gt 0) -and ($ev.setupStatusN1.needsSetup -eq $false) -and ($ev.loginN1 -eq 200) -and $ev.pgdataSame
Rec 'S5-nsis-update' $(if ($pass) { 'PASS' } else { 'FAIL' }) `
  ("vN install exit $($ev.installN.exit) ($($ev.installN.ms) ms), $($ev.runningN.Count) processes under the install dir while running; --quit-for-update exit $($ev.quitForUpdate.exit) in $($ev.quitForUpdate.ms) ms, left running: $($ev.leftAfterQuit.Count); vN+1 install exit $($ev.installN1.exit) ($($ev.installN1.ms) ms); booted versions: $($ev.versionsBooted -join ' -> '); same data dir: $($ev.pgdataSame), setup closed: $(-not $ev.setupStatusN1.needsSetup), vN's admin signs in: $($ev.loginN1); same UI port: $($port -eq $port1)") $ev

# ---- control: install over the RUNNING app, no ordered shutdown
$c = [ordered]@{}
$c.runningBefore = Procs
$pidFile = Join-Path $pgdataN 'postmaster.pid'
$c.install = Install $SetupN1
Start-Sleep -Seconds 2
$c.runningAfter = Procs
$c.postmasterPidLeft = Test-Path $pidFile
$c.stopLogAfter = StopLines
Start-Process -FilePath $Exe
$port2 = WaitHealthy
$c.rebootPort = $port2
try { $lr = Invoke-WebRequest -UseBasicParsing -Method Post -Uri "http://127.0.0.1:$port2/auth/login" -ContentType 'application/json' -Body $Body; $c.loginAfter = $lr.StatusCode } catch { $c.loginAfter = "failed: $($_.Exception.Message)" }
$pgLog = Join-Path $Data 'logs\postgres.log'
$c.crashRecoveryLogged = [bool](Select-String -Path $pgLog -Pattern 'not properly shut down|automatic recovery' -Quiet)
$c.recoveryLine = @(Select-String -Path (Join-Path $Data 'logs\desktop.log') -Pattern 'recovery on boot|stale postmaster|orphaned server' | ForEach-Object { $_.Line }) | Select-Object -Last 3
Rec 'S5-control-no-shutdown' 'INFO' `
  ("installing over a running app WITHOUT --quit-for-update: installer exit $($c.install.exit); processes under the install dir before $($c.runningBefore.Count) -> after $($c.runningAfter.Count) (the installer force-stops them, postgres.exe included); postmaster.pid left behind: $($c.postmasterPidLeft); postgres crash recovery on the next boot: $($c.crashRecoveryLogged); next boot healthy: $($port2 -gt 0), login $($c.loginAfter)") $c

# ---- cleanup
Start-Process -FilePath $Exe -ArgumentList '--quit-for-update' -Wait
$un = Join-Path $Inst 'Uninstall Uchiyomi.exe'
if (Test-Path $un) { Start-Process -FilePath $un -ArgumentList '/S' -Wait }
foreach ($n in 'desktop.log', 'postgres.log', 'bff.log') { Copy-Item (Join-Path $Data "logs\$n") (Join-Path $Out "s5-$n") -ErrorAction SilentlyContinue }
