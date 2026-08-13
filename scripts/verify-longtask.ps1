# Long-task reliability simulation: runs a ~60s busy read-only agent task in
# the REAL workspace while the health monitor is active, and asserts the
# monitor produces no false positive and no restart.
$ErrorActionPreference = 'Stop'
$root = 'D:\software\dsh-desktop'
$workspace = 'D:\software'
$appLog = Join-Path $env:APPDATA 'dsh-desktop\dsh-desktop.log'
$electronExe = Join-Path $root 'node_modules\electron\dist\electron.exe'

# Clean launch environment; inherit the credential env of the running harness.
Add-Type -TypeDefinition ([System.IO.File]::ReadAllText((Join-Path $PSScriptRoot 'envreader.cs.txt')))
Remove-Item Env:\DSH_SESSION_JSONL, Env:\DSH_SESSION_ID, Env:\DSH_WEB_URL, Env:\DSH_SHELL, Env:\DSH_DESKTOP_SHOT, Env:\DSH_VERIFY_DEBUG -ErrorAction SilentlyContinue
$hp = (Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess
if ($hp) {
  $m = [NativeEnvRow]::Read([int]$hp)
  if ($m.ContainsKey('DEEPSEEK_API_KEY')) { Set-Item -Path 'Env:DEEPSEEK_API_KEY' -Value $m['DEEPSEEK_API_KEY'] }
} else { 'RESULT: FAIL (no running harness on 3080 to inherit credentials from)'; exit 1 }

# Workspace hash snapshot (files only, excluding node_modules/dist/.verify/.git).
$hashBefore = Join-Path $root '.verify-longtask-hash-before.json'
$files = Get-ChildItem $root -Recurse -File | Where-Object { $_.FullName -notmatch '\\node_modules\\|\\dist\\|\.verify-|\\\.git\\' }
$files | ForEach-Object { [pscustomobject]@{ Path = $_.FullName.Substring($root.Length + 1); Hash = (Get-FileHash $_.FullName -Algorithm SHA256).Hash } } | ConvertTo-Json | Set-Content $hashBefore
"hash snapshot: $($files.Count) files"

Remove-Item $appLog -Force -ErrorAction SilentlyContinue
$p = Start-Process -FilePath $electronExe -ArgumentList @('.', '--workspace', $workspace, '--remote-debugging-port=9333') -WorkingDirectory $root -PassThru
"app pid=$($p.Id)"

$deadline = (Get-Date).AddSeconds(180)
do { Start-Sleep -Milliseconds 500; $text = if (Test-Path $appLog) { [System.IO.File]::ReadAllText($appLog) } else { '' } } while ($text -notmatch 'state: ready' -and $text -notmatch 'state: failed' -and (Get-Date) -lt $deadline)
if ($text -notmatch 'state: ready') { "app failed to reach ready"; exit 1 }
"app ready; starting long task"

$taskStart = Get-Date
node (Join-Path $root 'scripts\verify-agent.mjs') longtask
$driverExit = $LASTEXITCODE
"driver exit: $driverExit"
$taskSeconds = [Math]::Round(((Get-Date) - $taskStart).TotalSeconds)

if ($driverExit -eq 0) {
  $log = [System.IO.File]::ReadAllText($appLog)
  $result = Get-Content (Join-Path $root '.verify-longtask-result.json') -Raw | ConvertFrom-Json
  '=== long task results ==='
  "task duration (wall): $taskSeconds s"
  "session: $($result.sessionDir)"
  "tools: $($result.toolNames -join ', ')"
  "tool errors: $($result.isErrorCount)"
  $spawnCount = ([regex]::Matches($log, 'harness spawned: pid=(\d+)')).Count
  $healthOk = ([regex]::Matches($log, 'health: ok')).Count
  $healthFail = ([regex]::Matches($log, 'health: fail')).Count
  "spawn count: $spawnCount  health ok: $healthOk  health fail: $healthFail"
  $checks = [ordered]@{
    'longtask:turn-completed' = $true
    'longtask:health-monitor-ran' = ($healthOk -ge 3)
    'longtask:no-false-disconnect' = ($log -notmatch 'state: disconnected')
    'longtask:no-auto-restart' = ($spawnCount -eq 1)
    'longtask:no-tool-errors' = ($result.isErrorCount -eq 0)
  }
  foreach ($k in $checks.Keys) { "[{0}] {1} = {2}" -f ($(if ($checks[$k]) { 'PASS' } else { 'FAIL' }), $k, $checks[$k]) }
  # workspace diff
  $files2 = Get-ChildItem $root -Recurse -File | Where-Object { $_.FullName -notmatch '\\node_modules\\|\\dist\\|\.verify-|\\\.git\\' }
  $snap2 = $files2 | ForEach-Object { [pscustomobject]@{ Path = $_.FullName.Substring($root.Length + 1); Hash = (Get-FileHash $_.FullName -Algorithm SHA256).Hash } }
  $before = Get-Content $hashBefore -Raw | ConvertFrom-Json
  $changed = @(); foreach ($b in $before) { $a = $snap2 | Where-Object { $_.Path -eq $b.Path } | Select-Object -First 1; if (-not $a -or $a.Hash -ne $b.Hash) { $changed += $b.Path } }
  $added = @($snap2 | Where-Object { $_.Path -notin $before.Path })
  $diffOk = $changed.Count -eq 0 -and $added.Count -eq 0
  "[{0}] longtask:workspace-unchanged = {1}" -f ($(if ($diffOk) { 'PASS' } else { 'FAIL' }), $(if ($diffOk) { 'no changes' } else { "changed=$($changed -join ',') added=$($added -join ',')" }))
  # session log intact
  if (Test-Path $result.sessionFile) { "[PASS] longtask:session-persisted = $($result.sessionFile)" }
  if (-not ($checks.Values -contains $false) -and $diffOk) { 'RESULT: LONG TASK PASS' } else { 'RESULT: LONG TASK FAIL'; $failed = $true }
} else {
  'RESULT: LONG TASK FAIL (driver)'
  $failed = $true
}

$proc = Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if ($proc) { $null = $proc.CloseMainWindow() }
$d2 = (Get-Date).AddSeconds(30)
do { Start-Sleep -Milliseconds 500; $still = @(Get-Process electron -ErrorAction SilentlyContinue) } while ($still.Count -gt 0 -and (Get-Date) -lt $d2)
"electron exited: $($still.Count -eq 0)"
if ($failed) { exit 1 } else { exit 0 }
