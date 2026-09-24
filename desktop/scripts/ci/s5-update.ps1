# S5: an NSIS update from vN to vN+1 while the app's children run, the way both update paths do it.
#   install vN silently -> first run (--library-dir) -> postgres + bff up -> `Uchiyomi --quit-for-update` (the
#   in-app updater's ordered shutdown; it returns once the old instance is gone) -> install vN+1 silently over it
#   PASS = both installers exit 0, nothing of the old install is left running, vN+1 boots on the SAME data dir
#   and database (initdb ran once, in vN), with the library folder chosen in vN.
# Then: install vN+1 over the RUNNING app with no shutdown of our own. build/installer.nsh makes the installer
# itself ask the app for its ordered shutdown first; without it, the spike measured the installer killing
# Uchiyomi.exe and leaving the six postgres.exe running from the install folder (and still exiting 0).
#   PASS = nothing of ours still running after the installer, postmaster.pid gone (a clean stop), and the next
#   boot needs no crash recovery.
param(
  [Parameter(Mandatory = $true)][string]$SetupN,
  [Parameter(Mandatory = $true)][string]$SetupN1,
  [Parameter(Mandatory = $true)][string]$VersionN1
)
$ErrorActionPreference = 'Continue'
$Desktop = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$Out = Join-Path $Desktop 'ci-out'
New-Item -ItemType Directory -Force $Out | Out-Null
# electron-builder's one-click per-user installer names the folder after package.json "name" (sanitizedName),
# not productName: %LOCALAPPDATA%\Programs\uchiyomi-desktop. Found, not assumed.
$Inst = Join-Path $env:LOCALAPPDATA 'Programs\uchiyomi-desktop'
$Exe = Join-Path $Inst 'Uchiyomi.exe'
function FindInstall {
  $hit = Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Programs') -Directory -ErrorAction SilentlyContinue | Where-Object { Test-Path (Join-Path $_.FullName 'Uchiyomi.exe') } | Select-Object -First 1
  if ($hit) { $script:Inst = $hit.FullName; $script:Exe = Join-Path $hit.FullName 'Uchiyomi.exe' }
  $reg = Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue | ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object { $_.DisplayName -like 'Uchiyomi*' } | Select-Object -First 1 DisplayName, DisplayVersion, InstallLocation
  return $reg
}
$Data = Join-Path $env:LOCALAPPDATA 'Uchiyomi'
$Lib = Join-Path $env:RUNNER_TEMP 's5-library\Uchiyomi Library'

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
function WaitHealthy([int]$timeoutSec = 240) {
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
function DesktopMode($port) {
  try { return [bool](Invoke-RestMethod "http://127.0.0.1:$port/auth/config").desktop } catch { return $false }
}
function LogCount($pattern) { @(Select-String -Path (Join-Path $Data 'logs\desktop.log') -Pattern $pattern).Count }
function Versions { @(Select-String -Path (Join-Path $Data 'logs\desktop.log') -Pattern 'Uchiyomi Desktop (\S+) starting \{"mode":"app"' | ForEach-Object { $_.Matches[0].Groups[1].Value }) }
function StopLines { @(Select-String -Path (Join-Path $Data 'logs\desktop.log') -Pattern 'supervisor: stopped' | ForEach-Object { $_.Line.Substring(0, [Math]::Min(300, $_.Line.Length)) }) }

Remove-Item -Recurse -Force $Data -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force (Split-Path $Lib) -ErrorAction SilentlyContinue
$ev = [ordered]@{}

# ---- vN, first run
$ev.installN = Install $SetupN
$ev.uninstallEntryN = FindInstall
$ev.installDir = $Inst
$ev.versionN = (Get-Item $Exe -ErrorAction SilentlyContinue).VersionInfo.ProductVersion
Start-Process -FilePath $Exe -ArgumentList "--library-dir=`"$Lib`""
$port = WaitHealthy
$ev.portN = $port
$ev.desktopN = DesktopMode $port
$ev.runningN = Procs
$stateN = Get-Content (Join-Path $Data 'state.json') -Raw | ConvertFrom-Json
$pgdataN = $stateN.pgdata
$secretsN = Get-FileHash (Join-Path $Data 'secrets.json')

# ---- the updater's shutdown path
$t = Get-Date
$q = Start-Process -FilePath $Exe -ArgumentList '--quit-for-update' -PassThru -Wait
$ev.quitForUpdate = @{ exit = $q.ExitCode; ms = [int]((Get-Date) - $t).TotalMilliseconds }
Start-Sleep -Seconds 2
$ev.leftAfterQuit = Procs
$ev.stopLog = StopLines

# ---- vN+1 over it (no --library-dir: the choice is in state.json)
$ev.installN1 = Install $SetupN1
$ev.uninstallEntryN1 = FindInstall
$ev.versionN1 = (Get-Item $Exe -ErrorAction SilentlyContinue).VersionInfo.ProductVersion
Start-Process -FilePath $Exe
$port1 = WaitHealthy
$ev.portN1 = $port1
$ev.desktopN1 = DesktopMode $port1
$state1 = Get-Content (Join-Path $Data 'state.json') -Raw | ConvertFrom-Json
$ev.pgdataSame = ($state1.pgdata -eq $pgdataN)
$ev.libraryKept = ($state1.libraryDir -eq $stateN.libraryDir) -and (Test-Path $Lib)
$ev.secretsSame = ((Get-FileHash (Join-Path $Data 'secrets.json')).Hash -eq $secretsN.Hash)
$ev.initdbRuns = LogCount 'postgres: initdb ok'
$ev.versionsBooted = Versions

$pass = ($ev.installN.exit -eq 0) -and ($ev.quitForUpdate.exit -eq 0) -and ($ev.leftAfterQuit.Count -eq 0) -and ($ev.installN1.exit -eq 0) -and `
  ($ev.versionsBooted -contains $VersionN1) -and ($port1 -gt 0) -and $ev.desktopN1 -and $ev.pgdataSame -and $ev.libraryKept -and $ev.secretsSame -and ($ev.initdbRuns -eq 1) -and ($ev.runningN.Count -gt 0)
Rec 'S5-nsis-update' $(if ($pass) { 'PASS' } else { 'FAIL' }) `
  ("vN install exit $($ev.installN.exit) ($($ev.installN.ms) ms), $($ev.runningN.Count) processes under the install dir while running; --quit-for-update exit $($ev.quitForUpdate.exit) in $($ev.quitForUpdate.ms) ms, left running: $($ev.leftAfterQuit.Count); vN+1 install exit $($ev.installN1.exit) ($($ev.installN1.ms) ms); booted versions: $($ev.versionsBooted -join ' -> '); desktop mode: $($ev.desktopN1); same database: $($ev.pgdataSame) (initdb ran $($ev.initdbRuns)x); library folder kept: $($ev.libraryKept); same UI port: $($port -eq $port1)") $ev

# ---- install over the RUNNING app: build/installer.nsh must stop it in order first
$c = [ordered]@{}
$c.runningBefore = Procs
$pidFile = Join-Path $pgdataN 'postmaster.pid'
$c.install = Install $SetupN1
Start-Sleep -Seconds 2
$c.runningAfter = Procs
$c.postmasterPidLeft = Test-Path $pidFile
$c.stopLogAfter = StopLines
$pgLog = Join-Path $Data 'logs\postgres.log'
$pgLogLen = if (Test-Path $pgLog) { (Get-Item $pgLog).Length } else { 0 }
Start-Process -FilePath $Exe
$port2 = WaitHealthy
$c.rebootPort = $port2
$tail = if (Test-Path $pgLog) { [IO.File]::ReadAllText($pgLog).Substring([int]$pgLogLen) } else { '' }
$c.crashRecoveryOnReboot = [bool]($tail -match 'not properly shut down|automatic recovery')
$c.recoveryLine = @(Select-String -Path (Join-Path $Data 'logs\desktop.log') -Pattern 'recovery on boot|stale postmaster|orphaned server' | ForEach-Object { $_.Line }) | Select-Object -Last 3
$names = { param($list) (@($list) | Group-Object { $_.name } | ForEach-Object { "$($_.Name) x$($_.Count)" }) -join ', ' }
$cpass = ($c.install.exit -eq 0) -and ($c.runningBefore.Count -gt 0) -and ($c.runningAfter.Count -eq 0) -and (-not $c.postmasterPidLeft) -and ($port2 -gt 0) -and (-not $c.crashRecoveryOnReboot)
Rec 'S5-install-over-running-app' $(if ($cpass) { 'PASS' } else { 'FAIL' }) `
  ("Setup.exe run over a RUNNING app (the installer asks it for --quit-for-update first): installer exit $($c.install.exit); running from the install dir before: $(& $names $c.runningBefore); still running after the installer: $(& $names $c.runningAfter); postmaster.pid left behind: $($c.postmasterPidLeft); next boot: healthy $($port2 -gt 0), crash recovery needed: $($c.crashRecoveryOnReboot)") $c

# ---- cleanup
Start-Process -FilePath $Exe -ArgumentList '--quit-for-update' -Wait
$un = Join-Path $Inst 'Uninstall Uchiyomi.exe'
if (Test-Path $un) { Start-Process -FilePath $un -ArgumentList '/S' -Wait }
foreach ($n in 'desktop.log', 'postgres.log', 'bff.log') { Copy-Item (Join-Path $Data "logs\$n") (Join-Path $Out "s5-$n") -ErrorAction SilentlyContinue }
