# S2 (iv): the same --smoke lifecycle (initdb, start, the bff's backup, stop) as a STANDARD Windows user -- not an
# administrator, not elevated -- which is what most home PCs run as.
# A local user is created, the unpacked app copied somewhere it can read, and the app started under that user's
# logon with Start-Process -Credential (CreateProcessWithLogonW). If the runner refuses that, a scheduled task
# under the same account is tried. Whatever happens is recorded.
$ErrorActionPreference = 'Continue'
$Desktop = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$Src = Join-Path $Desktop 'dist\win-unpacked'
$Base = 'C:\uchi-std'
$User = 'uchistd'
$Result = Join-Path $Base 'data-smoke.json'

function Rec($id, $verdict, $summary, $evidence) {
  $f = Join-Path $env:RUNNER_TEMP "ev-$id.json"
  ($evidence | ConvertTo-Json -Depth 8) | Set-Content -Encoding utf8 $f
  node (Join-Path $PSScriptRoot 'record.mjs') $id $verdict $summary $f
}

$ev = [ordered]@{}
Remove-Item -Recurse -Force $Base -ErrorAction SilentlyContinue
# ⚠️ Its own library folder: under Start-Process -Credential the child inherits the CALLER's environment, so
# os.tmpdir() (the smoke's default library) is the admin's %TEMP%, which a standard user cannot write -- the first
# run of this check failed on that, not on the app. A real standard user's %TEMP% is its own.
New-Item -ItemType Directory -Force (Join-Path $Base 'app'), (Join-Path $Base 'data'), (Join-Path $Base 'library') | Out-Null
Copy-Item -Recurse -Force (Join-Path $Src '*') (Join-Path $Base 'app')

$pw = 'Uc!' + [guid]::NewGuid().ToString('N').Substring(0, 16) + 'aA1'
$sec = ConvertTo-SecureString $pw -AsPlainText -Force
try {
  Remove-LocalUser -Name $User -ErrorAction SilentlyContinue
  New-LocalUser -Name $User -Password $sec -PasswordNeverExpires -AccountNeverExpires -Description 'Uchiyomi spike standard user' | Out-Null
  Add-LocalGroupMember -Group 'Users' -Member $User -ErrorAction SilentlyContinue
  $ev.userCreated = $true
} catch { $ev.userCreated = "failed: $($_.Exception.Message)" }
$ev.isAdmin = [bool](Get-LocalGroupMember -Group 'Administrators' | Where-Object { $_.Name -like "*\$User" })
& icacls $Base /grant "${User}:(OI)(CI)RX" | Out-Null
& icacls (Join-Path $Base 'data') /grant "${User}:(OI)(CI)M" | Out-Null
& icacls (Join-Path $Base 'library') /grant "${User}:(OI)(CI)M" | Out-Null
& icacls $Base /grant "${User}:(M)" | Out-Null

$cred = New-Object System.Management.Automation.PSCredential($User, $sec)
$appArgs = @('--smoke', "--data-dir=$(Join-Path $Base 'data')", "--library-dir=$(Join-Path $Base 'library')", "--result=$Result")
try {
  $t = Get-Date
  $p = Start-Process -FilePath (Join-Path $Base 'app\Uchiyomi.exe') -ArgumentList $appArgs -Credential $cred -LoadUserProfile -WorkingDirectory $Base -PassThru
  if (-not $p.WaitForExit(360000)) { try { $p.Kill() } catch {}; $ev.exit = 'timeout' } else { $ev.exit = $p.ExitCode }
  $ev.ms = [int]((Get-Date) - $t).TotalMilliseconds
  $ev.how = 'Start-Process -Credential'
} catch { $ev.startProcessError = $_.Exception.Message }

if (-not (Test-Path $Result)) {
  try {
    $action = New-ScheduledTaskAction -Execute (Join-Path $Base 'app\Uchiyomi.exe') -Argument ($appArgs -join ' ') -WorkingDirectory $Base
    Register-ScheduledTask -TaskName 'uchi-std' -Action $action -User $User -Password $pw -RunLevel Limited -Force | Out-Null
    Start-ScheduledTask -TaskName 'uchi-std'
    $deadline = (Get-Date).AddMinutes(6)
    do { Start-Sleep -Seconds 3; $task = Get-ScheduledTask -TaskName 'uchi-std' } while ($task.State -eq 'Running' -and (Get-Date) -lt $deadline)
    $info = Get-ScheduledTaskInfo -TaskName 'uchi-std'
    $ev.how = 'scheduled task'
    $ev.exit = $info.LastTaskResult
    Unregister-ScheduledTask -TaskName 'uchi-std' -Confirm:$false
  } catch { $ev.scheduledTaskError = $_.Exception.Message }
}

$r = $null
if (Test-Path $Result) { $r = Get-Content $Result -Raw | ConvertFrom-Json }
$ev.result = $r
$log = Join-Path $Base 'data\logs\desktop.log'
if (Test-Path $log) { $ev.logTail = (Get-Content $log -Tail 12) -join "`n" }
$ranAs = if ($r) { $r.user } else { $null }
$ok = $r -and $r.ok -and ($ranAs -eq $User) -and (-not $ev.isAdmin)
$verdict = if ($ok) { 'PASS' } elseif (-not $r -and ($ev.startProcessError -or $ev.scheduledTaskError)) { 'FAIL' } else { 'FAIL' }
$summary = if ($r) {
  "as '$ranAs' (admin: $($ev.isAdmin)) via $($ev.how): smoke ok=$($r.ok), healthz $($r.checks.healthz.status), bff backup $($r.checks.bffBackup.files.'db.sql.gz') B, stop $($r.stop.bff)/$($r.stop.postgres), exit $($ev.exit)"
} else {
  "could not run the app as a standard user in CI: Start-Process: $($ev.startProcessError); scheduled task: $($ev.scheduledTaskError); exit $($ev.exit)"
}
Rec 'S2-iv-standard-user' $verdict $summary $ev
Remove-LocalUser -Name $User -ErrorAction SilentlyContinue
